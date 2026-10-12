import { COMMAND_TYPES } from "./protocol";
import { WEBHOOK_EVENTS } from "./webhooks";

/**
 * Especificação OpenAPI 3.0 da API BIOSENSE, servida em /v1/openapi.json e exibida
 * no Swagger UI em /docs/. Mantida à mão: ao criar ou mudar uma rota, atualize aqui.
 */

type Auth = "public" | "device" | "tech" | "panel" | "read" | "command" | "manage" | "admin";

interface Op {
  summary: string;
  description?: string;
  tag: string;
  auth: Auth;
  params?: string[];
  body?: string;
  /** Esquema da resposta de sucesso. Sufixo "[]" = lista paginada {data, count}. */
  res?: string;
  status?: 200 | 201 | 202;
  csv?: boolean;
  ws?: boolean;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const series = ["from", "to", "limit", "order"];

const routes: Record<string, Record<string, Op>> = {
  // ------------------------------------------------------------------ geral
  "/v1/health": { get: { summary: "Serviço no ar", tag: "Geral", auth: "public", res: "Health" } },
  "/v1/me": { get: { summary: "Escopos e pulseiras da chave usada", tag: "Geral", auth: "read", res: "Me" } },
  "/v1/openapi.json": { get: { summary: "Esta especificação", tag: "Geral", auth: "public" } },

  // ------------------------------------------------------------------ tempo real
  "/v1/overview": { get: { summary: "Último valor de todos os participantes", description: "Uma linha por instalação com última FC, bateria, passos e alertas pendentes.", tag: "Tempo real", auth: "read", res: "Overview[]" } },
  "/v1/devices/{id}/status": { get: { summary: "Estado ao vivo de uma instalação", tag: "Tempo real", auth: "read", res: "LiveStatus" } },
  "/v1/devices/{id}/stream": { get: { summary: "WebSocket de uma instalação", description: "Abra com `Upgrade: websocket` (ou `?access_token=` no navegador). Veja o protocolo na descrição geral.", tag: "Tempo real", auth: "read", ws: true } },
  "/v1/connect": { get: { summary: "WebSocket do app BIOSENSE", description: "Usado pelo app com o token `mbd_…`. Envia telemetria em lotes `{\"t\":\"batch\",\"seq\":N,\"items\":[…]}` (resposta `stored`) e recebe `welcome`, `status` e `command`.", tag: "Tempo real", auth: "device", ws: true } },
  "/v1/stream": { get: { summary: "WebSocket de todas as instalações permitidas", description: "Fluxo global; envie `{\"t\":\"subscribe\",\"devices\":[...],\"types\":[...]}` para filtrar.", tag: "Tempo real", auth: "read", ws: true } },

  // ------------------------------------------------------------------ instalações
  "/v1/devices": {
    get: { summary: "Listar instalações", tag: "Instalações", auth: "read", params: ["status", "online", "patient_ref", "q", "limit", "cursor", "archived"], res: "Device[]" },
    post: { summary: "Cadastrar instalação manualmente", description: "Normalmente as instalações nascem pelo app (`POST /v1/installations`). Esta rota cria uma já ativa e devolve o `device_token` uma única vez.", tag: "Instalações", auth: "manage", body: "DeviceInput", res: "DeviceWithToken", status: 201 },
  },
  "/v1/devices/{id}": {
    get: { summary: "Detalhes da instalação", tag: "Instalações", auth: "read", res: "Device" },
    patch: { summary: "Alterar nome, referência, notas e metadados", tag: "Instalações", auth: "manage", body: "DeviceInput", res: "Device" },
    delete: { summary: "Arquivar (ou apagar tudo com ?purge=true, exige admin)", tag: "Instalações", auth: "manage", params: ["purge"], res: "Deleted" },
  },
  "/v1/devices/{id}/authorize": { post: { summary: "Autorizar e vincular participante", description: "Instalação passa de `pending` para `active` e a telemetria começa a ser aceita.", tag: "Instalações", auth: "manage", body: "Authorize", res: "Installation" } },
  "/v1/devices/{id}/revoke": { post: { summary: "Bloquear instalação", description: "O app é desconectado (código 4003), passa a mostrar \"Conexão não autorizada\" e não consegue reconectar.", tag: "Instalações", auth: "manage", res: "Revoked" } },
  "/v1/devices/{id}/config": { put: { summary: "Perfil de coleta e perfil físico da pulseira", description: "Mescla com a configuração atual, incrementa a versão e envia ao app em tempo real.", tag: "Instalações", auth: "manage", body: "CollectionConfig", res: "ConfigResult" } },
  "/v1/devices/{id}/rotate-token": { post: { summary: "Gerar novo token do dispositivo", description: "Desconecta o app atual; o novo token precisa ser instalado no celular.", tag: "Instalações", auth: "manage", res: "TokenRotated" } },
  "/v1/devices/{id}/consents": { get: { summary: "Histórico de aceites e recusas", tag: "Instalações", auth: "read", res: "ConsentRecord[]" } },

  // ------------------------------------------------------------------ histórico
  "/v1/devices/{id}/heart-rate": { get: { summary: "Frequência cardíaca", description: "Leituras brutas, ou agregadas com `bucket` (média, mínimo e máximo por intervalo).", tag: "Histórico", auth: "read", params: [...series, "bucket", "format"], res: "HeartRate[]", csv: true } },
  "/v1/devices/{id}/steps": { get: { summary: "Passos, distância e calorias", description: "`bucket=1d&tz_offset_min=-180` devolve o total por dia no horário de Brasília.", tag: "Histórico", auth: "read", params: [...series, "bucket", "tz_offset_min", "format"], res: "Steps[]", csv: true } },
  "/v1/devices/{id}/battery": { get: { summary: "Bateria da pulseira", tag: "Histórico", auth: "read", params: [...series, "format"], res: "Battery[]", csv: true } },
  "/v1/devices/{id}/events": { get: { summary: "Eventos da pulseira", description: "Ex.: `BUTTON_PRESSED`, `START_NONWEAR`, `FELL_ASLEEP`, `WOKE_UP`, `STEPS_GOAL_REACHED`.", tag: "Histórico", auth: "read", params: [...series, "type", "format"], res: "Event[]", csv: true } },
  "/v1/devices/{id}/activity": { get: { summary: "Histórico por minuto baixado da pulseira", tag: "Histórico", auth: "read", params: [...series, "format"], res: "Activity[]", csv: true } },
  "/v1/devices/{id}/sleep": { get: { summary: "Sessões de sono (classificação provisória)", tag: "Histórico", auth: "read", params: ["from", "to"], res: "SleepResult" } },
  "/v1/devices/{id}/summary": { get: { summary: "Resumo do período", tag: "Histórico", auth: "read", params: ["from", "to"], res: "Summary" } },

  // ------------------------------------------------------------------ comandos
  "/v1/devices/{id}/commands": {
    get: { summary: "Comandos enviados", tag: "Comandos", auth: "read", params: [...series, "status"], res: "Command[]" },
    post: { summary: "Enviar comando à pulseira", description: `Tipos: ${COMMAND_TYPES.map((t) => `\`${t}\``).join(", ")}. Com o celular offline o comando fica na fila até \`ttl_s\`.`, tag: "Comandos", auth: "command", body: "CommandRequest", res: "Command", status: 202 },
  },
  "/v1/devices/{id}/vibrate": { post: { summary: "Atalho: vibrar", tag: "Comandos", auth: "command", body: "VibrateParams", res: "Command", status: 202 } },
  "/v1/devices/{id}/commands/{cid}": {
    get: { summary: "Situação de um comando", tag: "Comandos", auth: "read", res: "Command" },
    delete: { summary: "Cancelar comando ainda na fila", tag: "Comandos", auth: "command", res: "Cancelled" },
  },

  // ------------------------------------------------------------------ alertas
  "/v1/alert-rules": {
    get: { summary: "Regras de alerta", tag: "Alertas", auth: "read", params: ["device_id"], res: "AlertRule[]" },
    post: { summary: "Criar regra", tag: "Alertas", auth: "manage", body: "AlertRuleInput", res: "AlertRule", status: 201 },
  },
  "/v1/alert-rules/{rid}": {
    patch: { summary: "Alterar regra", tag: "Alertas", auth: "manage", body: "AlertRuleInput", res: "AlertRule" },
    delete: { summary: "Remover regra", tag: "Alertas", auth: "manage", res: "Deleted" },
  },
  "/v1/alerts": { get: { summary: "Alertas disparados", tag: "Alertas", auth: "read", params: [...series, "device_id", "severity", "acked", "format"], res: "Alert[]", csv: true } },
  "/v1/alerts/{aid}/ack": { post: { summary: "Reconhecer alerta", tag: "Alertas", auth: "command", res: "Alert" } },

  // ------------------------------------------------------------------ integrações
  "/v1/webhooks": {
    get: { summary: "Webhooks", tag: "Integrações", auth: "manage", res: "Webhook[]" },
    post: { summary: "Criar webhook (o segredo HMAC aparece só aqui)", tag: "Integrações", auth: "manage", body: "WebhookInput", res: "WebhookWithSecret", status: 201 },
  },
  "/v1/webhooks/{wid}": {
    patch: { summary: "Alterar webhook (reativar zera falhas)", tag: "Integrações", auth: "manage", body: "WebhookInput", res: "Webhook" },
    delete: { summary: "Remover webhook", tag: "Integrações", auth: "manage", res: "Deleted" },
  },
  "/v1/webhooks/{wid}/test": { post: { summary: "Enviar evento de teste", tag: "Integrações", auth: "manage", res: "WebhookTest" } },
  "/v1/api-keys": {
    get: { summary: "Chaves de API", tag: "Integrações", auth: "admin", res: "ApiKey[]" },
    post: { summary: "Criar chave (o valor aparece só aqui)", tag: "Integrações", auth: "admin", body: "ApiKeyInput", res: "ApiKeyWithSecret", status: 201 },
  },
  "/v1/api-keys/{kid}": { delete: { summary: "Revogar chave", tag: "Integrações", auth: "admin", res: "Revoked" } },

  // ------------------------------------------------------------------ participantes
  "/v1/consent/terms/current": { get: { summary: "Termo vigente", tag: "Participantes", auth: "public", res: "Term" } },
  "/v1/consent/terms": {
    get: { summary: "Versões publicadas", tag: "Participantes", auth: "read", res: "TermSummary[]" },
    post: { summary: "Publicar nova versão do termo", description: "Versões não são editadas. `requires_reconsent=true` exige novo aceite de quem aceitou versões anteriores.", tag: "Participantes", auth: "admin", body: "TermInput", res: "Term", status: 201 },
  },
  "/v1/installations": { post: { summary: "Adesão pelo app", description: "Registra o aceite do termo vigente e cria a instalação `pending`. Devolve o `device_token` uma única vez.", tag: "Participantes", auth: "public", body: "Enroll", res: "InstallationWithToken", status: 201 } },
  "/v1/consent": { post: { summary: "Aceite ou recusa pela própria instalação", tag: "Participantes", auth: "device", body: "ConsentDecision", res: "Installation" } },
  "/v1/installation": { get: { summary: "Estado da instalação vista pelo app", tag: "Participantes", auth: "device", res: "Installation" } },

  // ------------------------------------------------------------------ acesso técnico
  "/v1/technicians": {
    get: { summary: "Técnicos", tag: "Acesso técnico", auth: "admin", res: "Technician[]" },
    post: { summary: "Criar técnico", tag: "Acesso técnico", auth: "admin", body: "TechnicianInput", res: "Technician", status: 201 },
  },
  "/v1/technicians/{tid}": {
    patch: { summary: "Alterar nome, senha (encerra sessões), escopos ou desbloquear", tag: "Acesso técnico", auth: "admin", body: "TechnicianPatch", res: "Updated" },
    delete: { summary: "Desativar técnico e encerrar sessões", tag: "Acesso técnico", auth: "admin", res: "Disabled" },
  },
  "/v1/tech/login": { post: { summary: "Login técnico (usado pelo app)", description: "Sessão `mbt_…` presa à instalação do celular: 10 min sem uso, 8 h no máximo. 5 senhas erradas bloqueiam a credencial por 15 min (HTTP 429).", tag: "Acesso técnico", auth: "public", body: "TechLogin", res: "TechSession", status: 201 } },
  "/v1/panel/login": { post: { summary: "Login individual de técnico no painel (somente leitura)", description: "Exige o escopo `panel_read` concedido pela gestão. Sessão `mbp_…`: 10 min sem uso, 8 h no máximo.", tag: "Acesso técnico", auth: "public", body: "PanelLogin", res: "PanelSession", status: 201 } },
  "/v1/panel/logout": { post: { summary: "Encerrar sessão de painel do técnico", tag: "Acesso técnico", auth: "panel", res: "LoggedOut" } },
  "/v1/tech/logout": { post: { summary: "Encerrar sessão técnica", tag: "Acesso técnico", auth: "tech", res: "LoggedOut" } },
  "/v1/tech/installation": { get: { summary: "Instalação da sessão técnica", tag: "Acesso técnico", auth: "tech", res: "TechInstallation" } },
  "/v1/tech/installation/authorize": { post: { summary: "Autorizar a instalação da sessão (escopo provision)", tag: "Acesso técnico", auth: "tech", body: "Authorize", res: "TechInstallation" } },
  "/v1/tech/ping": { get: { summary: "Teste de comunicação autenticada", tag: "Acesso técnico", auth: "tech", res: "TechPing" } },
};

