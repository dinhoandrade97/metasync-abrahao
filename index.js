"use strict";

const express  = require("express");
const crypto   = require("crypto");
const fs       = require("fs");
const path     = require("path");
const fetch    = require("node-fetch");
const { google } = require("googleapis");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 4000;
const DATA_FILE      = path.join(__dirname, "data", "clients.json");
const QUEUE_FILE     = path.join(__dirname, "data", "queue.json");
const ANALYTICS_FILE = path.join(__dirname, "data", "analytics.json");
const LOGS_DIR       = path.join(__dirname, "data", "logs");
const META_CAPI_BASE = "https://graph.facebook.com/v19.0";

// ─── SSE clients for real-time logs ───────────────────────────────────────────
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

function getBrtDateStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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

  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const dateStr = getBrtDateStr();
    fs.appendFileSync(path.join(LOGS_DIR, `${dateStr}.jsonl`), JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error("Erro ao salvar log no disco:", e);
  }

  return entry;
}

// ─── Persist helpers ──────────────────────────────────────────────────────────
function loadJSON(file, defaultVal = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return defaultVal; }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadClients() { return loadJSON(DATA_FILE, {}); }
function saveClients(clients) { saveJSON(DATA_FILE, clients); }

// ─── Google Calendar Auth ─────────────────────────────────────────────────────
function getCalendarAuth() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
      const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
      return new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'],
      });
    } catch (e) {
      console.error("Erro ao fazer parse da variável GOOGLE_CREDENTIALS_JSON:", e);
    }
  }

  const credsPath = path.join(__dirname, "data", "google-credentials.json");
  if (!fs.existsSync(credsPath)) {
    throw new Error("Arquivo de credenciais do Google Workspace (data/google-credentials.json) não encontrado, e variável GOOGLE_CREDENTIALS_JSON não definida.");
  }
  return new google.auth.GoogleAuth({
    keyFile: credsPath,
    scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'],
  });
}

// ─── Analytics ────────────────────────────────────────────────────────────────
function trackAnalytics(inboxId, success, value = 0, eventName = "Unknown") {
  const analytics = loadJSON(ANALYTICS_FILE, {});
  const dateStr = getBrtDateStr();
  
  if (!analytics[inboxId]) analytics[inboxId] = {};
  if (!analytics[inboxId][dateStr]) analytics[inboxId][dateStr] = { success: 0, fail: 0, value: 0, events: {} };
  
  if (success) {
    analytics[inboxId][dateStr].success++;
    if (value > 0) analytics[inboxId][dateStr].value += parseFloat(value);
    
    analytics[inboxId][dateStr].events = analytics[inboxId][dateStr].events || {};
    analytics[inboxId][dateStr].events[eventName] = (analytics[inboxId][dateStr].events[eventName] || 0) + 1;
  } else {
    analytics[inboxId][dateStr].fail++;
  }
  saveJSON(ANALYTICS_FILE, analytics);
}

