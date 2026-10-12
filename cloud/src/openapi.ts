import { COMMAND_TYPES } from "./protocol";
import { WEBHOOK_EVENTS } from "./webhooks";

type Op = { summary: string; scope?: string; tag: string; params?: string[]; body?: string; csv?: boolean };

const timeParams = ["from", "to", "limit", "order"];

const routes: Record<string, Record<string, Op>> = {
  "/v1/health": { get: { summary: "Verifica se o serviço está no ar (sem autenticação).", tag: "Geral" } },
  "/v1/me": { get: { summary: "Mostra os escopos e pulseiras da chave usada.", tag: "Geral" } },
  "/v1/overview": { get: { summary: "Último valor (FC, bateria, passos, alertas) de todos os pacientes.", scope: "read", tag: "Tempo real" } },
  "/v1/stream": { get: { summary: "WebSocket global: dados e alertas de todas as pulseiras permitidas; aceita comandos.", scope: "read", tag: "Tempo real" } },
  "/v1/connect": { get: { summary: "WebSocket usado pelo app Android (token mbd_…).", tag: "App" } },
  "/v1/devices": {
    get: { summary: "Lista pulseiras/pacientes.", scope: "read", tag: "Pulseiras", params: ["online", "patient_ref", "q", "limit", "cursor", "archived"] },
    post: { summary: "Cadastra uma pulseira e devolve o device_token (mostrado uma única vez).", scope: "manage", tag: "Pulseiras", body: "DeviceInput" },
  },
  "/v1/devices/{id}": {
    get: { summary: "Detalhes da pulseira.", scope: "read", tag: "Pulseiras" },
    patch: { summary: "Altera nome, referência do paciente, notas e metadados.", scope: "manage", tag: "Pulseiras", body: "DeviceInput" },
    delete: { summary: "Arquiva (ou apaga tudo com ?purge=true, exige admin).", scope: "manage", tag: "Pulseiras", params: ["purge"] },
  },
  "/v1/devices/{id}/rotate-token": { post: { summary: "Gera novo device_token e desconecta o app atual.", scope: "manage", tag: "Pulseiras" } },
  "/v1/devices/{id}/status": { get: { summary: "Estado ao vivo: online, último valor de cada sensor, comandos pendentes.", scope: "read", tag: "Tempo real" } },
  "/v1/devices/{id}/stream": { get: { summary: "WebSocket de uma pulseira: dados ao vivo, alertas e comandos.", scope: "read", tag: "Tempo real" } },
  "/v1/devices/{id}/heart-rate": { get: { summary: "Frequência cardíaca. Com bucket=1m|5m|15m|1h|1d devolve média/mín/máx.", scope: "read", tag: "Histórico", params: [...timeParams, "bucket", "format"], csv: true } },
  "/v1/devices/{id}/steps": { get: { summary: "Passos/distância/calorias. bucket=1d dá o total por dia (tz_offset_min ajusta o fuso).", scope: "read", tag: "Histórico", params: [...timeParams, "bucket", "tz_offset_min", "format"], csv: true } },
  "/v1/devices/{id}/battery": { get: { summary: "Histórico de bateria.", scope: "read", tag: "Histórico", params: [...timeParams, "format"], csv: true } },
  "/v1/devices/{id}/events": { get: { summary: "Eventos da pulseira (botão, retirada do pulso, meta de passos…).", scope: "read", tag: "Histórico", params: [...timeParams, "type", "format"], csv: true } },
  "/v1/devices/{id}/activity": { get: { summary: "Amostras por minuto baixadas da pulseira (categoria, intensidade, passos, FC).", scope: "read", tag: "Histórico", params: [...timeParams, "format"], csv: true } },
  "/v1/devices/{id}/sleep": { get: { summary: "Sessões de sono derivadas das amostras por minuto (classificação provisória).", scope: "read", tag: "Histórico", params: ["from", "to"] } },
  "/v1/devices/{id}/summary": { get: { summary: "Resumo do período: FC, passos, bateria, eventos, alertas e sono.", scope: "read", tag: "Histórico", params: ["from", "to"] } },
  "/v1/devices/{id}/commands": {
    get: { summary: "Lista comandos enviados.", scope: "read", tag: "Comandos", params: [...timeParams, "status"] },
    post: { summary: `Envia um comando à pulseira (${COMMAND_TYPES.join(", ")}). Fica na fila se o app estiver offline até o ttl_s.`, scope: "command", tag: "Comandos", body: "CommandRequest" },
  },
  "/v1/devices/{id}/vibrate": { post: { summary: "Atalho para o comando vibrate.", scope: "command", tag: "Comandos", body: "VibrateParams" } },
  "/v1/devices/{id}/commands/{cid}": {
    get: { summary: "Estado de um comando: queued, sent, acked, failed, timeout, expired, cancelled.", scope: "read", tag: "Comandos" },
    delete: { summary: "Cancela um comando ainda na fila.", scope: "command", tag: "Comandos" },
  },
  "/v1/alert-rules": {
    get: { summary: "Lista regras de alerta.", scope: "read", tag: "Alertas", params: ["device_id"] },
    post: { summary: "Cria regra (FC, bateria, offline ou evento) com ação opcional de vibrar/mensagem.", scope: "manage", tag: "Alertas", body: "AlertRule" },
  },
  "/v1/alert-rules/{rid}": {
    patch: { summary: "Altera regra.", scope: "manage", tag: "Alertas", body: "AlertRule" },
    delete: { summary: "Remove regra.", scope: "manage", tag: "Alertas" },
  },
  "/v1/alerts": { get: { summary: "Alertas disparados.", scope: "read", tag: "Alertas", params: [...timeParams, "device_id", "severity", "acked", "format"], csv: true } },
  "/v1/alerts/{aid}/ack": { post: { summary: "Marca o alerta como reconhecido.", scope: "command", tag: "Alertas" } },
  "/v1/webhooks": {
    get: { summary: "Lista webhooks.", scope: "manage", tag: "Webhooks" },
    post: { summary: `Cria webhook HTTPS. Eventos: ${WEBHOOK_EVENTS.join(", ")}. O segredo (HMAC) só aparece na criação.`, scope: "manage", tag: "Webhooks", body: "Webhook" },
  },
  "/v1/webhooks/{wid}": {
    patch: { summary: "Altera webhook (reativar zera falhas).", scope: "manage", tag: "Webhooks", body: "Webhook" },
    delete: { summary: "Remove webhook.", scope: "manage", tag: "Webhooks" },
  },
  "/v1/webhooks/{wid}/test": { post: { summary: "Envia um evento de teste.", scope: "manage", tag: "Webhooks" } },
  "/v1/api-keys": {
    get: { summary: "Lista chaves de API.", scope: "admin", tag: "Chaves" },
    post: { summary: "Cria chave (escopos read/command/manage/admin; opcionalmente restrita a pulseiras).", scope: "admin", tag: "Chaves", body: "ApiKey" },
  },
  "/v1/api-keys/{kid}": { delete: { summary: "Revoga a chave.", scope: "admin", tag: "Chaves" } },
  "/v1/consent/terms/current": { get: { summary: "Termo de participação vigente (público).", tag: "Participantes" } },
  "/v1/consent/terms": {
    get: { summary: "Versões publicadas do termo.", scope: "read", tag: "Participantes" },
    post: { summary: "Publica nova versão do termo (não editável depois).", scope: "admin", tag: "Participantes", body: "Term" },
  },
  "/v1/installations": { post: { summary: "Adesão pelo app: registra o aceite do termo vigente e cria a instalação pendente. Devolve o device_token.", tag: "Participantes" } },
  "/v1/consent": { post: { summary: "Aceite ou recusa de uma versão do termo pela instalação (token mbd_).", tag: "Participantes" } },
  "/v1/installation": { get: { summary: "Estado da instalação: autorização, consentimento e perfil de coleta (token mbd_).", tag: "Participantes" } },
  "/v1/devices/{id}/consents": { get: { summary: "Histórico de aceites e recusas.", scope: "read", tag: "Participantes" } },
  "/v1/devices/{id}/authorize": { post: { summary: "Autoriza a instalação e vincula o participante (participant_ref).", scope: "manage", tag: "Participantes" } },
  "/v1/devices/{id}/revoke": { post: { summary: "Bloqueia a instalação (app mostra 'Conexão não autorizada').", scope: "manage", tag: "Participantes" } },
  "/v1/devices/{id}/config": { put: { summary: "Perfil de coleta: hr_interval_min (0=contínua, 5, 10, 15, 30, 60, 120) e history_interval_min (15–240). Enviado ao app em tempo real.", scope: "manage", tag: "Participantes" } },
  "/v1/technicians": {
    get: { summary: "Lista técnicos.", scope: "admin", tag: "Acesso técnico" },
    post: { summary: "Cria técnico (credencial, nome, senha ≥ 10 caracteres, escopos tech/provision).", scope: "admin", tag: "Acesso técnico" },
  },
  "/v1/technicians/{tid}": {
    patch: { summary: "Altera nome, senha (encerra sessões), escopos ou desbloqueia.", scope: "admin", tag: "Acesso técnico" },
    delete: { summary: "Desativa o técnico e encerra as sessões.", scope: "admin", tag: "Acesso técnico" },
  },
  "/v1/tech/login": { post: { summary: "Login técnico no app: credencial + senha + device_token → sessão mbt_ (10 min de inatividade, 8 h no máximo). 5 erros bloqueiam por 15 min.", tag: "Acesso técnico" } },
  "/v1/tech/logout": { post: { summary: "Encerra a sessão técnica.", tag: "Acesso técnico" } },
  "/v1/tech/installation": { get: { summary: "Instalação vinculada à sessão técnica.", tag: "Acesso técnico" } },
  "/v1/tech/installation/authorize": { post: { summary: "Autoriza a instalação desta sessão (escopo provision).", tag: "Acesso técnico" } },
  "/v1/tech/ping": { get: { summary: "Teste de comunicação autenticada.", tag: "Acesso técnico" } },
};