const PARAMS: Record<string, { description: string; schema: Record<string, unknown> }> = {
  from: { description: "Início (epoch em ms ou s, ou ISO 8601).", schema: { type: "string", example: "2026-10-12T00:00:00-03:00" } },
  to: { description: "Fim (epoch em ms ou s, ou ISO 8601). Padrão: agora.", schema: { type: "string" } },
  limit: { description: "Máximo de itens (até 10 000 nas séries, 500 em listas).", schema: { type: "integer", example: 1000 } },
  order: { description: "Ordem por horário.", schema: { type: "string", enum: ["asc", "desc"] } },
  bucket: { description: "Agregação por intervalo.", schema: { type: "string", enum: ["1m", "5m", "15m", "1h", "1d"] } },
  tz_offset_min: { description: "Fuso em minutos para agrupar por dia (Brasília = -180).", schema: { type: "integer", example: -180 } },
  format: { description: "`csv` devolve texto CSV em vez de JSON.", schema: { type: "string", enum: ["json", "csv"] } },
  type: { description: "Tipo do evento.", schema: { type: "string", example: "BUTTON_PRESSED" } },
  status: { description: "Filtra pela situação.", schema: { type: "string" } },
  online: { description: "Somente conectadas (true) ou desconectadas (false).", schema: { type: "boolean" } },
  patient_ref: { description: "Referência exata do participante.", schema: { type: "string" } },
  q: { description: "Busca no nome ou na referência.", schema: { type: "string" } },
  cursor: { description: "Valor `next` da página anterior.", schema: { type: "string" } },
  archived: { description: "Incluir arquivadas.", schema: { type: "boolean" } },
  purge: { description: "Apagar a instalação e todos os dados (exige admin).", schema: { type: "boolean" } },
  device_id: { description: "Filtra por instalação.", schema: { type: "string" } },
  severity: { description: "Gravidade.", schema: { type: "string", enum: ["info", "warning", "critical"] } },
  acked: { description: "Somente reconhecidos (true) ou pendentes (false).", schema: { type: "boolean" } },
};

