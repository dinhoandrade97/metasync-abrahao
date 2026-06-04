"use strict";

const express  = require("express");
const crypto   = require("crypto");
const fs       = require("fs");
const path     = require("path");
const fetch    = require("node-fetch");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 4000;
const DATA_FILE      = path.join(__dirname, "data", "clients.json");
const META_CAPI_BASE = "https://graph.facebook.com/v19.0";

// ─── SSE clients for real-time logs ───────────────────────────────────────────
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

function log(level, inboxId, message, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    inboxId: inboxId ?? "system",
    message,
    ...extra,
  };
  console.log(`[${level.toUpperCase()}]`, message, extra.error || "");
  broadcast(entry);
  return entry;
}

// ─── Persist helpers ──────────────────────────────────────────────────────────
function loadClients() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveClients(clients) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2));
}

// ─── Hashing ──────────────────────────────────────────────────────────────────
const sha256 = v => v ? crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex") : null;

function hashPhone(phone) {
  if (!phone) return null;
  return sha256(String(phone).replace(/\D/g, ""));
}

function hashName(fullName) {
  if (!fullName) return { fn: null, ln: null };
  const parts = String(fullName).trim().split(/\s+/);
  return {
    fn: sha256(parts[0]),
    ln: parts.length > 1 ? sha256(parts.slice(1).join(" ")) : null,
  };
}

function hashCity(city) {
  if (!city) return null;
  return sha256(String(city).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim());
}

// ─── Build Meta CAPI payload ──────────────────────────────────────────────────
// ─── Build Meta CAPI payload ──────────────────────────────────────────────────
function buildEvent(eventName, { eventId, conversationId, contact, dealValue }) {
  const { fn, ln } = hashName(contact.name);
  const hashedPhone = hashPhone(contact.phone_number);
  const hashedEmail = sha256(contact.email);
  const city  = contact.city ?? contact.additional_attributes?.city ?? null;
  const state = contact.state ?? contact.additional_attributes?.state ?? null;

  const user_data = { country: [sha256("br")] };
  if (hashedPhone) user_data.ph = [hashedPhone];
  if (hashedEmail) user_data.em = [hashedEmail];
  if (fn)          user_data.fn = [fn];
  if (ln)          user_data.ln = [ln];
  if (city)        user_data.ct = [hashCity(city)];
  if (state)       user_data.st = [sha256(String(state).toLowerCase().slice(0, 2))];

  const event = {
    event_name:    eventName,
    event_time:    Math.floor(Date.now() / 1000),
    action_source: "crm",
    event_id:      eventId,
    user_data,
  };

  if (eventName === "Purchase") {
    event.custom_data = {
      value:    parseFloat(dealValue) || 0,
      currency: "BRL",
    };
  }

  return event;
}

// ─── Send to Meta CAPI ────────────────────────────────────────────────────────
async function sendToMeta(pixelId, accessToken, eventData, conversationId, inboxId) {
  const url = `${META_CAPI_BASE}/${pixelId}/events?access_token=${accessToken}`;
  try {
    const res    = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ data: [eventData] }),
    });
    const result = await res.json();
    if (!res.ok) {
      const errMsg = result?.error?.error_user_msg || result?.error?.message || JSON.stringify(result);
      log("error", inboxId, `CAPI ERROR | Conv ${conversationId} | ${eventData.event_name}: ${errMsg}`);
    } else {
      log("success", inboxId, `CAPI OK | Conv ${conversationId} | ${eventData.event_name}`, {
        event_id: eventData.event_id,
        events_received: result.events_received,
        contact: eventData.user_data.fn ? "com nome" : "sem nome",
        value: eventData.custom_data?.value,
      });
    }
  } catch (err) {
    log("error", inboxId, `CAPI FETCH ERROR | Conv ${conversationId}: ${err.message}`);
  }
}

// ─── Process webhook payload ──────────────────────────────────────────────────
const recentEvents = new Set();

