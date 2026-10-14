import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { authenticate, canAccess, guardDevice, requireAuth, type AppEnv } from "./auth";
import { createCommand, serializeCommand, type CommandRow } from "./commands";
import { COMMAND_TYPES, CommandRequest } from "./protocol";
import { detectSleep, loadKindMap, type ActivitySample } from "./sleep";
import { ALL_SCOPES, H_DEVICE, H_DEVICES, H_PRINCIPAL, H_ROLE, type Scope } from "./types";
import { newId, parseJson, parseTime, randomToken, sha256Hex } from "./util";
import { deliverOne, WEBHOOK_EVENTS } from "./webhooks";
import { openapi } from "./openapi";
import { participantApi } from "./participant-api";
import { effectiveConfig } from "./participants";
import * as aidex from "./aidex";
import type { AidexEnv } from "./aidex";

export const api = new Hono<AppEnv>();

// ====================================================================== utilidades

const MAX_LIMIT = 10_000;

async function body<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let json: unknown = {};
  try {
    const text = await c.req.text();
    json = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, res: c.json({ error: "bad_request", message: "JSON inválido." }, 400) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, res: c.json({ error: "validation", details: parsed.error.flatten() }, 400) };
  return { ok: true, data: parsed.data };
}

interface Range {
  from: number;
  to: number;
  limit: number;
  order: "ASC" | "DESC";
}

function range(c: Context<AppEnv>, defaultWindowMs = 24 * 3600_000): Range | Response {
  const q = c.req.query();
  const now = Date.now();
  const to = q.to ? parseTime(q.to) : now;
  const from = q.from ? parseTime(q.from) : (to ?? now) - defaultWindowMs;
  if (from === null || to === null) return c.json({ error: "bad_request", message: "'from'/'to' inválidos (use epoch em ms ou ISO 8601)." }, 400);
  const limit = Math.min(Math.max(Number(q.limit ?? 1000) || 1000, 1), MAX_LIMIT);
  return { from, to, limit, order: q.order?.toLowerCase() === "desc" ? "DESC" : "ASC" };
}

const isResponse = (v: unknown): v is Response => v instanceof Response;

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((k) => esc(r[k])).join(","))].join("\n");
}

/** Responde JSON ou CSV (`?format=csv`) com paginação por cursor de tempo. */
function series(c: Context<AppEnv>, rows: Record<string, unknown>[], r: Range, extra: Record<string, unknown> = {}) {
  if (c.req.query("format") === "csv") {
    return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8" } });
  }
  const last = rows.at(-1) as { ts?: number } | undefined;
  const next = rows.length === r.limit && last?.ts !== undefined ? (r.order === "ASC" ? { from: last.ts + 1 } : { to: last.ts - 1 }) : null;
  return c.json({ data: rows, count: rows.length, next, ...extra });
}

const BUCKETS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "1d": 86_400_000 };

async function loadDevice(c: Context<AppEnv>, id: string) {
  return c.env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<DeviceRow>();
}

interface DeviceRow {
  id: string;
  name: string;
  patient_ref: string | null;
  notes: string | null;
  metadata: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  online: number;
  band_info: string | null;
  client_info: string | null;
  archived_at: number | null;
  status: string;
  consent_version: string | null;
  consent_at: number | null;
  config: string;
  config_version: number;
  config_updated_at: number | null;
}

const serializeDevice = (d: DeviceRow) => ({
  id: d.id,
  name: d.name,
  patient_ref: d.patient_ref,
  notes: d.notes,
  metadata: parseJson(d.metadata, {}),
  created_at: d.created_at,
  updated_at: d.updated_at,
  last_seen_at: d.last_seen_at,
  online: Boolean(d.online),
  band: parseJson(d.band_info, null),
  client: parseJson(d.client_info, null),
  archived_at: d.archived_at,
  status: d.status,
  consent_version: d.consent_version,
  consent_at: d.consent_at,
  config: effectiveConfig(d.config),
  config_version: d.config_version,
  config_updated_at: d.config_updated_at,
});

/** Middleware: autentica, confere o escopo e o acesso da chave à pulseira e garante que ela existe. */
const deviceRoute = (...scopes: Scope[]): MiddlewareHandler<AppEnv> => {
  const auth = requireAuth(...scopes);
  return async (c, next) => {
    const failure = await auth(c, async () => {});
    if (failure) return failure;
    const id = c.req.param("id")!;
    const denied = guardDevice(c, id);
    if (denied) return denied;
    if (!(await loadDevice(c, id))) return c.json({ error: "not_found", message: "Pulseira não encontrada." }, 404);
    await next();
  };
};

// ====================================================================== público