const AUTH_TEXT: Record<Auth, string> = {
  public: "Sem autenticação.",
  device: "Token do dispositivo (`mbd_…`), usado pelo app.",
  tech: "Sessão técnica (`mbt_…`) obtida em `POST /v1/tech/login`.",
  panel: "Sessão web individual (`mbp_…`) de técnico com escopo somente leitura.",
  read: "Chave com escopo `read` (ou a chave mestra).",
  command: "Chave com escopo `command` (ou a chave mestra).",
  manage: "Chave com escopo `manage` (ou a chave mestra).",
  admin: "Chave mestra ou chave com escopo `admin`.",
};

// ------------------------------------------------------------------ esquemas

const T = {
  str: { type: "string" },
  int: { type: "integer" },
  num: { type: "number" },
  bool: { type: "boolean" },
  ts: { type: "integer", format: "int64", description: "Epoch em milissegundos", example: 1791820000000 },
  tsNull: { type: "integer", format: "int64", nullable: true, description: "Epoch em milissegundos" },
  strNull: { type: "string", nullable: true },
  obj: { type: "object", additionalProperties: true },
};
const obj = (properties: Record<string, unknown>, required?: string[], extra: Record<string, unknown> = {}) => ({ type: "object", properties, ...(required ? { required } : {}), ...extra });

