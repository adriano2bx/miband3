# Mi Band 3 Cloud

Serviço em Cloudflare Workers que recebe, em tempo real, os dados das pulseiras (via app Android), guarda o histórico e expõe uma API completa para integrar outros sistemas: dados ao vivo, histórico, alertas, webhooks e **comandos para a pulseira** (vibrar, mensagem, medir FC…).

```
 Mi Band 3 ──BLE──▶ App Android ══WebSocket══▶ Worker ──▶ Durable Object (1 por pulseira) ──▶ D1
                         ▲                                      │   ▲
                         └───────── comandos (vibrar…) ◀────────┘   └── WebSocket/REST dos seus sistemas
```

| Peça | Papel |
| --- | --- |
| **Worker** (`src/index.ts`, `src/api.ts`) | API REST + roteamento dos WebSockets. Autentica e repassa ao Durable Object. |
| **`DeviceHub`** (Durable Object, 1 por pulseira) | Mantém o socket do app e dos visores, grava no D1, avalia alertas, entrega comandos e detecta app offline. Usa hibernação de WebSocket (custo ~zero sem tráfego). |
| **`Fleet`** (Durable Object único) | Fluxo global `/v1/stream` com todas as pulseiras permitidas à chave. |
| **D1** | Pulseiras, chaves, séries temporais (FC, passos, bateria, eventos, atividade por minuto), comandos, regras, alertas, webhooks. |

## Publicar

```bash
cd cloud
npm install
npx wrangler login
npx wrangler d1 create miband3            # copie o database_id para wrangler.jsonc
npx wrangler d1 migrations apply miband3 --remote
npx wrangler secret put ADMIN_API_KEY     # chave mestra: use um valor longo e aleatório
npx wrangler deploy
```

Desenvolvimento local: `npm run db:migrate:local && ADMIN_API_KEY=dev npx wrangler dev`. Testes: `npm test` (roda no runtime real do Workers via Miniflare). Tipos: `npm run typecheck`.

## Primeiros passos

```bash
H="authorization: Bearer $ADMIN_API_KEY"; API=https://miband3-cloud.SEU-USUARIO.workers.dev

# 1. cadastre a pulseira/paciente → devolve o device_token (mostrado uma única vez)
curl -X POST $API/v1/devices -H "$H" -H 'content-type: application/json' \
     -d '{"name":"Maria Silva","patient_ref":"prontuario-123"}'

# 2. no app: aba "Nuvem" → endereço do serviço + device_token → ligar "Enviar dados à nuvem"

# 3. veja ao vivo e faça vibrar
curl $API/v1/devices/dev_xxx/status -H "$H"
curl -X POST $API/v1/devices/dev_xxx/vibrate -H "$H" -H 'content-type: application/json' -d '{"count":3}'
```

A especificação completa está em **`GET /v1/openapi.json`** (sem autenticação; importe no Swagger/Postman).

## Autenticação e permissões

`Authorization: Bearer <token>`. Nos WebSockets de navegador, `?access_token=<token>` (evite em servidores: URLs costumam ir para logs).

| Token | Quem usa | Observação |
| --- | --- | --- |
| `ADMIN_API_KEY` | você | todos os escopos |
| `mbk_…` (chave de API) | outros sistemas | escopos `read`, `command`, `manage`, `admin`; pode ser restrita a pulseiras específicas (`device_ids`) |
| `mbd_…` (token do dispositivo) | o app Android | só abre `/v1/connect`; revogável com `rotate-token` |

Tokens são guardados apenas como hash SHA-256.

## API REST (resumo)

| Área | Rotas |
| --- | --- |
| Pulseiras | `POST/GET /v1/devices`, `GET/PATCH/DELETE /v1/devices/{id}` (`?purge=true` apaga tudo), `POST …/rotate-token` |
| Tempo real | `GET /v1/overview`, `GET …/status`, WebSockets `…/stream` e `/v1/stream` |
| Histórico | `…/heart-rate` (`bucket=1m\|5m\|15m\|1h\|1d` dá média/mín/máx), `…/steps` (`bucket=1d&tz_offset_min=-180` = total por dia), `…/battery`, `…/events`, `…/activity`, `…/sleep`, `…/summary` |
| Comandos | `POST/GET …/commands`, `GET/DELETE …/commands/{cid}`, atalho `POST …/vibrate` |
| Alertas | `POST/GET/PATCH/DELETE /v1/alert-rules`, `GET /v1/alerts`, `POST /v1/alerts/{id}/ack` |
| Integração | `POST/GET/PATCH/DELETE /v1/webhooks`, `POST …/test`, `POST/GET/DELETE /v1/api-keys` |

Filtros de série: `from`, `to` (epoch em ms/s ou ISO 8601), `limit` (≤ 10 000), `order=asc\|desc`; a resposta traz `next` com o cursor da próxima página. Qualquer série aceita `?format=csv`.

### Comandos

`POST /v1/devices/{id}/commands` com `{"type": "...", "params": {...}, "ttl_s": 300}`:

| `type` | `params` |
| --- | --- |
| `vibrate` | `count` (1–10), `durationMs`, `pauseMs`, `level` (`mild`/`high`) |
| `message` | `kind` (`sms`/`app`/`call`/`email`), `title` (≤ 32), `body` (≤ 200) |
| `stop_call`, `measure_hr`, `sync_time`, `refresh` | — |
| `hr_continuous` | `enabled` |
| `fetch_history` | `sinceMs` (opcional) |
| `set_alarm` | `slot` (0–2), `enabled`, `hour`, `minute`, `days` (máscara; 0 = uma vez) |

Ciclo de vida: `queued → sent → acked` (ou `failed`, `timeout` após 30 s sem confirmação, `expired` se o app ficou offline além do `ttl_s`, `cancelled`). Comandos enviados com o app offline ficam na fila e são entregues ao reconectar.

### Alertas

```bash
curl -X POST $API/v1/alert-rules -H "$H" -H 'content-type: application/json' -d '{
  "device_id": "dev_xxx", "name": "Taquicardia", "metric": "heart_rate",
  "op": "gt", "threshold": 120, "duration_s": 60, "cooldown_s": 600,
  "severity": "critical", "action": {"vibrate": {"count": 3}}
}'
```

Métricas: `heart_rate` e `battery` (limite + duração mínima), `offline` (segundos sem o app conectado), `event` (`match` = tipo do evento, ex. `START_NONWEAR`, `BUTTON_PRESSED`). Sem `device_id` a regra vale para todas as pulseiras. Ao disparar: grava o alerta, avisa os WebSockets, chama os webhooks `alert.created` e executa a `action` (vibrar / mensagem na pulseira).

### Webhooks

Eventos: `alert.created`, `device.online`, `device.offline`, `command.updated`, `event.created` (ou `*`). Só `https://`. Cada entrega é um `POST` JSON com os cabeçalhos `X-MiBand-Event`, `X-MiBand-Timestamp` e `X-MiBand-Signature: sha256=<HMAC-SHA256(segredo, "<timestamp>.<corpo>")>`. O segredo (`whsec_…`) aparece só na criação. Não há reentrega: após 20 falhas seguidas o webhook é desativado (reative com `PATCH`).

## WebSockets

**Visor** — `wss://…/v1/devices/{id}/stream` (uma pulseira) ou `wss://…/v1/stream` (todas as permitidas). Ao conectar chega `snapshot` (ou `hello` no global). Mensagens recebidas: `hr`, `steps`, `battery`, `event`, `activity`, `state`, `presence`, `hello`, `alert`, `command` — todas com `device_id`. Você pode enviar:

```json
{"t":"subscribe","types":["hr","alert"],"devices":["dev_a","dev_b"]}
{"t":"command","req":"1","type":"vibrate","params":{"count":2},"device":"dev_a"}
{"t":"ping"}
```
(`devices`/`device` só no fluxo global.) Respostas: `subscribed`, `command_created` (com o seu `req`), `error`, `pong`.

**App** — `/v1/connect` (token `mbd_…`). Mensagens `app → nuvem` em `src/protocol.ts` (`hello`, `hr`, `steps`, `battery`, `event`, `activity`, `state`, `batch`, `ack`); `nuvem → app`: `welcome`, `command`. O texto literal `ping` é respondido com `pong` sem acordar o Durable Object.

## Limites e pontos de atenção

- **Sono é provisório.** O app baixa da pulseira o histórico por minuto (protocolo do Gadgetbridge), mas os códigos de categoria (`sleep.ts`) e o fluxo de download **ainda não foram validados numa Mi Band 3 real**. As amostras brutas ficam em `/activity` e o mapa se corrige com `SLEEP_KIND_MAP` (ex.: `{"light":[9],"deep":[11],"nonwear":[6]}`) sem reprocessar. `/sleep` devolve `kinds_seen` para ajudar na calibração.
- **Não é dispositivo médico.** Os dados vêm de um sensor óptico de pulso de consumo; a FC pode falhar com a pulseira solta e não substitui equipamento clínico. Não use os alertas como única proteção.
- **Entrega "pelo menos uma vez" sem persistência no celular.** Sem internet o app guarda até 20 000 itens em memória; se o processo morrer, o que não foi enviado se perde (o histórico por minuto é rebaixado da pulseira). Webhooks não têm reentrega.
- **Escala.** A FC contínua gera ~1 linha/s por paciente no D1. Para dezenas de pacientes é tranquilo; para milhares, agregue ou reduza a resolução antes de gravar (ponto óbvio de evolução em `DeviceHub.ingest`). O `Fleet` é um objeto único (~1 000 req/s de repasse).
- **Dados de saúde são sensíveis (LGPD).** Use HTTPS (padrão no Workers), chaves restritas por paciente, defina `RETENTION_DAYS` e obtenha o consentimento do paciente. O D1 não é criptografado por campo.
- Sem limitação de taxa (rate limit) por chave — configure regras na Cloudflare (WAF/Rate Limiting) à frente do Worker se expuser a API publicamente.