api.get("/v1/health", (c) => c.json({ ok: true, time: Date.now() }));
api.get("/v1/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin)));
api.route("/", participantApi);

// ====================================================================== conexão do app

api.get("/v1/connect", async (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.json({ error: "bad_request", message: "Esperado WebSocket." }, 426);
  const token = c.req.header("authorization")?.replace(/^bearer /i, "") ?? c.req.query("access_token");
  if (!token?.startsWith("mbd_")) return c.json({ error: "unauthorized", message: "Token de dispositivo (mbd_…) ausente." }, 401);
  const row = await c.env.DB.prepare("SELECT id, status FROM devices WHERE token_hash = ? AND archived_at IS NULL").bind(await sha256Hex(token)).first<{ id: string; status: string }>();
  if (!row) return c.json({ error: "unauthorized", message: "Token de dispositivo inválido." }, 401);
  if (row.status === "revoked") return c.json({ error: "forbidden", message: "Instalação não autorizada." }, 403);

  const headers = new Headers(c.req.raw.headers);
  headers.set(H_ROLE, "device");
  headers.set(H_DEVICE, row.id);
  headers.set(H_PRINCIPAL, `device:${row.id}`);
  headers.delete("authorization");
  return c.env.HUB.get(c.env.HUB.idFromName(row.id)).fetch(new Request(c.req.url, { headers }));
});

// ====================================================================== fluxos em tempo real (visores)

function viewerRequest(c: Context<AppEnv>, deviceId: string | null): Request {
  const p = c.get("principal");
  const headers = new Headers(c.req.raw.headers);
  headers.set(H_ROLE, "viewer");
  if (deviceId) headers.set(H_DEVICE, deviceId);
  headers.set(H_PRINCIPAL, p.id);
  if (p.deviceIds) headers.set(H_DEVICES, JSON.stringify(p.deviceIds));
  headers.delete("authorization");
  return new Request(c.req.url, { headers });
}

api.get("/v1/devices/:id/stream", deviceRoute("read"), (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.json({ error: "bad_request", message: "Esperado WebSocket." }, 426);
  const id = c.req.param("id")!;
  return c.env.HUB.get(c.env.HUB.idFromName(id)).fetch(viewerRequest(c, id));
});

api.get("/v1/stream", requireAuth("read"), (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.json({ error: "bad_request", message: "Esperado WebSocket." }, 426);
  return c.env.FLEET.get(c.env.FLEET.idFromName("global")).fetch(viewerRequest(c, null));
});

// ====================================================================== pulseiras (CRUD)

const DeviceInput = z.object({
  name: z.string().min(1).max(120),
  patient_ref: z.string().max(120).nullish(),
  notes: z.string().max(2000).nullish(),
  metadata: z.record(z.unknown()).optional(),
});

api.post("/v1/devices", requireAuth("manage"), async (c) => {
  const b = await body(c, DeviceInput);
  if (!b.ok) return b.res;
  const id = newId("dev");
  const token = randomToken("mbd");
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO devices (id, name, patient_ref, notes, metadata, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, b.data.name, b.data.patient_ref ?? null, b.data.notes ?? null, JSON.stringify(b.data.metadata ?? {}), await sha256Hex(token), now, now)
    .run();
  const device = await loadDevice(c, id);
  // O token só é exibido agora; configure-o no app (campo "Token do dispositivo").
  return c.json({ ...serializeDevice(device!), device_token: token }, 201);
});

api.get("/v1/devices", requireAuth("read"), async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.archived !== "true") where.push("archived_at IS NULL");
  if (q.online) { where.push("online = ?"); args.push(q.online === "true" ? 1 : 0); }
  if (q.patient_ref) { where.push("patient_ref = ?"); args.push(q.patient_ref); }
  if (q.status) { where.push("status = ?"); args.push(q.status); }
  if (q.q) { where.push("(name LIKE ? OR patient_ref LIKE ?)"); args.push(`%${q.q}%`, `%${q.q}%`); }
  const p = c.get("principal");
  if (p.deviceIds) {
    if (!p.deviceIds.length) return c.json({ data: [], count: 0, next: null });
    where.push(`id IN (${p.deviceIds.map(() => "?").join(",")})`);
    args.push(...p.deviceIds);
  }
  const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);
  if (q.cursor) { where.push("id > ?"); args.push(q.cursor); }
  const { results } = await c.env.DB.prepare(`SELECT * FROM devices ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id LIMIT ?`)
    .bind(...args, limit)
    .all<DeviceRow>();
  return c.json({ data: results.map(serializeDevice), count: results.length, next: results.length === limit ? results.at(-1)!.id : null });
});

api.get("/v1/devices/:id", deviceRoute("read"), async (c) => c.json(serializeDevice((await loadDevice(c, c.req.param("id")!))!)));

api.patch("/v1/devices/:id", deviceRoute("manage"), async (c) => {
  const b = await body(c, DeviceInput.partial());
  if (!b.ok) return b.res;
  const id = c.req.param("id")!;
  const cur = (await loadDevice(c, id))!;
  await c.env.DB.prepare("UPDATE devices SET name = ?, patient_ref = ?, notes = ?, metadata = ?, updated_at = ? WHERE id = ?")
    .bind(
      b.data.name ?? cur.name,
      b.data.patient_ref === undefined ? cur.patient_ref : b.data.patient_ref,
      b.data.notes === undefined ? cur.notes : b.data.notes,
      b.data.metadata ? JSON.stringify(b.data.metadata) : cur.metadata,
      Date.now(),
      id,
    )
    .run();
  return c.json(serializeDevice((await loadDevice(c, id))!));
});

api.post("/v1/devices/:id/rotate-token", deviceRoute("manage"), async (c) => {
  const id = c.req.param("id")!;
  const token = randomToken("mbd");
  await c.env.DB.prepare("UPDATE devices SET token_hash = ?, updated_at = ? WHERE id = ?").bind(await sha256Hex(token), Date.now(), id).run();
  await c.env.HUB.get(c.env.HUB.idFromName(id)).kick("Token rotacionado");
  return c.json({ device_id: id, device_token: token });
});

