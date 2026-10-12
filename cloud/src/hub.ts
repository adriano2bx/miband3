import { DurableObject } from "cloudflare:workers";
import { describeRule, stepRule, compare, type AlertRule, type RuleState } from "./alerts";
import { createCommand, serializeCommand, type CommandRow } from "./commands";
import { DeviceMessage, ViewerMessage, type DeviceItem } from "./protocol";
import { H_DEVICE, H_DEVICES, H_PRINCIPAL, H_ROLE, type Env } from "./types";
import { newId, parseJson } from "./util";
import { deliverWebhooks, type WebhookEvent } from "./webhooks";
import { currentTerm, installationView, type DeviceRowLite } from "./participants";

type Role = "device" | "viewer";

interface Attachment {
  role: Role;
  deviceId: string;
  principal: string;
  /** Pulseiras que o visor pode comandar (null = todas). */
  allowed: string[] | null;
  /** Tipos assinados; null = todos. */
  types: string[] | null;
  /** Só para o app: instalação autorizada e com consentimento válido (pode enviar telemetria). */
  accepting?: boolean;
}

interface Latest {
  hr?: { ts: number; bpm: number };
  steps?: { ts: number; steps: number; meters?: number | null; calories?: number | null };
  battery?: { ts: number; level: number; charging: boolean };
  state?: { ts: number; connection: string; detail?: string };
  lastEvent?: { ts: number; type: string };
}

const LIVENESS_TICK_MS = 30_000;
const DEAD_AFTER_MS = 90_000;
const ACK_TIMEOUT_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const RULES_TTL_MS = 30_000;

/**
 * Um Durable Object por pulseira. Mantém o WebSocket do app (papel "device") e de qualquer
 * número de visores (papel "viewer"), grava os dados no D1, avalia regras de alerta e entrega comandos.
 * Usa a API de hibernação: sem tráfego, o objeto sai da memória mas os sockets continuam abertos.
 */