const bandProfile = obj(
  {
    birth_year: { type: "integer", minimum: 1900, maximum: 2030, example: 1985 },
    gender: { type: "string", enum: ["male", "female", "other"] },
    height_cm: { type: "integer", minimum: 50, maximum: 250, example: 165 },
    weight_kg: { type: "integer", minimum: 20, maximum: 300, example: 60 },
    wrist: { type: "string", enum: ["left", "right"], default: "left" },
    step_goal: { type: "integer", minimum: 1000, maximum: 50000, default: 8000 },
  },
  ["birth_year", "gender", "height_cm", "weight_kg"],
  { nullable: true, description: "Perfil físico usado pela pulseira (null = padrão do app)." },
);

const collectionConfig = obj({
  hr_interval_min: { type: "integer", enum: [0, 5, 10, 15, 30, 60, 120], description: "Minutos entre medições de FC (0 = contínua).", example: 30 },
  history_interval_min: { type: "integer", minimum: 15, maximum: 240, description: "Minutos entre downloads do histórico da pulseira.", example: 30 },
  band_profile: bandProfile,
});

const consent = obj({ accepted_version: T.strNull, current_version: T.strNull, valid: T.bool, accepted_at: T.tsNull });

const installation = obj({
  device_id: { type: "string", example: "dev_31a796de273d4ce2ba06" },
  status: { type: "string", enum: ["pending", "active", "revoked"] },
  authorized: T.bool,
  participant_ref: { type: "string", nullable: true, example: "P-0001" },
  online: T.bool,
  last_seen_at: T.tsNull,
  consent,
  config: collectionConfig,
  config_version: T.int,
  config_updated_at: T.tsNull,
  band: { type: "object", nullable: true, additionalProperties: true },
});

const device = obj({
  id: { type: "string", example: "dev_31a796de273d4ce2ba06" },
  name: T.str,
  patient_ref: { type: "string", nullable: true, example: "P-0001" },
  notes: T.strNull,
  metadata: T.obj,
  created_at: T.ts,
  updated_at: T.ts,
  last_seen_at: T.tsNull,
  online: T.bool,
  band: { type: "object", nullable: true, description: "Nome, endereço, firmware, hardware e série da pulseira.", additionalProperties: true },
  client: { type: "object", nullable: true, description: "Versão do app e modelo do celular.", additionalProperties: true },
  archived_at: T.tsNull,
  status: { type: "string", enum: ["pending", "active", "revoked"] },
  consent_version: T.strNull,
  consent_at: T.tsNull,
  config: collectionConfig,
  config_version: T.int,
  config_updated_at: T.tsNull,
});