/** Arquiva (padrão) ou apaga de vez com todos os dados (`?purge=true`, exige escopo admin). */
api.delete("/v1/devices/:id", deviceRoute("manage"), async (c) => {
  const id = c.req.param("id")!;
  await c.env.HUB.get(c.env.HUB.idFromName(id)).kick("Pulseira removida");
  if (c.req.query("purge") === "true") {
    if (!c.get("principal").scopes.has("admin")) return c.json({ error: "forbidden", message: "purge exige o escopo 'admin'." }, 403);
    const db = c.env.DB;
    await db.batch(
      ["heart_rate", "steps", "battery", "events", "activity", "commands", "alerts"].map((t) => db.prepare(`DELETE FROM ${t} WHERE device_id = ?`).bind(id))
        .concat(db.prepare("DELETE FROM alert_rules WHERE device_id = ?").bind(id), db.prepare("DELETE FROM devices WHERE id = ?").bind(id)),
    );
    return c.json({ deleted: id, purged: true });
  }
  await c.env.DB.prepare("UPDATE devices SET archived_at = ?, online = 0, updated_at = ? WHERE id = ?").bind(Date.now(), Date.now(), id).run();
  return c.json({ deleted: id, purged: false });
});

// ====================================================================== estado em tempo real

api.get("/v1/devices/:id/status", deviceRoute("read"), async (c) => {
  const id = c.req.param("id")!;
  const snap = await c.env.HUB.get(c.env.HUB.idFromName(id)).status(id);
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND status IN ('queued','sent')").bind(id).first<{ n: number }>();
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE device_id = ? AND acked_at IS NULL").bind(id).first<{ n: number }>();
  return c.json({ ...snap, t: undefined, pending_commands: pending?.n ?? 0, unacked_alerts: open?.n ?? 0 });
});

