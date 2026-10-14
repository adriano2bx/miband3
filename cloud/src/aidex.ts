import type { Env } from "./types";
import { compare, describeRule, type AlertRule } from "./alerts";
import { deliverWebhooks } from "./webhooks";
import { createCommand } from "./commands";
import { newId, parseJson } from "./util";

/**
 * Integração somente-leitura com a AiDEX API Open Platform (OAuth 2.0).
 * Doc: https://aidexapi.microtechmd.com/doc/Overview
 *
 * Fluxo: o paciente (dono do sensor) autoriza o app BIOSENSE na tela oficial da AiDEX.
 * Guardamos access/refresh token por pulseira e coletamos a glicemia periodicamente.
 * Nada do app Android trafega aqui — é tudo server-to-server a partir do Worker.
 */

export const AIDEX_BASE = {
  sandbox: "https://sandbox-accesslist.microtechmd.com",
  production: "https://accesslist.microtechmd.com",
} as const;

export type AidexEnv = keyof typeof AIDEX_BASE;

/** Janela máxima por chamada de recurso (doc: 30 dias). Usamos uma margem de segurança. */
const WINDOW_MS = 29 * 86400_000;
/** Sobreposição ao retomar a coleta, para capturar leituras que chegaram atrasadas. */
const OVERLAP_MS = 10 * 60_000;
/** Renova o access_token se faltar menos que isto para expirar. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface AidexLink {
  device_id: string;
  env: AidexEnv;
  status: "pending" | "linked" | "revoked" | "error";
  state: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  cursor_at: number | null;
  last_poll_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const baseUrl = (env: AidexEnv) => AIDEX_BASE[env] ?? AIDEX_BASE.sandbox;

/** Formata epoch ms como o padrão da API: "YYYY-MM-DDTHH:mm:ss" em UTC, sem sufixo de fuso. */
export function toApiTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/** A API devolve tempos UTC sem sufixo (ex.: "2022-06-21T00:01:10"). Interpretamos como UTC. */
export function parseApiTime(value: string): number {
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : value + "Z";
  return Date.parse(iso);
}

// ------------------------------------------------------------------ armazenamento

export async function getLink(env: Env, deviceId: string): Promise<AidexLink | null> {
  return env.DB.prepare("SELECT * FROM aidex_links WHERE device_id = ?").bind(deviceId).first<AidexLink>();
}

async function saveTokens(
  env: Env,
  deviceId: string,
  tok: { access_token: string; refresh_token: string; expires_at: number },
): Promise<void> {
  await env.DB.prepare(
    "UPDATE aidex_links SET access_token = ?, refresh_token = ?, expires_at = ?, status = 'linked', last_error = NULL, updated_at = ? WHERE device_id = ?",
  )
    .bind(tok.access_token, tok.refresh_token, tok.expires_at, Date.now(), deviceId)
    .run();
}

async function setError(env: Env, deviceId: string, status: AidexLink["status"], message: string): Promise<void> {
  await env.DB.prepare("UPDATE aidex_links SET status = ?, last_error = ?, updated_at = ? WHERE device_id = ?")
    .bind(status, message.slice(0, 500), Date.now(), deviceId)
    .run();
}

// ------------------------------------------------------------------ OAuth

/** URL para onde o paciente é enviado para fazer login e autorizar o app. */
export function authorizeUrl(env: Env, aidexEnv: AidexEnv, state: string): string {
  const clientId = env.AIDEX_CLIENT_ID ?? "";
  return `${baseUrl(aidexEnv)}/v1/oauth2/authorize?clientId=${encodeURIComponent(clientId)}&responseType=code&state=${encodeURIComponent(state)}`;
}

interface TokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: string;
}

async function postToken(env: Env, aidexEnv: AidexEnv, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${baseUrl(aidexEnv)}/v1/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
    body: new URLSearchParams(form).toString(),
  });
  return (await res.json()) as TokenResponse;
}

/** Troca o `code` recebido no callback por access/refresh token e persiste no vínculo. */
export async function exchangeCode(env: Env, deviceId: string, aidexEnv: AidexEnv, code: string): Promise<AidexLink> {
  if (!env.AIDEX_CLIENT_ID || !env.AIDEX_CLIENT_SECRET) throw new Error("AIDEX_CLIENT_ID/SECRET não configurados.");
  const r = await postToken(env, aidexEnv, {
    clientId: env.AIDEX_CLIENT_ID,
    clientSecret: env.AIDEX_CLIENT_SECRET,
    code,
    grantType: "authorization_code",
  });
  if (!r.accessToken || !r.refreshToken) throw new Error(`Falha na troca do code: ${r.error ?? "resposta sem token"}`);
  await saveTokens(env, deviceId, {
    access_token: r.accessToken,
    refresh_token: r.refreshToken,
    expires_at: Date.now() + (r.expiresIn ?? 86400) * 1000,
  });
  return (await getLink(env, deviceId))!;
}

