import type { Env } from "./types";
import { hmacHex, newId, parseJson } from "./util";

export const WEBHOOK_EVENTS = [
  "alert.created",
  "device.online",
  "device.offline",
  "command.updated",
  "event.created",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  device_id: string | null;
  failures: number;
}

const MAX_FAILURES = 20;

/**
 * Entrega um evento aos webhooks inscritos. O corpo é assinado com HMAC-SHA256
 * (cabeçalho `X-MiBand-Signature: sha256=<hex>` sobre `<timestamp>.<corpo>`).
 * Sem fila de reentrega: falhas apenas incrementam `failures`; após muitas, o webhook é desativado.
 */
export async function deliverWebhooks(env: Env, event: WebhookEvent, deviceId: string, data: unknown): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, url, secret, events, device_id, failures FROM webhooks WHERE enabled = 1 AND (device_id IS NULL OR device_id = ?)",
  )
    .bind(deviceId)
    .all<WebhookRow>();

  const targets = results.filter((w) => {
    const events = parseJson<string[]>(w.events, []);
    return events.includes("*") || events.includes(event);
  });
  await Promise.all(targets.map((w) => deliverOne(env, w, event, deviceId, data)));
}

export async function deliverOne(env: Env, w: Pick<WebhookRow, "id" | "url" | "secret" | "failures">, event: string, deviceId: string | null, data: unknown): Promise<number> {
  const body = JSON.stringify({ id: newId("evt"), event, device_id: deviceId, created_at: Date.now(), data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacHex(w.secret, `${timestamp}.${body}`);
  let status = 0;
  try {
    const res = await fetch(w.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "miband3-cloud/1",
        "x-miband-event": event,
        "x-miband-timestamp": timestamp,
        "x-miband-signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    status = res.status;
  } catch {
    status = 0;
  }
  const ok = status >= 200 && status < 300;
  const failures = ok ? 0 : w.failures + 1;
  await env.DB.prepare("UPDATE webhooks SET last_attempt_at = ?, last_status = ?, failures = ?, enabled = ? WHERE id = ?")
    .bind(Date.now(), status, failures, failures >= MAX_FAILURES ? 0 : 1, w.id)
    .run();
  return status;
}