async function processWebhook(payload, client, inboxId) {
  const eventType = payload.event;
  const targetStage = payload?.changed_attributes?.board_step?.current_value?.name || "";
  
  // Chatwoot as vezes dispara 4 vezes seguidas o mesmo evento (bug interno dele)
  // Criamos uma trava de 5 segundos para ignorar os eventos "gêmeos"
  const cacheKey = `${inboxId}_${eventType}_${payload.id}_${targetStage}`;
  if (recentEvents.has(cacheKey)) {
    return; // Ignora silenciosamente, pois já estamos processando o irmão gêmeo
  }
  recentEvents.add(cacheKey);
  setTimeout(() => recentEvents.delete(cacheKey), 5000);

  // ── conversation_created → Lead ──────────────────────────────────────────────
  if (eventType === "conversation_created") {
    const leadMapping = Object.entries(client.stageMap || {})
      .find(([, meta]) => meta === "Lead");
    if (!leadMapping) {
      log("info", inboxId, "conversation_created recebido mas Lead não configurado — ignorado");
      return;
    }

    const sender = payload?.meta?.sender ?? {};
    const convId = payload?.id ?? payload?.conversation?.id;
    const contact = {
      name:         sender.name,
      phone_number: sender.phone_number,
      email:        sender.email,
      additional_attributes: sender.additional_attributes || {},
    };

    const eventId = `metasync_${convId}_lead`;
    log("info", inboxId, `Lead | Conv ${convId} | ${contact.name || "desconhecido"}`);
    const eventData = buildEvent("Lead", { eventId, conversationId: convId, contact, dealValue: 0 });
    await sendToMeta(client.pixelId, client.accessToken, eventData, convId, inboxId);
    return;
  }

  // ── kanban_task_updated → etapa mapeada ─────────────────────────────────────
  if (eventType === "kanban_task_updated") {
    if (!payload?.changed_attributes?.board_step) {
      log("info", inboxId, `kanban_task_updated sem mudança de etapa — ignorado (Task ${payload.id})`);
      return;
    }

    const stageName   = payload?.board_step?.name;
    const metaEvent   = client.stageMap?.[stageName];
    const taskId      = payload.id;
    const convId      = payload?.conversation_ids?.[0] ?? taskId;
    const contact     = payload?.contacts?.[0] ?? payload?.conversations?.[0]?.contact ?? {};
    const dealValue   = payload?.value ?? 0;
    const from        = payload.changed_attributes.board_step.previous_value?.name;

    if (!stageName || !metaEvent) {
      const to = payload.changed_attributes.board_step.current_value?.name;
      log("info", inboxId, `Etapa "${stageName || to}" não mapeada (${from} → ${to || stageName}) — ignorado`);
      return;
    }

    const valueStr = metaEvent === "Purchase" && dealValue ? ` | R$ ${dealValue}` : "";
    log("info", inboxId, `${from} → ${stageName} → ${metaEvent} | ${contact.name || "desconhecido"}${valueStr}`, { taskId, convId });

    // Usa taskId e nome da etapa no eventId para garantir idempotência caso venham duplicados
    const eventId = `metasync_task_${taskId}_stage_${sha256(stageName).slice(0, 8)}`;
    const eventData = buildEvent(metaEvent, { eventId, conversationId: convId, contact, dealValue });
    await sendToMeta(client.pixelId, client.accessToken, eventData, convId, inboxId);
    return;
  }

  log("info", inboxId, `Evento "${eventType}" ignorado`);
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(path.join(__dirname, "public")));

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const clients = loadClients();
  res.json({
    status: "online",
    service: "MetaSync — Agência Abrahão",
    clients: Object.keys(clients).length,
    ts: new Date().toISOString(),
  });
});

// ── Auth Middleware & Login ───────────────────────────────────────────────────
const ADMIN_TOKEN = "metasync_admin_secret_token";

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "Agencia#@!321") {
    return res.json({ token: ADMIN_TOKEN });
  }
  res.status(401).json({ error: "Credenciais inválidas" });
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || `Bearer ${req.query.token || ""}`;
  if (authHeader.replace("Bearer ", "") === ADMIN_TOKEN) {
    return next();
  }
  res.status(401).json({ error: "Não autorizado" });
}

