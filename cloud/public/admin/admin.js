
"use strict";
const $ = (s) => document.querySelector(s);
const KEY = "biosense.admin.key";
const TECH_NAME = "biosense.admin.technician";
let apiKey = sessionStorage.getItem(KEY) || "";
let devices = [];
let isManager = false;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const fmt = (ms) => (ms ? new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

// Detalhes de evento legíveis (sem JSON cru): usa "description" quando houver, senão pares chave: valor.
function eventDetails(data) {
  if (data == null) return "—";
  if (typeof data !== "object") return String(data);
  if (data.description != null) return String(data.description);
  const parts = Object.entries(data).map(([k, v]) => `${k}: ${v && typeof v === "object" ? JSON.stringify(v) : v}`);
  return parts.length ? parts.join(" · ") : "—";
}
const EVENT_LABELS = { FELL_ASLEEP: "Adormeceu", WOKE_UP: "Acordou", DEEP_SLEEP: "Sono profundo", LIGHT_SLEEP: "Sono leve", AWAKE: "Acordado", STEP_GOAL: "Meta de passos", LOW_BATTERY: "Bateria baixa", CHARGING: "Carregando", FULLY_CHARGED: "Carga completa" };
function eventTypeLabel(t) { return EVENT_LABELS[t] || String(t).replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()); }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401) { logout("Sessão inválida. Entre novamente."); throw new Error("unauthorized"); }
  if (!res.ok) throw new Error(json?.message || json?.error || `Erro ${res.status}`);
  return json;
}

function flash(text, kind = "ok") {
  const box = $("#flash");
  box.replaceChildren(el("div", { class: `notice ${kind}`, role: kind === "error" ? "alert" : "status" }, text));
  if (kind === "ok") setTimeout(() => { if (box.firstChild?.textContent === text) box.replaceChildren(); }, 5000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (e.message !== "unauthorized") flash(e.message, "error"); } };

// ------------------------------------------------------------------ sessão
function logout(msg) {
  const oldToken = apiKey;
  if (oldToken.startsWith("mbp_")) {
    fetch("/v1/panel/logout", { method: "POST", headers: { authorization: `Bearer ${oldToken}` }, keepalive: true }).catch(() => {});
  }
  ++installsRequest;
  clearInterval(cmdTimer);
  cmdDevice = null;
  cfgDevice = null;
  devices = [];
  selectedDeviceId = null;
  nextCursor = null;
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $("#installs").replaceChildren();
  $("#deviceDetail").replaceChildren();
  $("#flash").replaceChildren();
  ["totalCount", "onlineCount", "pendingCount", "revokedCount"].forEach((id) => $("#" + id).textContent = "—");
  $("#updatedAt").textContent = "Aguardando atualização";
  $("#resultCount").textContent = "Carregando instalações…";
  $("#loadMore").classList.add("hidden");
  $("#installsEmpty").classList.add("hidden");
  document.querySelectorAll("nav button").forEach((button) => {
    if (button.dataset.tab === "installs") button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== "installs"));
  $("#reload").disabled = false;
  $("#loadMore").disabled = false;
  $("#installs").removeAttribute("aria-busy");
  apiKey = ""; sessionStorage.removeItem(KEY); sessionStorage.removeItem(TECH_NAME);
  $("#app").classList.add("hidden"); $("#logout").classList.add("hidden"); $("#docsLink").classList.add("hidden"); $("#who").textContent = "";
  $("#login").classList.remove("hidden");
  setLoginMode("admin");
  $("#loginMsg").replaceChildren(msg ? el("div", { class: "notice error", style: "margin-top:12px" }, msg) : "");
}
async function start() {
  if (!apiKey) return logout();
  try {
    const me = await api("GET", "/v1/me");
    const canManage = me.scopes.includes("manage") || me.scopes.includes("admin");
    isManager = canManage;
    const canRead = me.scopes.includes("read") || me.scopes.includes("admin");
    if (!canRead) return logout("Esta credencial não tem permissão de leitura.");
    $("#who").textContent = me.id === "admin" ? "Gestão" : me.id.startsWith("tech:") ? (sessionStorage.getItem(TECH_NAME) || "Técnico") : canManage ? "Gestão" : "Leitura";
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); $("#logout").classList.remove("hidden"); $("#docsLink").classList.remove("hidden");
    // Sem gestão (seguidor/técnico só-leitura): Voluntários (consolidado) + Monitoramento
    // (detalhe por dispositivo), ambos já escopados aos devices da conta.
    const readerTabs = ["patients", "monitor"];
    document.querySelectorAll("nav [data-tab]").forEach((button) => {
      button.classList.toggle("hidden", !canManage && !readerTabs.includes(button.dataset.tab));
    });
    if (canManage) {
      document.querySelector('[data-tab="installs"]').click();
    } else {
      document.querySelector('[data-tab="patients"]').click();
    }
  } catch (e) { if (e.message !== "unauthorized") logout(e.message); }
}
let loginMode = "admin";
function setLoginMode(mode) {
  loginMode = mode;
  const isTech = mode === "tech";
  $("#adminLoginFields").classList.toggle("hidden", isTech);
  $("#techLoginFields").classList.toggle("hidden", !isTech);
  $("#key").required = !isTech;
  $("#techCredential").required = isTech;
  $("#techPassword").required = isTech;
  document.querySelectorAll("[data-login-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.loginMode === mode)));
  $("#loginMsg").replaceChildren();
}
document.querySelectorAll("[data-login-mode]").forEach((button) => button.addEventListener("click", () => setLoginMode(button.dataset.loginMode)));
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginMsg").replaceChildren();
  try {
    if (loginMode === "tech") {
      const response = await fetch("/v1/panel/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: $("#techCredential").value.trim(), password: $("#techPassword").value }),
      });
      const result = await response.json();
      $("#techPassword").value = "";
      if (!response.ok) throw new Error(result.message || result.error || `Erro ${response.status}`);
      apiKey = result.session_token;
      sessionStorage.setItem(TECH_NAME, result.technician?.name || "Técnico");
    } else {
      apiKey = $("#key").value.trim();
      $("#key").value = "";
    }
    sessionStorage.setItem(KEY, apiKey);
    await start();
  } catch (error) {
    apiKey = ""; sessionStorage.removeItem(KEY); sessionStorage.removeItem(TECH_NAME);
    $("#loginMsg").replaceChildren(el("div", { class: "notice error", style: "margin-top:12px", role: "alert" }, error.message));
  }
});
$("#logout").addEventListener("click", () => logout());

// ------------------------------------------------------------------ abas
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => { if (x === b) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); });
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== b.dataset.tab));
  $("#flash").replaceChildren();
  ({ installs: loadInstalls, monitor: loadMonitorDevices, patients: loadPatients, terms: loadTerms, techs: loadTechs, alerts: loadAlerts })[b.dataset.tab]();
}));

// ------------------------------------------------------------------ instalações
const statusLabel = { pending: "Pendente", active: "Autorizada", revoked: "Bloqueada" };
const hrLabel = (m) => (m === 0 ? "FC contínua" : m == null ? "Não configurada" : `FC a cada ${m} min`);
let selectedDeviceId = null;
let nextCursor = null;
let installsRequest = 0;
let loadedFilter = { status: "", q: "" };