const command = obj({
  id: { type: "string", example: "cmd_8e03c16a51c045c3a0d7" },
  device_id: T.str,
  type: { type: "string", enum: COMMAND_TYPES },
  params: T.obj,
  status: { type: "string", enum: ["queued", "sent", "acked", "failed", "timeout", "expired", "cancelled"], description: "queued = celular offline; sent = entregue ao app; acked = executado pelo app na pulseira." },
  created_at: T.ts,
  expires_at: T.ts,
  sent_at: T.tsNull,
  acked_at: T.tsNull,
  result: { nullable: true },
  error: T.strNull,
  created_by: T.strNull,
});

const alertRuleInput = obj(
  {
    device_id: { type: "string", nullable: true, description: "null = todas as instalações." },
    name: { type: "string", example: "Taquicardia" },
    metric: { type: "string", enum: ["heart_rate", "battery", "offline", "event"] },
    op: { type: "string", enum: ["gt", "gte", "lt", "lte", "eq"], default: "gt" },
    threshold: { type: "number", nullable: true, description: "Obrigatório exceto para metric=event. Para offline, em segundos." },
    match: { type: "string", nullable: true, description: "Tipo do evento quando metric=event (ex.: START_NONWEAR)." },
    duration_s: { type: "integer", default: 0, description: "A condição precisa durar este tempo." },
    cooldown_s: { type: "integer", default: 300 },
    severity: { type: "string", enum: ["info", "warning", "critical"], default: "warning" },
    action: obj({ vibrate: { oneOf: [{ type: "boolean" }, { $ref: "#/components/schemas/VibrateParams" }] }, message: obj({ kind: T.str, title: T.str, body: T.str }) }),
    enabled: { type: "boolean", default: true },
  },
  ["name", "metric"],
  { example: { name: "Taquicardia", metric: "heart_rate", op: "gt", threshold: 120, duration_s: 0, severity: "critical", action: { vibrate: { count: 3 } } } },
);

