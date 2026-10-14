import { Hono, type Context } from "hono";
import { z } from "zod";
import { guardDevice, requireAuth, type AppEnv } from "./auth";
import {
  burnPasswordTime,
  CollectionConfig,

  currentTerm,
  effectiveConfig,
  hashPassword,
  installationView,
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILURES,
  TECH_SESSION_IDLE_MS,
  TECH_SESSION_MAX_MS,
  verifyPassword,
  type DeviceRowLite,
} from "./participants";
import { newId, parseJson, randomToken, sha256Hex } from "./util";
import { audit } from "./audit";

/**
 * Contratos usados pelo app BIOSENSE: termo vigente, adesão (instalação + consentimento),
 * estado da instalação, login técnico com sessão e as rotas administrativas correspondentes.
 */
export const participantApi = new Hono<AppEnv>();

async function json<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown = {};
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, res: c.json({ error: "bad_request", message: "JSON inválido." }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, res: c.json({ error: "validation", details: parsed.error.flatten() }, 400) };
  return { ok: true, data: parsed.data };
}

function bearer(c: Context<AppEnv>): string | null {
  const h = c.req.header("authorization");
  return h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

async function deviceByToken(c: Context<AppEnv>, token: string | null | undefined): Promise<DeviceRowLite | null> {
  if (!token?.startsWith("mbd_")) return null;
  return c.env.DB.prepare("SELECT * FROM devices WHERE token_hash = ? AND archived_at IS NULL").bind(await sha256Hex(token)).first<DeviceRowLite>();
}

async function refreshHub(c: Context<AppEnv>, deviceId: string): Promise<void> {
  await c.env.HUB.get(c.env.HUB.idFromName(deviceId)).refresh(deviceId);
}

const clientInfo = z
  .object({ app: z.string().max(64).optional(), version: z.string().max(32).optional(), os: z.string().max(64).optional(), model: z.string().max(64).optional() })
  .optional();

// ====================================================================== termo (público)

participantApi.get("/v1/consent/terms/current", async (c) => {
  const term = await currentTerm(c.env.DB);
  if (!term) return c.json({ error: "not_found", message: "Nenhum termo de participação publicado." }, 404);
  return c.json({ version: term.version, title: term.title, content: term.content, requires_reconsent: Boolean(term.requires_reconsent), published_at: term.published_at });
});

// ====================================================================== adesão

/**
 * Primeira adesão: registra o aceite do termo vigente e cria a instalação, que fica
 * "pending" até a equipe vincular o participante. Devolve o token do dispositivo (uma única vez).
 */
participantApi.post("/v1/installations", async (c) => {
  const b = await json(c, z.object({ consent_version: z.string().min(1).max(64), accepted: z.literal(true), client: clientInfo }));
  if (!b.ok) return b.res;
  const term = await currentTerm(c.env.DB);
  if (!term) return c.json({ error: "no_terms", message: "Nenhum termo de participação publicado." }, 409);
  if (term.version !== b.data.consent_version) {
    return c.json({ error: "terms_outdated", message: "O termo foi atualizado. Leia a versão vigente.", current_version: term.version }, 409);
  }
  const id = newId("dev");
  const token = randomToken("mbd");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO devices (id, name, metadata, token_hash, created_at, updated_at, status, consent_version, consent_at, client_info) VALUES (?, ?, '{}', ?, ?, ?, 'pending', ?, ?, ?)",
    ).bind(id, `Instalação ${id.slice(-6)}`, await sha256Hex(token), now, now, term.version, now, JSON.stringify(b.data.client ?? {})),
    c.env.DB.prepare("INSERT INTO consent_records (id, device_id, version, accepted, created_at, client) VALUES (?, ?, ?, 1, ?, ?)")
      .bind(newId("cns"), id, term.version, now, JSON.stringify(b.data.client ?? {})),
  ]);
  const device = await c.env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<DeviceRowLite>();
  return c.json({ ...installationView(device!, term), device_token: token }, 201);
});