const pulseIcon = () => el("img", { class: "pulse-icon", src: "/admin/assets/biosense-pulse.png", alt: "", width: "32", height: "44" });
// Ícone e nome do modelo conforme o tipo do dispositivo (pulseira × sensor de glicemia).
const deviceModel = (d) => d.type === "cgm" ? "Sensor AiDEX" : "BIOSENSE Pulse";
const deviceIcon = (d) => d.type === "cgm"
  ? el("img", { class: "cgm-icon", src: "/admin/assets/cgm-sensor.png", alt: "", width: "40", height: "40" })
  : pulseIcon();
const shortId = (id) => id.length > 12 ? `…${id.slice(-8)}` : id;
const onlineState = (d) => el("span", {}, el("span", { class: `dot ${d.online ? "on" : ""}`, "aria-hidden": "true" }), d.online ? "Online" : "Offline");
const detailRow = (label, value) => el("div", {}, el("dt", {}, label), el("dd", {}, value));

function renderDetail() {
  const d = devices.find((item) => item.id === selectedDeviceId);
  const box = $("#deviceDetail");
  if (!d) {
    box.replaceChildren(el("div", { class: "detail-empty" }, el("p", { class: "eyebrow" }, "Instalação selecionada"),
      el("p", { class: "muted" }, "Selecione uma instalação para consultar os detalhes e comandos.")));
    return;
  }
  const config = d.config || {};
  box.replaceChildren(
    el("p", { class: "eyebrow" }, "Instalação selecionada"),
    el("div", { class: "device-heading" }, deviceIcon(d), el("div", {}, el("h2", {}, deviceModel(d)), el("div", { class: "mono detail-id", title: d.id }, d.id))),
    el("dl", { class: "detail-group" },
      detailRow("Participante", el("span", { class: "mono" }, d.patient_ref || "Não vinculado")),
      detailRow("Situação", el("span", { class: `status-text ${d.status}` }, statusLabel[d.status] || d.status)),
      detailRow("Consentimento", [d.consent_version ? `Versão ${d.consent_version}` : "Sem aceite válido",
        el("button", { class: "link", onclick: () => showConsents(d) }, "Consultar histórico ↗")])
    ),
    el("dl", { class: "detail-group" },
      detailRow("Coleta", el("span", { class: "mono" }, hrLabel(config.hr_interval_min))),
      detailRow("Perfil", `${config.band_profile ? "Físico" : "Padrão"} · v${d.config_version ?? "—"}`),
      detailRow("Conexão", onlineState(d)),
      detailRow("Último contato", fmt(d.last_seen_at)),
      detailRow("Criada em", fmt(d.created_at))
    ),
    el("div", { class: "detail-actions" }, el("div", { class: "actions" },
      d.status !== "active" ? el("button", { class: "btn", onclick: () => authorize(d) }, "Autorizar instalação") :
        el("button", { class: "btn", onclick: () => openCommands(d) }, "Comandos"),
      el("button", { class: "btn secondary", onclick: () => editConfig(d) }, "Configurar coleta")),
      d.status !== "revoked" ? el("button", { class: "link danger-link", onclick: () => revoke(d) }, "Bloquear instalação") : null)
  );
}

function renderInstalls() {
  const rows = devices.map((d) => {
    const select = () => {
      selectedDeviceId = d.id;
      document.querySelectorAll("#installs tr").forEach((row) => row.classList.toggle("selected", row.dataset.id === d.id));
      document.querySelectorAll("#installs .device-id").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.id === d.id)));
      renderDetail();
    };
    return el("tr", { class: d.id === selectedDeviceId ? "selected" : "", "data-id": d.id, onclick: select },
      el("td", {}, el("div", { class: "device-cell" }, deviceIcon(d), el("div", {},
        el("button", { class: "device-id", "data-id": d.id, title: d.id, "aria-pressed": String(d.id === selectedDeviceId), "aria-label": `Selecionar ${deviceModel(d)} ${d.id}`, "aria-controls": "deviceDetail" }, shortId(d.id)),
        el("small", {}, deviceModel(d))))),
      el("td", { class: "mono" }, d.patient_ref || el("span", { class: "muted" }, "Não vinculado")),
      el("td", {}, el("span", { class: `status-text ${d.status}` }, statusLabel[d.status] || d.status)),
      el("td", {}, onlineState(d), el("div", { class: "muted last-contact" }, `Visto ${fmt(d.last_seen_at)}`)),
      el("td", { class: "chevron", "aria-hidden": "true" }, "›")
    );
  });
  $("#installs").replaceChildren(...rows);
  $("#installsEmpty").textContent = devices.length ? "" : "Nenhuma instalação encontrada para estes filtros.";
  $("#installsEmpty").classList.toggle("hidden", devices.length > 0);
  const counts = [devices.length, devices.filter((d) => d.online).length, devices.filter((d) => d.status === "pending").length, devices.filter((d) => d.status === "revoked").length];
  ["totalCount", "onlineCount", "pendingCount", "revokedCount"].forEach((id, i) => $("#" + id).textContent = String(counts[i]).padStart(2, "0"));
  const filtered = loadedFilter.status || loadedFilter.q;
  $("#resultCount").textContent = `${devices.length} ${devices.length === 1 ? "registro" : "registros"}${filtered ? " no filtro" : ""}${nextCursor ? " carregados · há mais resultados" : ""}`;
  $("#loadMore").classList.toggle("hidden", !nextCursor);
  renderDetail();
}

async function loadInstalls(append = false) {
  // Event listeners may pass an Event. Only explicit true requests the next page.
  append = append === true;
  const request = ++installsRequest;
  const keyAtStart = apiKey;
  const filter = append ? loadedFilter : { status: $("#fStatus").value, q: $("#fQ").value.trim() };
  const params = new URLSearchParams({ limit: "500" });
  if (filter.status) params.set("status", filter.status);
  if (filter.q) params.set("q", filter.q);
  if (append && nextCursor) params.set("cursor", nextCursor);
  $("#reload").disabled = true;
  $("#loadMore").disabled = true;
  $("#installs").setAttribute("aria-busy", "true");
  try {
    const { data, next } = await api("GET", `/v1/devices?${params}`);
    if (request !== installsRequest || apiKey !== keyAtStart || !apiKey) return;
    devices = append ? Array.from(new Map([...devices, ...data].map((d) => [d.id, d])).values()) : data;
    loadedFilter = filter;
    nextCursor = next || null;
    if (!devices.some((d) => d.id === selectedDeviceId)) selectedDeviceId = devices[0]?.id || null;
    renderInstalls();
    $("#updatedAt").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) {
    if (request !== installsRequest || apiKey !== keyAtStart || !apiKey) return;
    if (e.message !== "unauthorized") {
      flash(e.message, "error");
      $("#updatedAt").textContent = "Falha ao atualizar · dados anteriores";
      if (!devices.length) {
        $("#installsEmpty").textContent = "Não foi possível carregar as instalações. Tente atualizar novamente.";
        $("#installsEmpty").classList.remove("hidden");
        $("#resultCount").textContent = "Dados indisponíveis";
      }
    }
  } finally {
    if (request === installsRequest) {
      $("#reload").disabled = false;
      $("#loadMore").disabled = false;
      $("#installs").removeAttribute("aria-busy");
    }
  }
}
$("#reload").addEventListener("click", () => loadInstalls());
$("#fStatus").addEventListener("change", () => loadInstalls());
$("#filterForm").addEventListener("submit", (e) => { e.preventDefault(); loadInstalls(); });
$("#fQ").addEventListener("input", () => { if (!$("#fQ").value) loadInstalls(); });
$("#loadMore").addEventListener("click", () => loadInstalls(true));

