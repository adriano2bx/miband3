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

O caminho recomendado é o workflow **Deploy BIOSENSE** (veja o README principal): ele aplica as migrações no D1 `biosense` (já criado), publica em `biosense.deltabots.com.br`, grava a chave mestra e gera o APK. Manualmente:

```bash
cd cloud && npm install && npx wrangler login
npx wrangler d1 migrations apply biosense --remote
npx wrangler deploy
npx wrangler secret put ADMIN_API_KEY     # chave mestra: longa e aleatória
```

## Painel de administração

`https://biosense.deltabots.com.br/admin/` (a raiz redireciona para ele). Entre com a chave mestra ou uma chave `mbk_` com escopo `manage`; ela fica só na aba do navegador. Permite autorizar e bloquear instalações, definir o perfil de coleta e o perfil físico da pulseira, ver o histórico de consentimentos, publicar o termo, gerenciar técnicos e reconhecer alertas.

Desenvolvimento local: `npm run db:migrate:local && ADMIN_API_KEY=dev npx wrangler dev`. Testes: `npm test` (41 testes no runtime real do Workers via Miniflare). Tipos: `npm run typecheck`.

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

A documentação interativa (Swagger) fica em **`/docs/`** (link no painel); a especificação OpenAPI está em `GET /v1/openapi.json` (importável no Postman). Um teste garante que toda rota da API está documentada.

## Participantes (BIOSENSE)

O app do participante usa contratos próprios (`src/participant-api.ts`):

```bash
# 1. Publique o termo real (versões não são editadas; uma nova versão pode exigir novo aceite)
curl -X POST $API/v1/consent/terms -H "$H" -H 'content-type: application/json' -d '{
  "version": "2026.1", "title": "Termo de participação", "content": "<texto completo fornecido pela equipe>",
  "requires_reconsent": true }'

# 2. Crie técnicos (senha ≥ 10 caracteres; "provision" permite autorizar instalações pelo app)
curl -X POST $API/v1/technicians -H "$H" -H 'content-type: application/json' \
     -d '{"credential":"ana.souza","name":"Ana Souza","password":"<senha forte>","scopes":["tech","provision"]}'

# 3. Ajuste o perfil de coleta de uma instalação (chega ao app em tempo real)
curl -X PUT $API/v1/devices/dev_xxx/config -H "$H" -H 'content-type: application/json' -d '{"hr_interval_min":30}'
```

| Etapa | O que acontece |
| --- | --- |
| Adesão | `POST /v1/installations` (público) grava o aceite do termo vigente e cria a instalação **pendente**, devolvendo o token do dispositivo. |
| Autorização | Técnico com `provision` (no app) ou `POST /v1/devices/{id}/authorize` vincula `participant_ref` e ativa a instalação. Antes disso a telemetria é recusada. |
| Consentimento | Recusa (`POST /v1/consent` com `accepted:false`) ou termo novo que exige reaceite interrompem a telemetria até novo aceite. Histórico em `GET /v1/devices/{id}/consents`. |
| Bloqueio | `POST /v1/devices/{id}/revoke` derruba o app (código 4003) e impede reconexão (403). |
| Login técnico | `POST /v1/tech/login` (credencial, senha, token da instalação) → sessão `mbt_…` de 10 min de inatividade (8 h no máximo). 5 erros bloqueiam a credencial por 15 min. |

Telemetria: o app envia lotes `{"t":"batch","seq":N,...}`; a nuvem responde `{"t":"stored","seq":N,"accepted":true}` só depois de gravar no D1 (ou `accepted:false` se a instalação não pode enviar). Eventos levam `id` para não duplicar em reenvios.

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

Métricas: `heart_rate` e `battery` (limite + duração mínima; com a FC medida a cada 30 min, use `duration_s: 0`), `offline` (segundos sem o app conectado), `event` (`match` = tipo do evento, ex. `START_NONWEAR`, `BUTTON_PRESSED`). Sem `device_id` a regra vale para todas as pulseiras. Ao disparar: grava o alerta, avisa os WebSockets, chama os webhooks `alert.created` e executa a `action` (vibrar / mensagem na pulseira).

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