/** Novo aceite (termo atualizado) ou recusa, feito pela própria instalação. */
participantApi.post("/v1/consent", async (c) => {
  const device = await deviceByToken(c, bearer(c));
  if (!device) return c.json({ error: "unauthorized" }, 401);
  const b = await json(c, z.object({ version: z.string().min(1).max(64), accepted: z.boolean(), client: clientInfo }));
  if (!b.ok) return b.res;
  const term = await currentTerm(c.env.DB);
  if (!term) return c.json({ error: "no_terms", message: "Nenhum termo de participação publicado." }, 409);
  if (term.version !== b.data.version) {
    return c.json({ error: "terms_outdated", message: "O termo foi atualizado. Leia a versão vigente.", current_version: term.version }, 409);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO consent_records (id, device_id, version, accepted, created_at, client) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("cns"), device.id, term.version, b.data.accepted ? 1 : 0, now, JSON.stringify(b.data.client ?? {})),
    b.data.accepted
      ? c.env.DB.prepare("UPDATE devices SET consent_version = ?, consent_at = ?, updated_at = ? WHERE id = ?").bind(term.version, now, now, device.id)
      : c.env.DB.prepare("UPDATE devices SET consent_version = NULL, consent_at = ?, updated_at = ? WHERE id = ?").bind(now, now, device.id),
  ]);
  await refreshHub(c, device.id);
  const updated = await c.env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(device.id).first<DeviceRowLite>();
  return c.json(installationView(updated!, term));
});

/** Estado da instalação visto pelo app (autorização, consentimento, perfil de coleta). */
participantApi.get("/v1/installation", async (c) => {
  const device = await deviceByToken(c, bearer(c));
  if (!device) return c.json({ error: "unauthorized" }, 401);
  return c.json(installationView(device, await currentTerm(c.env.DB)));
});

// ====================================================================== login técnico

const LoginInput = z.object({
  credential: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
  /** Token da instalação deste celular: a sessão fica presa a ela. */
  device_token: z.string().max(200).optional(),
});