const schemas: Record<string, unknown> = {
  Error: obj({ error: { type: "string", example: "forbidden" }, message: T.str, details: T.obj }),
  Health: obj({ ok: T.bool, time: T.ts }),
  Me: obj({ id: { type: "string", example: "admin" }, scopes: { type: "array", items: T.str }, device_ids: { type: "array", nullable: true, items: T.str } }),
  Overview: obj({ id: T.str, name: T.str, patient_ref: T.strNull, online: T.bool, last_seen_at: T.tsNull, hr: { type: "integer", nullable: true }, hr_ts: T.tsNull, battery: { type: "integer", nullable: true }, steps: { type: "integer", nullable: true }, unacked_alerts: T.int }),
  LiveStatus: obj({
    device_id: T.str, online: T.bool, last_seen_at: T.tsNull, band: T.obj, client: T.obj, server_time: T.ts,
    latest: obj({ hr: obj({ ts: T.ts, bpm: T.int }), steps: obj({ ts: T.ts, steps: T.int, meters: T.int, calories: T.int }), battery: obj({ ts: T.ts, level: T.int, charging: T.bool }), state: obj({ ts: T.ts, connection: { type: "string", example: "READY" } }), lastEvent: obj({ ts: T.ts, type: T.str }) }),
    pending_commands: T.int, unacked_alerts: T.int,
  }),
  Device: device,
  DeviceWithToken: { allOf: [ref("Device"), obj({ device_token: { type: "string", description: "Mostrado uma única vez.", example: "mbd_…" } })] },
  DeviceInput: obj({ name: { type: "string", example: "Paciente 1" }, patient_ref: { type: "string", nullable: true, example: "P-0001" }, notes: T.strNull, metadata: T.obj }, ["name"]),
  Installation: installation,
  InstallationWithToken: { allOf: [ref("Installation"), obj({ device_token: { type: "string", example: "mbd_…" } })] },
  Authorize: obj({ participant_ref: { type: "string", maxLength: 120, example: "P-0001", description: "Código do participante (não use nome ou CPF)." }, name: { type: "string" } }, undefined),
  CollectionConfig: collectionConfig,
  BandProfile: bandProfile,
  ConfigResult: obj({ config: collectionConfig, config_version: T.int, config_updated_at: T.ts }),
  TokenRotated: obj({ device_id: T.str, device_token: T.str }),
  ConsentRecord: obj({ id: T.str, version: T.str, accepted: T.bool, created_at: T.ts }),
  HeartRate: obj({ ts: T.ts, bpm: { type: "integer", example: 72 }, avg: { type: "number", description: "Só com bucket" }, min: T.int, max: T.int, samples: T.int }),
  Steps: obj({ ts: T.ts, steps: T.int, meters: { type: "integer", nullable: true }, calories: { type: "integer", nullable: true } }),
  Battery: obj({ ts: T.ts, level: T.int, charging: T.bool }),
  Event: obj({ ts: T.ts, type: { type: "string", example: "BUTTON_PRESSED" }, data: { type: "object", nullable: true, additionalProperties: true } }),
  Activity: obj({ ts: T.ts, kind: { type: "integer", description: "Categoria bruta da pulseira" }, intensity: T.int, steps: T.int, hr: { type: "integer", nullable: true } }),
  SleepSession: obj({ start: T.ts, end: T.ts, duration_min: T.int, deep_min: T.int, light_min: T.int, awake_min: T.int, avg_hr: { type: "integer", nullable: true }, min_hr: { type: "integer", nullable: true } }),
  SleepResult: obj({ data: { type: "array", items: ref("SleepSession") }, count: T.int, kind_map: T.obj, kinds_seen: { type: "array", items: T.int }, warning: T.str }),
  Summary: obj({ from: T.ts, to: T.ts, heart_rate: obj({ avg: T.num, min: T.int, max: T.int, samples: T.int }), steps: T.obj, battery: T.obj, events: { type: "array", items: T.obj }, alerts: { type: "array", items: T.obj }, sleep: obj({ sessions: T.int, total_min: T.int, provisional: T.bool }) }),
  CommandRequest: obj(
    {
      type: { type: "string", enum: COMMAND_TYPES },
      params: { type: "object", additionalProperties: true, description: "vibrate: {count 1–10, durationMs, pauseMs, level mild|high} · message: {kind sms|app|call|email, title ≤32, body ≤200} · hr_continuous: {enabled} · fetch_history: {sinceMs?} · set_alarm: {slot 0–2, enabled, hour, minute, days} · demais: {}" },
      ttl_s: { type: "integer", minimum: 5, maximum: 86400, default: 300, description: "Validade enquanto o celular estiver offline." },
    },
    ["type"],
    { example: { type: "message", params: { kind: "app", title: "BIOSENSE", body: "Lembrete do estudo" }, ttl_s: 300 } },
  ),
  VibrateParams: obj({ count: { type: "integer", minimum: 1, maximum: 10, default: 1, example: 3 }, durationMs: { type: "integer", default: 800 }, pauseMs: { type: "integer", default: 500 }, level: { type: "string", enum: ["mild", "high"], default: "high" }, ttl_s: { type: "integer", default: 60 } }),
  Command: command,
  Cancelled: obj({ cancelled: T.str }),
  AlertRuleInput: alertRuleInput,
  AlertRule: { allOf: [alertRuleInput, obj({ id: T.str, created_at: T.ts })] },
  Alert: obj({ id: T.str, device_id: T.str, rule_id: T.strNull, ts: T.ts, metric: T.str, value: { type: "number", nullable: true }, severity: T.str, message: T.str, acked_at: T.tsNull, acked_by: T.strNull }),
  WebhookInput: obj({ url: { type: "string", format: "uri", example: "https://sistema.exemplo.com/biosense" }, events: { type: "array", items: { type: "string", enum: [...WEBHOOK_EVENTS, "*"] }, default: ["*"] }, device_id: T.strNull, enabled: T.bool }, ["url"]),
  Webhook: obj({ id: T.str, url: T.str, events: { type: "array", items: T.str }, device_id: T.strNull, enabled: T.bool, created_at: T.ts, last_attempt_at: T.tsNull, last_status: { type: "integer", nullable: true }, failures: T.int }),
  WebhookWithSecret: { allOf: [ref("Webhook"), obj({ secret: { type: "string", example: "whsec_…" } })] },
  WebhookTest: obj({ delivered: T.bool, status: T.int }),
  ApiKeyInput: obj({ name: { type: "string", example: "Sistema hospitalar" }, scopes: { type: "array", items: { type: "string", enum: ["read", "command", "manage", "admin"] }, default: ["read"] }, device_ids: { type: "array", nullable: true, items: T.str, description: "Restringe a chave a estas instalações." } }, ["name"]),
  ApiKey: obj({ id: T.str, name: T.str, scopes: { type: "array", items: T.str }, device_ids: { type: "array", nullable: true, items: T.str }, created_at: T.ts, last_used_at: T.tsNull, revoked_at: T.tsNull }),
  ApiKeyWithSecret: obj({ id: T.str, name: T.str, scopes: { type: "array", items: T.str }, device_ids: { type: "array", nullable: true, items: T.str }, api_key: { type: "string", example: "mbk_…", description: "Mostrada uma única vez." } }),
  Term: obj({ version: { type: "string", example: "2026.1" }, title: T.str, content: T.str, requires_reconsent: T.bool, published_at: T.ts }),
  TermSummary: obj({ version: T.str, title: T.str, requires_reconsent: T.bool, published_at: T.ts }),
  TermInput: obj({ version: { type: "string", example: "2026.1" }, title: T.str, content: { type: "string", minLength: 20 }, requires_reconsent: { type: "boolean", default: true } }, ["version", "title", "content"]),
  Enroll: obj({ consent_version: { type: "string", example: "2026.1" }, accepted: { type: "boolean", enum: [true] }, client: obj({ app: T.str, version: T.str, os: T.str, model: T.str }) }, ["consent_version", "accepted"]),
  ConsentDecision: obj({ version: T.str, accepted: T.bool, client: T.obj }, ["version", "accepted"]),
  TechnicianInput: obj({ credential: { type: "string", example: "ana.souza" }, name: T.str, password: { type: "string", minLength: 10 }, scopes: { type: "array", items: { type: "string", enum: ["tech", "provision", "panel_read"] }, default: ["tech"] } }, ["credential", "name", "password"]),
  TechnicianPatch: obj({ name: T.str, password: { type: "string", minLength: 10 }, scopes: { type: "array", items: { type: "string", enum: ["tech", "provision", "panel_read"] } }, unlock: T.bool }),
  Technician: obj({ id: T.str, credential: T.str, name: T.str, scopes: { type: "array", items: T.str }, created_at: T.ts, disabled_at: T.tsNull, locked_until: T.tsNull }),
  TechLogin: obj({ credential: T.str, password: T.str, device_token: { type: "string", description: "Token da instalação do celular." } }, ["credential", "password"]),
  TechSession: obj({ session_token: { type: "string", example: "mbt_…" }, expires_at: T.ts, idle_timeout_s: T.int, technician: obj({ name: T.str }), scopes: { type: "array", items: T.str } }),
  PanelLogin: obj({ credential: T.str, password: T.str }, ["credential", "password"]),
  PanelSession: obj({ session_token: { type: "string", example: "mbp_…" }, expires_at: T.ts, idle_timeout_s: T.int, technician: obj({ name: T.str }), scopes: { type: "array", items: T.str } }),
  TechInstallation: { allOf: [ref("Installation"), obj({ name: T.str, technician: T.str, scopes: { type: "array", items: T.str }, session_expires_at: T.ts })] },
  TechPing: obj({ ok: T.bool, server_time: T.ts, device_online: T.bool }),
  Deleted: obj({ deleted: T.str }),
  Revoked: obj({ revoked: T.str }),
  Disabled: obj({ disabled: T.str }),
  Updated: obj({ updated: T.str }),
  LoggedOut: obj({ logged_out: T.bool }),
};