const authorize = guard(async (d) => {
  const ref = prompt(`Referência do participante para ${d.id} (código, não o nome):`, d.patient_ref || "");
  if (ref === null) return;
  if (!ref.trim()) return flash("Informe a referência do participante.", "error");
  await api("POST", `/v1/devices/${encodeURIComponent(d.id)}/authorize`, { participant_ref: ref.trim() });
  flash(`Instalação ${d.id} autorizada para ${ref.trim()}.`);
  loadInstalls();
});

const revoke = guard(async (d) => {
  if (!confirm(`Bloquear ${d.id}? O app deixa de enviar dados e mostra "Conexão não autorizada".`)) return;
  await api("POST", `/v1/devices/${encodeURIComponent(d.id)}/revoke`);
  flash(`Instalação ${d.id} bloqueada.`);
  loadInstalls();
});

let cfgDevice = null;
function editConfig(d) {
  cfgDevice = d;
  $("#cfgFor").textContent = `${d.id}${d.patient_ref ? " · " + d.patient_ref : ""} · versão atual ${d.config_version}`;
  $("#cfgHr").value = String(d.config.hr_interval_min);
  $("#cfgHist").value = d.config.history_interval_min;
  const p = d.config.band_profile || {};
  $("#pYear").value = p.birth_year ?? ""; $("#pGender").value = p.gender ?? ""; $("#pHeight").value = p.height_cm ?? "";
  $("#pWeight").value = p.weight_kg ?? ""; $("#pWrist").value = p.wrist ?? "left"; $("#pGoal").value = p.step_goal ?? 8000;
  $("#cfgMsg").replaceChildren();
  $("#cfgDialog").showModal();
}
$("#cfgSave").addEventListener("click", guard(async (e) => {
  e.preventDefault();
  if (!$("#cfgForm").reportValidity()) return;
  const body = { hr_interval_min: Number($("#cfgHr").value), history_interval_min: Number($("#cfgHist").value) };
  const fields = [$("#pYear").value, $("#pGender").value, $("#pHeight").value, $("#pWeight").value];
  if (fields.some(Boolean)) {
    if (!fields.every(Boolean)) {
      $("#cfgMsg").replaceChildren(el("div", { class: "notice error", style: "margin-top:12px" }, "Preencha nascimento, sexo, altura e peso — ou deixe todos em branco."));
      return;
    }
    body.band_profile = { birth_year: Number(fields[0]), gender: fields[1], height_cm: Number(fields[2]), weight_kg: Number(fields[3]), wrist: $("#pWrist").value, step_goal: Number($("#pGoal").value) };
  } else if (cfgDevice.config.band_profile) {
    body.band_profile = null;
  }
  const r = await api("PUT", `/v1/devices/${encodeURIComponent(cfgDevice.id)}/config`, body);
  $("#cfgDialog").close();
  flash(`Perfil de coleta salvo (versão ${r.config_version}). O app recebe a mudança ao estar conectado.`);
  loadInstalls();
}));

const showConsents = guard(async (d) => {
  const { data } = await api("GET", `/v1/devices/${encodeURIComponent(d.id)}/consents`);
  $("#consFor").textContent = d.id;
  $("#consents").replaceChildren(...(data.length ? data.map((c) => el("tr", {}, el("td", {}, fmt(c.created_at)), el("td", {}, c.version), el("td", {}, c.accepted ? "Aceitou" : "Recusou")))
    : [el("tr", {}, el("td", { colspan: "3", class: "muted" }, "Sem registros."))]));
  $("#consDialog").showModal();
});

// ------------------------------------------------------------------ comandos
const cmdNames = { vibrate: "Vibrar", message: "Mensagem", measure_hr: "Medir FC", fetch_history: "Baixar histórico", sync_time: "Sincronizar hora", hr_continuous: "FC contínua", refresh: "Atualizar", set_alarm: "Alarme", stop_call: "Encerrar chamada" };
const cmdStatus = {
  queued: ["Na fila (celular offline)", "pending"], sent: ["Enviado ao celular", "pending"], acked: ["Executado", "active"],
  failed: ["Falhou", "revoked"], timeout: ["Sem confirmação", "revoked"], expired: ["Expirou", "revoked"], cancelled: ["Cancelado", ""],
};
let cmdDevice = null;
let cmdTimer = null;

function openCommands(d) {
  cmdDevice = d;
  $("#cmdFor").textContent = `${d.patient_ref || "Sem referência"} · ${d.id}`;
  $("#cmdList").replaceChildren();
  $("#cmdLive").textContent = "Carregando estado…";
  refreshCommands();
  clearInterval(cmdTimer);
  cmdTimer = setInterval(refreshCommands, 2500);
  $("#cmdDialog").showModal();
}
$("#cmdDialog").addEventListener("close", () => { clearInterval(cmdTimer); cmdDevice = null; });

async function refreshCommands() {
  if (!cmdDevice) return;
  try {
    const deviceAtStart = cmdDevice;
    const id = encodeURIComponent(cmdDevice.id);
    const [st, cmds] = await Promise.all([api("GET", `/v1/devices/${id}/status`), api("GET", `/v1/devices/${id}/commands?order=desc&limit=10`)]);
    if (cmdDevice !== deviceAtStart || !apiKey) return;
    const l = st.latest || {};
    const parts = [st.online ? "Celular conectado ao serviço" : "Celular offline — os comandos ficam na fila"];
    if (l.state) parts.push(`pulseira: ${l.state.connection === "READY" ? "conectada" : "desconectada"}`);
    if (l.hr) parts.push(`FC ${l.hr.bpm} bpm às ${new Date(l.hr.ts).toLocaleTimeString("pt-BR")}`);
    if (l.battery) parts.push(`bateria ${l.battery.level}%`);
    if (l.steps) parts.push(`${l.steps.steps} passos`);
    const live = $("#cmdLive");
    live.textContent = parts.join(" · ");
    live.className = `notice ${st.online && l.state?.connection === "READY" ? "ok" : "warn"}`;
    $("#cmdList").replaceChildren(...(cmds.data.length ? cmds.data.map((c) => {
      const [label, kind] = cmdStatus[c.status] || [c.status, ""];
      return el("tr", {}, el("td", {}, fmt(c.created_at)), el("td", {}, cmdNames[c.type] || c.type),
        el("td", {}, el("span", { class: `pill ${kind}` }, label), c.error ? el("div", { class: "muted" }, c.error) : null));
    }) : [el("tr", {}, el("td", { colspan: "3", class: "muted" }, "Nenhum comando enviado."))]));
  } catch (e) { if (e.message !== "unauthorized") $("#cmdLive").textContent = e.message; }
}

