/* ─── State ──────────────────────────────────────────────────────────────────── */
let clients    = {};
let activeInboxId = null;
let logCount   = 0;
let logPanel   = false;
let authToken  = localStorage.getItem("metasync_token") || "";
let isViewingHistory = false;

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

function toggleLoginPass() {
  const el = document.getElementById("login-pass");
  el.type = el.type === "password" ? "text" : "password";
}

async function handleLogin(e) {
  e.preventDefault();
  const user = document.getElementById("login-user").value.trim();
  const pass = document.getElementById("login-pass").value.trim();
  const btn = document.getElementById("btn-login");
  const errMsg = document.getElementById("login-error-msg");
  
  btn.textContent = "Aguarde...";
  errMsg.style.display = "none";
  
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
      errMsg.textContent = "Usuário ou senha incorretos";
      errMsg.style.display = "block";
      toast("Usuário ou senha incorretos", "err");
    }
  } catch (err) {
    errMsg.textContent = "Erro ao conectar no servidor";
    errMsg.style.display = "block";
    toast("Erro ao conectar no servidor", "err");
  }
  btn.textContent = "Entrar";
}

const META_EVENTS = [
  "Lead", "Schedule", "ViewContent", "Purchase", 
  "InitiateCheckout", "AddPaymentInfo", "CompleteRegistration", 
  "Contact", "SubmitApplication", "Subscribe", "Search"
];

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

  const select = document.getElementById("analytics-client-select");
  if (select) {
    if (keys.length === 0) {
      select.innerHTML = `<option value="">Nenhum cliente cadastrado</option>`;
    } else {
      select.innerHTML = keys.map(id => `<option value="${id}">${clients[id].name || `Inbox ${id}`}</option>`).join("");
      if (activeInboxId) select.value = activeInboxId;
    }
    
    const logSelect = document.getElementById("logs-client-select");
    if (logSelect) {
      const prevVal = logSelect.value;
      logSelect.innerHTML = `<option value="">Todos os clientes</option>` + keys.map(id => `<option value="${id}">${clients[id].name || `Inbox ${id}`}</option>`).join("");
      logSelect.value = prevVal;
    }
  }
}

function changeAnalyticsClient() {
  const val = document.getElementById("analytics-client-select").value;
  if (val) {
    activeInboxId = val;
    renderClientList(); // Atualiza a cor no sidebar esquerdo
    loadAnalytics();
  }
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
      loadAnalytics(); // Carrega gráfico
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
  
  document.getElementById("f-tiktok-pixel").value = data.tiktokPixelId || "";
  document.getElementById("f-tiktok-token").value = data.tiktokAccessToken || "";
  document.getElementById("f-ga4-id").value = data.ga4MeasurementId || "";
  document.getElementById("f-ga4-secret").value = data.ga4ApiSecret || "";
  document.getElementById("f-google-calendar-id").value = data.googleCalendarId || "";

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
  
  document.getElementById("f-tiktok-pixel").value = "";
  document.getElementById("f-tiktok-token").value = "";
  document.getElementById("f-ga4-id").value = "";
  document.getElementById("f-ga4-secret").value = "";
  document.getElementById("f-google-calendar-id").value = "";

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
  
  const tiktokPixelId     = document.getElementById("f-tiktok-pixel").value.trim();
  const tiktokAccessToken = document.getElementById("f-tiktok-token").value.trim();
  const ga4MeasurementId  = document.getElementById("f-ga4-id").value.trim();
  const ga4ApiSecret      = document.getElementById("f-ga4-secret").value.trim();
  const googleCalendarId  = document.getElementById("f-google-calendar-id").value.trim();

  if (!inboxId || !pixelId || !token) {
    toast("Preencha Inbox ID, Pixel ID e Access Token", "err"); return;
  }

  const stageMap = collectStageMap();

  try {
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ 
        inboxId, name, pixelId, accessToken: token, webhookSecret: secret, baseUrl, stageMap,
        tiktokPixelId, tiktokAccessToken, ga4MeasurementId, ga4ApiSecret, googleCalendarId
      }),
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

