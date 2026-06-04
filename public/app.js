/* ─── State ──────────────────────────────────────────────────────────────────── */
let clients    = {};
let activeInboxId = null;
let logCount   = 0;
let logPanel   = false;
let authToken  = localStorage.getItem("metasync_token") || "";

function getAuthHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`
  };
}

function showLogin() {
  localStorage.removeItem("metasync_token");
  authToken = "";
  document.getElementById("login-overlay").classList.add("show");
}

async function handleLogin(e) {
  e.preventDefault();
  const user = document.getElementById("login-user").value.trim();
  const pass = document.getElementById("login-pass").value.trim();
  const btn = document.getElementById("btn-login");
  btn.textContent = "Aguarde...";
  
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass })
    });
    if (res.ok) {
      const data = await res.json();
      authToken = data.token;
      localStorage.setItem("metasync_token", authToken);
      document.getElementById("login-overlay").classList.remove("show");
      loadClients();
      connectSSE();
    } else {
      toast("Usuário ou senha incorretos", "err");
    }
  } catch (err) {
    toast("Erro ao conectar no servidor", "err");
  }
  btn.textContent = "Entrar";
}

const META_EVENTS = ["Lead", "Schedule", "ViewContent", "Purchase"];

/* ─── Init ───────────────────────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  if (!authToken) {
    showLogin();
  } else {
    document.getElementById("login-overlay").classList.remove("show");
    loadClients();
    connectSSE();
  }
});

/* ─── Panel nav ──────────────────────────────────────────────────────────────── */
function showPanel(name) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById(`panel-${name}`).classList.add("active");
  document.getElementById(`nav-${name}`).classList.add("active");
  logPanel = name === "logs";
  if (logPanel) {
    logCount = 0;
    const badge = document.getElementById("log-badge");
    badge.style.display = "none";
    badge.textContent = "0";
  }
}

/* ─── Load clients ───────────────────────────────────────────────────────────── */
async function loadClients() {
  if (!authToken) return;
  try {
    const res = await fetch("/api/clients", { headers: getAuthHeaders() });
    if (res.status === 401) return showLogin();
    clients = await res.json();
    renderClientList();
  } catch (e) {
    toast("Erro ao carregar clientes", "err");
  }
}

function renderClientList() {
  const el = document.getElementById("client-list");
  const keys = Object.keys(clients);
  if (keys.length === 0) {
    el.innerHTML = '<div class="client-list-empty">Nenhum cliente ainda</div>';
    return;
  }
  el.innerHTML = keys.map(id => `
    <button class="client-item ${id === activeInboxId ? "active" : ""}" onclick="selectClient('${id}')">
      <span class="dot"></span>
      ${clients[id].name || `Inbox ${id}`}
    </button>
  `).join("");
}

/* ─── Select client ──────────────────────────────────────────────────────────── */
async function selectClient(inboxId) {
  activeInboxId = inboxId;
  showPanel("clients");
  renderClientList();

  // Re-fetch to get full token
  try {
    const res = await fetch(`/api/clients/full/${inboxId}`, { headers: getAuthHeaders() });
    if (res.status === 401) return showLogin();
    if (res.ok) {
      const data = await res.json();
      fillForm(inboxId, data);
    } else {
      // Use masked version
      fillForm(inboxId, clients[inboxId]);
    }
  } catch {
    fillForm(inboxId, clients[inboxId]);
  }
}

function fillForm(inboxId, data) {
  document.getElementById("f-name").value   = data.name || "";
  document.getElementById("f-inbox").value  = inboxId;
  document.getElementById("f-pixel").value  = data.pixelId || "";
  document.getElementById("f-token").value  = data.accessToken || "";
  document.getElementById("f-secret").value = data.webhookSecret || "";
  document.getElementById("f-baseurl").value = data.baseUrl || "";

  document.getElementById("form-client-title").textContent = data.name || `Inbox ${inboxId}`;
  document.getElementById("badge-connected").style.display = "inline-flex";
  document.getElementById("btn-delete").style.display = "flex";

  updateWebhookUrl(inboxId);
  renderStageMap(data.stageMap || {});
}

/* ─── New client ─────────────────────────────────────────────────────────────── */
function newClient() {
  activeInboxId = null;
  showPanel("clients");
  document.getElementById("f-name").value   = "";
  document.getElementById("f-inbox").value  = "";
  document.getElementById("f-pixel").value  = "";
  document.getElementById("f-token").value  = "";
  document.getElementById("f-secret").value = "";
  document.getElementById("form-client-title").textContent = "Novo Cliente";
  document.getElementById("badge-connected").style.display = "none";
  document.getElementById("btn-delete").style.display = "none";
  document.getElementById("webhook-url-box").style.display = "none";
  renderClientList();
  renderStageMap({});
  openSettingsModal();
  document.getElementById("f-name").focus();
}

/* ─── Stage mapping ──────────────────────────────────────────────────────────── */
function renderStageMap(stageMap) {
  const el = document.getElementById("stage-list");
  el.innerHTML = "";
  const entries = Object.entries(stageMap);
  if (entries.length === 0) {
    addStageRow();
  } else {
    entries.forEach(([stage, event]) => addStageRow(stage, event));
  }
}

function addStageRow(stage = "", selectedEvent = "") {
  const el    = document.getElementById("stage-list");
  const row   = document.createElement("div");
  row.className = "stage-row";

  const eventsHTML = META_EVENTS.map(ev => `
    <span class="event-tag ${ev} ${ev === selectedEvent ? "selected" : ""}"
          onclick="selectEvent(this, '${ev}', event)">${ev}</span>
  `).join("");

  row.innerHTML = `
    <input type="text" placeholder="Nome da etapa no Kanban" value="${stage}" class="stage-name" />
    <div>
      <div class="meta-event-select">${eventsHTML}</div>
      <div class="purchase-value-opt ${selectedEvent === 'Purchase' ? 'show' : ''}">
        <input type="checkbox" id="chk-${Date.now()}" checked />
        <label>Usar valor do card</label>
      </div>
    </div>
    <button class="btn-remove-stage" onclick="this.closest('.stage-row').remove()" title="Remover">
      <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
    </button>
  `;

  el.appendChild(row);
}

function selectEvent(el, eventName, e) {
  e.stopPropagation();
  const row = el.closest(".stage-row");
  row.querySelectorAll(".event-tag").forEach(t => t.classList.remove("selected"));
  el.classList.add("selected");
  const opt = row.querySelector(".purchase-value-opt");
  if (opt) opt.classList.toggle("show", eventName === "Purchase");
}

/* ─── Collect stage map ──────────────────────────────────────────────────────── */
function collectStageMap() {
  const map = {};
  document.querySelectorAll(".stage-row").forEach(row => {
    const stage = row.querySelector(".stage-name")?.value?.trim();
    const event = row.querySelector(".event-tag.selected")?.textContent?.trim();
    if (stage && event) map[stage] = event;
  });
  return map;
}

/* ─── Save client ────────────────────────────────────────────────────────────── */
async function saveClient() {
  const inboxId      = document.getElementById("f-inbox").value.trim();
  const name         = document.getElementById("f-name").value.trim();
  const pixelId      = document.getElementById("f-pixel").value.trim();
  const token        = document.getElementById("f-token").value.trim();
  const secret       = document.getElementById("f-secret").value.trim();
  const baseUrl      = document.getElementById("f-baseurl").value.trim().replace(/\/$/, "");

  if (!inboxId || !pixelId || !token) {
    toast("Preencha Inbox ID, Pixel ID e Access Token", "err"); return;
  }

  const stageMap = collectStageMap();

  try {
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ inboxId, name, pixelId, accessToken: token, webhookSecret: secret, baseUrl, stageMap }),
    });
    if (res.status === 401) return showLogin();
    if (!res.ok) throw new Error();
    activeInboxId = inboxId;
    await loadClients();
    document.getElementById("form-client-title").textContent = name || `Inbox ${inboxId}`;
    document.getElementById("badge-connected").style.display = "inline-flex";
    document.getElementById("btn-delete").style.display = "flex";
    updateWebhookUrl(inboxId);
    toast("✅ Cliente salvo com sucesso!", "ok");
  } catch {
    toast("Erro ao salvar cliente", "err");
  }
}

/* ─── Delete client ──────────────────────────────────────────────────────────── */
async function deleteClient() {
  if (!activeInboxId) return;
  if (!confirm(`Remover cliente "${clients[activeInboxId]?.name}"?`)) return;
  try {
    const res = await fetch(`/api/clients/${activeInboxId}`, { method: "DELETE", headers: getAuthHeaders() });
    if (res.status === 401) return showLogin();
    activeInboxId = null;
    await loadClients();
    newClient();
    toast("Cliente removido", "ok");
  } catch {
    toast("Erro ao remover cliente", "err");
  }
}

/* ─── Webhook URL ────────────────────────────────────────────────────────────── */
function updateWebhookUrl(inboxId) {
  const box     = document.getElementById("webhook-url-box");
  const baseUrl = document.getElementById("f-baseurl").value.trim().replace(/\/$/, "") || location.origin;
  const url     = `${baseUrl}/webhook/${inboxId}`;
  document.getElementById("webhook-url-display").textContent = url;
  box.style.display = "flex";
}

function copyUrl() {
  const url = document.getElementById("webhook-url-display").textContent;
  navigator.clipboard.writeText(url).then(() => toast("URL copiada!", "ok"));
}

/* ─── Token visibility ───────────────────────────────────────────────────────── */
function toggleToken() {
  const inp = document.getElementById("f-token");
  inp.type = inp.type === "password" ? "text" : "password";
}

/* ─── SSE Logs ───────────────────────────────────────────────────────────────── */
let currentES = null;
function connectSSE() {
  if (!authToken) return;
  if (currentES) currentES.close();
  currentES = new EventSource(`/api/logs/stream?token=${authToken}`);
  currentES.onmessage = e => {
    const data = JSON.parse(e.data);
    appendLog(data);
  };
  currentES.onerror = () => {
    currentES.close();
    setTimeout(connectSSE, 3000);
  };
}

function appendLog(data) {
  const container = document.getElementById("log-container");
  const empty = container.querySelector(".log-empty");
  if (empty) empty.remove();

  const ts   = new Date(data.ts).toLocaleTimeString("pt-BR");
  const date = new Date(data.ts).toLocaleDateString("pt-BR");
  const entry = document.createElement("div");
  entry.className = `log-entry ${data.level}`;
  
  let clientName = data.inboxId;
  if (data.inboxId && window.clients && window.clients[data.inboxId]) {
    clientName = window.clients[data.inboxId].name;
  }

  entry.innerHTML = `
    <span class="log-ts">${date} ${ts}</span>
    <span class="log-level">${data.level}</span>
    <span class="log-inbox">${clientName}</span>
    <span class="log-msg">${data.message}${data.events_received !== undefined ? ` — <b>events_received: ${data.events_received}</b>` : ""}${data.value ? ` | R$ ${data.value}` : ""}</span>
  `;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;

  // Badge
  if (!logPanel) {
    logCount++;
    const badge = document.getElementById("log-badge");
    badge.style.display = "inline-flex";
    badge.textContent = logCount;
  }
}

function clearLogs() {
  document.getElementById("log-container").innerHTML = '<div class="log-empty">Aguardando eventos...</div>';
  logCount = 0;
  document.getElementById("log-badge").style.display = "none";
}

/* ─── Toast ──────────────────────────────────────────────────────────────────── */
function toast(msg, type = "ok") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove("show"), 3000);
}

/* ─── Mobile Sidebar ─────────────────────────────────────────────────────────── */
function toggleSidebar(force) {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  if (typeof force === "boolean") {
    sidebar.classList.toggle("open", force);
    overlay.classList.toggle("show", force);
  } else {
    sidebar.classList.toggle("open");
    overlay.classList.toggle("show");
  }
}

/* ─── Modal Settings ─────────────────────────────────────────────────────────── */
function openSettingsModal() {
  document.getElementById("settings-modal").classList.add("show");
}

function closeSettingsModal() {
  document.getElementById("settings-modal").classList.remove("show");
}