// Erros aparecem dentro da janela (o aviso geral fica atrás dela).
const cmdGuard = (fn) => async () => {
  try { await fn(); } catch (e) {
    if (e.message === "unauthorized") return;
    const live = $("#cmdLive"); live.textContent = e.message; live.className = "notice error";
  }
};

async function sendCommand(type, params, ttl_s = 120) {
  await api("POST", `/v1/devices/${encodeURIComponent(cmdDevice.id)}/commands`, { type, params, ttl_s });
  refreshCommands();
}
$("#cmdVibrate").addEventListener("click", cmdGuard(() => sendCommand("vibrate", { count: Number($("#vibCount").value), level: $("#vibLevel").value }, 60)));
$("#cmdMessage").addEventListener("click", cmdGuard(async () => {
  const title = $("#msgTitle").value.trim();
  if (!title) throw new Error("Informe o título da mensagem.");
  await sendCommand("message", { kind: "app", title, body: $("#msgBody").value.trim() });
  $("#msgBody").value = "";
}));
$("#cmdHr").addEventListener("click", cmdGuard(() => sendCommand("measure_hr", {})));
$("#cmdHistory").addEventListener("click", cmdGuard(() => sendCommand("fetch_history", {}, 300)));
$("#cmdTime").addEventListener("click", cmdGuard(() => sendCommand("sync_time", {})));

