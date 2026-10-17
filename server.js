const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true }));

// Enable CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, x-api-key, x-admin-token, x-webhook-secret");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const PORT = Number(process.env.PORT || 3000);
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || "";
const UNIVERSE_ID = process.env.UNIVERSE_ID || "";
const MESSAGING_TOPIC = process.env.MESSAGING_TOPIC || "DonationNotif";
const SAWERIA_WEBHOOK_SECRET = process.env.SAWERIA_WEBHOOK_SECRET || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

app.use(express.static(path.join(__dirname, "public"), { index: false }));

// ============================================
// IN-MEMORY QUEUE UNTUK ROBLOX HTTPSERVICE
// ============================================
const queue = [];
const history = [];
const MAX_HISTORY = 100;
let lastRobloxPoll = null;
let lastRobloxServerId = null;

function extractTarget(message, explicit) {
  if (explicit && typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim().replace(/^@/, "");
  }
  const match = String(message || "").match(/@([a-zA-Z0-9_]{3,20})/);
  return match ? match[1] : "";
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const supplied = req.get("x-admin-token") || req.query.token || (req.body && req.body.token) || "";
  if (!safeEqual(supplied, ADMIN_TOKEN)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

function requireSaweriaSecret(req, res, next) {
  if (!SAWERIA_WEBHOOK_SECRET) return next(); // Jika tidak diset di Railway, jangan blokir donasi
  const supplied = req.query.secret || req.get("x-webhook-secret") || (req.body && req.body.secret) || "";
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
  const donor = firstValue(
    body.donator_name,
    body.donatorName,
    body.donor_name,
    body.supporter_name,
    body.supporter,
    body.name,
    data.donator_name,
    data.name,
    "Donatur Anonim"
  );
  const rawAmount = firstValue(
    body.amount_raw,
    body.amount,
    body.gross_amount,
    body.donation_amount,
    body.amount_settled,
    body.total,
    body.nominal,
    data.amount,
    0
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
  if (history.length > MAX_HISTORY) history.pop();
  console.log(`[Queue] Added: ${donation.donatorName} - Rp ${donation.amount.toLocaleString()} (Target: @${donation.targetName || "-"})`);
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
    targetName: donation.targetName,
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
      console.error("[Roblox OpenCloud] Rejected:", response.status, responseText.slice(0, 500));
      return { success: false, status: response.status, error: responseText };
    }
    console.log("[Roblox OpenCloud] Sent:", donation.platform, donation.amount);
    return { success: true, status: response.status };
  } catch (error) {
    console.error("[Roblox OpenCloud] Failed:", error.message);
    return { success: false, status: 502, error: error.message };
  }
}

// ============================================
// ENDPOINTS ROBLOX HTTPSERVICE (/api/pull & /api/ack)
// ============================================
app.post("/api/pull", (req, res) => {
  const serverId = req.body.serverId || req.headers["user-agent"] || "roblox-server";
  const limit = Math.min(Math.max(Number(req.body.limit) || 10, 1), 25);
  const now = Date.now();
  const leaseDuration = 30000;

  lastRobloxPoll = new Date().toISOString();
  lastRobloxServerId = String(serverId);

  const available = [];
  for (const item of queue) {
    if (item.status === "pending") {
      available.push(item);
    } else if (item.status === "leased" && item.leaseExpiresAt && now > item.leaseExpiresAt) {
      item.status = "pending";
      item.leaseToken = null;
      available.push(item);
    }
    if (available.length >= limit) break;
  }

  const items = available.map((item) => {
    const leaseToken = `lease_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    item.status = "leased";
    item.leaseToken = leaseToken;
    item.leasedTo = serverId;
    item.leasedAt = now;
    item.leaseExpiresAt = now + leaseDuration;

    return {
      id: item.id,
      leaseToken,
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
    };
  });

  if (items.length > 0) {
    console.log(`[Roblox HttpService] 📤 Polled ${items.length} donation(s) by ${serverId}`);
  }

  res.json({
    ok: true,
    items,
    count: items.length,
    serverTime: Date.now()
  });
});

app.post("/api/ack", (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  let acknowledged = 0;

  for (const ackItem of items) {
    const qIdx = queue.findIndex((q) => q.id === ackItem.id);
    const hItem = history.find((h) => h.id === ackItem.id);

    if (ackItem.status === "done") {
      acknowledged++;
      if (qIdx !== -1) queue.splice(qIdx, 1);
      if (hItem) {
        hItem.status = "done";
        hItem.acknowledgedAt = new Date().toISOString();
      }
    } else {
      if (qIdx !== -1) queue[qIdx].status = "failed";
      if (hItem) hItem.status = "failed";
    }
  }

  res.json({ ok: true, acknowledged });
});

// ============================================
// WEBHOOKS
// ============================================
app.post("/webhook/saweria", requireSaweriaSecret, async (req, res) => {
  const donation = normalizeDonation(req.body || {}, "saweria");
  if (!(donation.amount > 0)) {
    return res.status(400).json({ success: false, error: "Nominal donasi tidak valid" });
  }

  enqueueDonation(donation);
  const roblox = await sendToRoblox(donation);

  return res.json({
    success: true,
    ok: true,
    platform: "saweria",
    id: donation.id,
    openCloud: roblox
  });
});

app.post("/webhook/sociabuzz", (req, res) => {
  const donation = normalizeDonation(req.body || {}, "sociabuzz");
  if (!(donation.amount > 0)) return res.status(400).json({ success: false, error: "Nominal tidak valid" });
  enqueueDonation(donation);
  sendToRoblox(donation).catch(() => {});
  res.json({ success: true, ok: true, id: donation.id });
});

app.post("/webhook/bagibagi", (req, res) => {
  const donation = normalizeDonation(req.body || {}, "bagibagi");
  if (!(donation.amount > 0)) return res.status(400).json({ success: false, error: "Nominal tidak valid" });
  enqueueDonation(donation);
  sendToRoblox(donation).catch(() => {});
  res.json({ success: true, ok: true, id: donation.id });
});

app.post("/api/test", requireAdmin, async (req, res) => {
  const donation = normalizeDonation(req.body || {}, "test");
  if (!(donation.amount > 0)) return res.status(400).json({ success: false, error: "Nominal harus lebih besar dari 0" });

  enqueueDonation(donation);
  const roblox = await sendToRoblox(donation);

  return res.status(200).json({
    success: true,
    ok: true,
    platform: "test",
    queuedForRoblox: true,
    openCloud: roblox,
    donation
  });
});

app.get("/", (_req, res) => {
  const publicIndex = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(publicIndex)) {
    res.sendFile(publicIndex);
  } else {
    res.json({ status: "ok", service: "DONATION- Roblox Bridge", mode: "HttpService + Open Cloud" });
  }
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
    topic: MESSAGING_TOPIC,
    lastRobloxPoll,
    lastRobloxServerId,
    pendingInQueue: queue.length
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    service: "DONATION- Roblox Bridge",
    platforms: ["saweria", "sociabuzz", "bagibagi"],
    webhookPath: "/webhook/saweria",
    pullPath: "/api/pull",
    ackPath: "/api/ack",
    testPath: "/api/test",
    healthPath: "/health",
    pendingInQueue: queue.length,
    lastRobloxPoll
  });
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ success: false, error: "JSON request tidak valid" });
  console.error("[Server] Error:", err.message);
  res.status(500).json({ success: false, error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DONATION- bridge listening on port ${PORT}`);
  console.log(`Endpoints active: POST /api/pull, POST /api/ack, POST /webhook/saweria`);
});
