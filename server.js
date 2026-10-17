const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true }));

// Enable CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = Number(process.env.PORT || 3000);
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || "";
const UNIVERSE_ID = process.env.UNIVERSE_ID || "";
const MESSAGING_TOPIC = process.env.MESSAGING_TOPIC || "DonationNotif";

// Antrean donasi untuk Roblox HttpService
const queue = [];
const history = [];
let lastRobloxPoll = null;
let lastRobloxServerId = null;

function extractTarget(message, explicit) {
  if (explicit && typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim().replace(/^@/, "");
  }
  const match = String(message || "").match(/@([a-zA-Z0-9_]{3,20})/);
  return match ? match[1] : "";
}

function firstValue(...values) {
  return values.find(v => v !== undefined && v !== null && String(v).trim() !== "");
}

function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const normalized = value.replace(/[^0-9.,-]/g, "").replace(/[.,](?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeDonation(body, platform = "saweria") {
  const data = body && typeof body.data === "object" && body.data ? body.data : {};
  const donor = firstValue(
    body.donator_name, body.donatorName, body.donor_name, body.donorName,
    body.supporter_name, body.supporter, body.name, data.donator_name, data.name, "Donatur Anonim"
  );
  const rawAmount = firstValue(
    body.amount_raw, body.amount, body.gross_amount, body.donation_amount,
    body.amount_settled, body.total, body.nominal, data.amount, 0
  );
  const message = firstValue(body.message, body.note, body.comment, body.support_message, data.message, "");
  const target = firstValue(body.targetName, body.target_name, body.recipient, data.targetName, "");

  const cleanMessage = String(message).trim().slice(0, 300);
  const targetName = extractTarget(cleanMessage, target);

  return {
    id: `don_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    platform,
    donatorName: String(donor).trim().slice(0, 80) || "Donatur Anonim",
    amount: parseAmount(rawAmount),
    message: cleanMessage,
    targetName: targetName,
    status: "pending",
    timestamp: new Date().toISOString(),
    leaseToken: null,
    leasedTo: null,
    leasedAt: null,
    leaseExpiresAt: null
  };
}

function enqueueDonation(donation) {
  queue.push(donation);
  history.unshift({ ...donation });
  if (history.length > 100) history.pop();
  console.log(`[Queue] Added: ${donation.donatorName} - Rp ${donation.amount.toLocaleString()} (Target: @${donation.targetName || "-"})`);
}

async function sendToOpenCloud(donation) {
  if (!ROBLOX_API_KEY || !UNIVERSE_ID) return;
  try {
    const url = `https://apis.roblox.com/messaging-service/v1/universes/${encodeURIComponent(UNIVERSE_ID)}/topics/${encodeURIComponent(MESSAGING_TOPIC)}`;
    await fetch(url, {
      method: "POST",
      headers: { "x-api-key": ROBLOX_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        message: JSON.stringify({
          platform: donation.platform,
          donatorName: donation.donatorName,
          amount: donation.amount,
          message: donation.message,
          targetName: donation.targetName,
          timestamp: donation.timestamp
        })
      })
    });
  } catch (e) {}
}

// 1. ENDPOINT PULL ROBLOX
app.post("/api/pull", (req, res) => {
  const serverId = req.body.serverId || req.headers["user-agent"] || "roblox-server";
  const limit = Math.min(Math.max(Number(req.body.limit) || 10, 1), 25);
  const now = Date.now();

  lastRobloxPoll = new Date().toISOString();
  lastRobloxServerId = String(serverId);

  const available = [];
  for (const item of queue) {
    if (item.status === "pending" || (item.status === "leased" && now > item.leaseExpiresAt)) {
      item.status = "leased";
      item.leaseToken = `lease_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      item.leasedTo = serverId;
      item.leasedAt = now;
      item.leaseExpiresAt = now + 30000;
      available.push(item);
    }
    if (available.length >= limit) break;
  }

  const items = available.map((item) => ({
    id: item.id,
    leaseToken: item.leaseToken,
    donorName: item.donatorName,
    donator_name: item.donatorName,
    username: item.donatorName,
    amount: item.amount,
    amount_raw: item.amount,
    message: item.message,
    targetName: item.targetName,
    recipient: item.targetName,
    platform: item.platform,
    createdAt: item.timestamp
  }));

  res.json({ ok: true, items, count: items.length, serverTime: Date.now() });
});

// 2. ENDPOINT ACK ROBLOX
app.post("/api/ack", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  for (const ackItem of items) {
    const qIdx = queue.findIndex((q) => q.id === ackItem.id);
    if (qIdx !== -1 && ackItem.status === "done") {
      queue.splice(qIdx, 1);
    }
  }
  res.json({ ok: true, acknowledged: items.length });
});

// 3. WEBHOOKS SAWERIA
app.post(["/webhook/saweria", "/webhook"], async (req, res) => {
  const donation = normalizeDonation(req.body || {}, "saweria");
  if (!(donation.amount > 0)) {
    return res.status(400).json({ success: false, error: "Nominal donasi tidak valid" });
  }

  enqueueDonation(donation);
  sendToOpenCloud(donation).catch(() => {});
  return res.json({ success: true, ok: true, platform: "saweria", id: donation.id });
});

app.post("/webhook/sociabuzz", (req, res) => {
  const donation = normalizeDonation(req.body || {}, "sociabuzz");
  if (donation.amount > 0) enqueueDonation(donation);
  res.json({ success: true, ok: true });
});

app.post("/webhook/bagibagi", (req, res) => {
  const donation = normalizeDonation(req.body || {}, "bagibagi");
  if (donation.amount > 0) enqueueDonation(donation);
  res.json({ success: true, ok: true });
});

// 4. TEST ENDPOINT - BISA DI-KLIK LANGSUNG DI BROWSER (GET & POST)
function processTest(req, res) {
  const combined = { ...req.query, ...req.body };
  const donation = normalizeDonation(combined, "test");
  if (!(donation.amount > 0)) donation.amount = 50000;
  if (!donation.donatorName || donation.donatorName === "Donatur Anonim") {
    donation.donatorName = combined.name || "Sultan Testing";
  }
  if (!donation.message) {
    donation.message = "Semangat live @Player!";
  }

  enqueueDonation(donation);
  sendToOpenCloud(donation).catch(() => {});

  // Tampilan HTML langsung di Browser
  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Donasi Masuk ke Roblox!</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; background: #0c0f1d; color: #fff; padding: 30px; text-align: center; }
        .card { max-width: 480px; margin: 20px auto; background: #151b2e; border: 2px solid #22c55e; border-radius: 16px; padding: 25px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
        .nominal { font-size: 36px; font-weight: 900; color: #fbbf24; margin: 10px 0; }
        .msg { background: #0c0f1d; padding: 12px; border-radius: 8px; color: #94a3b8; font-style: italic; margin: 15px 0; }
        .btn { display: inline-block; background: #f59e0b; color: #000; padding: 14px 28px; border-radius: 8px; font-weight: bold; text-decoration: none; font-size: 16px; border: 0; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="card">
        <div style="background:#22c55e20;color:#22c55e;padding:6px 14px;border-radius:20px;display:inline-block;font-weight:bold;font-size:12px;">BERHASIL DIKIRIM KE ROBLOX!</div>
        <h2 style="margin:15px 0 5px;">Donatur: ${donation.donatorName}</h2>
        <div class="nominal">Rp ${donation.amount.toLocaleString("id-ID")}</div>
        <div class="msg">"${donation.message}"</div>
        <p style="color:#4ade80;">Roblox Studio akan menarik donasi ini dalam 1-3 detik!</p>
        <button class="btn" onclick="location.reload()">Kirim Donasi Tes Lagi 🚀</button>
      </div>
      <p style="color:#64748b;font-size:13px;">Status Roblox: <strong>${lastRobloxPoll ? "Terhubung" : "Menunggu Game..."}</strong></p>
    </body>
    </html>
  `);
}

app.get(["/test", "/api/test"], processTest);
app.post(["/test", "/api/test"], processTest);

app.get(["/", "/health"], (req, res) => {
  res.redirect("/test");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DONATION- bridge listening on port ${PORT}`);
});
