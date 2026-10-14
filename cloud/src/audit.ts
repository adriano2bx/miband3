import type { Env } from "./types";
import { newId } from "./util";

/**
 * Trilha de auditoria de acesso a dados de saúde. Nunca quebra a requisição:
 * uma falha de auditoria é engolida (melhor registrar de menos do que derrubar o acesso).
 */
export async function audit(
  env: Env,
  entry: { principal: string; action: string; patient_id?: string | null; device_id?: string | null; detail?: string | null },
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (id, ts, principal, action, patient_id, device_id, detail) VALUES (?,?,?,?,?,?,?)",
    ).bind(newId("aud"), Date.now(), entry.principal, entry.action, entry.patient_id ?? null, entry.device_id ?? null, entry.detail ?? null).run();
  } catch {
    /* auditoria é best-effort */
  }
}
