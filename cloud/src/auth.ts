import type { Context, MiddlewareHandler } from "hono";
import { ALL_SCOPES, type Env, type Principal, type Scope } from "./types";
import { parseJson, safeEqual, sha256Hex } from "./util";
import { TECH_SESSION_IDLE_MS, TECH_SESSION_MAX_MS } from "./participants";

export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };

export function extractToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const url = new URL(req.url);
  // Navegadores não conseguem enviar cabeçalhos em WebSocket.
  return url.searchParams.get("access_token");
}

export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const token = extractToken(req);
  if (!token) return null;

  if (env.ADMIN_API_KEY && (await safeEqual(token, env.ADMIN_API_KEY))) {
    return { id: "admin", scopes: new Set(ALL_SCOPES), deviceIds: null };
  }
  if (token.startsWith("mbp_")) {
    const now = Date.now();
    const session = await env.DB.prepare(
      `SELECT s.id, s.technician_id, s.expires_at, s.max_expires_at, s.revoked_at, t.scopes, t.disabled_at
       FROM panel_sessions s JOIN technicians t ON t.id = s.technician_id WHERE s.token_hash = ?`,
    ).bind(await sha256Hex(token)).first<{
      id: string; technician_id: string; expires_at: number; max_expires_at: number; revoked_at: number | null; scopes: string; disabled_at: number | null;
    }>();
    const technicianScopes = parseJson<string[]>(session?.scopes ?? "[]", []);
    if (!session || session.revoked_at || session.disabled_at || session.expires_at <= now || session.max_expires_at <= now || !technicianScopes.includes("panel_read")) return null;
    const expiresAt = Math.min(now + TECH_SESSION_IDLE_MS, session.max_expires_at);
    env.DB.prepare("UPDATE panel_sessions SET expires_at = ? WHERE id = ?").bind(expiresAt, session.id).run().catch(() => {});
    return { id: `tech:${session.technician_id}`, scopes: new Set(["read"]), deviceIds: null };
  }
  if (!token.startsWith("mbk_")) return null;

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT id, scopes, device_ids FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: string; scopes: string; device_ids: string | null }>();
  if (!row) return null;

  // Atualização "melhor esforço" do último uso, sem bloquear a requisição.
  env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run().catch(() => {});

  const scopes = new Set(parseJson<Scope[]>(row.scopes, []).filter((s) => ALL_SCOPES.includes(s)));
  // "admin" implica todos os outros escopos.
  if (scopes.has("admin")) ALL_SCOPES.forEach((s) => scopes.add(s));
  return { id: `key:${row.id}`, scopes, deviceIds: row.device_ids ? parseJson<string[]>(row.device_ids, []) : null };
}

export function requireAuth(...needed: Scope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = await authenticate(c.req.raw, c.env);
    if (!principal) return c.json({ error: "unauthorized", message: "Token ausente ou inválido." }, 401);
    for (const scope of needed) {
      if (!principal.scopes.has(scope)) {
        return c.json({ error: "forbidden", message: `A chave não possui o escopo '${scope}'.` }, 403);
      }
    }
    c.set("principal", principal);
    await next();
  };
}

export function canAccess(principal: Principal, deviceId: string): boolean {
  return principal.deviceIds === null || principal.deviceIds.includes(deviceId);
}

/** Retorna um Response de erro se a chave não puder acessar a pulseira. */
export function guardDevice(c: Context<AppEnv>, deviceId: string): Response | null {
  if (!canAccess(c.get("principal"), deviceId)) {
    return c.json({ error: "forbidden", message: "A chave não tem acesso a esta pulseira." }, 403);
  }
  return null;
}
