import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./api";
import type { AppEnv } from "./auth";
import type { Env } from "./types";
import { pollAll } from "./aidex";

export { DeviceHub } from "./hub";
export { Fleet } from "./fleet";

/**
 * Marca como offline os devices "presos" em online (ex.: a pulseira saiu sem fechar
 * a conexão e o socket ficou zumbi). Limiar generoso para não derrubar pulseira
 * conectada e ociosa. Corrige o flag usado no overview; o alerta de offline continua
 * no Durable Object.
 */
const PRESENCE_STALE_MS = 3 * 3600_000;
async function reconcilePresence(env: Env): Promise<void> {
  const cutoff = Date.now() - PRESENCE_STALE_MS;
  await env.DB.prepare("UPDATE devices SET online = 0 WHERE online = 1 AND (last_seen_at IS NULL OR last_seen_at < ?)").bind(cutoff).run();
}

/** Poda os dados antigos conforme RETENTION_DAYS e as sessões expiradas. */
async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  // Sessões de técnico/painel totalmente expiradas (independe de RETENTION_DAYS).
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tech_sessions WHERE max_expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM panel_sessions WHERE max_expires_at < ?").bind(now),
  ]);
  const days = Number(env.RETENTION_DAYS ?? 365);
  if (!days || days < 0) return;
  const cutoff = Date.now() - days * 86400_000;
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM heart_rate WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM steps WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM battery WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM events WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM activity WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM commands WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM alerts WHERE ts < ? AND acked_at IS NOT NULL").bind(cutoff),
    db.prepare("DELETE FROM glucose WHERE ts < ?").bind(cutoff),
    db.prepare("DELETE FROM glucose_events WHERE ts < ?").bind(cutoff),
  ]);
}

const app = new Hono<AppEnv>();
app.use("/v1/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], maxAge: 86400 }));
app.route("/", api);
// A raiz leva ao painel; a API fica em /v1 (documentação em /v1/openapi.json).
app.get("/", (c) => c.redirect("/admin/", 302));

export default {
  fetch: app.fetch,

  /**
   * Um único cron (a cada 15 min, ver wrangler.jsonc) por causa do limite de 5
   * crons/conta do plano Free. Toda execução dispara a coleta AiDEX; a limpeza
   * diária roda uma vez por dia, na primeira execução após as 03h UTC.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(pollAll(env));
    ctx.waitUntil(reconcilePresence(env));
    const now = new Date();
    // A janela das 03:00 UTC é atingida só pela execução das 03:00 (minuto < 15).
    if (now.getUTCHours() === 3 && now.getUTCMinutes() < 15) {
      ctx.waitUntil(cleanup(env));
    }
  },
} satisfies ExportedHandler<Env>;
