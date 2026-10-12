import { z } from "zod";

/**
 * Protocolo WebSocket (JSON, uma mensagem por frame).
 *
 * app -> nuvem   : hello, hr, steps, battery, event, activity, state, ack, batch, ping
 * nuvem -> app   : welcome, command, pong
 * visor -> nuvem : subscribe, command, ping
 * nuvem -> visor : snapshot, presence, hr, steps, battery, event, activity, state,
 *                  alert, command, pong
 */

const ts = z.number().int().nonnegative();

export const DeviceItem = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hr"), ts, bpm: z.number().int().min(1).max(300) }),
  z.object({
    t: z.literal("steps"),
    ts,
    steps: z.number().int().nonnegative(),
    meters: z.number().int().nonnegative().nullish(),
    calories: z.number().int().nonnegative().nullish(),
  }),
  z.object({
    t: z.literal("battery"),
    ts,
    level: z.number().int().min(0).max(100),
    charging: z.boolean().default(false),
  }),
  z.object({
    t: z.literal("event"),
    ts,
    /** Identificador gerado pelo app; reenvios com o mesmo id são ignorados. */
    id: z.string().min(1).max(64).optional(),
    type: z.string().min(1).max(64),
    data: z.record(z.unknown()).optional(),
  }),
  z.object({
    t: z.literal("activity"),
    samples: z
      .array(
        z.object({
          ts,
          kind: z.number().int().min(0).max(255),
          intensity: z.number().int().min(0).max(255),
          steps: z.number().int().min(0).max(255),
          hr: z.number().int().min(0).max(255).nullish(),
        }),
      )
      .max(2000),
  }),
  z.object({
    t: z.literal("state"),
    ts,
    connection: z.string().max(32),
    detail: z.string().max(500).optional(),
  }),
]);
export type DeviceItem = z.infer<typeof DeviceItem>;

export const BandInfo = z
  .object({
    name: z.string().max(100).nullish(),
    address: z.string().max(64).nullish(),
    firmware: z.string().max(64).nullish(),
    hardware: z.string().max(64).nullish(),
    serial: z.string().max(64).nullish(),
  })
  .partial();

export const DeviceMessage = z.union([
  DeviceItem,
  /** `seq` pede confirmação: a nuvem responde {t:"stored", seq} depois de gravar. */
  z.object({ t: z.literal("batch"), seq: z.number().int().nonnegative().optional(), items: z.array(DeviceItem).max(500) }),
  z.object({
    t: z.literal("hello"),
    client: z
      .object({
        app: z.string().max(64).optional(),
        version: z.string().max(32).optional(),
        os: z.string().max(64).optional(),
        model: z.string().max(64).optional(),
      })
      .optional(),
    band: BandInfo.optional(),
  }),
  z.object({
    t: z.literal("ack"),
    id: z.string(),
    ok: z.boolean(),
    error: z.string().max(500).optional(),
    result: z.unknown().optional(),
  }),
  z.object({ t: z.literal("ping") }),
]);
export type DeviceMessage = z.infer<typeof DeviceMessage>;

// ------------------------------------------------------------------ comandos

export const CommandSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("vibrate"),
    params: z
      .object({
        count: z.number().int().min(1).max(10).default(1),
        durationMs: z.number().int().min(100).max(3000).default(800),
        pauseMs: z.number().int().min(100).max(3000).default(500),
        level: z.enum(["mild", "high"]).default("high"),
      })
      .default({}),
  }),
  z.object({
    type: z.literal("message"),
    params: z.object({
      kind: z.enum(["sms", "app", "call", "email"]).default("app"),
      title: z.string().min(1).max(32),
      body: z.string().max(200).default(""),
    }),
  }),
  z.object({ type: z.literal("stop_call"), params: z.object({}).default({}) }),
  z.object({ type: z.literal("measure_hr"), params: z.object({}).default({}) }),
  z.object({
    type: z.literal("hr_continuous"),
    params: z.object({ enabled: z.boolean() }),
  }),
  z.object({ type: z.literal("sync_time"), params: z.object({}).default({}) }),
  z.object({ type: z.literal("refresh"), params: z.object({}).default({}) }),
  z.object({
    type: z.literal("fetch_history"),
    params: z.object({ sinceMs: z.number().int().nonnegative().optional() }).default({}),
  }),
  z.object({
    type: z.literal("set_alarm"),
    params: z.object({
      slot: z.number().int().min(0).max(2),
      enabled: z.boolean(),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      /** Bits: seg=1 ter=2 qua=4 qui=8 sex=16 sáb=32 dom=64; 0 = apenas uma vez. */
      days: z.number().int().min(0).max(127).default(127),
    }),
  }),
]);
export type CommandSpec = z.infer<typeof CommandSpec>;
export const COMMAND_TYPES = CommandSpec.options.map((o) => o.shape.type.value);

export const CommandRequest = z.object({
  type: z.string(),
  params: z.record(z.unknown()).optional(),
  /** Validade em segundos: se a pulseira ficar offline além disso, o comando expira. */
  ttl_s: z.number().int().min(5).max(86400).default(300),
});

export const ViewerMessage = z.union([
  z.object({
    t: z.literal("subscribe"),
    /** Tipos desejados (hr, steps, battery, event, activity, state, alert, command, presence). Vazio = todos. */
    types: z.array(z.string()).optional(),
    /** Só no fluxo global: restringe a estas pulseiras. */
    devices: z.array(z.string()).optional(),
  }),
  z.object({
    t: z.literal("command"),
    req: z.string().max(64).optional(),
    type: z.string(),
    params: z.record(z.unknown()).optional(),
    ttl_s: z.number().int().min(5).max(86400).optional(),
    /** Só no fluxo global. */
    device: z.string().optional(),
  }),
  z.object({ t: z.literal("ping") }),
]);
export type ViewerMessage = z.infer<typeof ViewerMessage>;
