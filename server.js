const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb", strict: true }));

const PORT = Number(process.env.PORT || 3000);
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || "";
const UNIVERSE_ID = process.env.UNIVERSE_ID || "";
const MESSAGING_TOPIC = process.env.MESSAGING_TOPIC || "DonationNotif";
const SAWERIA_WEBHOOK_SECRET = process.env.SAWERIA_WEBHOOK_SECRET || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

app.use(express.static(path.join(__dirname, "public"), { index: false }));

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  const supplied = req.get("x-admin-token") || "";
  if (!ADMIN_TOKEN || !safeEqual(supplied, ADMIN_TOKEN)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

function requireSaweriaSecret(req, res, next) {
  if (!SAWERIA_WEBHOOK_SECRET) {
    return res.status(503).json({ success: false, error: "Webhook belum dikonfigurasi di Railway" });
  }
  const supplied = req.query.secret || req.get("x-webhook-secret") || "";
  if (!safeEqual(String(supplied), SAWERIA_WEBHOOK_SECRET)) {
    return res.status(401).json({ success: false, error: "Webhook secret tidak valid" });
  }
  next();
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
  const donor = firstValue(body.donator_name, body.donatorName, body.donor_name, body.supporter_name, body.supporter, body.name, data.donator_name, data.name, "Donatur Anonim");
  const rawAmount = firstValue(body.amount_raw, body.amount, body.gross_amount, body.donation_amount, body.amount_settled, body.total, body.nominal, data.amount, 0);
  const message = firstValue(body.message, body.note, body.comment, body.support_message, data.message, "");
  return {
    platform,
    donatorName: String(donor).trim().slice(0, 80) || "Donatur Anonim",
    amount: parseAmount(rawAmount),
    message: String(message).trim().slice(0, 300),
    timestamp: new Date().toISOString()
  };
}

async function sendToRoblox(donation) {
  if (!ROBLOX_API_KEY || !UNIVERSE_ID) {
    return { success: false, status: 503, error: "ROBLOX_API_KEY atau UNIVERSE_ID belum diatur di Railway" };
  }

  const url = `https://apis.roblox.com/messaging-service/v1/universes/${encodeURIComponent(UNIVERSE_ID)}/topics/${encodeURIComponent(MESSAGING_TOPIC)}`;
  const message = JSON.stringify({
    platform: donation.platform,
    donatorName: donation.donatorName,
    amount: donation.amount,
    message: donation.message,
    timestamp: donation.timestamp
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": ROBLOX_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(10000)
    });
    const responseText = await response.text();
    if (!response.ok) {
      console.error("[Roblox] MessagingService rejected request:", response.status, responseText.slice(0, 500));
      return { success: false, status: response.status, error: "Roblox menolak pesan. Periksa API key, permission, Universe ID, dan konfigurasi experience." };
    }
    console.log("[Roblox] Donation published:", donation.platform, donation.amount);
    return { success: true, status: response.status };
  } catch (error) {
    console.error("[Roblox] Request failed:", error.message);
    return { success: false, status: 502, error: "Tidak dapat menghubungi Roblox API" };
  }
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "DONATION- Roblox Bridge",
    timestamp: new Date().toISOString(),
    configured: {
      robloxApiKey: Boolean(ROBLOX_API_KEY),
      universeId: Boolean(UNIVERSE_ID),
      saweriaWebhookSecret: Boolean(SAWERIA_WEBHOOK_SECRET),
      adminToken: Boolean(ADMIN_TOKEN)
    },
    topic: MESSAGING_TOPIC
  });
});

app.get("/api/status", (_req, res) => {
  res.json({ service: "DONATION- Roblox Bridge", platforms: ["saweria"], webhookPath: "/webhook/saweria", testPath: "/api/test", healthPath: "/health" });
});

app.post("/webhook/saweria", requireSaweriaSecret, async (req, res) => {
  const donation = normalizeDonation(req.body || {}, "saweria");
  if (!(donation.amount > 0)) {
    return res.status(400).json({ success: false, error: "Nominal donasi tidak valid" });
  }

  console.log("[Saweria] Webhook received:", { donor: donation.donatorName, amount: donation.amount });
  const roblox = await sendToRoblox(donation);
  if (!roblox.success) return res.status(502).json({ success: false, platform: "saweria", roblox });
  return res.json({ success: true, platform: "saweria", roblox });
});

app.post("/api/test", requireAdmin, async (req, res) => {
  const donation = normalizeDonation(req.body || {}, "test");
  if (!(donation.amount > 0)) return res.status(400).json({ success: false, error: "Nominal harus lebih besar dari 0" });
  const roblox = await sendToRoblox(donation);
  return res.status(roblox.success ? 200 : 502).json({ success: roblox.success, platform: "test", roblox });
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ success: false, error: "JSON request tidak valid" });
  console.error("[Server] Error:", err.message);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DONATION- bridge listening on port ${PORT}`);
  console.log(`Roblox topic: ${MESSAGING_TOPIC}`);
});