/**
 * Garante um access_token válido, renovando com refreshToken se necessário.
 * refreshToken é de uso único: o novo par é persistido na mesma transação lógica.
 */
async function ensureAccessToken(env: Env, link: AidexLink): Promise<string> {
  if (link.access_token && link.expires_at && link.expires_at - Date.now() > REFRESH_SKEW_MS) {
    return link.access_token;
  }
  if (!link.refresh_token) throw new Error("Sem refresh_token; é preciso reautorizar.");
  const r = await postToken(env, link.env, { refreshToken: link.refresh_token, grantType: "refresh_token" });
  if (!r.accessToken || !r.refreshToken) {
    // refreshToken inválido: o usuário revogou, trocou a senha, ou o token expirou.
    await setError(env, link.device_id, "revoked", `Refresh falhou: ${r.error ?? "sem token"}`);
    throw new Error(`Refresh falhou: ${r.error ?? "sem token"}`);
  }
  const tok = {
    access_token: r.accessToken,
    refresh_token: r.refreshToken,
    expires_at: Date.now() + (r.expiresIn ?? 86400) * 1000,
  };
  await saveTokens(env, link.device_id, tok);
  link.access_token = tok.access_token;
  link.refresh_token = tok.refresh_token;
  link.expires_at = tok.expires_at;
  return tok.access_token;
}