function filterLogs() {
  const selectedInboxId = document.getElementById("logs-client-select")?.value;
  const container = document.getElementById("log-container");
  const entries = container.querySelectorAll(".log-entry");
  
  entries.forEach(entry => {
    if (!selectedInboxId) {
      entry.style.display = "flex";
    } else {
      if (entry.dataset.inboxId === selectedInboxId || entry.dataset.inboxId === "system") {
        entry.style.display = "flex";
      } else {
        entry.style.display = "none";
      }
    }
  });
}

function clearLogs() {
  document.getElementById("log-container").innerHTML = `<div class="log-empty">Mostrando apenas logs daqui em diante...</div>`;
  logCount = 0;
  document.getElementById("log-badge").style.display = "none";
}

async function loadHistoricalLogs() {
  const preset = document.getElementById("logs-preset").value;
  const customDiv = document.getElementById("logs-custom-date");
  const container = document.getElementById("log-container");

  if (preset === "custom") {
    customDiv.style.display = "flex";
  } else {
    customDiv.style.display = "none";
  }

  if (preset === "realtime") {
    isViewingHistory = false;
    clearLogs();
    container.innerHTML = `<div class="log-empty">Mostrando apenas logs em tempo real daqui em diante...</div>`;
    return;
  }

  let startDate, endDate;
  const today = new Date();
  const formatObj = (d) => {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  };

  if (preset === "custom") {
    startDate = document.getElementById("logs-date-start").value;
    endDate = document.getElementById("logs-date-end").value;
    if (!startDate || !endDate) return;
  } else {
    endDate = formatObj(today);
    if (preset === "today") {
      startDate = endDate;
    } else if (preset === "yesterday") {
      const start = new Date(today); start.setDate(start.getDate() - 1);
      startDate = formatObj(start);
      endDate = startDate;
    } else if (preset === "7") {
      const start = new Date(today); start.setDate(start.getDate() - 6);
      startDate = formatObj(start);
    } else if (preset === "15") {
      const start = new Date(today); start.setDate(start.getDate() - 14);
      startDate = formatObj(start);
    } else if (preset === "30") {
      const start = new Date(today); start.setDate(start.getDate() - 29);
      startDate = formatObj(start);
    } else if (preset === "all") {
      startDate = "2020-01-01"; // Fetch all
    }
  }

  isViewingHistory = true;
  container.innerHTML = `<div class="log-empty">Carregando histórico do período...</div>`;
  
  try {
    const res = await fetch(`/api/logs/history?start=${startDate}&end=${endDate}`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error("Erro");
    const logs = await res.json();
    
    container.innerHTML = "";
    if (logs.length === 0) {
      container.innerHTML = `<div class="log-empty">Nenhum log encontrado para este período</div>`;
      return;
    }
    
    logs.forEach(l => appendLog(l, true));
    filterLogs(); // Aplica o filtro de cliente que já estiver selecionado
  } catch (e) {
    container.innerHTML = `<div class="log-empty" style="color:var(--red)">Erro ao carregar histórico</div>`;
  }
}

function appendLog(data, isHistorical = false) {
  if (isViewingHistory && !isHistorical) return; // Se está vendo o histórico, ignora novos logs em tempo real

  const container = document.getElementById("log-container");
  const empty = container.querySelector(".log-empty");
  if (empty) empty.remove();

  const ts   = new Date(data.ts).toLocaleTimeString("pt-BR");
  const date = new Date(data.ts).toLocaleDateString("pt-BR");
  const entry = document.createElement("div");
  entry.className = `log-entry ${data.level}`;
  entry.dataset.inboxId = data.inboxId || "system";
  
  let clientName = data.inboxId;
  if (data.inboxId && typeof clients !== "undefined" && clients[data.inboxId]) {
    clientName = clients[data.inboxId].name;
  }

  entry.innerHTML = `
    <span class="log-ts">${date} ${ts}</span>
    <span class="log-level">${data.level}</span>
    <span class="log-inbox">${clientName}</span>
    <span class="log-msg">${data.message}${data.events_received !== undefined ? ` — <b>events_received: ${data.events_received}</b>` : ""}${data.value ? ` | R$ ${data.value}` : ""}</span>
  `;
  
  // Hide if it doesn't match current filter
  const selectedInboxId = document.getElementById("logs-client-select")?.value;
  if (selectedInboxId && selectedInboxId !== entry.dataset.inboxId && entry.dataset.inboxId !== "system") {
    entry.style.display = "none";
  }
  
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

/* ─── Analytics Dashboard ────────────────────────────────────────────────────── */
let myChart = null;

function applyPresetFilter() {
  const preset = document.getElementById("filter-preset").value;
  const customDiv = document.getElementById("filter-custom-dates");
  if (preset === "custom") {
    customDiv.style.display = "flex";
  } else {
    customDiv.style.display = "none";
    loadAnalytics();
  }
}

async function loadAnalytics() {
  if (!activeInboxId) {
    document.getElementById("stat-total").textContent = "0";
    document.getElementById("stat-success-rate").textContent = "0%";
    document.getElementById("stat-revenue").textContent = "R$ 0,00";
    if (myChart) myChart.destroy();
    return;
  }
  
  try {
    const res = await fetch(`/api/analytics/${activeInboxId}`, { headers: getAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    
    const labels = [];
    const successes = [];
    const fails = [];
    const dailyEvents = [];
    let totalSucc = 0;
    let totalFail = 0;
    let totalRev = 0;
    let eventsBreakdown = {};
    
    const preset = document.getElementById("filter-preset").value;
    const subtitle = document.getElementById("analytics-subtitle");
    let daysToLoad = [];
    
    if (preset === "all") {
       daysToLoad = Object.keys(data).sort();
       subtitle.textContent = "Performance de todo o período trackeado";
    } else if (preset === "custom") {
       const start = document.getElementById("filter-start").value;
       const end = document.getElementById("filter-end").value;
       if (start && end) {
          const keys = Object.keys(data).filter(k => k >= start && k <= end).sort();
          if (keys.length > 0) {
            daysToLoad = keys;
          } else {
            let curr = new Date(start + "T00:00:00Z");
            const last = new Date(end + "T00:00:00Z");
            while (curr <= last) {
               daysToLoad.push(curr.toISOString().split("T")[0]);
               curr.setDate(curr.getDate() + 1);
            }
          }
          subtitle.textContent = `Performance de ${start.split("-").reverse().join("/")} até ${end.split("-").reverse().join("/")}`;
       } else {
          toast("Selecione as datas de início e fim", "warn");
          return;
       }
    } else if (preset === "yesterday") {
       const d = new Date();
       d.setDate(d.getDate() - 1);
       const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
       daysToLoad.push(dateStr);
       subtitle.textContent = "Performance de ontem";
    } else {
       const numDays = parseInt(preset);
       for (let i = numDays - 1; i >= 0; i--) {
         const d = new Date();
         d.setDate(d.getDate() - i);
         const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
         daysToLoad.push(dateStr);
       }
       if (preset === "1") {
         subtitle.textContent = "Performance de hoje";
       } else {
         subtitle.textContent = `Performance dos últimos ${preset} dias trackeados`;
       }
    }
    
    daysToLoad.forEach(ds => {
      const dayData = data[ds] || { success: 0, fail: 0, value: 0 };
      labels.push(ds.split("-").slice(1).join("/")); 
      successes.push(dayData.success);
      fails.push(dayData.fail);
      totalSucc += dayData.success;
      totalFail += dayData.fail;
      totalRev += dayData.value || 0;
      dailyEvents.push(dayData.events || {});
      
      if (dayData.events) {
        Object.keys(dayData.events).forEach(ev => {
          eventsBreakdown[ev] = (eventsBreakdown[ev] || 0) + dayData.events[ev];
        });
      }
    });
    
    const total = totalSucc + totalFail;
    const rate = total === 0 ? 0 : Math.round((totalSucc / total) * 100);
    
    document.getElementById("stat-total").textContent = totalSucc;
    document.getElementById("stat-success-rate").textContent = `${rate}%`;
    document.getElementById("stat-revenue").textContent = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalRev);
    
    const breakdownEl = document.getElementById("stat-events-breakdown");
    if (Object.keys(eventsBreakdown).length === 0) {
      breakdownEl.innerHTML = '<span style="color:var(--text-muted)">Nenhum</span>';
    } else {
      breakdownEl.innerHTML = Object.entries(eventsBreakdown).map(([name, count], idx) => {
        const colors = [
          { color: "#60a5fa", bg: "rgba(31,120,255,.15)", border: "rgba(31,120,255,.3)" },
          { color: "#4ade80", bg: "rgba(63,185,80,.15)", border: "rgba(63,185,80,.3)" },
          { color: "#c084fc", bg: "rgba(139,92,246,.15)", border: "rgba(139,92,246,.3)" },
          { color: "#fb923c", bg: "rgba(240,136,62,.15)", border: "rgba(240,136,62,.3)" },
          { color: "#f87171", bg: "rgba(239,68,68,.15)",  border: "rgba(239,68,68,.3)" },
          { color: "#fbbf24", bg: "rgba(245,158,11,.15)", border: "rgba(245,158,11,.3)" }
        ];
        const theme = colors[idx % colors.length];
        return `<span style="background:${theme.bg}; color:${theme.color}; border: 1px solid ${theme.border}; padding:2px 8px; border-radius:12px; font-size:12px; font-weight:600; text-transform:capitalize;">${name}: ${count}</span>`;
      }).join("");
    }
    
    renderChart(labels, successes, fails, dailyEvents);
  } catch (e) {
    console.error("Erro estatisticas", e);
  }
}

function renderChart(labels, successes, fails, dailyEvents = []) {
  const ctx = document.getElementById('eventsChart').getContext('2d');
  if (myChart) myChart.destroy();
  
  myChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Enviados c/ Sucesso', data: successes, backgroundColor: '#3b82f6', borderRadius: 4 },
        { label: 'Falhas (Fila)', data: fails, backgroundColor: '#ef4444', borderRadius: 4 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, stacked: true }, x: { stacked: true } },
      plugins: { 
        legend: { labels: { color: '#94a3b8' } },
        tooltip: {
          callbacks: {
            afterBody: function(context) {
              const dataIndex = context[0].dataIndex;
              const events = dailyEvents[dataIndex];
              if (!events || Object.keys(events).length === 0) return null;
              
              let lines = ['', 'Eventos daquele dia:'];
              for (const [name, count] of Object.entries(events)) {
                lines.push(`  • ${name}: ${count}`);
              }
              return lines;
            }
          }
        }
      }
    }
  });
}

