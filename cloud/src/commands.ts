import { CommandSpec } from "./protocol";
import type { Env } from "./types";
import { newId, parseJson } from "./util";

export interface CommandRow {
  id: string;
  device_id: string;
  type: string;
  params: string;
  status: string;
  created_at: number;
  expires_at: number;
  sent_at: number | null;
  acked_at: number | null;
  result: string | null;
  error: string | null;
  created_by: string | null;
}

export function serializeCommand(row: CommandRow) {
  return {
    id: row.id,
    device_id: row.device_id,
    type: row.type,
    params: parseJson(row.params, {}),
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    sent_at: row.sent_at,
    acked_at: row.acked_at,
    result: parseJson(row.result, null),
    error: row.error,
    created_by: row.created_by,
  };
}

export type CreateResult =
  | { ok: true; command: ReturnType<typeof serializeCommand> }
  | { ok: false; status: 400 | 404; error: string; details?: unknown };

/** Valida, grava e entrega (se a pulseira estiver online) um comando. */
export async function createCommand(
  env: Env,
  deviceId: string,
  input: { type: string; params?: unknown; ttl_s?: number },
  createdBy: string,
): Promise<CreateResult> {
  const exists = await env.DB.prepare("SELECT 1 FROM devices WHERE id = ? AND archived_at IS NULL").bind(deviceId).first();
  if (!exists) return { ok: false, status: 404, error: "Pulseira não encontrada." };

  const parsed = CommandSpec.safeParse({ type: input.type, params: input.params ?? {} });
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Comando inválido.", details: parsed.error.flatten() };
  }
  const now = Date.now();
  const id = newId("cmd");
  const ttl = input.ttl_s ?? 300;
  await env.DB.prepare(
    "INSERT INTO commands (id, device_id, type, params, status, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)",
  )
    .bind(id, deviceId, parsed.data.type, JSON.stringify(parsed.data.params), now, now + ttl * 1000, createdBy)
    .run();

  await env.HUB.get(env.HUB.idFromName(deviceId)).deliver(id);

  const row = await env.DB.prepare("SELECT * FROM commands WHERE id = ?").bind(id).first<CommandRow>();
  return { ok: true, command: serializeCommand(row!) };
}