/** Visão geral de todos os pacientes (último valor de cada pulseira) em uma única chamada. */
api.get("/v1/overview", requireAuth("read"), async (c) => {
  const p = c.get("principal");
  const filter = p.deviceIds ? `AND d.id IN (${p.deviceIds.map(() => "?").join(",") || "NULL"})` : "";
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.name, d.patient_ref, d.online, d.last_seen_at,
       (SELECT bpm FROM heart_rate WHERE device_id = d.id ORDER BY ts DESC LIMIT 1) AS hr,
       (SELECT ts FROM heart_rate WHERE device_id = d.id ORDER BY ts DESC LIMIT 1) AS hr_ts,
       (SELECT level FROM battery WHERE device_id = d.id ORDER BY ts DESC LIMIT 1) AS battery,
       (SELECT steps FROM steps WHERE device_id = d.id ORDER BY ts DESC LIMIT 1) AS steps,
       (SELECT COUNT(*) FROM alerts WHERE device_id = d.id AND acked_at IS NULL) AS unacked_alerts
     FROM devices d WHERE d.archived_at IS NULL ${filter} ORDER BY d.name LIMIT 1000`,
  )
    .bind(...(p.deviceIds ?? []))
    .all();
  return c.json({ data: results.map((r) => ({ ...r, online: Boolean(r.online) })), count: results.length });
});

// ====================================================================== histórico

api.get("/v1/devices/:id/heart-rate", deviceRoute("read"), async (c) => {
  const r = range(c);
  if (isResponse(r)) return r;
  const id = c.req.param("id")!;
  const bucket = c.req.query("bucket");
  if (bucket) {
    const size = BUCKETS[bucket];
    if (!size) return c.json({ error: "bad_request", message: `bucket deve ser um de: ${Object.keys(BUCKETS).join(", ")}` }, 400);
    const { results } = await c.env.DB.prepare(
      `SELECT (ts / ${size}) * ${size} AS ts, ROUND(AVG(bpm), 1) AS avg, MIN(bpm) AS min, MAX(bpm) AS max, COUNT(*) AS samples
       FROM heart_rate WHERE device_id = ? AND ts BETWEEN ? AND ? GROUP BY ts / ${size} ORDER BY ts ${r.order} LIMIT ?`,
    ).bind(id, r.from, r.to, r.limit).all();
    return series(c, results as Record<string, unknown>[], r, { bucket });
  }
  const { results } = await c.env.DB.prepare("SELECT ts, bpm FROM heart_rate WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts " + r.order + " LIMIT ?")
    .bind(id, r.from, r.to, r.limit).all();
  return series(c, results as Record<string, unknown>[], r);
});

api.get("/v1/devices/:id/steps", deviceRoute("read"), async (c) => {
  const r = range(c, 7 * 86400_000);
  if (isResponse(r)) return r;
  const id = c.req.param("id")!;
  const bucket = c.req.query("bucket");
  if (bucket) {
    // O contador da pulseira zera à meia-noite; o máximo do dia é o total do dia.
    const size = BUCKETS[bucket];
    if (!size) return c.json({ error: "bad_request", message: `bucket deve ser um de: ${Object.keys(BUCKETS).join(", ")}` }, 400);
    // Interpolado (já validado como inteiro): o D1 manda números como REAL e a divisão deixaria de ser inteira.
    const offset = Math.trunc(Number(c.req.query("tz_offset_min") ?? 0) || 0) * 60_000;
    const { results } = await c.env.DB.prepare(
      `SELECT ((ts + ${offset}) / ${size}) * ${size} - ${offset} AS ts, MAX(steps) AS steps, MAX(meters) AS meters, MAX(calories) AS calories
       FROM steps WHERE device_id = ? AND ts BETWEEN ? AND ? GROUP BY (ts + ${offset}) / ${size} ORDER BY ts ${r.order} LIMIT ?`,
    ).bind(id, r.from, r.to, r.limit).all();
    return series(c, results as Record<string, unknown>[], r, { bucket });
  }
  const { results } = await c.env.DB.prepare("SELECT ts, steps, meters, calories FROM steps WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts " + r.order + " LIMIT ?")
    .bind(id, r.from, r.to, r.limit).all();
  return series(c, results as Record<string, unknown>[], r);
});

api.get("/v1/devices/:id/battery", deviceRoute("read"), async (c) => {
  const r = range(c, 7 * 86400_000);
  if (isResponse(r)) return r;
  const { results } = await c.env.DB.prepare("SELECT ts, level, charging FROM battery WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts " + r.order + " LIMIT ?")
    .bind(c.req.param("id")!, r.from, r.to, r.limit).all();
  return series(c, results.map((x) => ({ ...x, charging: Boolean(x.charging) })), r);
});

api.get("/v1/devices/:id/events", deviceRoute("read"), async (c) => {
  const r = range(c, 7 * 86400_000);
  if (isResponse(r)) return r;
  const type = c.req.query("type");
  const { results } = await c.env.DB.prepare(
    `SELECT ts, type, data FROM events WHERE device_id = ? AND ts BETWEEN ? AND ? ${type ? "AND type = ?" : ""} ORDER BY ts ${r.order} LIMIT ?`,
  ).bind(...[c.req.param("id")!, r.from, r.to, ...(type ? [type] : []), r.limit]).all<{ ts: number; type: string; data: string | null }>();
  return series(c, results.map((e) => ({ ts: e.ts, type: e.type, data: parseJson(e.data, null) })), r);
});

api.get("/v1/devices/:id/activity", deviceRoute("read"), async (c) => {
  const r = range(c);
  if (isResponse(r)) return r;
  const { results } = await c.env.DB.prepare("SELECT ts, kind, intensity, steps, hr FROM activity WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts " + r.order + " LIMIT ?")
    .bind(c.req.param("id")!, r.from, r.to, r.limit).all();
  return series(c, results as Record<string, unknown>[], r);
});

/** Sessões de sono derivadas do histórico por minuto (classificação ainda provisória; ver sleep.ts). */
api.get("/v1/devices/:id/sleep", deviceRoute("read"), async (c) => {
  const r = range(c, 3 * 86400_000);
  if (isResponse(r)) return r;
  const { results } = await c.env.DB.prepare("SELECT ts, kind, intensity, steps, hr FROM activity WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT 20000")
    .bind(c.req.param("id")!, r.from, r.to).all<ActivitySample>();
  const map = loadKindMap(c.env.SLEEP_KIND_MAP);
  const sessions = detectSleep(results, map);
  const kinds = [...new Set(results.map((s) => s.kind))].sort((a, b) => a - b);
  return c.json({
    data: sessions,
    count: sessions.length,
    kind_map: map,
    kinds_seen: kinds,
    warning: "Classificação provisória: confirme o mapa de categorias com uma pulseira real (variável SLEEP_KIND_MAP).",
  });
});

/** Resumo por dia: FC (média/mín/máx), passos, eventos, alertas. */
api.get("/v1/devices/:id/summary", deviceRoute("read"), async (c) => {
  const r = range(c, 86400_000);
  if (isResponse(r)) return r;
  const id = c.req.param("id")!;
  const db = c.env.DB;
  const [hr, steps, battery, events, alerts, sleep] = await Promise.all([
    db.prepare("SELECT ROUND(AVG(bpm),1) AS avg, MIN(bpm) AS min, MAX(bpm) AS max, COUNT(*) AS samples FROM heart_rate WHERE device_id = ? AND ts BETWEEN ? AND ?").bind(id, r.from, r.to).first(),
    db.prepare("SELECT MAX(steps) AS max_steps, MAX(meters) AS max_meters, MAX(calories) AS max_calories FROM steps WHERE device_id = ? AND ts BETWEEN ? AND ?").bind(id, r.from, r.to).first(),
    db.prepare("SELECT MIN(level) AS min_level, MAX(level) AS max_level FROM battery WHERE device_id = ? AND ts BETWEEN ? AND ?").bind(id, r.from, r.to).first(),
    db.prepare("SELECT type, COUNT(*) AS n FROM events WHERE device_id = ? AND ts BETWEEN ? AND ? GROUP BY type").bind(id, r.from, r.to).all(),
    db.prepare("SELECT severity, COUNT(*) AS n FROM alerts WHERE device_id = ? AND ts BETWEEN ? AND ? GROUP BY severity").bind(id, r.from, r.to).all(),
    db.prepare("SELECT ts, kind, intensity, steps, hr FROM activity WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT 20000").bind(id, r.from, r.to).all<ActivitySample>(),
  ]);
  const sessions = detectSleep(sleep.results, loadKindMap(c.env.SLEEP_KIND_MAP));
  return c.json({
    from: r.from,
    to: r.to,
    heart_rate: hr,
    steps,
    battery,
    events: events.results,
    alerts: alerts.results,
    sleep: { sessions: sessions.length, total_min: sessions.reduce((a, s) => a + s.duration_min, 0), provisional: true },
  });
});

// ====================================================================== glicemia (AiDEX)

function pickAidexEnv(c: Context<AppEnv>, value?: unknown): AidexEnv {
  const v = (value ?? c.env.AIDEX_ENV ?? "sandbox") as string;
  return v === "production" ? "production" : "sandbox";
}

/** Estado do vínculo AiDEX da pulseira (nunca expõe tokens). */
api.get("/v1/devices/:id/aidex", deviceRoute("read"), async (c) => {
  const link = await aidex.getLink(c.env, c.req.param("id")!);
  if (!link) return c.json({ status: "unlinked" });
  return c.json({
    status: link.status,
    env: link.env,
    cursor_at: link.cursor_at,
    last_poll_at: link.last_poll_at,
    last_error: link.last_error,
    updated_at: link.updated_at,
  });
});

/** Inicia o vínculo: devolve a URL oficial de autorização para o paciente abrir e autorizar. */
api.post("/v1/devices/:id/aidex/connect", deviceRoute("manage"), async (c) => {
  if (!c.env.AIDEX_CLIENT_ID) return c.json({ error: "not_configured", message: "AIDEX_CLIENT_ID não configurado." }, 503);
  const id = c.req.param("id")!;
  const b = await body(c, z.object({ env: z.enum(["sandbox", "production"]).optional() }));
  if (!b.ok) return b.res;
  const env = pickAidexEnv(c, b.data.env);
  const state = randomToken("st");
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO aidex_links (device_id, env, status, state, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET env = excluded.env, status = 'pending', state = excluded.state, updated_at = excluded.updated_at`,
  ).bind(id, env, state, now, now).run();
  return c.json({ authorize_url: aidex.authorizeUrl(c.env, env, state), env });
});