/* ─── Google Calendar ───────────────────────────────────────────────────────── */
async function loadCalendarEvents() {
  if (!activeInboxId) return;
  const container = document.getElementById("calendar-container");
  container.innerHTML = '<div class="log-empty">Carregando eventos...</div>';

  try {
    const res = await fetch(`/api/calendar/${activeInboxId}/events`, { headers: getAuthHeaders() });
    if (!res.ok) {
      if (res.status === 400) {
        container.innerHTML = '<div class="log-empty">Este cliente não possui um Google Calendar ID configurado.</div>';
      } else {
        container.innerHTML = '<div class="log-empty">Erro ao carregar eventos da agenda.</div>';
      }
      return;
    }
    const events = await res.json();
    if (!events || events.length === 0) {
      container.innerHTML = '<div class="log-empty">Nenhum evento futuro encontrado.</div>';
      return;
    }

    container.innerHTML = "";
    events.forEach(ev => {
      const start = ev.start.dateTime || ev.start.date;
      const end = ev.end.dateTime || ev.end.date;
      
      const item = document.createElement("div");
      item.className = "stat-card"; // Reusing styles for now, or making a specific class
      item.style.cursor = "pointer";
      item.style.marginBottom = "10px";
      item.style.display = "flex";
      item.style.justifyContent = "space-between";
      item.style.alignItems = "center";
      item.onclick = () => openCalendarEventModal(ev);

      item.innerHTML = `
        <div>
          <div style="font-weight: 600; font-size: 14px; color: var(--text-color);">${ev.summary || "Sem título"}</div>
          <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${new Date(start).toLocaleString()} - ${new Date(end).toLocaleString()}</div>
          ${ev.location ? `<div style="font-size: 11px; color: var(--blue); margin-top: 4px;">📍 ${ev.location}</div>` : ''}
        </div>
        <div style="color: var(--text-muted);">
          <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
        </div>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    console.error("Calendar Load error", err);
    container.innerHTML = '<div class="log-empty">Erro ao carregar agenda.</div>';
  }
}

function openCalendarEventModal(ev = null) {
  document.getElementById("calendar-modal").classList.add("show");
  if (ev) {
    document.getElementById("calendar-modal-title").textContent = "Editar Evento";
    document.getElementById("f-cal-event-id").value = ev.id;
    document.getElementById("f-cal-title").value = ev.summary || "";
    document.getElementById("f-cal-desc").value = ev.description || "";
    document.getElementById("f-cal-location").value = ev.location || "";
    
    if (ev.start.dateTime) {
      document.getElementById("f-cal-start").value = ev.start.dateTime.slice(0, 16);
    }
    if (ev.end.dateTime) {
      document.getElementById("f-cal-end").value = ev.end.dateTime.slice(0, 16);
    }
    document.getElementById("btn-delete-cal").style.display = "block";
  } else {
    document.getElementById("calendar-modal-title").textContent = "Novo Evento";
    document.getElementById("f-cal-event-id").value = "";
    document.getElementById("f-cal-title").value = "";
    document.getElementById("f-cal-desc").value = "";
    document.getElementById("f-cal-location").value = "";
    document.getElementById("f-cal-start").value = "";
    document.getElementById("f-cal-end").value = "";
    document.getElementById("btn-delete-cal").style.display = "none";
  }
}

function closeCalendarEventModal() {
  document.getElementById("calendar-modal").classList.remove("show");
}

async function saveCalendarEvent() {
  if (!activeInboxId) return;
  const id = document.getElementById("f-cal-event-id").value;
  const summary = document.getElementById("f-cal-title").value.trim();
  const start = document.getElementById("f-cal-start").value;
  const end = document.getElementById("f-cal-end").value;
  const location = document.getElementById("f-cal-location").value.trim();
  const description = document.getElementById("f-cal-desc").value.trim();

  if (!summary || !start || !end) {
    toast("Preencha o título e os horários", "err");
    return;
  }

  const payload = { summary, description, location, start: new Date(start).toISOString(), end: new Date(end).toISOString() };

  try {
    const res = await fetch(\`/api/calendar/\${activeInboxId}/events\${id ? \`/\${id}\` : ''}\`, {
      method: id ? "PATCH" : "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error();
    toast(id ? "Evento atualizado!" : "Evento criado!", "success");
    closeCalendarEventModal();
    loadCalendarEvents();
  } catch {
    toast("Erro ao salvar evento", "err");
  }
}

async function deleteCalendarEvent() {
  if (!activeInboxId) return;
  const id = document.getElementById("f-cal-event-id").value;
  if (!id) return;
  if (!confirm("Tem certeza que deseja excluir este evento?")) return;

  try {
    const res = await fetch(\`/api/calendar/\${activeInboxId}/events/\${id}\`, {
      method: "DELETE",
      headers: getAuthHeaders()
    });
    if (!res.ok) throw new Error();
    toast("Evento excluído!", "success");
    closeCalendarEventModal();
    loadCalendarEvents();
  } catch {
    toast("Erro ao excluir", "err");
  }
}
