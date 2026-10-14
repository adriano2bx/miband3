import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./api";
import type { AppEnv } from "./auth";
import type { Env } from "./types";
import { pollAll } from "./aidex";

/** Cron da limpeza diária (ver wrangler.jsonc). Os demais crons disparam a coleta AiDEX. */
const CLEANUP_CRON = "17 3 * * *";

export { DeviceHub } from "./hub";
export { Fleet } from "./fleet";

const app = new Hono<AppEnv>();
app.use("/v1/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], maxAge: 86400 }));
app.route("/", api);
// A raiz leva ao painel; a API fica em /v1 (documentação em /v1/openapi.json).
app.get("/", (c) => c.redirect("/admin/", 302));

export default {
  fetch: app.fetch,

  /** Limpeza diária (RETENTION_DAYS); os demais horários de cron disparam a coleta AiDEX. */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron !== CLEANUP_CRON) {
      // Coleta periódica da glicemia (ver cron em wrangler.jsonc).
      ctx.waitUntil(pollAll(env));
      return;
    }
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
  },
} satisfies ExportedHandler<Env>;