// ------------------------------------------------------------------ descrição geral (Markdown)

const DESCRIPTION = `
API do serviço **BIOSENSE** (Deltabots): instalações dos participantes, dados das pulseiras em tempo real e histórico, comandos para a pulseira, alertas, webhooks e acesso técnico.

## Autenticação
Envie \`Authorization: Bearer <token>\`. Clique em **Authorize** e cole a chave para testar aqui.

| Token | Quem usa | Escopos |
|---|---|---|
| Chave mestra (\`ADMIN_API_KEY\`) | administração | todos |
| \`mbk_…\` (chave de API) | outros sistemas | \`read\`, \`command\`, \`manage\`, \`admin\`; pode ser restrita a instalações |
| \`mbd_…\` (token do dispositivo) | app BIOSENSE | \`/v1/connect\`, \`/v1/consent\`, \`/v1/installation\` |
| \`mbt_…\` (sessão técnica) | área técnica do app | rotas \`/v1/tech/*\` |
| \`mbp_…\` (sessão do painel) | técnico autorizado pela gestão | leitura dos registros; 10 min sem uso, 8 h no máximo |

Horários são epoch em **milissegundos** (filtros \`from\`/\`to\` também aceitam ISO 8601). Séries aceitam \`?format=csv\` e paginam com o objeto \`next\` (use como novo \`from\`/\`to\`).

## Tempo real (WebSocket)
\`wss://…/v1/devices/{id}/stream\` (uma instalação) ou \`wss://…/v1/stream\` (todas as permitidas). No navegador use \`?access_token=<chave>\`.

Mensagens recebidas (JSON, todas com \`device_id\`): \`snapshot\`, \`hr\`, \`steps\`, \`battery\`, \`event\`, \`activity\`, \`state\`, \`presence\`, \`hello\`, \`alert\`, \`command\`.

Mensagens que você pode enviar:
\`\`\`json
{"t":"subscribe","types":["hr","alert"],"devices":["dev_a"]}
{"t":"command","req":"1","type":"vibrate","params":{"count":2},"device":"dev_a"}
{"t":"ping"}
\`\`\`
(\`devices\` e \`device\` só no fluxo global.) Respostas: \`subscribed\`, \`command_created\` (com o seu \`req\`), \`error\`, \`pong\`.

## Comandos
Ciclo: \`queued\` (celular offline) → \`sent\` (entregue ao app) → \`acked\` (executado na pulseira) ou \`failed\`; \`timeout\` sem confirmação em 30 s; \`expired\` após \`ttl_s\` offline; \`cancelled\`.
"Executado" indica que o app escreveu o comando na pulseira — o efeito físico (vibração) só pode ser confirmado por quem está com ela.

## Webhooks
\`POST\` JSON para a sua URL HTTPS com \`X-MiBand-Event\`, \`X-MiBand-Timestamp\` e \`X-MiBand-Signature: sha256=HMAC_SHA256(segredo, "<timestamp>.<corpo>")\`. Eventos: ${WEBHOOK_EVENTS.map((e) => `\`${e}\``).join(", ")}.