## Módulo AiDEX (glicemia)

Integração **somente-leitura** com a **AiDEX API Open Platform** (OAuth 2.0) para trazer a glicemia do sensor CGM para junto dos dados da pulseira, por paciente (`device`). Tudo é server-to-server a partir do Worker; nada trafega pelo app Android. O paciente (dono do sensor) autoriza na tela oficial da AiDEX e pode revogar quando quiser no app AiDEX.

```
Sensor AiDEX ─▶ nuvem MicroTech ◀──OAuth 2.0── Worker (cron /15min) ──▶ D1 (glucose) ──▶ API /v1 + painel
```

**Configuração (uma vez):**

1. No **Console da AiDEX** (`aidexapi.microtechmd.com` → My App), crie o app e registre o `redirect_uri` **exatamente** como o callback do Worker:
   `https://biosense.deltabots.com.br/v1/aidex/callback` (ou a URL `workers.dev`).
2. Defina as credenciais:
   - `AIDEX_CLIENT_ID` em `vars` (wrangler.jsonc) — não é segredo.
   - `AIDEX_CLIENT_SECRET` como segredo: `npx wrangler secret put AIDEX_CLIENT_SECRET`.
   - `AIDEX_ENV`: `sandbox` (padrão) ou `production` (só após o *Upgrade App* aprovado).
3. Aplique a migração: `npm run db:migrate:remote` (tabelas `aidex_links`, `glucose`, `glucose_events`).

**Vincular um paciente:**

```bash
# 1. Gera a URL de autorização (o paciente abre e autoriza na AiDEX)
curl -X POST .../v1/devices/{id}/aidex/connect -H 'authorization: Bearer <chave>' -d '{}'
#    -> { "authorize_url": "https://.../v1/oauth2/authorize?clientId=...&state=..." }
# 2. O callback grava os tokens e já dispara a 1ª coleta. A partir daí o cron coleta sozinho.
```

**Consumir:** `GET /v1/devices/{id}/glucose` (bruto ou `?bucket=5m`), `GET /v1/devices/{id}/glucose/summary` (TIR, média, GMI, CV — janela padrão 14 dias), `GET /v1/devices/{id}/glucose/events`, `GET /v1/devices/{id}/aidex` (estado do vínculo). A glicemia da API vem em **mmol/L**; a janela máxima por consulta à AiDEX é de 30 dias (o coletor pagina sozinho) e o backfill inicial é limitado por `AIDEX_BACKFILL_DAYS` (padrão 90).

> **Segredos em repouso:** diferente do token da pulseira (guardado só como hash), os tokens OAuth ficam em claro na D1 porque precisam ser reapresentados à AiDEX. Restrinja o acesso à D1 e defina `RETENTION_DAYS`.

## Interface administrativa

O frontend de `/admin/` usa HTML, CSS e JavaScript reais, com dados e ações pela API existente. A identidade BIOSENSE/Deltabots inclui tema claro, lista de instalações com detalhe selecionável e o asset local `public/admin/assets/biosense-pulse.png`. Os contadores representam os registros carregados do filtro atual; quando há outra página, use **Carregar mais**. O horário junto de **Atualizar** indica a última consulta bem-sucedida. A janela de comandos atualiza o estado a cada 2,5 segundos.

Validação da interface (fixtures sintéticas restritas aos testes, sem acesso à nuvem):

```bash
npm ci
npx playwright install --with-deps chromium
npm run test:admin
```

Os testes verificam seleção por teclado, paginação, filtros, estados de erro, contratos de configuração/autorização/vibração, navegação e layout móvel. Capturas de navegador ficam em `test-results/`. `npm test` continua executando os testes da API; `npm run typecheck` verifica o serviço. A publicação segue o workflow de deploy existente, incluindo os arquivos estáticos de `public/`.