export function openapi(origin: string) {
  const paths: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(routes)) {
    const out: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      const parameters = [
        ...[...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } })),
        ...(op.params ?? []).map((name) => ({ name, in: "query", required: false, schema: { type: name === "limit" || name === "tz_offset_min" ? "integer" : "string" } })),
      ];
      out[method] = {
        tags: [op.tag],
        summary: op.summary,
        description: op.scope ? `Escopo necessário: \`${op.scope}\`.` : undefined,
        parameters,
        requestBody: op.body ? { required: method !== "patch", content: { "application/json": { schema: { $ref: `#/components/schemas/${op.body}` } } } } : undefined,
        responses: { "200": { description: "OK" }, "401": { description: "Token ausente/inválido" }, "403": { description: "Sem escopo ou sem acesso à pulseira" } },
        security: op.scope || path === "/v1/connect" ? [{ bearer: [] }] : [],
      };
    }
    paths[path] = out;
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "Mi Band 3 Cloud",
      version: "1.0.0",
      description:
        "Monitoramento remoto de pacientes com Mi Band 3. Autenticação: `Authorization: Bearer <mbk_… | chave mestra>`. " +
        "WebSockets de visualização aceitam `?access_token=`. Tempos são epoch em milissegundos (ou ISO 8601 nos filtros).",
    },
    servers: [{ url: origin }],
    tags: [...new Set(Object.values(routes).flatMap((m) => Object.values(m).map((o) => o.tag)))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        DeviceInput: { type: "object", required: ["name"], properties: { name: { type: "string" }, patient_ref: { type: "string" }, notes: { type: "string" }, metadata: { type: "object" } } },
        CommandRequest: {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string", enum: COMMAND_TYPES }, params: { type: "object" }, ttl_s: { type: "integer", default: 300 } },
          example: { type: "vibrate", params: { count: 3, durationMs: 800 }, ttl_s: 60 },
        },
        VibrateParams: { type: "object", properties: { count: { type: "integer" }, durationMs: { type: "integer" }, pauseMs: { type: "integer" }, level: { type: "string", enum: ["mild", "high"] }, ttl_s: { type: "integer" } } },
        AlertRule: {
          type: "object",
          required: ["name", "metric"],
          properties: {
            device_id: { type: "string", nullable: true }, name: { type: "string" },
            metric: { type: "string", enum: ["heart_rate", "battery", "offline", "event"] },
            op: { type: "string", enum: ["gt", "gte", "lt", "lte", "eq"] }, threshold: { type: "number" }, match: { type: "string" },
            duration_s: { type: "integer" }, cooldown_s: { type: "integer" },
            severity: { type: "string", enum: ["info", "warning", "critical"] },
            action: { type: "object", properties: { vibrate: { type: "object" }, message: { type: "object" } } },
            enabled: { type: "boolean" },
          },
          example: { name: "Taquicardia", metric: "heart_rate", op: "gt", threshold: 120, duration_s: 60, severity: "critical", action: { vibrate: { count: 3 } } },
        },
        Webhook: { type: "object", required: ["url"], properties: { url: { type: "string" }, events: { type: "array", items: { type: "string", enum: [...WEBHOOK_EVENTS, "*"] } }, device_id: { type: "string" }, enabled: { type: "boolean" } } },
        Term: { type: "object", required: ["version", "title", "content"], properties: { version: { type: "string" }, title: { type: "string" }, content: { type: "string" }, requires_reconsent: { type: "boolean" } } },
        ApiKey: { type: "object", required: ["name"], properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string", enum: ["read", "command", "manage", "admin"] } }, device_ids: { type: "array", items: { type: "string" } } } },
      },
    },
  };
}