export class DeviceHub extends DurableObject<Env> {
  private rules: { at: number; list: AlertRule[] } | null = null;
  private ruleState: Record<string, RuleState> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Responde "ping" sem acordar o objeto; o horário serve para detectar o app morto.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ------------------------------------------------------------------ entrada HTTP/WS

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Esperado WebSocket", { status: 426 });
    const role = request.headers.get(H_ROLE) as Role;
    const deviceId = request.headers.get(H_DEVICE)!;
    const principal = request.headers.get(H_PRINCIPAL) ?? "unknown";
    const devicesHeader = request.headers.get(H_DEVICES);
    const allowed = devicesHeader ? (JSON.parse(devicesHeader) as string[]) : null;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === "device") {
      // Apenas um app por pulseira: o mais novo substitui o antigo.
      for (const old of this.ctx.getWebSockets("device")) old.close(4000, "Substituído por uma nova conexão");
    }
    this.ctx.acceptWebSocket(server, [role]);
    const attachment: Attachment = { role, deviceId, principal, allowed, types: null };
    server.serializeAttachment(attachment);

    if (role === "device") {
      await this.onDeviceConnected(deviceId, server);
    } else {
      server.send(JSON.stringify(await this.snapshot(deviceId)));
    }
    await this.scheduleTick();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (typeof raw !== "string") return this.reply(ws, { t: "error", error: "Somente mensagens de texto (JSON)." });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.reply(ws, { t: "error", error: "JSON inválido." });
    }
    try {
      if (att.role === "device") await this.onDeviceMessage(ws, att, json);
      else await this.onViewerMessage(ws, att, json);
    } catch (e) {
      console.error("hub message error", e);
      this.reply(ws, { t: "error", error: "Erro interno ao processar a mensagem." });
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.afterClose(ws);
    try { ws.close(code, reason); } catch { /* já fechado */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.afterClose(ws);
  }

  private async afterClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role !== "device") return;
    // Uma conexão substituída por outra não deve marcar a pulseira como offline.
    const stillOnline = this.ctx.getWebSockets("device").some((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (stillOnline) return;
    await this.setOnline(att.deviceId, false);
  }

  // ------------------------------------------------------------------ RPC (chamado pelo Worker)

  /** Tenta entregar um comando recém-criado. */
  async deliver(commandId: string): Promise<void> {
    const row = await this.env.DB.prepare("SELECT * FROM commands WHERE id = ?").bind(commandId).first<CommandRow>();
    if (!row || row.status !== "queued") return;
    await this.sendCommand(row);
    await this.scheduleTick();
  }

  async status(deviceId: string) {
    return this.snapshot(deviceId);
  }

  /** Autorização, consentimento ou perfil de coleta mudaram: avisa o app conectado. */
  async refresh(deviceId: string): Promise<void> {
    await this.ctx.storage.put("deviceId", deviceId);
    const status = await this.installationStatus(deviceId);
    for (const ws of this.ctx.getWebSockets("device")) {
      if (!status || status.revoked) {
        ws.close(4003, "Instalação não autorizada");
        continue;
      }
      this.setAccepting(ws, status.accepting);
      this.reply(ws, { t: "status", server_time: Date.now(), ...status.payload });
    }
  }

  private async installationStatus(deviceId: string) {
    const d = await this.env.DB.prepare("SELECT * FROM devices WHERE id = ? AND archived_at IS NULL").bind(deviceId).first<DeviceRowLite>();
    if (!d) return null;
    const view = installationView(d, await currentTerm(this.env.DB));
    return {
      revoked: d.status === "revoked",
      accepting: view.authorized && view.consent.valid,
      payload: {
        status: view.status,
        authorized: view.authorized,
        consent: view.consent,
        config: view.config,
        config_version: view.config_version,
        config_updated_at: view.config_updated_at,
      },
    };
  }

  private setAccepting(ws: WebSocket, accepting: boolean): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    att.accepting = accepting;
    ws.serializeAttachment(att);
  }

  /** Encerra o socket do app (por exemplo, ao rotacionar o token). */
  async kick(reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets("device")) ws.close(4001, reason);
  }

  // ------------------------------------------------------------------ app (device)

  private async onDeviceConnected(deviceId: string, ws: WebSocket): Promise<void> {
    await this.setOnline(deviceId, true);
    const status = await this.installationStatus(deviceId);
    this.setAccepting(ws, status?.accepting ?? false);
    ws.send(JSON.stringify({ t: "welcome", device_id: deviceId, server_time: Date.now(), ...(status?.payload ?? {}) }));
    // Comandos que ficaram na fila enquanto o app estava offline.
    const now = Date.now();
    await this.env.DB.prepare("UPDATE commands SET status = 'expired' WHERE device_id = ? AND status = 'queued' AND expires_at < ?")
      .bind(deviceId, now)
      .run();
    const { results } = await this.env.DB.prepare(
      "SELECT * FROM commands WHERE device_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 100",
    )
      .bind(deviceId)
      .all<CommandRow>();
    for (const row of results) await this.sendCommand(row);
  }

  private async onDeviceMessage(ws: WebSocket, att: Attachment, json: unknown): Promise<void> {
    const parsed = DeviceMessage.safeParse(json);
    if (!parsed.success) {
      return this.reply(ws, { t: "error", error: "Mensagem inválida.", details: parsed.error.flatten() });
    }
    const msg = parsed.data;
    const now = Date.now();
    await this.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now, att.deviceId).run();

    switch (msg.t) {
      case "ping":
        return this.reply(ws, { t: "pong", server_time: now });
      case "hello": {
        await this.env.DB.prepare("UPDATE devices SET band_info = ?, client_info = ?, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(msg.band ?? {}), JSON.stringify(msg.client ?? {}), now, att.deviceId)
          .run();
        return this.broadcast(att.deviceId, "hello", { t: "hello", band: msg.band ?? {}, client: msg.client ?? {} });
      }
      case "ack":
        return this.onAck(att.deviceId, msg);
      case "batch": {
        if (!att.accepting) {
          // Sem autorização ou sem consentimento válido: nada é gravado nem repassado.
          if (msg.seq !== undefined) this.reply(ws, { t: "stored", seq: msg.seq, accepted: false, reason: "not_authorized" });
          return;
        }
        await this.ingest(att.deviceId, msg.items);
        // Só confirma depois de gravado no D1: o app então descarta os itens da fila local.
        if (msg.seq !== undefined) this.reply(ws, { t: "stored", seq: msg.seq, accepted: true, count: msg.items.length });
        return;
      }
      default:
        if (!att.accepting) return this.reply(ws, { t: "error", error: "Instalação sem autorização ou consentimento válido." });
        return this.ingest(att.deviceId, [msg]);
    }
  }

  private async onAck(deviceId: string, msg: { id: string; ok: boolean; error?: string; result?: unknown }): Promise<void> {
    const now = Date.now();
    const res = await this.env.DB.prepare(
      "UPDATE commands SET status = ?, acked_at = ?, result = ?, error = ? WHERE id = ? AND device_id = ? AND status IN ('sent','queued','timeout')",
    )
      .bind(msg.ok ? "acked" : "failed", now, msg.result === undefined ? null : JSON.stringify(msg.result), msg.error ?? null, msg.id, deviceId)
      .run();
    if (!res.meta.changes) return;
    await this.publishCommand(deviceId, msg.id);
  }

  /** Grava no D1, atualiza o "último valor", avalia alertas e transmite aos visores. */
  private async ingest(deviceId: string, items: DeviceItem[]): Promise<void> {
    const now = Date.now();
    const clamp = (ts: number) => (ts > now + MAX_FUTURE_SKEW_MS ? now : ts);
    const db = this.env.DB;
    const stmts: D1PreparedStatement[] = [];
    const latest = (await this.ctx.storage.get<Latest>("latest")) ?? {};
    const outgoing: Array<{ type: string; payload: Record<string, unknown>; when?: () => boolean }> = [];
    const results: D1Result[] = [];
    const checks: Array<() => Promise<void>> = [];

    for (const item of items) {
      switch (item.t) {
        case "hr": {
          const ts = clamp(item.ts);
          stmts.push(db.prepare("INSERT OR REPLACE INTO heart_rate (device_id, ts, bpm) VALUES (?, ?, ?)").bind(deviceId, ts, item.bpm));
          if (!latest.hr || ts >= latest.hr.ts) latest.hr = { ts, bpm: item.bpm };
          outgoing.push({ type: "hr", payload: { ts, bpm: item.bpm } });
          checks.push(() => this.evaluate(deviceId, "heart_rate", item.bpm, ts));
          break;
        }
        case "steps": {
          const ts = clamp(item.ts);
          stmts.push(
            db.prepare("INSERT OR REPLACE INTO steps (device_id, ts, steps, meters, calories) VALUES (?, ?, ?, ?, ?)")
              .bind(deviceId, ts, item.steps, item.meters ?? null, item.calories ?? null),
          );
          if (!latest.steps || ts >= latest.steps.ts) latest.steps = { ts, steps: item.steps, meters: item.meters, calories: item.calories };
          outgoing.push({ type: "steps", payload: { ts, steps: item.steps, meters: item.meters ?? null, calories: item.calories ?? null } });
          break;
        }
        case "battery": {
          const ts = clamp(item.ts);
          stmts.push(
            db.prepare("INSERT OR REPLACE INTO battery (device_id, ts, level, charging) VALUES (?, ?, ?, ?)")
              .bind(deviceId, ts, item.level, item.charging ? 1 : 0),
          );
          if (!latest.battery || ts >= latest.battery.ts) latest.battery = { ts, level: item.level, charging: item.charging };
          outgoing.push({ type: "battery", payload: { ts, level: item.level, charging: item.charging } });
          if (!item.charging) checks.push(() => this.evaluate(deviceId, "battery", item.level, ts));
          break;
        }
        case "event": {
          const ts = clamp(item.ts);
          const index = stmts.length;
          stmts.push(
            db.prepare("INSERT OR IGNORE INTO events (device_id, ts, type, data, client_id) VALUES (?, ?, ?, ?, ?)")
              .bind(deviceId, ts, item.type, item.data ? JSON.stringify(item.data) : null, item.id ?? null),
          );
          latest.lastEvent = { ts, type: item.type };
          // Reenvio de um evento já gravado (mesmo id): não repete alerta, webhook nem transmissão.
          const fresh = () => (results[index]?.meta?.changes ?? 1) > 0;
          outgoing.push({ type: "event", payload: { ts, type: item.type, data: item.data ?? null }, when: fresh });
          checks.push(() => (fresh() ? this.evaluateEvent(deviceId, item.type, ts) : Promise.resolve()));
          checks.push(() => (fresh() ? this.webhook("event.created", deviceId, { ts, type: item.type, data: item.data ?? null }) : Promise.resolve()));
          break;
        }
        case "activity": {
          for (const s of item.samples) {
            stmts.push(
              db.prepare("INSERT OR REPLACE INTO activity (device_id, ts, kind, intensity, steps, hr) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(deviceId, s.ts, s.kind, s.intensity, s.steps, s.hr ?? null),
            );
          }
          outgoing.push({ type: "activity", payload: { count: item.samples.length, from: item.samples[0]?.ts ?? null, to: item.samples.at(-1)?.ts ?? null } });
          break;
        }
        case "state": {
          latest.state = { ts: clamp(item.ts), connection: item.connection, detail: item.detail };
          outgoing.push({ type: "state", payload: { ts: latest.state.ts, connection: item.connection, detail: item.detail ?? null } });
          break;
        }
      }
    }

    if (stmts.length) {
      // D1 limita ~100 comandos por batch; fatiamos para segurança.
      for (let i = 0; i < stmts.length; i += 90) results.push(...(await db.batch(stmts.slice(i, i + 90))));
    }
    await this.ctx.storage.put("latest", latest);
    for (const o of outgoing) if (!o.when || o.when()) await this.broadcast(deviceId, o.type, { t: o.type, ...o.payload });
    for (const check of checks) await check();
  }

  // ------------------------------------------------------------------ visores (viewer)

  private async onViewerMessage(ws: WebSocket, att: Attachment, json: unknown): Promise<void> {
    const parsed = ViewerMessage.safeParse(json);
    if (!parsed.success) {
      return this.reply(ws, { t: "error", error: "Mensagem inválida.", details: parsed.error.flatten() });
    }
    const msg = parsed.data;
    if (msg.t === "ping") return this.reply(ws, { t: "pong", server_time: Date.now() });
    if (msg.t === "subscribe") {
      att.types = msg.types?.length ? msg.types : null;
      ws.serializeAttachment(att);
      return this.reply(ws, { t: "subscribed", types: att.types ?? "all" });
    }
    // msg.t === "command"
    if (!att.principal.startsWith("admin") && att.allowed && !att.allowed.includes(att.deviceId)) {
      return this.reply(ws, { t: "error", req: msg.req, error: "Sem acesso a esta pulseira." });
    }
    if (!(await this.canCommand(att.principal))) {
      return this.reply(ws, { t: "error", req: msg.req, error: "A chave não possui o escopo 'command'." });
    }
    const result = await createCommand(this.env, att.deviceId, { type: msg.type, params: msg.params, ttl_s: msg.ttl_s }, att.principal);
    this.reply(ws, result.ok ? { t: "command_created", req: msg.req, command: result.command } : { t: "error", req: msg.req, error: result.error, details: result.details });
  }

  private async canCommand(principal: string): Promise<boolean> {
    if (principal === "admin") return true;
    if (!principal.startsWith("key:")) return false;
    const row = await this.env.DB.prepare("SELECT scopes FROM api_keys WHERE id = ? AND revoked_at IS NULL")
      .bind(principal.slice(4))
      .first<{ scopes: string }>();
    const scopes = parseJson<string[]>(row?.scopes, []);
    return scopes.includes("command") || scopes.includes("admin");
  }

  // ------------------------------------------------------------------ comandos

  private async sendCommand(row: CommandRow): Promise<void> {
    const device = this.ctx.getWebSockets("device").find((s) => s.readyState === WebSocket.OPEN);
    const now = Date.now();
    if (row.expires_at < now) {
      await this.env.DB.prepare("UPDATE commands SET status = 'expired' WHERE id = ? AND status = 'queued'").bind(row.id).run();
      return this.publishCommand(row.device_id, row.id);
    }
    if (!device) return; // continua 'queued' até o app conectar
    device.send(JSON.stringify({ t: "command", id: row.id, type: row.type, params: parseJson(row.params, {}), expires_at: row.expires_at }));
    await this.env.DB.prepare("UPDATE commands SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'queued'").bind(now, row.id).run();
    await this.publishCommand(row.device_id, row.id);
  }

  private async publishCommand(deviceId: string, commandId: string): Promise<void> {
    const row = await this.env.DB.prepare("SELECT * FROM commands WHERE id = ?").bind(commandId).first<CommandRow>();
    if (!row) return;
    const command = serializeCommand(row);
    await this.broadcast(deviceId, "command", { t: "command", command });
    await this.webhook("command.updated", deviceId, command);
  }

  // ------------------------------------------------------------------ alertas

  private async loadRules(deviceId: string): Promise<AlertRule[]> {
    if (this.rules && Date.now() - this.rules.at < RULES_TTL_MS) return this.rules.list;
    const { results } = await this.env.DB.prepare("SELECT * FROM alert_rules WHERE enabled = 1 AND (device_id IS NULL OR device_id = ?)")
      .bind(deviceId)
      .all<AlertRule>();
    this.rules = { at: Date.now(), list: results };
    return results;
  }

  private async state(): Promise<Record<string, RuleState>> {
    this.ruleState ??= (await this.ctx.storage.get<Record<string, RuleState>>("ruleState")) ?? {};
    return this.ruleState;
  }

  private async evaluate(deviceId: string, metric: "heart_rate" | "battery" | "offline", value: number, ts: number): Promise<void> {
    const rules = (await this.loadRules(deviceId)).filter((r) => r.metric === metric && r.threshold !== null);
    if (!rules.length) return;
    const states = await this.state();
    let dirty = false;
    for (const rule of rules) {
      const prev = states[rule.id] ?? { since: null, lastFired: null };
      const { fire, state } = stepRule(rule, prev, compare(rule.op, value, rule.threshold!), ts);
      if (state.since !== prev.since || state.lastFired !== prev.lastFired) {
        states[rule.id] = state;
        dirty = true;
      }
      if (fire) await this.fireAlert(deviceId, rule, value, describeRule(rule, value), ts);
    }
    if (dirty) await this.ctx.storage.put("ruleState", states);
  }

  private async evaluateEvent(deviceId: string, type: string, ts: number): Promise<void> {
    const rules = (await this.loadRules(deviceId)).filter((r) => r.metric === "event" && r.match === type);
    if (!rules.length) return;
    const states = await this.state();
    for (const rule of rules) {
      const prev = states[rule.id] ?? { since: null, lastFired: null };
      const { fire, state } = stepRule({ duration_s: 0, cooldown_s: rule.cooldown_s }, prev, true, ts);
      states[rule.id] = { since: null, lastFired: state.lastFired };
      if (fire) await this.fireAlert(deviceId, rule, null, describeRule(rule, type), ts);
    }
    await this.ctx.storage.put("ruleState", states);
  }

  private async fireAlert(deviceId: string, rule: AlertRule, value: number | null, message: string, ts: number): Promise<void> {
    const alert = { id: newId("alt"), device_id: deviceId, rule_id: rule.id, ts, metric: rule.metric, value, severity: rule.severity, message, acked_at: null, acked_by: null };
    await this.env.DB.prepare("INSERT INTO alerts (id, device_id, rule_id, ts, metric, value, severity, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(alert.id, deviceId, rule.id, ts, rule.metric, value, rule.severity, message)
      .run();
    await this.broadcast(deviceId, "alert", { t: "alert", alert: { ...alert, rule_name: rule.name } });
    await this.webhook("alert.created", deviceId, { ...alert, rule_name: rule.name });

    // Ação automática: vibrar / mandar mensagem para o paciente.
    const action = parseJson<{ vibrate?: Record<string, unknown> | boolean; message?: Record<string, unknown> }>(rule.action, {});
    if (action.vibrate) {
      await createCommand(this.env, deviceId, { type: "vibrate", params: typeof action.vibrate === "object" ? action.vibrate : {}, ttl_s: 60 }, `rule:${rule.id}`);
    }
    if (action.message) {
      await createCommand(this.env, deviceId, { type: "message", params: action.message, ttl_s: 120 }, `rule:${rule.id}`);
    }
  }

  // ------------------------------------------------------------------ presença e vigilância

  private async setOnline(deviceId: string, online: boolean): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare("UPDATE devices SET online = ?, last_seen_at = ? WHERE id = ?").bind(online ? 1 : 0, now, deviceId).run();
    if (online) {
      await this.ctx.storage.delete("offlineSince");
    } else {
      await this.ctx.storage.put("offlineSince", now);
    }
    await this.broadcast(deviceId, "presence", { t: "presence", online, ts: now });
    await this.webhook(online ? "device.online" : "device.offline", deviceId, { ts: now });
    await this.scheduleTick();
  }

  private async scheduleTick(): Promise<void> {
    const offlineSince = await this.ctx.storage.get<number>("offlineSince");
    const pending = await this.ctx.storage.get<boolean>("watch");
    const hasSockets = this.ctx.getWebSockets().length > 0;
    if (hasSockets || offlineSince || pending) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null) await this.ctx.storage.setAlarm(Date.now() + LIVENESS_TICK_MS);
    }
  }

  /** A cada 30 s: derruba apps mudos, expira comandos e avalia regras "offline". */
  async alarm(): Promise<void> {
    const now = Date.now();
    const deviceId = await this.knownDeviceId();
    let keepWatching = false;

    for (const ws of this.ctx.getWebSockets("device")) {
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      const dbSeen = deviceId ? await this.env.DB.prepare("SELECT last_seen_at FROM devices WHERE id = ?").bind(deviceId).first<{ last_seen_at: number | null }>() : null;
      const seen = Math.max(lastPing, dbSeen?.last_seen_at ?? 0);
      if (now - seen > DEAD_AFTER_MS) {
        ws.close(4008, "Sem sinal de vida");
        await this.afterClose(ws);
      } else {
        keepWatching = true;
      }
    }

    if (deviceId) {
      const expired = await this.env.DB.prepare("SELECT id FROM commands WHERE device_id = ? AND status = 'queued' AND expires_at < ?").bind(deviceId, now).all<{ id: string }>();
      const timedOut = await this.env.DB.prepare("SELECT id FROM commands WHERE device_id = ? AND status = 'sent' AND sent_at < ?").bind(deviceId, now - ACK_TIMEOUT_MS).all<{ id: string }>();
      if (expired.results.length) {
        await this.env.DB.prepare("UPDATE commands SET status = 'expired' WHERE device_id = ? AND status = 'queued' AND expires_at < ?").bind(deviceId, now).run();
        for (const r of expired.results) await this.publishCommand(deviceId, r.id);
      }
      if (timedOut.results.length) {
        await this.env.DB.prepare("UPDATE commands SET status = 'timeout', error = 'Sem confirmação do app' WHERE device_id = ? AND status = 'sent' AND sent_at < ?").bind(deviceId, now - ACK_TIMEOUT_MS).run();
        for (const r of timedOut.results) await this.publishCommand(deviceId, r.id);
      }

      const offlineSince = await this.ctx.storage.get<number>("offlineSince");
      if (offlineSince) {
        const rules = (await this.loadRules(deviceId)).filter((r) => r.metric === "offline" && r.threshold !== null);
        const secs = Math.round((now - offlineSince) / 1000);
        const states = await this.state();
        for (const rule of rules) {
          const prev = states[rule.id] ?? { since: null, lastFired: null };
          // Dispara uma única vez por período offline.
          if (prev.lastFired !== null && prev.lastFired >= offlineSince) continue;
          if (secs > rule.threshold!) {
            states[rule.id] = { since: offlineSince, lastFired: now };
            await this.ctx.storage.put("ruleState", states);
            await this.fireAlert(deviceId, rule, secs, describeRule(rule, secs), now);
          } else {
            keepWatching = true;
          }
        }
      }
    }

    const pendingCommands = deviceId ? await this.env.DB.prepare("SELECT 1 FROM commands WHERE device_id = ? AND status IN ('queued','sent') LIMIT 1").bind(deviceId).first() : null;
    await this.ctx.storage.put("watch", Boolean(pendingCommands));
    if (keepWatching || pendingCommands || this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + LIVENESS_TICK_MS);
    }
  }

  private async knownDeviceId(): Promise<string | null> {
    const stored = await this.ctx.storage.get<string>("deviceId");
    if (stored) return stored;
    const ws = this.ctx.getWebSockets()[0];
    const id = (ws?.deserializeAttachment() as Attachment | null)?.deviceId ?? null;
    if (id) await this.ctx.storage.put("deviceId", id);
    return id;
  }

  // ------------------------------------------------------------------ utilidades

  private async snapshot(deviceId: string) {
    await this.ctx.storage.put("deviceId", deviceId);
    const latest = (await this.ctx.storage.get<Latest>("latest")) ?? {};
    const row = await this.env.DB.prepare("SELECT online, last_seen_at, band_info, client_info FROM devices WHERE id = ?")
      .bind(deviceId)
      .first<{ online: number; last_seen_at: number | null; band_info: string | null; client_info: string | null }>();
    const connected = this.ctx.getWebSockets("device").some((s) => s.readyState === WebSocket.OPEN);
    return {
      t: "snapshot",
      device_id: deviceId,
      online: connected,
      last_seen_at: row?.last_seen_at ?? null,
      band: parseJson(row?.band_info, {}),
      client: parseJson(row?.client_info, {}),
      latest,
      server_time: Date.now(),
    };
  }

  private reply(ws: WebSocket, payload: unknown): void {
    try { ws.send(JSON.stringify(payload)); } catch { /* socket fechado */ }
  }

  /** Envia aos visores desta pulseira e ao fluxo global. */
  private async broadcast(deviceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify({ ...payload, device_id: deviceId });
    for (const ws of this.ctx.getWebSockets("viewer")) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.types && !att.types.includes(type)) continue;
      try { ws.send(text); } catch { /* ignora */ }
    }
    try {
      await this.env.FLEET.get(this.env.FLEET.idFromName("global")).publish(deviceId, type, text);
    } catch (e) {
      console.error("fleet publish failed", e);
    }
  }

  private async webhook(event: WebhookEvent, deviceId: string, data: unknown): Promise<void> {
    this.ctx.waitUntil(deliverWebhooks(this.env, event, deviceId, data).catch((e) => console.error("webhook", e)));
  }
}