/**
 * Callback do OAuth (público: é o redirect do navegador do paciente após autorizar).
 * Validado pelo `state`. Registre este endpoint como redirect_uri no Console da AiDEX.
 */
api.get("/v1/aidex/callback", async (c) => {
  const { code, state, error } = c.req.query();
  const page = (msg: string) => c.html(`<!doctype html><meta charset=utf-8><title>BIOSENSE · AiDEX</title><body style="font-family:system-ui;padding:2rem;max-width:30rem;margin:auto"><h2>BIOSENSE × AiDEX</h2><p>${msg}</p></body>`);
  if (!state) return page("Requisição inválida: faltou o parâmetro <code>state</code>.");
  const row = await c.env.DB.prepare("SELECT device_id, env FROM aidex_links WHERE state = ?").bind(state).first<{ device_id: string; env: AidexEnv }>();
  if (!row) return page("Autorização não reconhecida (state expirado ou já usado).");
  if (error) {
    await c.env.DB.prepare("UPDATE aidex_links SET status='error', last_error=?, state=NULL, updated_at=? WHERE device_id=?")
      .bind(`authorize: ${error}`, Date.now(), row.device_id).run();
    return page(`A autorização foi negada ou falhou (<code>${error}</code>). Você pode fechar esta janela.`);
  }
  if (!code) return page("Requisição inválida: faltou o parâmetro <code>code</code>.");
  try {
    await aidex.exchangeCode(c.env, row.device_id, row.env, code);
    await c.env.DB.prepare("UPDATE aidex_links SET state=NULL, updated_at=? WHERE device_id=?").bind(Date.now(), row.device_id).run();
    const link2 = (await aidex.getLink(c.env, row.device_id))!;
    c.executionCtx.waitUntil(aidex.pollDevice(c.env, link2).catch(() => {}));
    return page("Conta AiDEX conectada com sucesso. A coleta de glicemia começou. Você pode fechar esta janela.");
  } catch (e) {
    await c.env.DB.prepare("UPDATE aidex_links SET status='error', last_error=?, updated_at=? WHERE device_id=?")
      .bind(e instanceof Error ? e.message : String(e), Date.now(), row.device_id).run();
    return page("Não foi possível concluir a conexão. Tente novamente mais tarde.");
  }
});