## Participantes
A instalação nasce \`pending\` quando o participante aceita o termo no app; a telemetria só é aceita depois de **autorizada** e com consentimento válido. Identifique participantes por código (\`participant_ref\`), nunca por nome ou CPF.
`.trim();

const TAGS: Array<{ name: string; description: string }> = [
  { name: "Geral", description: "Saúde do serviço e informações da chave." },
  { name: "Tempo real", description: "Estado ao vivo e WebSockets." },
  { name: "Instalações", description: "Celulares/pulseiras dos participantes: autorização, bloqueio e perfil de coleta." },
  { name: "Histórico", description: "Séries gravadas: FC, passos, bateria, eventos, atividade por minuto e sono." },
  { name: "Comandos", description: "Ações na pulseira: vibrar, mensagem, medir FC, histórico, hora, alarmes." },
  { name: "Alertas", description: "Regras e alertas disparados." },
  { name: "Integrações", description: "Webhooks e chaves de API para outros sistemas." },
  { name: "Participantes", description: "Termo de participação e adesão pelo app." },
  { name: "Acesso técnico", description: "Técnicos e sessões da área técnica do app." },
];

// ------------------------------------------------------------------ montagem

function responseFor(op: Op) {
  const ok = String(op.status ?? 200);
  if (op.ws) return { "101": { description: "Conexão WebSocket aberta" } };
  let content: Record<string, unknown> | undefined;
  if (op.res?.endsWith("[]")) {
    const item = ref(op.res.slice(0, -2));
    content = { "application/json": { schema: obj({ data: { type: "array", items: item }, count: T.int, next: { type: "object", nullable: true, description: "Cursor da próxima página" } }) } };
    if (op.csv) content["text/csv"] = { schema: { type: "string" } };
  } else if (op.res) {
    content = { "application/json": { schema: ref(op.res) } };
  }
  const err = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });
  return {
    [ok]: { description: "Sucesso", ...(content ? { content } : {}) },
    ...(op.body ? { "400": err("Dados inválidos") } : {}),
    ...(op.auth !== "public" ? { "401": err("Token ausente, inválido ou sessão expirada"), "403": err("Sem escopo ou sem acesso à instalação") } : {}),
  };
}

export function openapi(origin: string) {
  const paths: Record<string, unknown> = {};
  for (const [path, methods] of Object.entries(routes)) {
    const out: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      const parameters = [
        ...[...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" }, description: m[1] === "id" ? "ID da instalação (dev_…)" : undefined })),
        ...(op.params ?? []).map((name) => ({ name, in: "query", required: false, ...(PARAMS[name] ?? { schema: { type: "string" } }) })),
      ];
      out[method] = {
        tags: [op.tag],
        summary: op.summary,
        description: [op.description, `**Autenticação:** ${AUTH_TEXT[op.auth]}`].filter(Boolean).join("\n\n"),
        operationId: `${method}${path.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))}`,
        parameters,
        ...(op.body ? { requestBody: { required: method !== "patch", content: { "application/json": { schema: ref(op.body) } } } } : {}),
        responses: responseFor(op),
        security: op.auth === "public" ? [] : [{ bearer: [] }],
      };
    }
    paths[path] = out;
  }
  return {
    openapi: "3.0.3",
    info: { title: "BIOSENSE API", version: "1.0.0", description: DESCRIPTION, contact: { name: "Deltabots · BIOSENSE" } },
    // Relativo: as chamadas do "Try it out" vão sempre para o mesmo domínio da documentação.
    servers: [{ url: "/", description: "Este serviço" }, { url: origin, description: "Endereço absoluto" }],
    tags: TAGS,
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "Chave mestra, chave mbk_, token mbd_ ou sessão mbt_, conforme a rota." } },
      schemas,
    },
  };
}
