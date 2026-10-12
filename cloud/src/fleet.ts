import { DurableObject } from "cloudflare:workers";
import { H_DEVICES, H_PRINCIPAL, type Env } from "./types";
import { ViewerMessage } from "./protocol";
import { createCommand } from "./commands";
import { parseJson } from "./util";

interface FleetAttachment {
  principal: string;
  /** Pulseiras permitidas à chave (null = todas). */
  allowed: string[] | null;
  /** Filtros escolhidos pelo cliente. */
  devices: string[] | null;
  types: string[] | null;
}

/**
 * Fluxo global: um único objeto que recebe cópia de tudo que as pulseiras publicam e
 * repassa aos clientes conectados em /v1/stream, respeitando as pulseiras permitidas à chave.
 */
export class Fleet extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Esperado WebSocket", { status: 426 });
    const header = request.headers.get(H_DEVICES);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const att: FleetAttachment = {
      principal: request.headers.get(H_PRINCIPAL) ?? "unknown",
      allowed: header ? (JSON.parse(header) as string[]) : null,
      devices: null,
      types: null,
    };
    server.serializeAttachment(att);
    server.send(JSON.stringify({ t: "hello", message: "Fluxo global conectado. Envie {t:'subscribe', devices?, types?}." }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Chamado pelos DeviceHub a cada mensagem a ser transmitida. */
  async publish(deviceId: string, type: string, text: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as FleetAttachment | null;
      if (!att) continue;
      if (att.allowed && !att.allowed.includes(deviceId)) continue;
      if (att.devices && !att.devices.includes(deviceId)) continue;
      if (att.types && !att.types.includes(type)) continue;
      try { ws.send(text); } catch { /* socket fechado */ }
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as FleetAttachment | null;
    if (!att || typeof raw !== "string") return;
    const parsed = ViewerMessage.safeParse(parseJson(raw, null));
    if (!parsed.success) return void ws.send(JSON.stringify({ t: "error", error: "Mensagem inválida." }));
    const msg = parsed.data;
    if (msg.t === "ping") return void ws.send(JSON.stringify({ t: "pong", server_time: Date.now() }));
    if (msg.t === "subscribe") {
      att.types = msg.types?.length ? msg.types : null;
      att.devices = msg.devices?.length ? msg.devices : null;
      ws.serializeAttachment(att);
      return void ws.send(JSON.stringify({ t: "subscribed", types: att.types ?? "all", devices: att.devices ?? "all" }));
    }
    // Comando pelo fluxo global: exige o escopo 'command' e acesso à pulseira.
    const deviceId = msg.device;
    if (!deviceId) return void ws.send(JSON.stringify({ t: "error", req: msg.req, error: "Informe 'device'." }));
    if (att.allowed && !att.allowed.includes(deviceId)) {
      return void ws.send(JSON.stringify({ t: "error", req: msg.req, error: "Sem acesso a esta pulseira." }));
    }
    if (!(await this.canCommand(att.principal))) {
      return void ws.send(JSON.stringify({ t: "error", req: msg.req, error: "A chave não possui o escopo 'command'." }));
    }
    const result = await createCommand(this.env, deviceId, { type: msg.type, params: msg.params, ttl_s: msg.ttl_s }, att.principal);
    ws.send(JSON.stringify(result.ok ? { t: "command_created", req: msg.req, command: result.command } : { t: "error", req: msg.req, error: result.error, details: result.details }));
  }

  private async canCommand(principal: string): Promise<boolean> {
    if (principal === "admin") return true;
    if (!principal.startsWith("key:")) return false;
    const row = await this.env.DB.prepare("SELECT scopes FROM api_keys WHERE id = ? AND revoked_at IS NULL").bind(principal.slice(4)).first<{ scopes: string }>();
    const scopes = parseJson<string[]>(row?.scopes, []);
    return scopes.includes("command") || scopes.includes("admin");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch { /* já fechado */ }
  }
}