/** Dispara uma coleta imediata (além do cron). */
api.post("/v1/devices/:id/aidex/poll", deviceRoute("manage"), async (c) => {
  const link = await aidex.getLink(c.env, c.req.param("id")!);
  if (!link || link.status === "pending") return c.json({ error: "not_linked", message: "Pulseira sem vínculo AiDEX ativo." }, 409);
  try {
    const r = await aidex.pollDevice(c.env, link);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ error: "poll_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Desfaz o vínculo localmente. (A revogação definitiva é feita pelo paciente no app AiDEX.) */
api.delete("/v1/devices/:id/aidex", deviceRoute("manage"), async (c) => {
  await c.env.DB.prepare("DELETE FROM aidex_links WHERE device_id = ?").bind(c.req.param("id")!).run();
  return c.body(null, 204);
});

api.get("/v1/devices/:id/glucose", deviceRoute("read"), async (c) => {
  const r = range(c);
  if (isResponse(r)) return r;
  const id = c.req.param("id")!;
  const bucket = c.req.query("bucket");
  if (bucket) {
    const size = BUCKETS[bucket];
    if (!size) return c.json({ error: "bad_request", message: `bucket deve ser um de: ${Object.keys(BUCKETS).join(", ")}` }, 400);
    const { results } = await c.env.DB.prepare(
      `SELECT (ts / ${size}) * ${size} AS ts, ROUND(AVG(mmol), 2) AS avg, ROUND(MIN(mmol), 2) AS min, ROUND(MAX(mmol), 2) AS max, COUNT(*) AS samples
       FROM glucose WHERE device_id = ? AND ts BETWEEN ? AND ? GROUP BY ts / ${size} ORDER BY ts ${r.order} LIMIT ?`,
    ).bind(id, r.from, r.to, r.limit).all();
    return series(c, results as Record<string, unknown>[], r, { bucket, unit: "mmol/L" });
  }
  const { results } = await c.env.DB.prepare("SELECT ts, mmol, warning FROM glucose WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts " + r.order + " LIMIT ?")
    .bind(id, r.from, r.to, r.limit).all();
  return series(c, results as Record<string, unknown>[], r, { unit: "mmol/L" });
});

api.get("/v1/devices/:id/glucose/summary", deviceRoute("read"), async (c) => {
  const r = range(c, 14 * 86400_000); // janela padrão de 14 dias (padrão clínico de relatório CGM)
  if (isResponse(r)) return r;
  const { results } = await c.env.DB.prepare("SELECT ts, mmol FROM glucose WHERE device_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC")
    .bind(c.req.param("id")!, r.from, r.to).all<{ ts: number; mmol: number }>();
  return c.json({ window_from: r.from, window_to: r.to, unit: "mmol/L", ...aidex.summarize(results) });
});

api.get("/v1/devices/:id/glucose/events", deviceRoute("read"), async (c) => {
  const r = range(c, 7 * 86400_000);
  if (isResponse(r)) return r;
  const type = c.req.query("type");
  const base = "SELECT type, ext_id, ts, payload FROM glucose_events WHERE device_id = ? AND ts BETWEEN ? AND ?";
  const q = type ? base + " AND type = ? ORDER BY ts " + r.order + " LIMIT ?" : base + " ORDER BY ts " + r.order + " LIMIT ?";
  const binds = type ? [c.req.param("id")!, r.from, r.to, type, r.limit] : [c.req.param("id")!, r.from, r.to, r.limit];
  const { results } = await c.env.DB.prepare(q).bind(...binds).all<Record<string, unknown>>();
  return c.json({ data: results.map((e) => ({ ...e, payload: parseJson(e.payload as string, {}) })), count: results.length });
});

// ====================================================================== comandos

api.post("/v1/devices/:id/commands", deviceRoute("command"), async (c) => {
  const b = await body(c, CommandRequest);
  if (!b.ok) return b.res;
  const result = await createCommand(c.env, c.req.param("id")!, b.data, c.get("principal").id);
  if (!result.ok) return c.json({ error: "bad_request", message: result.error, details: result.details, supported_types: COMMAND_TYPES }, result.status);
  return c.json(result.command, 202);
});

/** Atalho: vibrar. Corpo opcional: { count, durationMs, pauseMs, level }. */
api.post("/v1/devices/:id/vibrate", deviceRoute("command"), async (c) => {
  const b = await body(c, z.record(z.unknown()));
  if (!b.ok) return b.res;
  const { ttl_s, ...params } = b.data as Record<string, unknown> & { ttl_s?: number };
  const result = await createCommand(c.env, c.req.param("id")!, { type: "vibrate", params, ttl_s: ttl_s ?? 60 }, c.get("principal").id);
  if (!result.ok) return c.json({ error: "bad_request", message: result.error, details: result.details }, result.status);
  return c.json(result.command, 202);
});

api.get("/v1/devices/:id/commands", deviceRoute("read"), async (c) => {
  const r = range(c, 7 * 86400_000);
  if (isResponse(r)) return r;
  const status = c.req.query("status");
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM commands WHERE device_id = ? AND created_at BETWEEN ? AND ? ${status ? "AND status = ?" : ""} ORDER BY created_at ${r.order} LIMIT ?`,
  ).bind(...[c.req.param("id")!, r.from, r.to, ...(status ? [status] : []), r.limit]).all<CommandRow>();
  return c.json({ data: results.map(serializeCommand), count: results.length });
});

api.get("/v1/devices/:id/commands/:cid", deviceRoute("read"), async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM commands WHERE id = ? AND device_id = ?").bind(c.req.param("cid")!, c.req.param("id")!).first<CommandRow>();
  return row ? c.json(serializeCommand(row)) : c.json({ error: "not_found" }, 404);
});

api.delete("/v1/devices/:id/commands/:cid", deviceRoute("command"), async (c) => {
  const res = await c.env.DB.prepare("UPDATE commands SET status = 'cancelled' WHERE id = ? AND device_id = ? AND status = 'queued'")
    .bind(c.req.param("cid")!, c.req.param("id")!).run();
  if (!res.meta.changes) return c.json({ error: "conflict", message: "Só comandos ainda na fila (queued) podem ser cancelados." }, 409);
  return c.json({ cancelled: c.req.param("cid") });
});

// ====================================================================== regras de alerta e alertas

const RuleInput = z.object({
  device_id: z.string().nullish(),
  name: z.string().min(1).max(120),
  metric: z.enum(["heart_rate", "battery", "offline", "event"]),
  op: z.enum(["gt", "gte", "lt", "lte", "eq"]).default("gt"),
  threshold: z.number().nullish(),
  match: z.string().max(64).nullish(),
  duration_s: z.number().int().min(0).max(86400).default(0),
  cooldown_s: z.number().int().min(0).max(604800).default(300),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
  action: z
    .object({
      vibrate: z.union([z.boolean(), z.record(z.unknown())]).optional(),
      message: z.object({ kind: z.string().optional(), title: z.string(), body: z.string().optional() }).optional(),
    })
    .default({}),
  enabled: z.boolean().default(true),
}).superRefine((r, ctx) => {
  if (r.metric === "event" && !r.match) ctx.addIssue({ code: "custom", message: "metric=event exige 'match' (tipo do evento).", path: ["match"] });
  if (r.metric !== "event" && (r.threshold === null || r.threshold === undefined)) ctx.addIssue({ code: "custom", message: "'threshold' é obrigatório.", path: ["threshold"] });
});

/** Chaves restritas a certas pulseiras só mexem em regras dessas pulseiras. */
function ownsRule(c: Context<AppEnv>, rule: Record<string, unknown>): boolean {
  const p = c.get("principal");
  return p.deviceIds === null || Boolean(rule.device_id && p.deviceIds.includes(rule.device_id as string));
}

const serializeRule = (r: Record<string, unknown>) => ({ ...r, action: parseJson(r.action as string, {}), enabled: Boolean(r.enabled) });

api.post("/v1/alert-rules", requireAuth("manage"), async (c) => {
  const b = await body(c, RuleInput);
  if (!b.ok) return b.res;
  const r = b.data;
  if (r.device_id && !canAccess(c.get("principal"), r.device_id)) return c.json({ error: "forbidden" }, 403);
  if (!r.device_id && c.get("principal").deviceIds) return c.json({ error: "forbidden", message: "Chaves restritas só criam regras para suas pulseiras." }, 403);
  const id = newId("rul");
  await c.env.DB.prepare(
    "INSERT INTO alert_rules (id, device_id, name, metric, op, threshold, match, duration_s, cooldown_s, severity, action, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, r.device_id ?? null, r.name, r.metric, r.op, r.threshold ?? null, r.match ?? null, r.duration_s, r.cooldown_s, r.severity, JSON.stringify(r.action), r.enabled ? 1 : 0, Date.now()).run();
  const row = await c.env.DB.prepare("SELECT * FROM alert_rules WHERE id = ?").bind(id).first();
  return c.json(serializeRule(row!), 201);
});

api.get("/v1/alert-rules", requireAuth("read"), async (c) => {
  const device = c.req.query("device_id");
  const { results } = await c.env.DB.prepare(`SELECT * FROM alert_rules ${device ? "WHERE device_id = ? OR device_id IS NULL" : ""} ORDER BY created_at DESC LIMIT 500`)
    .bind(...(device ? [device] : [])).all();
  const p = c.get("principal");
  const visible = results.filter((r) => !p.deviceIds || (r.device_id && p.deviceIds.includes(r.device_id as string)));
  return c.json({ data: visible.map(serializeRule), count: visible.length });
});

api.patch("/v1/alert-rules/:rid", requireAuth("manage"), async (c) => {
  const rid = c.req.param("rid")!;
  const cur = await c.env.DB.prepare("SELECT * FROM alert_rules WHERE id = ?").bind(rid).first<Record<string, unknown>>();
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (!ownsRule(c, cur)) return c.json({ error: "forbidden" }, 403);
  const merged = { ...cur, action: parseJson(cur.action as string, {}), enabled: Boolean(cur.enabled) };
  const patch = await body(c, z.record(z.unknown()));
  if (!patch.ok) return patch.res;
  const b = RuleInput.safeParse({ ...merged, ...patch.data });
  if (!b.success) return c.json({ error: "validation", details: b.error.flatten() }, 400);
  const r = b.data;
  await c.env.DB.prepare(
    "UPDATE alert_rules SET device_id=?, name=?, metric=?, op=?, threshold=?, match=?, duration_s=?, cooldown_s=?, severity=?, action=?, enabled=? WHERE id=?",
  ).bind(r.device_id ?? null, r.name, r.metric, r.op, r.threshold ?? null, r.match ?? null, r.duration_s, r.cooldown_s, r.severity, JSON.stringify(r.action), r.enabled ? 1 : 0, rid).run();
  return c.json(serializeRule((await c.env.DB.prepare("SELECT * FROM alert_rules WHERE id = ?").bind(rid).first())!));
});

api.delete("/v1/alert-rules/:rid", requireAuth("manage"), async (c) => {
  const cur = await c.env.DB.prepare("SELECT device_id FROM alert_rules WHERE id = ?").bind(c.req.param("rid")!).first<Record<string, unknown>>();
  if (cur && !ownsRule(c, cur)) return c.json({ error: "forbidden" }, 403);
  const res = await c.env.DB.prepare("DELETE FROM alert_rules WHERE id = ?").bind(c.req.param("rid")!).run();
  return res.meta.changes ? c.json({ deleted: c.req.param("rid") }) : c.json({ error: "not_found" }, 404);
});

api.get("/v1/alerts", requireAuth("read"), async (c) => {
  const q = c.req.query();
  const r = range(c, 7 * 86400_000);
  if (isResponse(r)) return r;
  const where = ["ts BETWEEN ? AND ?"];
  const args: unknown[] = [r.from, r.to];
  if (q.device_id) { where.push("device_id = ?"); args.push(q.device_id); }
  if (q.severity) { where.push("severity = ?"); args.push(q.severity); }
  if (q.acked === "false") where.push("acked_at IS NULL");
  if (q.acked === "true") where.push("acked_at IS NOT NULL");
  const p = c.get("principal");
  if (p.deviceIds) {
    where.push(`device_id IN (${p.deviceIds.map(() => "?").join(",") || "NULL"})`);
    args.push(...p.deviceIds);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM alerts WHERE ${where.join(" AND ")} ORDER BY ts ${r.order} LIMIT ?`).bind(...args, r.limit).all();
  return series(c, results as Record<string, unknown>[], r);
});

api.post("/v1/alerts/:aid/ack", requireAuth("command"), async (c) => {
  const aid = c.req.param("aid")!;
  const row = await c.env.DB.prepare("SELECT device_id FROM alerts WHERE id = ?").bind(aid).first<{ device_id: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!canAccess(c.get("principal"), row.device_id)) return c.json({ error: "forbidden" }, 403);
  await c.env.DB.prepare("UPDATE alerts SET acked_at = COALESCE(acked_at, ?), acked_by = COALESCE(acked_by, ?) WHERE id = ?").bind(Date.now(), c.get("principal").id, aid).run();
  return c.json((await c.env.DB.prepare("SELECT * FROM alerts WHERE id = ?").bind(aid).first())!);
});

// ====================================================================== webhooks

const WebhookInput = z.object({
  url: z.string().url().refine((u) => u.startsWith("https://"), "Use https://"),
  events: z.array(z.enum([...WEBHOOK_EVENTS, "*"])).min(1).default(["*"]),
  device_id: z.string().nullish(),
  enabled: z.boolean().default(true),
});

const serializeWebhook = (w: Record<string, unknown>) => ({ ...w, secret: undefined, events: parseJson(w.events as string, []), enabled: Boolean(w.enabled) });

api.post("/v1/webhooks", requireAuth("manage"), async (c) => {
  const b = await body(c, WebhookInput);
  if (!b.ok) return b.res;
  if (b.data.device_id && !canAccess(c.get("principal"), b.data.device_id)) return c.json({ error: "forbidden" }, 403);
  if (!b.data.device_id && c.get("principal").deviceIds) return c.json({ error: "forbidden", message: "Chaves restritas precisam informar device_id." }, 403);
  const id = newId("whk");
  const secret = randomToken("whsec");
  await c.env.DB.prepare("INSERT INTO webhooks (id, url, secret, events, device_id, enabled, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, b.data.url, secret, JSON.stringify(b.data.events), b.data.device_id ?? null, b.data.enabled ? 1 : 0, Date.now()).run();
  const row = await c.env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(id).first<Record<string, unknown>>();
  return c.json({ ...serializeWebhook(row!), secret }, 201); // o segredo só aparece aqui
});

api.get("/v1/webhooks", requireAuth("manage"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM webhooks ORDER BY created_at DESC LIMIT 200").all<Record<string, unknown>>();
  const p = c.get("principal");
  const visible = results.filter((w) => !p.deviceIds || (w.device_id && p.deviceIds.includes(w.device_id as string)));
  return c.json({ data: visible.map(serializeWebhook), count: visible.length });
});

api.patch("/v1/webhooks/:wid", requireAuth("manage"), async (c) => {
  const wid = c.req.param("wid")!;
  const cur = await c.env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(wid).first<Record<string, unknown>>();
  if (!cur) return c.json({ error: "not_found" }, 404);
  if (cur.device_id ? !canAccess(c.get("principal"), cur.device_id as string) : c.get("principal").deviceIds !== null) return c.json({ error: "forbidden" }, 403);
  const patch = await body(c, WebhookInput.partial());
  if (!patch.ok) return patch.res;
  const m = { url: cur.url as string, events: parseJson<string[]>(cur.events as string, []), enabled: Boolean(cur.enabled), ...patch.data };
  // Reativar zera a contagem de falhas.
  await c.env.DB.prepare("UPDATE webhooks SET url=?, events=?, enabled=?, failures=CASE WHEN ?=1 THEN 0 ELSE failures END WHERE id=?")
    .bind(m.url, JSON.stringify(m.events), m.enabled ? 1 : 0, m.enabled ? 1 : 0, wid).run();
  return c.json(serializeWebhook((await c.env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(wid).first<Record<string, unknown>>())!));
});

api.delete("/v1/webhooks/:wid", requireAuth("manage"), async (c) => {
  const cur = await c.env.DB.prepare("SELECT device_id FROM webhooks WHERE id = ?").bind(c.req.param("wid")!).first<{ device_id: string | null }>();
  const p = c.get("principal");
  if (cur && p.deviceIds !== null && !(cur.device_id && p.deviceIds.includes(cur.device_id))) return c.json({ error: "forbidden" }, 403);
  const res = await c.env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(c.req.param("wid")!).run();
  return res.meta.changes ? c.json({ deleted: c.req.param("wid") }) : c.json({ error: "not_found" }, 404);
});

api.post("/v1/webhooks/:wid/test", requireAuth("manage"), async (c) => {
  const w = await c.env.DB.prepare("SELECT id, url, secret, failures FROM webhooks WHERE id = ?").bind(c.req.param("wid")!).first<{ id: string; url: string; secret: string; failures: number }>();
  if (!w) return c.json({ error: "not_found" }, 404);
  const status = await deliverOne(c.env, w, "webhook.test", null, { message: "Teste de webhook" });
  return c.json({ delivered: status >= 200 && status < 300, status });
});

// ====================================================================== chaves de API (admin)

const KeyInput = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(ALL_SCOPES as [string, ...string[]])).min(1).default(["read"]),
  device_ids: z.array(z.string()).nullish(),
});

