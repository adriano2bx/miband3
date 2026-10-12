import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./api";
import type { AppEnv } from "./auth";
import type { Env } from "./types";

export { DeviceHub } from "./hub";
export { Fleet } from "./fleet";

const app = new Hono<AppEnv>();
app.use("/v1/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], maxAge: 86400 }));
app.route("/", api);
// A raiz leva ao painel; a API fica em /v1 (documentação em /v1/openapi.json).
app.get("/", (c) => c.redirect("/admin/", 302));

export default {
  fetch: app.fetch,

  /** Limpeza diária conforme RETENTION_DAYS (0 = nunca apagar). */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
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
    ]);
  },
} satisfies ExportedHandler<Env>;