async function apiGet(env: Env, link: AidexLink, token: string, path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl(link.env)}${path}`, { headers: { authorization: token } });
  const json = (await res.json()) as { code?: number; success?: boolean; data?: unknown; msg?: string };
  // 10003 = token inválido/expirado.
  if (json.code === 10003) throw new Error("token_invalid");
  if (json.code !== 1 && json.success !== true) throw new Error(`AiDEX erro ${json.code ?? "?"}: ${json.msg ?? "desconhecido"}`);
  return json.data;
}

// ------------------------------------------------------------------ recursos

interface GlucosePoint {
  deviceTime: string;
  sensorGlucose: number;
  unit?: string;
  warning?: string | null;
}

interface DataRange {
  sensorGlucose?: { startTime: string; endTime: string };
}

/** Converte mmol/L -> mg/dL (fator padrão). */
export const mmolToMgdl = (mmol: number) => mmol * 18.0182;

// ------------------------------------------------------------------ coleta

/** Coleta a glicemia de um vínculo, da posição salva (cursor) até agora, em janelas de 30 dias. */
export async function pollDevice(env: Env, link: AidexLink): Promise<{ inserted: number; windows: number }> {
  if (link.status === "revoked") throw new Error("Vínculo revogado; reautorize.");
  let token = await ensureAccessToken(env, link);
  const now = Date.now();

  // Ponto de partida: cursor salvo (com sobreposição) ou início disponível na primeira coleta.
  let from = link.cursor_at ? link.cursor_at - OVERLAP_MS : null;
  if (from === null) {
    const dr = (await apiGet(env, link, token, "/v1/user/public/data-range")) as DataRange | null;
    const startStr = dr?.sensorGlucose?.startTime;
    const start = startStr ? parseApiTime(startStr) : now - WINDOW_MS;
    const maxBackfill = now - Number(env.AIDEX_BACKFILL_DAYS ?? "90") * 86400_000;
    from = Math.max(start, maxBackfill);
  }

  let inserted = 0;
  let windows = 0;
  for (let ws = from; ws < now; ws += WINDOW_MS + 1) {
    const we = Math.min(ws + WINDOW_MS, now);
    const path = `/v1/user/glu/sensor-glucose?startTime=${toApiTime(ws)}&endTime=${toApiTime(we)}`;
    let data: unknown;
    try {
      data = await apiGet(env, link, token, path);
    } catch (e) {
      if (e instanceof Error && e.message === "token_invalid") {
        token = await ensureAccessToken(env, { ...link, expires_at: 0 }); // força refresh
        data = await apiGet(env, link, token, path);
      } else {
        throw e;
      }
    }
    windows++;
    const points = Array.isArray(data) ? (data as GlucosePoint[]) : [];
    inserted += await insertGlucose(env, link.device_id, points);
  }

  await env.DB.prepare("UPDATE aidex_links SET cursor_at = ?, last_poll_at = ?, status = 'linked', updated_at = ? WHERE device_id = ?")
    .bind(now, now, now, link.device_id)
    .run();
  // Alertas de glicemia (hipo/hiper) sobre a leitura mais recente; não aborta a coleta se falhar.
  if (inserted > 0) {
    try { await evaluateGlucoseAlerts(env, link.device_id); } catch (e) { console.error("glucose alerts", e); }
  }
  return { inserted, windows };
}

async function insertGlucose(env: Env, deviceId: string, points: GlucosePoint[]): Promise<number> {
  if (!points.length) return 0;
  const stmt = env.DB.prepare("INSERT OR IGNORE INTO glucose (device_id, ts, mmol, warning) VALUES (?, ?, ?, ?)");
  let inserted = 0;
  // Lotes para não estourar limites de batch da D1.
  for (let i = 0; i < points.length; i += 50) {
    const chunk = points.slice(i, i + 50);
    const res = await env.DB.batch(
      chunk.map((p) => stmt.bind(deviceId, parseApiTime(p.deviceTime), p.sensorGlucose, p.warning ?? null)),
    );
    inserted += res.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }
  return inserted;
}

/** Percorre todos os vínculos ativos e coleta (usado pelo cron). Erros por vínculo não abortam os demais. */
export async function pollAll(env: Env): Promise<void> {
  const { results } = await env.DB.prepare("SELECT * FROM aidex_links WHERE status = 'linked'").all<AidexLink>();
  for (const link of results) {
    try {
      await pollDevice(env, link);
    } catch (e) {
      await setError(env, link.device_id, link.status === "revoked" ? "revoked" : "error", e instanceof Error ? e.message : String(e));
    }
  }
}

// ------------------------------------------------------------------ alertas de glicemia

/**
 * Avalia as regras de alerta de glicemia (metric='glucose') sobre a ÚLTIMA leitura
 * do sensor e registra alertas de hipo/hiper. O cooldown é garantido pela própria
 * tabela de alertas (não refaz o mesmo alerta dentro de cooldown_s). Roda na coleta
 * porque a glicemia não passa pelo Durable Object das pulseiras.
 */
export async function evaluateGlucoseAlerts(env: Env, deviceId: string): Promise<number> {
  const latest = await env.DB.prepare("SELECT ts, mmol FROM glucose WHERE device_id = ? ORDER BY ts DESC LIMIT 1").bind(deviceId).first<{ ts: number; mmol: number }>();
  if (!latest) return 0;
  const { results: rules } = await env.DB.prepare(
    "SELECT * FROM alert_rules WHERE enabled = 1 AND metric = 'glucose' AND threshold IS NOT NULL AND (device_id IS NULL OR device_id = ?)",
  ).bind(deviceId).all<AlertRule>();

  // A pulseira (miband) do mesmo paciente, para avisar o voluntário (vibrar/mensagem).
  let bandId: string | null | undefined;
  const patientBand = async () => {
    if (bandId === undefined) {
      const row = await env.DB.prepare(
        "SELECT d.id FROM devices d JOIN devices c ON c.patient_id = d.patient_id WHERE c.id = ? AND d.type = 'miband' AND d.archived_at IS NULL LIMIT 1",
      ).bind(deviceId).first<{ id: string }>();
      bandId = row ? row.id : null;
    }
    return bandId;
  };

  let fired = 0;
  for (const rule of rules) {
    if (!compare(rule.op, latest.mmol, rule.threshold!)) continue;
    const last = await env.DB.prepare("SELECT MAX(ts) AS ts FROM alerts WHERE rule_id = ? AND device_id = ?").bind(rule.id, deviceId).first<{ ts: number | null }>();
    if (last?.ts != null && latest.ts - last.ts < rule.cooldown_s * 1000) continue;
    const id = newId("alt");
    const message = describeRule(rule, latest.mmol);
    await env.DB.prepare("INSERT INTO alerts (id, device_id, rule_id, ts, metric, value, severity, message) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, deviceId, rule.id, latest.ts, "glucose", latest.mmol, rule.severity, message).run();
    await deliverWebhooks(env, "alert.created", deviceId, { id, device_id: deviceId, rule_id: rule.id, ts: latest.ts, metric: "glucose", value: latest.mmol, severity: rule.severity, message, rule_name: rule.name }).catch(() => {});

    // Ação automática: avisar o voluntário na pulseira dele (vibrar / mensagem).
    const action = parseJson<{ vibrate?: Record<string, unknown> | boolean; message?: Record<string, unknown> }>(rule.action, {});
    if (action.vibrate || action.message) {
      const band = await patientBand();
      if (band) {
        if (action.vibrate) await createCommand(env, band, { type: "vibrate", params: typeof action.vibrate === "object" ? action.vibrate : {}, ttl_s: 60 }, `rule:${rule.id}`).catch(() => {});
        if (action.message) await createCommand(env, band, { type: "message", params: action.message, ttl_s: 120 }, `rule:${rule.id}`).catch(() => {});
      }
    }
    fired++;
  }
  return fired;
}

/** Cria regras de alerta de glicemia padrão (uma vez) para o sensor ao conectar. Faixas em mmol/L. */
export async function seedDefaultGlucoseRules(env: Env, deviceId: string): Promise<number> {
  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM alert_rules WHERE metric = 'glucose' AND device_id = ?").bind(deviceId).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return 0;
  const now = Date.now();
  const defaults = [
    { name: "Hipoglicemia crítica (< 3,0)", op: "lt", threshold: 3.0, severity: "critical", cooldown_s: 1800 },
    { name: "Glicemia baixa (< 3,9)", op: "lt", threshold: 3.9, severity: "warning", cooldown_s: 1800 },
    { name: "Glicemia alta (> 13,9)", op: "gt", threshold: 13.9, severity: "warning", cooldown_s: 3600 },
  ];
  await env.DB.batch(defaults.map((d) => env.DB.prepare(
    "INSERT INTO alert_rules (id, device_id, name, metric, op, threshold, duration_s, cooldown_s, severity, action, enabled, created_at) VALUES (?,?,?,?,?,?,0,?,?,'{}',1,?)",
  ).bind(newId("rul"), deviceId, d.name, "glucose", d.op, d.threshold, d.cooldown_s, d.severity, now)));
  return defaults.length;
}

// ------------------------------------------------------------------ análise

export interface GlucoseSummary {
  samples: number;
  from: number | null;
  to: number | null;
  mean_mmol: number | null;
  mean_mgdl: number | null;
  gmi_percent: number | null; // Glucose Management Indicator
  cv_percent: number | null; // coeficiente de variação
  min_mmol: number | null;
  max_mmol: number | null;
  /** Time-in-range (% de leituras), faixas do consenso internacional (mmol/L). */
  tir: { very_low: number; low: number; in_range: number; high: number; very_high: number };
}

/** Métricas padrão de CGM a partir de leituras {ts, mmol}. Faixas: <3.0 / 3.0-3.9 / 3.9-10.0 / 10.0-13.9 / >13.9. */
export function summarize(rows: { ts: number; mmol: number }[]): GlucoseSummary {
  const n = rows.length;
  const empty: GlucoseSummary = {
    samples: 0, from: null, to: null, mean_mmol: null, mean_mgdl: null, gmi_percent: null, cv_percent: null,
    min_mmol: null, max_mmol: null, tir: { very_low: 0, low: 0, in_range: 0, high: 0, very_high: 0 },
  };
  if (!n) return empty;
  let sum = 0, min = Infinity, max = -Infinity;
  const band = { very_low: 0, low: 0, in_range: 0, high: 0, very_high: 0 };
  for (const { mmol } of rows) {
    sum += mmol;
    if (mmol < min) min = mmol;
    if (mmol > max) max = mmol;
    if (mmol < 3.0) band.very_low++;
    else if (mmol < 3.9) band.low++;
    else if (mmol <= 10.0) band.in_range++;
    else if (mmol <= 13.9) band.high++;
    else band.very_high++;
  }
  const mean = sum / n;
  const variance = rows.reduce((acc, { mmol }) => acc + (mmol - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const meanMgdl = mmolToMgdl(mean);
  const pct = (x: number) => Math.round((x / n) * 1000) / 10;
  return {
    samples: n,
    from: rows[0].ts,
    to: rows[n - 1].ts,
    mean_mmol: Math.round(mean * 100) / 100,
    mean_mgdl: Math.round(meanMgdl * 10) / 10,
    gmi_percent: Math.round((3.31 + 0.02392 * meanMgdl) * 100) / 100,
    cv_percent: Math.round((std / mean) * 1000) / 10,
    min_mmol: Math.round(min * 100) / 100,
    max_mmol: Math.round(max * 100) / 100,
    tir: {
      very_low: pct(band.very_low), low: pct(band.low), in_range: pct(band.in_range),
      high: pct(band.high), very_high: pct(band.very_high),
    },
  };
}