// ─── Queue System ─────────────────────────────────────────────────────────────
function enqueueJob(inboxId, platform, endpoint, payload, accessToken = "") {
  const queue = loadJSON(QUEUE_FILE, []);
  
  // 1. Extrai o event_id exato do payload para evitar duplicatas na fila
  let eventId = null;
  if (platform === "meta" && payload.data && payload.data[0]) {
    eventId = payload.data[0].event_id;
  } else if (platform === "tiktok" && payload.event_id) {
    eventId = payload.event_id;
  } else if (platform === "ga4" && payload.events && payload.events[0].params) {
    eventId = payload.events[0].params.transaction_id;
  }

  // 2. Se já existir um evento com esse exato ID para essa plataforma na fila, ignoramos
  if (eventId) {
    const isDuplicate = queue.some(j => j.platform === platform && j.eventId === eventId);
    if (isDuplicate) {
      log("info", inboxId, `Fila Segura: Evento ${eventId} já está aguardando re-tentativa na plataforma ${platform.toUpperCase()}. Duplicata evitada.`);
      return;
    }
  }

  queue.push({
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    eventId,
    inboxId,
    platform,
    endpoint,
    payload,
    accessToken,
    attempts: 0,
    nextRunAt: Date.now() + 60000 // Retry em 1 min
  });
  saveJSON(QUEUE_FILE, queue);
  log("warn", inboxId, `Falha na plataforma ${platform.toUpperCase()}. Evento colocado na Fila (Retry em 1m).`);
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
function buildEvent(eventName, { eventId, conversationId, contact, dealValue, stageName }) {
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
  if (contact.id)  user_data.external_id = [sha256(String(contact.id))];

  const event = {
    event_name:    eventName,
    event_time:    Math.floor(Date.now() / 1000),
    action_source: "crm",
    event_id:      eventId,
    user_data,
    custom_data: {
      lead_source: "chatwoot_metasync",
      kanban_stage: stageName || "Novo Lead"
    }
  };

  if (eventName === "Purchase") {
    event.custom_data.value = parseFloat(dealValue) || 0;
    event.custom_data.currency = "BRL";
  }

  return event;
}

// ─── Dispatchers (Meta, GA4, TikTok) ─────────────────────────────────────────
async function sendToMeta(pixelId, accessToken, eventData, conversationId, inboxId, isRetry = false) {
  if (!pixelId || !accessToken) return;
  const url = `${META_CAPI_BASE}/${pixelId}/events?access_token=${accessToken}`;
  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ data: [eventData] }),
    });
    const result = await res.json();
    if (!res.ok) {
      const errMsg = result?.error?.error_user_msg || result?.error?.message || JSON.stringify(result);
      log("error", inboxId, `CAPI ERROR | Conv ${conversationId} | ${eventData.event_name}: ${errMsg}`);
      if (!isRetry && res.status >= 500) {
        enqueueJob(inboxId, "meta", url, { data: [eventData] }, ""); // Note: Token is in URL
      } else if (!isRetry) {
        const stageName = eventData.custom_data?.kanban_stage || eventData.event_name;
        trackAnalytics(inboxId, false, 0, stageName);
      }
    } else {
      log("success", inboxId, `CAPI META OK | Conv ${conversationId} | ${eventData.event_name}${isRetry ? " (Retry)" : ""}`, {
        event_id: eventData.event_id,
        events_received: result.events_received,
        value: eventData.custom_data?.value,
      });
      if (!isRetry) {
        const stageName = eventData.custom_data?.kanban_stage || eventData.event_name;
        trackAnalytics(inboxId, true, eventData.custom_data?.value || 0, stageName);
      }
    }
  } catch (err) {
    log("error", inboxId, `CAPI FETCH ERROR | Conv ${conversationId}: ${err.message}`);
    if (!isRetry) enqueueJob(inboxId, "meta", url, { data: [eventData] }, "");
  }
}

async function sendToTikTok(pixelId, accessToken, eventData, conversationId, inboxId, isRetry = false) {
  if (!pixelId || !accessToken) return;
  const ttEvent = {
    event: eventData.event_name,
    event_time: eventData.event_time,
    event_id: eventData.event_id,
    user: { phone_number: eventData.user_data?.ph?.[0], email: eventData.user_data?.em?.[0] },
    properties: { value: eventData.custom_data?.value, currency: "BRL" }
  };
  const url = `https://business-api.tiktok.com/open_api/v1.3/pixel/track/`;
  const payload = {
    pixel_code: pixelId,
    event: ttEvent.event,
    event_id: ttEvent.event_id,
    timestamp: ttEvent.event_time,
    context: { user: ttEvent.user },
    properties: ttEvent.properties
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": accessToken },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      if (!isRetry && res.status >= 500) enqueueJob(inboxId, "tiktok", url, payload, accessToken);
      log("error", inboxId, `TIKTOK ERROR | Conv ${conversationId} | Status ${res.status}`);
    } else {
      log("success", inboxId, `CAPI TIKTOK OK | Conv ${conversationId} | ${ttEvent.event}${isRetry ? " (Retry)" : ""}`);
    }
  } catch (e) {
    log("error", inboxId, `TIKTOK FETCH ERROR | Conv ${conversationId}: ${e.message}`);
    if (!isRetry) enqueueJob(inboxId, "tiktok", url, payload, accessToken);
  }
}