// ------------------------------------------------------------------ monitoramento de dados registrados
let monitorDevices = [];
let selectedMonitorId = "";
let monitorRequest = 0;
const selectedMonitorDevice = () => monitorDevices.find((d) => d.id === selectedMonitorId);
const dateLabel = (ms) => ms ? new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const durationLabel = (minutes) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}min`;
const setMonitorEmpty = (message) => {
  ["hrChart", "stepsChart"].forEach((id) => $("#" + id).replaceChildren(el("div", { class: "chart-empty" }, message)));
  ["metricHrAvg", "metricSteps", "metricSleep", "metricBattery", "metricAlerts"].forEach((id) => $("#" + id).textContent = "—");
  $("#metricHrRange").textContent = "sem amostras";
  $("#metricDistance").textContent = "no período selecionado";
  $("#metricSleepCount").textContent = "sem sessões";
  $("#metricBatteryRange").textContent = "sem leituras";
  $("#metricEvents").textContent = "eventos no período";
  $("#sleepRows").replaceChildren(); $("#eventRows").replaceChildren();
  $("#sleepEmpty").classList.remove("hidden"); $("#eventsEmpty").classList.remove("hidden");
};

function drawHeartChart(rows) {
  const points = rows.map((r) => ({ ts: Number(r.ts), value: Number(r.avg ?? r.bpm) })).filter((p) => Number.isFinite(p.value));
  const box = $("#hrChart");
  if (!points.length) { box.replaceChildren(el("div", { class: "chart-empty" }, "Sem registros de frequência cardíaca neste período.")); return; }
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 800 210"); svg.setAttribute("role", "presentation");
  const min = Math.min(...points.map((p) => p.value)); const max = Math.max(...points.map((p) => p.value));
  const pad = Math.max(5, Math.ceil((max - min) * 0.15)); const lo = Math.max(0, min - pad); const hi = max + pad;
  const xy = points.map((p, i) => [points.length === 1 ? 400 : 18 + i * 764 / (points.length - 1), 184 - ((p.value - lo) / Math.max(1, hi - lo)) * 158]);
  [26, 78, 130, 184].forEach((y) => { const line = document.createElementNS(NS, "line"); line.setAttribute("x1", "0"); line.setAttribute("x2", "800"); line.setAttribute("y1", String(y)); line.setAttribute("y2", String(y)); line.setAttribute("class", "chart-grid"); svg.append(line); });
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = document.createElementNS(NS, "path"); area.setAttribute("d", `${d} L${xy.at(-1)[0]},184 L${xy[0][0]},184 Z`); area.setAttribute("class", "chart-area"); svg.append(area);
  const line = document.createElementNS(NS, "path"); line.setAttribute("d", d); line.setAttribute("class", "chart-line"); svg.append(line);
  xy.forEach(([x, y], i) => { const circle = document.createElementNS(NS, "circle"); circle.setAttribute("cx", String(x)); circle.setAttribute("cy", String(y)); circle.setAttribute("r", points.length > 36 ? "2.4" : "4"); circle.setAttribute("class", "chart-dot"); circle.setAttribute("aria-label", `${dateLabel(points[i].ts)}: ${points[i].value} bpm`); svg.append(circle); });
  box.replaceChildren(svg, el("div", { class: "chart-labels" }, dateLabel(points[0].ts), `${Math.min(...points.map((p) => p.value))}–${Math.max(...points.map((p) => p.value))} bpm`, dateLabel(points.at(-1).ts)));
}

function drawStepsChart(rows) {
  const points = rows.map((r) => ({ ts: Number(r.ts), value: Number(r.steps) })).filter((p) => Number.isFinite(p.value));
  const box = $("#stepsChart");
  if (!points.length) { box.replaceChildren(el("div", { class: "chart-empty" }, "Sem registros de passos neste período.")); return; }
  const max = Math.max(1, ...points.map((p) => p.value));
  const bars = el("div", { class: "chart-bars", role: "list" }, ...points.slice(-30).map((p) => {
    const bar = el("div", { class: "chart-bar", role: "listitem", title: `${dateLabel(p.ts)} · ${p.value.toLocaleString("pt-BR")} passos` });
    bar.append(el("span", { style: `--bar-height:${Math.max(2, p.value / max * 100)}%` }));
    return bar;
  }));
  const shown = points.slice(-30);
  box.replaceChildren(bars, el("div", { class: "chart-labels" }, dateLabel(shown[0].ts), `${Math.max(...points.map((p) => p.value)).toLocaleString("pt-BR")} passos`, dateLabel(shown.at(-1).ts)));
}

async function loadMonitorDevices() {
  const select = $("#monitorDevice");
  select.disabled = true;
  try {
    const { data } = await api("GET", "/v1/devices?limit=500&status=active");
    monitorDevices = data;
    select.replaceChildren(...data.map((d) => el("option", { value: d.id }, `${d.patient_ref || d.name || "Sem referência"} · ${shortId(d.id)}`)));
    if (!data.length) {
      selectedMonitorId = ""; setMonitorEmpty("Nenhuma instalação autorizada com dados disponíveis.");
      $("#monitorUpdatedAt").textContent = "Sem instalações autorizadas";
      select.disabled = true;
      return;
    }
    if (!data.some((d) => d.id === selectedMonitorId)) selectedMonitorId = data[0].id;
    select.value = selectedMonitorId;
    select.disabled = false;
    await loadMonitorData();
  } catch (e) {
    if (e.message !== "unauthorized") {
      $("#monitorNotice").className = "notice error"; $("#monitorNotice").textContent = e.message;
      setMonitorEmpty("Não foi possível carregar as instalações.");
    }
  }
}

async function loadMonitorData() {
  const device = selectedMonitorDevice();
  if (!device) return setMonitorEmpty("Selecione uma instalação para consultar os registros.");
  const request = ++monitorRequest;
  const notice = $("#monitorNotice"); notice.classList.add("hidden"); notice.textContent = "";
  $("#monitorUpdatedAt").textContent = "Atualizando registros…";
  $("#monitorReload").disabled = true;
  const to = Date.now(); const from = to - Number($("#monitorRange").value);
    const query = new URLSearchParams({ from: String(from), to: String(to), limit: "1000" });
    const eventsQuery = new URLSearchParams(query);
    eventsQuery.set("limit", "30");
    eventsQuery.set("order", "desc");
  const id = encodeURIComponent(device.id);
  try {
    const span = to - from;
    const [summary, hr, steps, sleep, events] = await Promise.all([
      api("GET", `/v1/devices/${id}/summary?${query}`),
      api("GET", `/v1/devices/${id}/heart-rate?${query}&bucket=${span <= 86_400_000 ? "15m" : "1h"}`),
      api("GET", `/v1/devices/${id}/steps?${query}&bucket=${span <= 86_400_000 ? "1h" : "1d"}&tz_offset_min=-180`),
      api("GET", `/v1/devices/${id}/sleep?${query}`),
      api("GET", `/v1/devices/${id}/events?${eventsQuery}`),
    ]);
    if (request !== monitorRequest || !apiKey) return;
    const h = summary.heart_rate || {}; const s = summary.steps || {}; const b = summary.battery || {};
    $("#metricHrAvg").textContent = Number.isFinite(Number(h.avg)) && h.samples ? `${h.avg} bpm` : "—";
    $("#metricHrRange").textContent = h.samples ? `mín. ${h.min} · máx. ${h.max} · ${h.samples} amostras` : "sem amostras";
    $("#metricSteps").textContent = s.max_steps == null ? "—" : Number(s.max_steps).toLocaleString("pt-BR");
    $("#metricDistance").textContent = s.max_meters == null ? "distância não informada" : `${(Number(s.max_meters) / 1000).toFixed(2).replace(".", ",")} km estimados`;
    $("#metricSleep").textContent = sleep.count ? durationLabel(summary.sleep.total_min || 0) : "—";
    $("#metricSleepCount").textContent = sleep.count ? `${sleep.count} sessão(ões) · classificação provisória` : "sem sessões";
    $("#metricBattery").textContent = b.min_level == null ? "—" : `${b.min_level}–${b.max_level}%`;
    $("#metricBatteryRange").textContent = b.min_level == null ? "sem leituras" : "mínimo–máximo no período";
    const alertCount = (summary.alerts || []).reduce((n, x) => n + Number(x.n || 0), 0);
    const eventCount = (summary.events || []).reduce((n, x) => n + Number(x.n || 0), 0);
    $("#metricAlerts").textContent = String(alertCount);
    $("#metricEvents").textContent = `${eventCount} evento(s) registrado(s)`;
    drawHeartChart(hr.data || []); drawStepsChart(steps.data || []);
    $("#sleepRows").replaceChildren(...(sleep.data || []).slice().reverse().map((row) => el("tr", {},
      el("td", {}, fmt(row.start)), el("td", {}, durationLabel(row.duration_min)), el("td", {}, `${row.deep_min} min`), el("td", {}, `${row.light_min} min`), el("td", {}, row.avg_hr == null ? "—" : `${row.avg_hr} bpm`))));
    $("#sleepEmpty").classList.toggle("hidden", Boolean(sleep.count));
    $("#eventRows").replaceChildren(...(events.data || []).map((row) => {
      const details = eventDetails(row.data);
      return el("tr", {}, el("td", {}, fmt(row.ts)), el("td", {}, eventTypeLabel(row.type)), el("td", {}, details.length > 120 ? `${details.slice(0, 120)}…` : details));
    }));
    $("#eventsEmpty").classList.toggle("hidden", Boolean(events.count));
    $("#monitorUpdatedAt").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) {
    if (request === monitorRequest && e.message !== "unauthorized") {
      notice.textContent = e.message; notice.className = "notice error";
      $("#monitorUpdatedAt").textContent = "Falha ao atualizar";
    }
  } finally {
    if (request === monitorRequest) $("#monitorReload").disabled = false;
  }
}
$("#monitorDevice").addEventListener("change", () => { selectedMonitorId = $("#monitorDevice").value; loadMonitorData(); });
$("#monitorRange").addEventListener("change", loadMonitorData);
$("#monitorReload").addEventListener("click", () => loadMonitorDevices());

// ------------------------------------------------------------------ termo
const loadTerms = guard(async () => {
  const cur = await fetch("/v1/consent/terms/current");
  if (cur.ok) {
    const t = await cur.json();
    $("#currentTerm").replaceChildren(el("h2", {}, `Vigente: ${t.title} (versão ${t.version})`), el("p", { class: "muted" }, `Publicado em ${fmt(t.published_at)}${t.requires_reconsent ? " · exigiu novo aceite" : ""}`), el("pre", { class: "term" }, t.content));
  } else {
    $("#currentTerm").replaceChildren(el("div", { class: "notice warn" }, "Nenhum termo publicado. Enquanto isso, ninguém consegue aderir pelo app."));
  }
  const { data } = await api("GET", "/v1/consent/terms");
  $("#terms").replaceChildren(...data.map((t) => el("tr", {}, el("td", {}, t.version), el("td", {}, t.title), el("td", {}, t.requires_reconsent ? "Sim" : "Não"), el("td", {}, fmt(t.published_at)))));
});
$("#termForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const version = $("#tVersion").value.trim();
  if (!confirm(`Publicar a versão ${version}? Ela não poderá ser editada depois.${$("#tReconsent").checked ? " Quem aceitou versões anteriores precisará aceitar de novo." : ""}`)) return;
  await api("POST", "/v1/consent/terms", { version, title: $("#tTitle").value.trim(), content: $("#tContent").value.trim(), requires_reconsent: $("#tReconsent").checked });
  $("#tVersion").value = ""; $("#tContent").value = "";
  flash(`Versão ${version} publicada.`);
  loadTerms();
}));

// ------------------------------------------------------------------ técnicos
const loadTechs = guard(async () => {
  const { data } = await api("GET", "/v1/technicians");
  $("#techs").replaceChildren(...data.map((t) => {
    const locked = t.locked_until && t.locked_until > Date.now();
    return el("tr", {},
      el("td", {}, t.name),
      el("td", {}, t.credential),
      el("td", {}, ["Testes", ...(t.scopes.includes("provision") ? ["Autorizar instalações"] : []), ...(t.scopes.includes("panel_read") ? ["Painel · leitura"] : [])].join(" · ")),
      el("td", {}, t.disabled_at ? el("span", { class: "pill revoked" }, "Desativado") : locked ? el("span", { class: "pill pending" }, "Bloqueado por tentativas") : el("span", { class: "pill active" }, "Ativo")),
      el("td", {}, t.disabled_at ? "" : el("div", { class: "actions" },
        locked ? el("button", { class: "btn secondary", onclick: () => techAction(t, { unlock: true }, "Desbloqueado.") }, "Desbloquear") : null,
        el("button", { class: "btn secondary", onclick: () => {
          const scopes = t.scopes.includes("panel_read") ? t.scopes.filter((scope) => scope !== "panel_read") : [...t.scopes, "panel_read"];
          techAction(t, { scopes }, t.scopes.includes("panel_read") ? "Acesso web revogado." : "Acesso web de leitura concedido.");
        } }, t.scopes.includes("panel_read") ? "Revogar painel" : "Permitir painel"),
        el("button", { class: "btn secondary", onclick: () => resetPassword(t) }, "Nova senha"),
        el("button", { class: "btn danger", onclick: () => disableTech(t) }, "Desativar"),
      )),
    );
  }));
});
$("#techForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  const scopes = ["tech"];
  if ($("#cProv").checked) scopes.push("provision");
  if ($("#cPanelRead").checked) scopes.push("panel_read");
  await api("POST", "/v1/technicians", { credential: $("#cCred").value.trim(), name: $("#cName").value.trim(), password: $("#cPass").value, scopes });
  flash(`Técnico ${$("#cName").value.trim()} criado.`);
  $("#techForm").reset();
  loadTechs();
}));
const techAction = guard(async (t, body, msg) => { await api("PATCH", `/v1/technicians/${encodeURIComponent(t.id)}`, body); flash(msg); loadTechs(); });
function resetPassword(t) {
  const p = prompt(`Nova senha para ${t.name} (mínimo 10 caracteres). As sessões abertas serão encerradas.`);
  if (p === null) return;
  if (p.length < 10) return flash("A senha precisa ter pelo menos 10 caracteres.", "error");
  techAction(t, { password: p }, "Senha alterada.");
}
const disableTech = guard(async (t) => {
  if (!confirm(`Desativar ${t.name}? As sessões abertas serão encerradas.`)) return;
  await api("DELETE", `/v1/technicians/${encodeURIComponent(t.id)}`);
  flash(`${t.name} desativado.`);
  loadTechs();
});

// ------------------------------------------------------------------ alertas
const sevLabel = { info: "Informativo", warning: "Atenção", critical: "Crítico" };
const loadAlerts = guard(async () => {
  const { data } = await api("GET", "/v1/alerts?acked=false&order=desc&limit=500");
  $("#alerts").replaceChildren(...data.map((a) => el("tr", {},
    el("td", {}, fmt(a.ts)), el("td", {}, a.device_id),
    el("td", {}, el("span", { class: `pill ${a.severity === "critical" ? "revoked" : a.severity === "warning" ? "pending" : "active"}` }, sevLabel[a.severity] || a.severity)),
    el("td", {}, a.message),
    el("td", {}, el("button", { class: "btn secondary", onclick: guard(async () => { await api("POST", `/v1/alerts/${encodeURIComponent(a.id)}/ack`); loadAlerts(); }) }, "Reconhecer")),
  )));
  $("#alertsEmpty").textContent = data.length ? "" : "Nenhum alerta pendente.";
});

// ------------------------------------------------------------------ voluntários (visão consolidada)
let patients = [];
let selectedPatientId = "";
let patRequest = 0;
const NS = "http://www.w3.org/2000/svg";
const mmolLabel = (v) => (v == null ? "—" : `${Number(v).toFixed(1).replace(".", ",")} mmol/L`);
const TIR_BANDS = [
  ["very_low", "Muito baixa", "#8a1c1c"],
  ["low", "Baixa", "#d64545"],
  ["in_range", "No alvo", "#2f9e6f"],
  ["high", "Alta", "#e0a100"],
  ["very_high", "Muito alta", "#b25f00"],
];
const gluEventType = { diet: "Refeição", exercise: "Exercício", medication: "Medicação", insulin: "Insulina", other: "Outro" };

function setPatientEmpty(msg) {
  ["gluChart", "patHrChart", "patStepsChart"].forEach((id) => $("#" + id).replaceChildren(el("div", { class: "chart-empty" }, msg || "Sem dados.")));
  ["kGluNow", "kTir", "kGmi", "kHr", "kSteps", "kSleep", "kAlerts"].forEach((id) => $("#" + id).textContent = "—");
  $("#kGluNowAt").textContent = "sem leituras"; $("#kGluMean").textContent = "glicose média —"; $("#kHrRange").textContent = "sem amostras";
  $("#tirBar").replaceChildren(); $("#tirLegend").replaceChildren();
  $("#gluEventRows").replaceChildren(); $("#gluEventsEmpty").classList.remove("hidden");
  $("#aidexStatus").textContent = "—"; $("#aidexActions").replaceChildren();
}

async function loadPatients() {
  const select = $("#patSelect");
  select.disabled = true;
  try {
    const { data } = await api("GET", "/v1/patients");
    patients = data;
    if (!data.length) {
      select.replaceChildren();
      selectedPatientId = "";
      $("#patHeader").replaceChildren(el("p", { class: "muted" }, "Nenhum voluntário cadastrado."));
      $("#patUpdatedAt").textContent = "Sem voluntários";
      return setPatientEmpty("Nenhum voluntário cadastrado.");
    }
    select.replaceChildren(...data.map((p) => el("option", { value: p.id }, `${shortId(p.id)} · ${p.name}`)));
    if (!data.some((p) => p.id === selectedPatientId)) selectedPatientId = data[0].id;
    select.value = selectedPatientId;
    select.disabled = false;
    await loadPatientData();
  } catch (e) {
    if (e.message !== "unauthorized") { const n = $("#patNotice"); n.className = "notice error"; n.classList.remove("hidden"); n.textContent = e.message; }
  }
}

function renderPatientHeader(detail, band, cgm) {
  const chip = (label, on) => el("span", { class: `dev-chip ${on ? "on" : "off"}` }, el("span", { class: "dot " + (on ? "on" : ""), "aria-hidden": "true" }), label);
  const chips = [];
  if (band) chips.push(chip(`Pulseira ${band.online ? "online" : "offline"}`, band.online));
  if (cgm) chips.push(chip("Sensor AiDEX", true));
  if (!chips.length) chips.push(el("span", { class: "muted" }, "Sem dispositivos vinculados."));
  $("#patHeader").replaceChildren(
    el("div", { class: "patient-id" }, el("h2", {}, detail.name), detail.ref ? el("span", { class: "mono" }, detail.ref) : null),
    el("div", { class: "dev-chips" }, ...chips),
  );
}

function renderTir(s) {
  const bar = $("#tirBar"); const legend = $("#tirLegend");
  if (!s || !s.samples) { bar.replaceChildren(); legend.replaceChildren(); return; }
  bar.replaceChildren(...TIR_BANDS.map(([k, , color]) => el("span", { class: "tir-seg", style: `width:${s.tir[k] || 0}%;background:${color}`, title: `${s.tir[k] || 0}%` })));
  legend.replaceChildren(...TIR_BANDS.map(([k, label, color]) =>
    el("span", { class: "tir-key" }, el("span", { class: "tir-swatch", style: `background:${color}` }), `${label} ${String(s.tir[k] || 0).replace(".", ",")}%`)));
}

function renderGlucoseEvents(rows) {
  $("#gluEventsEmpty").classList.toggle("hidden", rows.length > 0);
  $("#gluEventRows").replaceChildren(...rows.map((e) => {
    const details = eventDetails(e.payload);
    return el("tr", {}, el("td", {}, dateLabel(e.ts)), el("td", {}, gluEventType[e.type] || e.type), el("td", {}, details.length > 120 ? details.slice(0, 120) + "…" : details));
  }));
}

async function connectAidex(deviceId) {
  const r = await api("POST", `/v1/devices/${encodeURIComponent(deviceId)}/aidex/connect`, {});
  $("#aidexActions").replaceChildren(
    el("p", { class: "muted" }, "Abra este link para o voluntário autorizar no AiDEX:"),
    el("a", { href: r.authorize_url, target: "_blank", rel: "noopener", class: "link" }, "Abrir autorização AiDEX ↗"),
  );
  flash("Link de autorização gerado.");
}

function renderAidex(cgm, status) {
  const box = $("#aidexStatus"); const actions = $("#aidexActions");
  actions.replaceChildren();
  if (!cgm) { box.textContent = "Este voluntário não tem sensor de glicemia vinculado."; return; }
  const st = (status && status.status) || "unlinked";
  const label = { unlinked: "Não conectado", pending: "Aguardando autorização", linked: "Conectado", revoked: "Revogado — reautorizar", error: "Erro na coleta" }[st] || st;
  const cls = st === "linked" ? "active" : (st === "error" || st === "revoked") ? "revoked" : "pending";
  box.replaceChildren(
    el("span", { class: "status-text " + cls }, label),
    status && status.last_poll_at ? el("div", { class: "muted" }, `Última coleta: ${fmt(status.last_poll_at)}`) : null,
    status && status.last_error ? el("div", { class: "muted" }, String(status.last_error)) : null,
  );
  if (isManager && st !== "linked") {
    actions.append(el("button", { class: "btn", onclick: guard(() => connectAidex(cgm.id)) }, st === "unlinked" ? "Conectar AiDEX" : "Gerar novo link"));
  }
}

function drawGlucoseChart(box, rows) {
  const points = rows.map((r) => ({ ts: Number(r.ts), value: Number(r.avg != null ? r.avg : r.mmol) })).filter((p) => Number.isFinite(p.value));
  if (!points.length) { box.replaceChildren(el("div", { class: "chart-empty" }, "Sem leituras de glicose neste período.")); return; }
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 800 210"); svg.setAttribute("role", "presentation"); svg.setAttribute("preserveAspectRatio", "none");
  const dataMin = Math.min(...points.map((p) => p.value)); const dataMax = Math.max(...points.map((p) => p.value));
  const lo = Math.min(3, Math.floor(dataMin - 1)); const hi = Math.max(14, Math.ceil(dataMax + 1));
  const y = (v) => 184 - ((v - lo) / Math.max(1, hi - lo)) * 158;
  const target = document.createElementNS(NS, "rect"); target.setAttribute("x", "0"); target.setAttribute("width", "800"); target.setAttribute("y", String(y(10))); target.setAttribute("height", String(y(3.9) - y(10))); target.setAttribute("class", "glu-target"); svg.append(target);
  [3.9, 10].forEach((v) => { const line = document.createElementNS(NS, "line"); line.setAttribute("x1", "0"); line.setAttribute("x2", "800"); line.setAttribute("y1", String(y(v))); line.setAttribute("y2", String(y(v))); line.setAttribute("class", "glu-limit"); svg.append(line); });
  const xy = points.map((p, i) => [points.length === 1 ? 400 : 18 + i * 764 / (points.length - 1), y(p.value)]);
  const d = xy.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)},${yy.toFixed(1)}`).join(" ");
  const path = document.createElementNS(NS, "path"); path.setAttribute("d", d); path.setAttribute("class", "glu-line"); svg.append(path);
  xy.forEach(([x, yy], i) => { const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", String(x)); c.setAttribute("cy", String(yy)); c.setAttribute("r", points.length > 48 ? "2" : "3.4"); const v = points[i].value; c.setAttribute("class", "glu-dot" + (v < 3.9 ? " lowdot" : v > 10 ? " highdot" : "")); c.setAttribute("aria-label", `${dateLabel(points[i].ts)}: ${v.toFixed(1)} mmol/L`); svg.append(c); });
  box.replaceChildren(svg, el("div", { class: "chart-labels" }, dateLabel(points[0].ts), `${dataMin.toFixed(1).replace(".", ",")}–${dataMax.toFixed(1).replace(".", ",")} mmol/L`, dateLabel(points.at(-1).ts)));
}

function drawPatientHr(box, rows, hasBand) {
  const points = rows.map((r) => ({ ts: Number(r.ts), value: Number(r.avg != null ? r.avg : r.bpm) })).filter((p) => Number.isFinite(p.value));
  if (!points.length) { box.replaceChildren(el("div", { class: "chart-empty" }, hasBand ? "Sem registros de FC neste período." : "Voluntário sem pulseira vinculada.")); return; }
  const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", "0 0 800 210"); svg.setAttribute("role", "presentation"); svg.setAttribute("preserveAspectRatio", "none");
  const min = Math.min(...points.map((p) => p.value)); const max = Math.max(...points.map((p) => p.value));
  const pad = Math.max(5, Math.ceil((max - min) * 0.15)); const lo = Math.max(0, min - pad); const hi = max + pad;
  const xy = points.map((p, i) => [points.length === 1 ? 400 : 18 + i * 764 / (points.length - 1), 184 - ((p.value - lo) / Math.max(1, hi - lo)) * 158]);
  [26, 78, 130, 184].forEach((yv) => { const line = document.createElementNS(NS, "line"); line.setAttribute("x1", "0"); line.setAttribute("x2", "800"); line.setAttribute("y1", String(yv)); line.setAttribute("y2", String(yv)); line.setAttribute("class", "chart-grid"); svg.append(line); });
  const d = xy.map(([x, yv], i) => `${i ? "L" : "M"}${x.toFixed(1)},${yv.toFixed(1)}`).join(" ");
  const area = document.createElementNS(NS, "path"); area.setAttribute("d", `${d} L${xy.at(-1)[0]},184 L${xy[0][0]},184 Z`); area.setAttribute("class", "chart-area"); svg.append(area);
  const line = document.createElementNS(NS, "path"); line.setAttribute("d", d); line.setAttribute("class", "chart-line"); svg.append(line);
  box.replaceChildren(svg, el("div", { class: "chart-labels" }, dateLabel(points[0].ts), `${Math.min(...points.map((p) => p.value))}–${Math.max(...points.map((p) => p.value))} bpm`, dateLabel(points.at(-1).ts)));
}

// Exportação CSV: pagina a série pelo cursor e monta o arquivo no cliente (histórico completo).
async function fetchAllRows(deviceId, stream, from, to) {
  const rows = [];
  let cursorFrom = from;
  for (let i = 0; i < 400; i++) {
    const q = new URLSearchParams({ from: String(cursorFrom), to: String(to), limit: "10000", order: "asc" });
    const res = await api("GET", `/v1/devices/${encodeURIComponent(deviceId)}/${stream}?${q}`);
    const data = res.data || [];
    rows.push(...data);
    if (!res.next || res.next.from == null || !data.length) break;
    cursorFrom = res.next.from;
  }
  return rows;
}
function rowsToCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v && typeof v === "object") v = JSON.stringify(v);
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
async function exportStream(deviceId, stream, label, from, to) {
  flash(`Exportando ${label}…`);
  const rows = await fetchAllRows(deviceId, stream, from, to);
  const blob = new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: `${label}-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  flash(`${label}: ${rows.length} registro(s) exportado(s).`);
}

function drawPatientSteps(box, rows, hasBand) {
  const points = rows.map((r) => ({ ts: Number(r.ts), value: Number(r.steps) })).filter((p) => Number.isFinite(p.value));
  if (!points.length) { box.replaceChildren(el("div", { class: "chart-empty" }, hasBand ? "Sem registros de passos neste período." : "Voluntário sem pulseira vinculada.")); return; }
  const max = Math.max(1, ...points.map((p) => p.value));
  const shown = points.slice(-30);
  const bars = el("div", { class: "chart-bars", role: "list" }, ...shown.map((p) => {
    const bar = el("div", { class: "chart-bar", role: "listitem", title: `${dateLabel(p.ts)} · ${p.value.toLocaleString("pt-BR")} passos` });
    bar.append(el("span", { style: `--bar-height:${Math.max(2, p.value / max * 100)}%` }));
    return bar;
  }));
  box.replaceChildren(bars, el("div", { class: "chart-labels" }, dateLabel(shown[0].ts), `${Math.max(...points.map((p) => p.value)).toLocaleString("pt-BR")} passos`, dateLabel(shown.at(-1).ts)));
}

async function loadPatientData() {
  const patient = patients.find((p) => p.id === selectedPatientId);
  if (!patient) return setPatientEmpty("Selecione um voluntário.");
  const request = ++patRequest;
  $("#patNotice").classList.add("hidden");
  $("#patUpdatedAt").textContent = "Atualizando…";
  const to = Date.now(); const from = to - Number($("#patRange").value); const span = to - from;
  try {
    const detail = await api("GET", `/v1/patients/${encodeURIComponent(patient.id)}`);
    if (request !== patRequest || !apiKey) return;
    const band = detail.devices.find((d) => d.type === "miband");
    const cgm = detail.devices.find((d) => d.type === "cgm");
    renderPatientHeader(detail, band, cgm);

    const exp = $("#patExport"); exp.replaceChildren();
    if (band) {
      exp.append(el("button", { class: "btn secondary", onclick: guard(() => exportStream(band.id, "heart-rate", `FC-${detail.name}`, from, to)) }, "FC"));
      exp.append(el("button", { class: "btn secondary", onclick: guard(() => exportStream(band.id, "steps", `Passos-${detail.name}`, from, to)) }, "Passos"));
      exp.append(el("button", { class: "btn secondary", onclick: guard(() => exportStream(band.id, "events", `Eventos-${detail.name}`, from, to)) }, "Eventos"));
    }
    if (cgm) {
      exp.append(el("button", { class: "btn secondary", onclick: guard(() => exportStream(cgm.id, "glucose", `Glicemia-${detail.name}`, from, to)) }, "Glicemia"));
    }
    if (!band && !cgm) exp.replaceChildren(el("span", { class: "muted" }, "Sem dispositivos."));

    $("#kGluNow").textContent = patient.last_glucose != null ? mmolLabel(patient.last_glucose) : "—";
    $("#kGluNowAt").textContent = patient.last_glucose_ts ? dateLabel(patient.last_glucose_ts) : "sem leituras";
    $("#kAlerts").textContent = patient.unacked_alerts != null ? patient.unacked_alerts : "0";

    const bucket = span <= 86_400_000 ? "15m" : "1h";
    const win = `from=${from}&to=${to}`;
    const tasks = {};
    if (cgm) {
      tasks.glu = api("GET", `/v1/devices/${cgm.id}/glucose?${win}&bucket=${bucket}&limit=1000`).catch(() => null);
      tasks.gsum = api("GET", `/v1/devices/${cgm.id}/glucose/summary?${win}`).catch(() => null);
      tasks.gev = api("GET", `/v1/devices/${cgm.id}/glucose/events?${win}&limit=30&order=desc`).catch(() => null);
      tasks.aidex = api("GET", `/v1/devices/${cgm.id}/aidex`).catch(() => null);
    }
    if (band) {
      tasks.hr = api("GET", `/v1/devices/${band.id}/heart-rate?${win}&bucket=${bucket}&limit=1000`).catch(() => null);
      tasks.steps = api("GET", `/v1/devices/${band.id}/steps?${win}&bucket=${span <= 86_400_000 ? "1h" : "1d"}&tz_offset_min=-180&limit=1000`).catch(() => null);
      tasks.hrsum = api("GET", `/v1/devices/${band.id}/summary?${win}`).catch(() => null);
    }
    const keys = Object.keys(tasks);
    const vals = await Promise.all(keys.map((k) => tasks[k]));
    if (request !== patRequest || !apiKey) return;
    const r = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));

    drawGlucoseChart($("#gluChart"), (r.glu && r.glu.data) || []);
    const s = r.gsum;
    $("#kTir").textContent = s && s.samples ? `${Math.round(s.tir.in_range)}%` : "—";
    $("#kGmi").textContent = s && s.gmi_percent != null ? `${String(s.gmi_percent).replace(".", ",")}%` : "—";
    $("#kGluMean").textContent = s && s.mean_mmol != null ? `glicose média ${mmolLabel(s.mean_mmol)}` : "glicose média —";
    renderTir(s);
    renderGlucoseEvents((r.gev && r.gev.data) || []);
    renderAidex(cgm, r.aidex);

    drawPatientHr($("#patHrChart"), (r.hr && r.hr.data) || [], !!band);
    const h = (r.hrsum && r.hrsum.heart_rate) || {};
    $("#kHr").textContent = h.samples ? `${h.avg} bpm` : "—";
    $("#kHrRange").textContent = h.samples ? `mín. ${h.min} · máx. ${h.max}` : "sem amostras";

    drawPatientSteps($("#patStepsChart"), (r.steps && r.steps.data) || [], !!band);
    const st = (r.hrsum && r.hrsum.steps) || {};
    $("#kSteps").textContent = st.max_steps == null ? "—" : Number(st.max_steps).toLocaleString("pt-BR");
    const sl = (r.hrsum && r.hrsum.sleep) || {};
    $("#kSleep").textContent = sl.total_min ? `${Math.floor(sl.total_min / 60)}h ${String(sl.total_min % 60).padStart(2, "0")}min` : "—";

    $("#patUpdatedAt").textContent = `Atualizado ${fmt(Date.now())}`;
  } catch (e) {
    if (e.message !== "unauthorized") { const n = $("#patNotice"); n.className = "notice error"; n.classList.remove("hidden"); n.textContent = e.message; setPatientEmpty("Não foi possível carregar os dados."); }
  }
}

$("#patReload").addEventListener("click", guard(loadPatientData));
$("#patSelect").addEventListener("change", (e) => { selectedPatientId = e.target.value; guard(loadPatientData)(); });
$("#patRange").addEventListener("change", guard(loadPatientData));

document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
start();
