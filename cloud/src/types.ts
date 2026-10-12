import type { DeviceHub } from "./hub";
import type { Fleet } from "./fleet";

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<DeviceHub>;
  FLEET: DurableObjectNamespace<Fleet>;
  /** Chave mestra (segredo). Cria as demais chaves de API. */
  ADMIN_API_KEY: string;
  RETENTION_DAYS?: string;
  /** JSON opcional que sobrescreve o mapa de categorias de sono (ver sleep.ts). */
  SLEEP_KIND_MAP?: string;
}

export type Scope = "read" | "command" | "manage" | "admin";
export const ALL_SCOPES: Scope[] = ["read", "command", "manage", "admin"];

export interface Principal {
  /** "admin" para a chave mestra, "key:<id>" para chaves de API. */
  id: string;
  scopes: Set<Scope>;
  /** null = todas as pulseiras. */
  deviceIds: string[] | null;
}

/** Cabeçalhos internos Worker -> Durable Object (o DO nunca é exposto diretamente). */
export const H_ROLE = "x-mb-role";
export const H_DEVICE = "x-mb-device";
export const H_PRINCIPAL = "x-mb-principal";
export const H_DEVICES = "x-mb-devices";
