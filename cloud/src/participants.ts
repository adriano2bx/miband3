import { z } from "zod";

import { enc, parseJson } from "./util";

// ====================================================================== termo e consentimento

export interface TermRow {
  version: string;
  title: string;
  content: string;
  requires_reconsent: number;
  published_at: number;
}

export async function currentTerm(db: D1Database): Promise<TermRow | null> {
  return db.prepare("SELECT * FROM consent_terms ORDER BY published_at DESC LIMIT 1").first<TermRow>();
}

export interface ConsentState {
  accepted_version: string | null;
  current_version: string | null;
  /** O participante tem um aceite que vale para o termo vigente. */
  valid: boolean;
}

/**
 * Um aceite vale se for da versão vigente, ou de uma versão anterior quando a versão
 * vigente não exige novo aceite. Sem termo publicado, não há consentimento possível.
 */
export function consentState(acceptedVersion: string | null, term: TermRow | null): ConsentState {
  const valid = Boolean(term && acceptedVersion && (acceptedVersion === term.version || !term.requires_reconsent));
  return { accepted_version: acceptedVersion, current_version: term?.version ?? null, valid };
}

// ====================================================================== perfil de coleta

export const CollectionConfig = z.object({
  /** Minutos entre medições de FC; 0 = contínua. */
  hr_interval_min: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60), z.literal(120)]),
  /** Minutos entre downloads do histórico por minuto da pulseira. */
  history_interval_min: z.number().int().min(15).max(240),
});
export type CollectionConfig = z.infer<typeof CollectionConfig>;

export const DEFAULT_CONFIG: CollectionConfig = { hr_interval_min: 30, history_interval_min: 30 };

export function effectiveConfig(json: string | null | undefined): CollectionConfig {
  const parsed = CollectionConfig.partial().safeParse(parseJson(json, {}));
  return { ...DEFAULT_CONFIG, ...(parsed.success ? parsed.data : {}) };
}

// ====================================================================== instalação (visão do app)

export interface DeviceRowLite {
  id: string;
  name: string;
  patient_ref: string | null;
  status: string;
  online: number;
  last_seen_at: number | null;
  band_info: string | null;
  consent_version: string | null;
  consent_at: number | null;
  config: string;
  config_version: number;
  config_updated_at: number | null;
  archived_at: number | null;
}

export function installationView(d: DeviceRowLite, term: TermRow | null) {
  const consent = consentState(d.consent_version, term);
  return {
    device_id: d.id,
    status: d.status,
    authorized: d.status === "active",
    participant_ref: d.patient_ref,
    online: Boolean(d.online),
    last_seen_at: d.last_seen_at,
    consent: { ...consent, accepted_at: d.consent_at },
    config: effectiveConfig(d.config),
    config_version: d.config_version,
    config_updated_at: d.config_updated_at,
    band: parseJson(d.band_info, null),
  };
}

// ====================================================================== senhas dos técnicos

const PBKDF2_ITERATIONS = 100_000; // limite do Workers
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const computed = await pbkdf2(password, unb64(salt), Number(iter));
  const expected = unb64(hash);
  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed[i] ^ expected[i];
  return diff === 0;
}

/** Hash de uma senha aleatória, usado para gastar o mesmo tempo quando a credencial não existe. */
let dummyHash: string | null = null;
export async function burnPasswordTime(password: string): Promise<void> {
  dummyHash ??= await hashPassword(crypto.randomUUID());
  await verifyPassword(password, dummyHash);
}

export const TECH_SESSION_IDLE_MS = 10 * 60_000;
export const TECH_SESSION_MAX_MS = 8 * 3600_000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60_000;