// ── SSE — real-time logs ──────────────────────────────────────────────────────
app.get("/api/logs/stream", authMiddleware, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ ts: new Date().toISOString(), level: "info", inboxId: "system", message: "Conectado ao stream de logs ✅" })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// ── CRUD Clients ──────────────────────────────────────────────────────────────
app.get("/api/clients", authMiddleware, (_req, res) => {
  const clients = loadClients();
  // Mascara o access token
  const safe = Object.fromEntries(
    Object.entries(clients).map(([id, c]) => [id, {
      ...c,
      accessToken: c.accessToken ? `${c.accessToken.slice(0, 8)}...` : "",
    }])
  );
  res.json(safe);
});

app.get("/api/clients/full/:inboxId", authMiddleware, (req, res) => {
  const clients = loadClients();
  const client  = clients[req.params.inboxId];
  if (!client) return res.status(404).json({ error: "não encontrado" });
  res.json(client); // token completo
});

app.post("/api/clients", authMiddleware, (req, res) => {
  const { inboxId, name, pixelId, accessToken, webhookSecret, stageMap } = req.body;
  if (!inboxId || !pixelId || !accessToken) {
    return res.status(400).json({ error: "inboxId, pixelId e accessToken são obrigatórios" });
  }
  const clients = loadClients();
  clients[String(inboxId)] = { name: name || `Cliente ${inboxId}`, pixelId, accessToken, webhookSecret: webhookSecret || "", stageMap: stageMap || {} };
  saveClients(clients);
  log("success", inboxId, `Cliente "${clients[inboxId].name}" salvo`);
  res.json({ ok: true, inboxId });
});

app.delete("/api/clients/:inboxId", authMiddleware, (req, res) => {
  const clients = loadClients();
  const { inboxId } = req.params;
  if (!clients[inboxId]) return res.status(404).json({ error: "Cliente não encontrado" });
  const name = clients[inboxId].name;
  delete clients[inboxId];
  saveClients(clients);
  log("info", inboxId, `Cliente "${name}" removido`);
  res.json({ ok: true });
});

// ── Webhook endpoint ──────────────────────────────────────────────────────────
app.post("/webhook/:inboxId", async (req, res) => {
  const { inboxId } = req.params;
  const clients = loadClients();
  const client  = clients[inboxId];

  res.json({ status: "ok" });

  if (!client) {
    log("warn", inboxId, `Webhook recebido para inbox ${inboxId} não cadastrado`);
    return;
  }

  // Verifica se o evento pertence a este inboxId
  const actualInboxId = req.body.inbox_id || req.body.conversation?.inbox_id || req.body.inbox?.id;
  if (actualInboxId && String(actualInboxId) !== String(inboxId)) {
    return res.status(200).send("OK - Ignored, belongs to another inbox");
  }

  // Verifica assinatura se secret configurado
  if (client.webhookSecret) {
    const raw = req.headers["x-chatwoot-signature"];
    if (raw) {
      const received = raw.startsWith("sha256=") ? raw.slice(7) : raw;
      const expected = crypto.createHmac("sha256", client.webhookSecret).update(req.rawBody).digest("hex");
      if (received !== expected) {
        log("warn", inboxId, "Assinatura não confere — processando mesmo assim");
      }
    }
  }

  const payload = req.body;
  log("info", inboxId, `Recebido: "${payload?.event}" | ID: ${payload?.id ?? "-"}`);

  try {
    await processWebhook(payload, client, inboxId);
  } catch (err) {
    log("error", inboxId, `Erro ao processar: ${err.message}`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("─".repeat(50));
  console.log("  🔷  MetaSync — Agência Abrahão");
  console.log(`  🚀  Dashboard: http://localhost:${PORT}`);
  console.log(`  📡  Webhook:   http://localhost:${PORT}/webhook/:inboxId`);
  console.log("─".repeat(50));
});