async function sendToGA4(measurementId, apiSecret, eventData, conversationId, inboxId, isRetry = false) {
  if (!measurementId || !apiSecret) return;
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`;
  let ga4EventName = "custom_stage";
  if (eventData.event_name === "Purchase") ga4EventName = "purchase";
  else if (eventData.event_name === "Lead") ga4EventName = "generate_lead";
  
  const payload = {
    client_id: String(conversationId),
    events: [{
      name: ga4EventName,
      params: { currency: "BRL", value: eventData.custom_data?.value || 0, transaction_id: eventData.event_id }
    }]
  };
  try {
    const res = await fetch(url, { method: "POST", body: JSON.stringify(payload) });
    if (!res.ok) {
      if (!isRetry && res.status >= 500) enqueueJob(inboxId, "ga4", url, payload, "");
      log("error", inboxId, `GA4 ERROR | Conv ${conversationId} | Status ${res.status}`);
    } else {
      log("success", inboxId, `GA4 OK | Conv ${conversationId} | ${ga4EventName}${isRetry ? " (Retry)" : ""}`);
    }
  } catch (e) {
    log("error", inboxId, `GA4 FETCH ERROR | Conv ${conversationId}: ${e.message}`);
    if (!isRetry) enqueueJob(inboxId, "ga4", url, payload, "");
  }
}

// ─── Queue Processor ──────────────────────────────────────────────────────────
async function processQueue() {
  const queue = loadJSON(QUEUE_FILE, []);
  if (queue.length === 0) return;
  
  const now = Date.now();
  const toProcess = queue.filter(j => j.nextRunAt <= now && j.attempts < 5);
  const remaining = queue.filter(j => j.nextRunAt > now || j.attempts >= 5);
  
  if (toProcess.length > 0) log("info", "system", `Processando ${toProcess.length} eventos encalhados na fila...`);
  
  for (const job of toProcess) {
    job.attempts++;
    let success = false;
    try {
      const headers = { "Content-Type": "application/json" };
      if (job.accessToken && job.platform === "tiktok") headers["Access-Token"] = job.accessToken;
      
      const res = await fetch(job.endpoint, { method: "POST", headers, body: JSON.stringify(job.payload) });
      if (res.ok) success = true;
    } catch(e) {}

    if (success) {
      log("success", job.inboxId, `Re-tentativa OK para plataforma ${job.platform.toUpperCase()}`);
    } else {
      job.nextRunAt = Date.now() + (Math.pow(2, job.attempts) * 60000); // Backoff: 2m, 4m, 8m...
      remaining.push(job);
    }
  }
  saveJSON(QUEUE_FILE, remaining);
}
setInterval(processQueue, 60000); // Roda a cada 1 minuto

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

  // ── conversation_created → Etapa Inicial ─────────────────────────────────────
  if (eventType === "conversation_created") {
    const stages = Object.entries(client.stageMap || {});
    if (stages.length === 0) {
      log("info", inboxId, "conversation_created recebido mas nenhuma etapa configurada — ignorado");
      return;
    }
    const [initialStageName, metaEventName] = stages[0];

    // Ignora conversas criadas ativamente pelo agente (Outbound)
    const isOutbound = payload?.messages?.some(m => [1, 2].includes(m.message_type)) && !payload?.messages?.some(m => m.message_type === 0);
    if (isOutbound) {
      log("info", inboxId, "Conversa iniciada pelo atendente (Outbound) — Evento inicial ignorado");
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

    const eventId = `metasync_${convId}_initial`;
    log("info", inboxId, `${metaEventName} | Conv ${convId} | ${contact.name || "desconhecido"}`);
    const eventData = buildEvent(metaEventName, { eventId, conversationId: convId, contact, dealValue: 0, stageName: initialStageName });
    
    // Dispara para todas as plataformas configuradas em paralelo
    await Promise.allSettled([
      sendToMeta(client.pixelId, client.accessToken, eventData, convId, inboxId),
      sendToTikTok(client.tiktokPixelId, client.tiktokAccessToken, eventData, convId, inboxId),
      sendToGA4(client.ga4MeasurementId, client.ga4ApiSecret, eventData, convId, inboxId)
    ]);

    // Atualizar custom attribute do contato com o link da agenda
    if (client.chatwootAccessToken && payload?.account?.id && sender?.id) {
      const chatwootUrl = "https://chatwoot.agenciaabrahao.io";
      const agendaUrl = `https://metasync.agenciaabrahao.io/calendar-widget.html?token=metasync_admin_secret_token&inboxId=${inboxId}`;
      
      fetch(`${chatwootUrl}/api/v1/accounts/${payload.account.id}/contacts/${sender.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "api_access_token": client.chatwootAccessToken
        },
        body: JSON.stringify({
          custom_attributes: {
            ...(sender.custom_attributes || {}),
            link_da_agenda: agendaUrl
          }
        })
      }).then(r => r.json()).then(res => {
        if (res.id) log("info", inboxId, `Agenda auto-preenchida para contato ${sender.id}`);
      }).catch(err => {
        log("error", inboxId, `Erro ao auto-preencher agenda: ${err.message}`);
      });
    }
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

    // Prevenção contra disparo duplo (conversation_created já mandou o evento da etapa inicial)
    const initialStageName = Object.keys(client.stageMap || {})[0];
    if (!from && stageName === initialStageName) {
      log("info", inboxId, `Ignorado: Tarefa recém-criada na etapa "${stageName}". O evento já foi enviado na abertura da conversa.`);
      return;
    }

    const valueStr = metaEvent === "Purchase" && dealValue ? ` | R$ ${dealValue}` : "";
    log("info", inboxId, `${from} → ${stageName} → ${metaEvent} | ${contact.name || "desconhecido"}${valueStr}`, { taskId, convId });

    // Usa taskId e nome da etapa no eventId para garantir idempotência caso venham duplicados
    const eventId = `metasync_task_${taskId}_stage_${sha256(stageName).slice(0, 8)}`;
    const eventData = buildEvent(metaEvent, { eventId, conversationId: convId, contact, dealValue, stageName });
    
    // Dispara para todas as plataformas configuradas em paralelo
    await Promise.allSettled([
      sendToMeta(client.pixelId, client.accessToken, eventData, convId, inboxId),
      sendToTikTok(client.tiktokPixelId, client.tiktokAccessToken, eventData, convId, inboxId),
      sendToGA4(client.ga4MeasurementId, client.ga4ApiSecret, eventData, convId, inboxId)
    ]);
    return;
  }

  log("info", inboxId, `Evento "${eventType}" ignorado`);
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));
app.use(express.static("public"));

app.get("/calendar-widget", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "calendar-widget.html"));
});

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

// ── Analytics ─────────────────────────────────────────────────────────────────
app.get("/api/analytics/:inboxId", authMiddleware, (req, res) => {
  const analytics = loadJSON(ANALYTICS_FILE, {});
  res.json(analytics[req.params.inboxId] || {});
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

// ── Histórico de Logs ─────────────────────────────────────────────────────────
app.get("/api/logs/history", authMiddleware, (req, res) => {
  let { start, end, date } = req.query; // start e end no formato YYYY-MM-DD
  if (date) { start = date; end = date; } // retrocompatibilidade temporária
  
  if (!start || !end) return res.status(400).json({ error: "start and end dates are required" });
  
  let logs = [];
  try {
    if (!fs.existsSync(LOGS_DIR)) return res.json([]);
    const files = fs.readdirSync(LOGS_DIR);
    
    const validFiles = files
      .filter(f => f.endsWith(".jsonl"))
      .filter(f => {
        const fileDate = f.replace(".jsonl", "");
        return fileDate >= start && fileDate <= end;
      })
      .sort(); // Em ordem cronológica
      
    for (const file of validFiles) {
      const content = fs.readFileSync(path.join(LOGS_DIR, file), "utf-8");
      const lines = content.split("\n").filter(Boolean);
      logs = logs.concat(lines.map(l => JSON.parse(l)));
    }
    
    res.json(logs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "erro ao ler os logs" });
  }
});

// ── CRUD Clients ──────────────────────────────────────────────────────────────
app.get("/api/clients", authMiddleware, (req, res) => {
  const clients = loadClients();
  const agentEmail = req.query.agentEmail ? req.query.agentEmail.toLowerCase().trim() : null;
  
  // Mascara o access token
  let safe = Object.fromEntries(
    Object.entries(clients).map(([id, c]) => [id, {
      ...c,
      accessToken: c.accessToken ? `${c.accessToken.slice(0, 8)}...` : "",
    }])
  );

  // Filtra por agentEmail se fornecido
  if (agentEmail) {
    const filtered = {};
    for (const id in safe) {
      const c = safe[id];
      const allowedStr = c.allowedEmails || "";
      const allowedList = allowedStr.split(",").map(e => e.trim().toLowerCase()).filter(e => e);
      if (allowedList.length === 0 || allowedList.includes(agentEmail)) {
        filtered[id] = c;
      }
    }
    safe = filtered;
  }

  res.json(safe);
});

app.get("/api/clients/full/:inboxId", authMiddleware, (req, res) => {
  const clients = loadClients();
  const client  = clients[req.params.inboxId];
  if (!client) return res.status(404).json({ error: "não encontrado" });
  res.json(client); // token completo
});

app.post("/api/clients", authMiddleware, (req, res) => {
  const { inboxId, name, pixelId, accessToken, webhookSecret, stageMap, tiktokPixelId, tiktokAccessToken, ga4MeasurementId, ga4ApiSecret, googleCalendarId, allowedEmails, chatwootAccessToken } = req.body;
  if (!inboxId || !pixelId || !accessToken) {
    return res.status(400).json({ error: "inboxId, pixelId e accessToken são obrigatórios" });
  }
  const clients = loadClients();
  clients[String(inboxId)] = { 
    name: name || `Cliente ${inboxId}`, 
    pixelId, accessToken, webhookSecret: webhookSecret || "", stageMap: stageMap || {},
    tiktokPixelId: tiktokPixelId || "",
    tiktokAccessToken: tiktokAccessToken || "",
    ga4MeasurementId: ga4MeasurementId || "",
    ga4ApiSecret: ga4ApiSecret || "",
    googleCalendarId: googleCalendarId || "",
    allowedEmails: allowedEmails || "",
    chatwootAccessToken: chatwootAccessToken || ""
  };
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

  // Limpa Analytics e Fila
  const analyticsData = loadJSON(ANALYTICS_FILE, {});
  if (analyticsData[inboxId]) {
    delete analyticsData[inboxId];
    saveJSON(ANALYTICS_FILE, analyticsData);
  }
  let queue = loadJSON(QUEUE_FILE, []);
  if (queue.some(j => j.inboxId === inboxId)) {
    queue = queue.filter(j => j.inboxId !== inboxId);
    saveJSON(QUEUE_FILE, queue);
  }

  log("info", inboxId, `Cliente "${name}" e todos os seus dados locais foram removidos`);
  res.json({ ok: true });
});

// ─── Google Calendar Endpoints ──────────────────────────────────────────────────
app.get("/api/calendar/:inboxId/events", authMiddleware, async (req, res) => {
  try {
    const clients = loadClients();
    const client = clients[req.params.inboxId];
    if (!client || !client.googleCalendarId) return res.status(400).json({ error: "Cliente não possui Calendar ID configurado." });

    const auth = getCalendarAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const { data } = await calendar.events.list({
      calendarId: client.googleCalendarId,
      timeMin: req.query.from ? new Date(req.query.from).toISOString() : new Date().toISOString(),
      timeMax: req.query.to ? new Date(req.query.to).toISOString() : undefined,
      maxResults: 50,
      singleEvents: true,
      orderBy: "startTime",
    });

    res.json(data.items || []);
  } catch (error) {
    console.error("Erro no Calendar GET:", error.message);
    res.status(500).json({ error: "Erro ao buscar eventos do Google Calendar." });
  }
});

app.post("/api/calendar/:inboxId/events", authMiddleware, async (req, res) => {
  try {
    const clients = loadClients();
    const client = clients[req.params.inboxId];
    if (!client || !client.googleCalendarId) return res.status(400).json({ error: "Cliente não configurado." });

    const { summary, description, start, end, location } = req.body;
    const auth = getCalendarAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const { data } = await calendar.events.insert({
      calendarId: client.googleCalendarId,
      resource: {
        summary,
        description,
        location,
        start: { dateTime: start, timeZone: "America/Sao_Paulo" },
        end: { dateTime: end, timeZone: "America/Sao_Paulo" },
      },
    });

    res.json(data);
  } catch (error) {
    console.error("Erro no Calendar POST:", error.message);
    res.status(500).json({ error: "Erro ao criar evento." });
  }
});

app.patch("/api/calendar/:inboxId/events/:eventId", authMiddleware, async (req, res) => {
  try {
    const clients = loadClients();
    const client = clients[req.params.inboxId];
    if (!client || !client.googleCalendarId) return res.status(400).json({ error: "Cliente não configurado." });

    const { summary, description, start, end, location } = req.body;
    const auth = getCalendarAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const { data } = await calendar.events.patch({
      calendarId: client.googleCalendarId,
      eventId: req.params.eventId,
      resource: {
        summary,
        description,
        location,
        start: start ? { dateTime: start, timeZone: "America/Sao_Paulo" } : undefined,
        end: end ? { dateTime: end, timeZone: "America/Sao_Paulo" } : undefined,
      },
    });

    res.json(data);
  } catch (error) {
    console.error("Erro no Calendar PATCH:", error.message);
    res.status(500).json({ error: "Erro ao editar evento." });
  }
});

app.delete("/api/calendar/:inboxId/events/:eventId", authMiddleware, async (req, res) => {
  try {
    const clients = loadClients();
    const client = clients[req.params.inboxId];
    if (!client || !client.googleCalendarId) return res.status(400).json({ error: "Cliente não configurado." });

    const auth = getCalendarAuth();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({
      calendarId: client.googleCalendarId,
      eventId: req.params.eventId,
    });

    res.json({ ok: true });
  } catch (error) {
    console.error("Erro no Calendar DELETE:", error.message);
    res.status(500).json({ error: "Erro ao excluir evento." });
  }
});

// ── Webhook endpoint ──────────────────────────────────────────────────────────
app.post("/webhook/:inboxId", async (req, res) => {
  const { inboxId } = req.params;
  const clients = loadClients();
  const client  = clients[inboxId];

  if (!client) {
    log("warn", inboxId, `Webhook recebido para inbox ${inboxId} não cadastrado`);
    return res.status(200).json({ status: "ignored", reason: "not registered" });
  }

  // Verifica se o evento pertence a este inboxId
  const actualInboxId = req.body.inbox_id || 
                        req.body.conversation?.inbox_id || 
                        req.body.inbox?.id || 
                        req.body.conversations?.[0]?.inbox_id;
                        
  if (actualInboxId && String(actualInboxId) !== String(inboxId)) {
    return res.status(200).json({ status: "ignored", reason: "belongs to another inbox" });
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
  
  return res.status(200).json({ status: "ok" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("─".repeat(50));
  console.log("  🔷  MetaSync — Agência Abrahão");
  console.log(`  🚀  Dashboard: http://localhost:${PORT}`);
  console.log(`  📡  Webhook:   http://localhost:${PORT}/webhook/:inboxId`);
  console.log("─".repeat(50));
});