api.post("/v1/api-keys", requireAuth("admin"), async (c) => {
  const b = await body(c, KeyInput);
  if (!b.ok) return b.res;
  const id = newId("key");
  const token = randomToken("mbk");
  await c.env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, scopes, device_ids, created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, b.data.name, await sha256Hex(token), JSON.stringify(b.data.scopes), b.data.device_ids ? JSON.stringify(b.data.device_ids) : null, Date.now()).run();
  return c.json({ id, name: b.data.name, scopes: b.data.scopes, device_ids: b.data.device_ids ?? null, api_key: token }, 201);
});

api.get("/v1/api-keys", requireAuth("admin"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, scopes, device_ids, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC").all<Record<string, unknown>>();
  return c.json({ data: results.map((k) => ({ ...k, scopes: parseJson(k.scopes as string, []), device_ids: parseJson(k.device_ids as string | null, null) })) });
});

api.delete("/v1/api-keys/:kid", requireAuth("admin"), async (c) => {
  const res = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), c.req.param("kid")!).run();
  return res.meta.changes ? c.json({ revoked: c.req.param("kid") }) : c.json({ error: "not_found" }, 404);
});

api.get("/v1/me", async (c) => {
  const p = await authenticate(c.req.raw, c.env);
  if (!p) return c.json({ error: "unauthorized" }, 401);
  return c.json({ id: p.id, scopes: [...p.scopes], device_ids: p.deviceIds });
});

api.notFound((c) => c.json({ error: "not_found", message: "Rota inexistente. Veja /v1/openapi.json." }, 404));
api.onError((e, c) => {
  console.error("api error", e);
  return c.json({ error: "internal", message: "Erro interno." }, 500);
});