participantApi.post("/v1/tech/login", async (c) => {
  const b = await json(c, LoginInput);
  if (!b.ok) return b.res;
  const now = Date.now();
  const db = c.env.DB;
  const tech = await db.prepare("SELECT * FROM technicians WHERE credential = ? AND disabled_at IS NULL").bind(b.data.credential).first<{
    id: string; name: string; password_hash: string; scopes: string; failed_attempts: number; locked_until: number | null;
  }>();
  if (!tech) {
    await burnPasswordTime(b.data.password);
    return c.json({ error: "invalid_credentials", message: "Credencial ou senha incorretas." }, 401);
  }
  if (tech.locked_until && tech.locked_until > now) {
    return c.json({ error: "locked", message: "Muitas tentativas. Tente novamente mais tarde.", retry_at: tech.locked_until }, 429);
  }
  if (!(await verifyPassword(b.data.password, tech.password_hash))) {
    const failures = tech.failed_attempts + 1;
    const lock = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : null;
    await db.prepare("UPDATE technicians SET failed_attempts = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : failures, lock, tech.id).run();
    if (lock) return c.json({ error: "locked", message: "Muitas tentativas. Tente novamente mais tarde.", retry_at: lock }, 429);
    return c.json({ error: "invalid_credentials", message: "Credencial ou senha incorretas.", attempts_left: LOGIN_MAX_FAILURES - failures }, 401);
  }
  const device = await deviceByToken(c, b.data.device_token);
  if (!device) return c.json({ error: "no_installation", message: "Este celular não tem uma instalação válida." }, 403);

  const token = randomToken("mbt");
  const expires = now + TECH_SESSION_IDLE_MS;
  await db.batch([
    db.prepare("UPDATE technicians SET failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(tech.id),
    db.prepare("INSERT INTO tech_sessions (id, token_hash, technician_id, device_id, scopes, created_at, expires_at, max_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(newId("tss"), await sha256Hex(token), tech.id, device.id, tech.scopes, now, expires, now + TECH_SESSION_MAX_MS),
  ]);
  return c.json({ session_token: token, expires_at: expires, idle_timeout_s: TECH_SESSION_IDLE_MS / 1000, technician: { name: tech.name }, scopes: parseJson<string[]>(tech.scopes, []) }, 201);
});

/** Login do painel web: sessão individual, somente leitura, concedida pela gestão. */
participantApi.post("/v1/panel/login", async (c) => {
  const b = await json(c, z.object({ credential: z.string().trim().min(1).max(120), password: z.string().min(1).max(200) }));
  if (!b.ok) return b.res;
  const now = Date.now();
  const db = c.env.DB;
  const tech = await db.prepare("SELECT id, name, password_hash, scopes, failed_attempts, locked_until FROM technicians WHERE credential = ? AND disabled_at IS NULL")
    .bind(b.data.credential).first<{ id: string; name: string; password_hash: string; scopes: string; failed_attempts: number; locked_until: number | null }>();
  if (!tech) {
    await burnPasswordTime(b.data.password);
    return c.json({ error: "invalid_credentials", message: "Credencial ou senha incorretas." }, 401);
  }
  if (tech.locked_until && tech.locked_until > now) {
    return c.json({ error: "locked", message: "Muitas tentativas. Tente novamente mais tarde.", retry_at: tech.locked_until }, 429);
  }
  if (!(await verifyPassword(b.data.password, tech.password_hash))) {
    const failures = tech.failed_attempts + 1;
    const lock = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : null;
    await db.prepare("UPDATE technicians SET failed_attempts = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : failures, lock, tech.id).run();
    if (lock) return c.json({ error: "locked", message: "Muitas tentativas. Tente novamente mais tarde.", retry_at: lock }, 429);
    return c.json({ error: "invalid_credentials", message: "Credencial ou senha incorretas.", attempts_left: LOGIN_MAX_FAILURES - failures }, 401);
  }
  const scopes = parseJson<string[]>(tech.scopes, []);
  if (!scopes.includes("panel_read")) {
    return c.json({ error: "panel_access_disabled", message: "A gestão ainda não autorizou este técnico a consultar dados no painel." }, 403);
  }
  const token = randomToken("mbp");
  const expires = now + TECH_SESSION_IDLE_MS;
  await db.batch([
    db.prepare("UPDATE technicians SET failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(tech.id),
    db.prepare("INSERT INTO panel_sessions (id, token_hash, technician_id, created_at, expires_at, max_expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("pws"), await sha256Hex(token), tech.id, now, expires, now + TECH_SESSION_MAX_MS),
  ]);
  await audit(c.env, { principal: `tech:${tech.id}`, action: "panel.login", detail: tech.name });
  return c.json({ session_token: token, expires_at: expires, idle_timeout_s: TECH_SESSION_IDLE_MS / 1000, technician: { name: tech.name }, scopes: ["read"] }, 201);
});

participantApi.post("/v1/panel/logout", async (c) => {
  const token = bearer(c);
  if (token?.startsWith("mbp_")) {
    await c.env.DB.prepare("UPDATE panel_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(Date.now(), await sha256Hex(token)).run();
  }
  return c.json({ logged_out: true });
});

interface TechContext {
  sessionId: string;
  technician: { id: string; name: string };
  scopes: string[];
  device: DeviceRowLite;
  expiresAt: number;
}

/** Valida a sessão técnica e renova o prazo de inatividade. */
async function techAuth(c: Context<AppEnv>): Promise<TechContext | Response> {
  const token = bearer(c);
  if (!token?.startsWith("mbt_")) return c.json({ error: "unauthorized", message: "Sessão técnica ausente." }, 401);
  const now = Date.now();
  const s = await c.env.DB.prepare(
    `SELECT s.id, s.scopes, s.device_id, s.expires_at, s.max_expires_at, s.revoked_at, t.id AS tid, t.name AS tname, t.disabled_at
     FROM tech_sessions s JOIN technicians t ON t.id = s.technician_id WHERE s.token_hash = ?`,
  ).bind(await sha256Hex(token)).first<{
    id: string; scopes: string; device_id: string; expires_at: number; max_expires_at: number; revoked_at: number | null; tid: string; tname: string; disabled_at: number | null;
  }>();
  if (!s || s.revoked_at || s.disabled_at || s.expires_at <= now || s.max_expires_at <= now) {
    return c.json({ error: "session_expired", message: "Sessão técnica encerrada ou expirada." }, 401);
  }
  const device = await c.env.DB.prepare("SELECT * FROM devices WHERE id = ? AND archived_at IS NULL").bind(s.device_id).first<DeviceRowLite>();
  if (!device) return c.json({ error: "session_expired", message: "Instalação não encontrada." }, 401);
  const expiresAt = Math.min(now + TECH_SESSION_IDLE_MS, s.max_expires_at);
  await c.env.DB.prepare("UPDATE tech_sessions SET expires_at = ? WHERE id = ?").bind(expiresAt, s.id).run();
  return { sessionId: s.id, technician: { id: s.tid, name: s.tname }, scopes: parseJson<string[]>(s.scopes, []), device, expiresAt };
}

async function techView(c: Context<AppEnv>, t: TechContext) {
  const device = (await c.env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(t.device.id).first<DeviceRowLite>())!;
  return {
    ...installationView(device, await currentTerm(c.env.DB)),
    name: device.name,
    technician: t.technician.name,
    scopes: t.scopes,
    session_expires_at: t.expiresAt,
  };
}

participantApi.post("/v1/tech/logout", async (c) => {
  const t = await techAuth(c);
  if (t instanceof Response) return t;
  await c.env.DB.prepare("UPDATE tech_sessions SET revoked_at = ? WHERE id = ?").bind(Date.now(), t.sessionId).run();
  return c.json({ logged_out: true });
});

participantApi.get("/v1/tech/installation", async (c) => {
  const t = await techAuth(c);
  if (t instanceof Response) return t;
  return c.json(await techView(c, t));
});

/** Teste de comunicação: ida e volta autenticada com o servidor. */
participantApi.get("/v1/tech/ping", async (c) => {
  const t = await techAuth(c);
  if (t instanceof Response) return t;
  return c.json({ ok: true, server_time: Date.now(), device_online: Boolean(t.device.online) });
});

/** Vincula o participante e autoriza esta instalação (escopo "provision"). */
participantApi.post("/v1/tech/installation/authorize", async (c) => {
  const t = await techAuth(c);
  if (t instanceof Response) return t;
  if (!t.scopes.includes("provision")) return c.json({ error: "forbidden", message: "Seu acesso não permite autorizar instalações." }, 403);
  if (t.device.status === "revoked") return c.json({ error: "revoked", message: "Instalação bloqueada. Fale com a coordenação." }, 409);
  const b = await json(c, z.object({ participant_ref: z.string().trim().min(1).max(120) }));
  if (!b.ok) return b.res;
  await c.env.DB.prepare("UPDATE devices SET status = 'active', patient_ref = ?, updated_at = ? WHERE id = ?").bind(b.data.participant_ref, Date.now(), t.device.id).run();
  await refreshHub(c, t.device.id);
  return c.json(await techView(c, t));
});

// ====================================================================== administração

const TermInput = z.object({
  version: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(20).max(100_000),
  requires_reconsent: z.boolean().default(true),
});

participantApi.post("/v1/consent/terms", requireAuth("admin"), async (c) => {
  const b = await json(c, TermInput);
  if (!b.ok) return b.res;
  const exists = await c.env.DB.prepare("SELECT 1 FROM consent_terms WHERE version = ?").bind(b.data.version).first();
  if (exists) return c.json({ error: "conflict", message: "Versão já publicada; termos não são editados, publique uma nova versão." }, 409);
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO consent_terms (version, title, content, requires_reconsent, published_at) VALUES (?, ?, ?, ?, ?)")
    .bind(b.data.version, b.data.title, b.data.content, b.data.requires_reconsent ? 1 : 0, now).run();
  return c.json({ ...b.data, published_at: now }, 201);
});

participantApi.get("/v1/consent/terms", requireAuth("read"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT version, title, requires_reconsent, published_at FROM consent_terms ORDER BY published_at DESC").all();
  return c.json({ data: results.map((r) => ({ ...r, requires_reconsent: Boolean(r.requires_reconsent) })) });
});

participantApi.get("/v1/devices/:id/consents", requireAuth("read"), async (c) => {
  const denied = guardDevice(c, c.req.param("id"));
  if (denied) return denied;
  const { results } = await c.env.DB.prepare("SELECT id, version, accepted, created_at FROM consent_records WHERE device_id = ? ORDER BY created_at DESC")
    .bind(c.req.param("id")).all();
  return c.json({ data: results.map((r) => ({ ...r, accepted: Boolean(r.accepted) })) });
});

participantApi.post("/v1/devices/:id/authorize", requireAuth("manage"), async (c) => {
  const denied = guardDevice(c, c.req.param("id"));
  if (denied) return denied;
  const b = await json(c, z.object({ participant_ref: z.string().trim().min(1).max(120).optional(), name: z.string().trim().min(1).max(120).optional() }));
  if (!b.ok) return b.res;
  const id = c.req.param("id");
  const d = await c.env.DB.prepare("SELECT * FROM devices WHERE id = ? AND archived_at IS NULL").bind(id).first<DeviceRowLite>();
  if (!d) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("UPDATE devices SET status = 'active', patient_ref = COALESCE(?, patient_ref), name = COALESCE(?, name), updated_at = ? WHERE id = ?")
    .bind(b.data.participant_ref ?? null, b.data.name ?? null, Date.now(), id).run();
  await refreshHub(c, id);
  return c.json(installationView((await c.env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first<DeviceRowLite>())!, await currentTerm(c.env.DB)));
});

/** Bloqueia a instalação: o app passa a mostrar "Conexão não autorizada" e a telemetria é recusada. */
participantApi.post("/v1/devices/:id/revoke", requireAuth("manage"), async (c) => {
  const denied = guardDevice(c, c.req.param("id"));
  if (denied) return denied;
  const id = c.req.param("id");
  const res = await c.env.DB.prepare("UPDATE devices SET status = 'revoked', updated_at = ? WHERE id = ? AND archived_at IS NULL").bind(Date.now(), id).run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  await refreshHub(c, id);
  return c.json({ revoked: id });
});

participantApi.put("/v1/devices/:id/config", requireAuth("manage"), async (c) => {
  const denied = guardDevice(c, c.req.param("id"));
  if (denied) return denied;
  const b = await json(c, CollectionConfig.partial());
  if (!b.ok) return b.res;
  const id = c.req.param("id");
  const d = await c.env.DB.prepare("SELECT config FROM devices WHERE id = ? AND archived_at IS NULL").bind(id).first<{ config: string }>();
  if (!d) return c.json({ error: "not_found" }, 404);
  const config = { ...effectiveConfig(d.config), ...b.data };
  const now = Date.now();
  await c.env.DB.prepare("UPDATE devices SET config = ?, config_version = config_version + 1, config_updated_at = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(config), now, now, id).run();
  await refreshHub(c, id);
  const row = await c.env.DB.prepare("SELECT config, config_version, config_updated_at FROM devices WHERE id = ?").bind(id).first<{ config: string; config_version: number; config_updated_at: number }>();
  return c.json({ config: effectiveConfig(row!.config), config_version: row!.config_version, config_updated_at: row!.config_updated_at });
});

const TechInput = z.object({
  credential: z.string().trim().min(3).max(120),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(10).max(200),
  scopes: z.array(z.enum(["tech", "provision", "panel_read"])).min(1).default(["tech"]),
});

participantApi.post("/v1/technicians", requireAuth("admin"), async (c) => {
  const b = await json(c, TechInput);
  if (!b.ok) return b.res;
  const exists = await c.env.DB.prepare("SELECT 1 FROM technicians WHERE credential = ?").bind(b.data.credential).first();
  if (exists) return c.json({ error: "conflict", message: "Credencial já existe." }, 409);
  const id = newId("tec");
  await c.env.DB.prepare("INSERT INTO technicians (id, credential, name, password_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, b.data.credential, b.data.name, await hashPassword(b.data.password), JSON.stringify(b.data.scopes), Date.now()).run();
  return c.json({ id, credential: b.data.credential, name: b.data.name, scopes: b.data.scopes }, 201);
});

participantApi.get("/v1/technicians", requireAuth("admin"), async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, credential, name, scopes, created_at, disabled_at, locked_until,
       (SELECT group_concat(patient_id) FROM technician_patients tp WHERE tp.technician_id = technicians.id) AS patient_ids
     FROM technicians ORDER BY created_at DESC`,
  ).all();
  return c.json({
    data: results.map((t) => ({
      ...t,
      scopes: parseJson(t.scopes as string, []),
      patient_ids: t.patient_ids ? String(t.patient_ids).split(",") : [],
    })),
  });
});

participantApi.patch("/v1/technicians/:tid", requireAuth("admin"), async (c) => {
  const b = await json(c, TechInput.pick({ name: true, password: true, scopes: true }).partial().extend({ unlock: z.boolean().optional() }));
  if (!b.ok) return b.res;
  const tid = c.req.param("tid");
  const cur = await c.env.DB.prepare("SELECT 1 FROM technicians WHERE id = ?").bind(tid).first();
  if (!cur) return c.json({ error: "not_found" }, 404);
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [];
  if (b.data.name) stmts.push(db.prepare("UPDATE technicians SET name = ? WHERE id = ?").bind(b.data.name, tid));
  if (b.data.scopes) stmts.push(db.prepare("UPDATE technicians SET scopes = ? WHERE id = ?").bind(JSON.stringify(b.data.scopes), tid));
  if (b.data.password) {
    stmts.push(db.prepare("UPDATE technicians SET password_hash = ? WHERE id = ?").bind(await hashPassword(b.data.password), tid));
    // Trocar a senha encerra as sessões abertas.
    stmts.push(db.prepare("UPDATE tech_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(Date.now(), tid));
    stmts.push(db.prepare("UPDATE panel_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(Date.now(), tid));
  }
  if (b.data.scopes) {
    stmts.push(db.prepare("UPDATE technicians SET scopes = ? WHERE id = ?").bind(JSON.stringify(b.data.scopes), tid));
    if (!b.data.scopes.includes("panel_read")) stmts.push(db.prepare("UPDATE panel_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(Date.now(), tid));
  }
  if (b.data.unlock) stmts.push(db.prepare("UPDATE technicians SET failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(tid));
  if (stmts.length) await db.batch(stmts);
  return c.json({ updated: tid });
});

participantApi.delete("/v1/technicians/:tid", requireAuth("admin"), async (c) => {
  const tid = c.req.param("tid");
  const now = Date.now();
  const res = await c.env.DB.prepare("UPDATE technicians SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").bind(now, tid).run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("UPDATE tech_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(now, tid).run();
  await c.env.DB.prepare("UPDATE panel_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(now, tid).run();
  return c.json({ disabled: tid });
});

// ====================================================================== seguidores (acesso por paciente)

const FollowerInput = z.object({
  name: z.string().trim().min(1).max(120),
  credential: z.string().trim().min(3).max(120),
  password: z.string().min(8).max(200),
  // Consentimento do voluntário para este seguidor (ex.: "autorizado pelo voluntário em DD/MM").
  consent_note: z.string().max(500).nullish(),
});

/**
 * Cria um seguidor: conta de painel só-leitura amarrada ao paciente. Entra no
 * painel pelo login de técnico (credencial + senha) e só enxerga os devices
 * (pulseira e/ou CGM) daquele paciente.
 */
participantApi.post("/v1/patients/:pid/followers", requireAuth("manage"), async (c) => {
  if (c.get("principal").deviceIds) return c.json({ error: "forbidden", message: "Chaves restritas não criam seguidores." }, 403);
  const pid = c.req.param("pid");
  const pat = await c.env.DB.prepare("SELECT id FROM patients WHERE id = ? AND archived_at IS NULL").bind(pid).first();
  if (!pat) return c.json({ error: "not_found", message: "Paciente não encontrado." }, 404);
  const b = await json(c, FollowerInput);
  if (!b.ok) return b.res;
  const exists = await c.env.DB.prepare("SELECT 1 FROM technicians WHERE credential = ?").bind(b.data.credential).first();
  if (exists) return c.json({ error: "conflict", message: "Credencial já existe." }, 409);
  const id = newId("tec");
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO technicians (id, credential, name, password_hash, scopes, created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, b.data.credential, b.data.name, await hashPassword(b.data.password), JSON.stringify(["panel_read"]), now),
    c.env.DB.prepare("INSERT INTO technician_patients (technician_id, patient_id, created_at, granted_by, consent_note) VALUES (?,?,?,?,?)")
      .bind(id, pid, now, c.get("principal").id, b.data.consent_note ?? null),
  ]);
  await audit(c.env, { principal: c.get("principal").id, action: "follower.grant", patient_id: pid, detail: `${b.data.name} (${b.data.credential})` });
  return c.json({ id, credential: b.data.credential, name: b.data.name, patient_id: pid, role: "follower" }, 201);
});

participantApi.get("/v1/patients/:pid/followers", requireAuth("manage"), async (c) => {
  if (c.get("principal").deviceIds) return c.json({ error: "forbidden" }, 403);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.credential, t.name, t.scopes, t.created_at, t.disabled_at, t.locked_until,
            tp.granted_by, tp.consent_note, tp.created_at AS granted_at
     FROM technicians t JOIN technician_patients tp ON tp.technician_id = t.id
     WHERE tp.patient_id = ? AND t.disabled_at IS NULL ORDER BY t.created_at DESC`,
  ).bind(c.req.param("pid")).all();
  return c.json({ data: results.map((t) => ({ ...t, scopes: parseJson(t.scopes as string, []) })), count: results.length });
});

/** Remove o vínculo deste paciente com a conta; se não sobrar nenhum paciente, desativa a conta. */
participantApi.delete("/v1/patients/:pid/followers/:tid", requireAuth("manage"), async (c) => {
  if (c.get("principal").deviceIds) return c.json({ error: "forbidden" }, 403);
  const now = Date.now();
  const tid = c.req.param("tid");
  const res = await c.env.DB.prepare("DELETE FROM technician_patients WHERE technician_id = ? AND patient_id = ?").bind(tid, c.req.param("pid")).run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  const rest = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM technician_patients WHERE technician_id = ?").bind(tid).first<{ n: number }>();
  if ((rest?.n ?? 0) === 0) {
    await c.env.DB.prepare("UPDATE technicians SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").bind(now, tid).run();
  }
  // Encerra as sessões para reavaliar o escopo imediatamente.
  await c.env.DB.prepare("UPDATE panel_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(now, tid).run();
  await audit(c.env, { principal: c.get("principal").id, action: "follower.revoke", patient_id: c.req.param("pid"), detail: tid });
  return c.json({ removed: c.req.param("pid"), technician: tid, disabled: (rest?.n ?? 0) === 0 });
});

// ---- técnico responsável: atrelar / desatrelar vários voluntários (pacientes) ----

participantApi.post("/v1/technicians/:tid/patients", requireAuth("admin"), async (c) => {
  const tid = c.req.param("tid");
  const tech = await c.env.DB.prepare("SELECT 1 FROM technicians WHERE id = ? AND disabled_at IS NULL").bind(tid).first();
  if (!tech) return c.json({ error: "not_found", message: "Técnico não encontrado." }, 404);
  const b = await json(c, z.object({ patient_id: z.string().min(1).max(40), consent_note: z.string().max(500).nullish() }));
  if (!b.ok) return b.res;
  const pat = await c.env.DB.prepare("SELECT 1 FROM patients WHERE id = ? AND archived_at IS NULL").bind(b.data.patient_id).first();
  if (!pat) return c.json({ error: "not_found", message: "Paciente não encontrado." }, 404);
  await c.env.DB.prepare("INSERT OR IGNORE INTO technician_patients (technician_id, patient_id, created_at, granted_by, consent_note) VALUES (?,?,?,?,?)")
    .bind(tid, b.data.patient_id, Date.now(), c.get("principal").id, b.data.consent_note ?? null).run();
  await c.env.DB.prepare("UPDATE panel_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(Date.now(), tid).run();
  await audit(c.env, { principal: c.get("principal").id, action: "patient.attach", patient_id: b.data.patient_id, detail: tid });
  return c.json({ technician: tid, patient_id: b.data.patient_id, attached: true }, 201);
});

participantApi.delete("/v1/technicians/:tid/patients/:pid", requireAuth("admin"), async (c) => {
  const tid = c.req.param("tid");
  const res = await c.env.DB.prepare("DELETE FROM technician_patients WHERE technician_id = ? AND patient_id = ?").bind(tid, c.req.param("pid")).run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("UPDATE panel_sessions SET revoked_at = ? WHERE technician_id = ? AND revoked_at IS NULL").bind(Date.now(), tid).run();
  await audit(c.env, { principal: c.get("principal").id, action: "patient.detach", patient_id: c.req.param("pid"), detail: tid });
  return c.json({ technician: tid, removed: c.req.param("pid") });
});

