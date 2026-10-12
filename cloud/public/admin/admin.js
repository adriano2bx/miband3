
"use strict";
const $ = (s) => document.querySelector(s);
const KEY = "biosense.admin.key";
let apiKey = sessionStorage.getItem(KEY) || "";
let devices = [];

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
  apiKey = ""; sessionStorage.removeItem(KEY);
  $("#app").classList.add("hidden"); $("#logout").classList.add("hidden"); $("#docsLink").classList.add("hidden"); $("#who").textContent = "";
  $("#login").classList.remove("hidden");
  $("#loginMsg").replaceChildren(msg ? el("div", { class: "notice error", style: "margin-top:12px" }, msg) : "");
}
async function start() {
  if (!apiKey) return logout();
  try {
    const me = await api("GET", "/v1/me");
    if (!me.scopes.includes("manage")) return logout("Esta chave não tem permissão de gestão.");
    $("#who").textContent = me.id === "admin" ? "Administrador" : "Gestão";
    $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); $("#logout").classList.remove("hidden"); $("#docsLink").classList.remove("hidden");
    loadInstalls();
  } catch (e) { if (e.message !== "unauthorized") logout(e.message); }
}
$("#loginForm").addEventListener("submit", (e) => { e.preventDefault(); apiKey = $("#key").value.trim(); sessionStorage.setItem(KEY, apiKey); $("#key").value = ""; start(); });
$("#logout").addEventListener("click", () => logout());

// ------------------------------------------------------------------ abas
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => { if (x === b) x.setAttribute("aria-current", "page"); else x.removeAttribute("aria-current"); });
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== b.dataset.tab));
  $("#flash").replaceChildren();
  ({ installs: loadInstalls, terms: loadTerms, techs: loadTechs, alerts: loadAlerts })[b.dataset.tab]();
}));

// ------------------------------------------------------------------ instalações
const statusLabel = { pending: "Pendente", active: "Autorizada", revoked: "Bloqueada" };
const hrLabel = (m) => (m === 0 ? "FC contínua" : m == null ? "Não configurada" : `FC a cada ${m} min`);
let selectedDeviceId = null;
let nextCursor = null;
let installsRequest = 0;
let loadedFilter = { status: "", q: "" };

const pulseIcon = () => el("img", { class: "pulse-icon", src: "/admin/assets/biosense-pulse.png", alt: "", width: "32", height: "44" });
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
    el("div", { class: "device-heading" }, pulseIcon(), el("div", {}, el("h2", {}, "BIOSENSE Pulse"), el("div", { class: "mono detail-id", title: d.id }, d.id))),
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
      el("td", {}, el("div", { class: "device-cell" }, pulseIcon(), el("div", {},
        el("button", { class: "device-id", "data-id": d.id, title: d.id, "aria-pressed": String(d.id === selectedDeviceId), "aria-label": `Selecionar BIOSENSE Pulse ${d.id}`, "aria-controls": "deviceDetail" }, shortId(d.id)),
        el("small", {}, "BIOSENSE Pulse")))),
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
      el("td", {}, t.scopes.includes("provision") ? "Testes e autorização" : "Testes"),
      el("td", {}, t.disabled_at ? el("span", { class: "pill revoked" }, "Desativado") : locked ? el("span", { class: "pill pending" }, "Bloqueado por tentativas") : el("span", { class: "pill active" }, "Ativo")),
      el("td", {}, t.disabled_at ? "" : el("div", { class: "actions" },
        locked ? el("button", { class: "btn secondary", onclick: () => techAction(t, { unlock: true }, "Desbloqueado.") }, "Desbloquear") : null,
        el("button", { class: "btn secondary", onclick: () => resetPassword(t) }, "Nova senha"),
        el("button", { class: "btn danger", onclick: () => disableTech(t) }, "Desativar"),
      )),
    );
  }));
});
$("#techForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  await api("POST", "/v1/technicians", { credential: $("#cCred").value.trim(), name: $("#cName").value.trim(), password: $("#cPass").value, scopes: $("#cProv").checked ? ["tech", "provision"] : ["tech"] });
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

document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
start();
