# BIOSENSE — app Android e serviço na nuvem

**BIOSENSE** é um produto da Deltabots (Divisão de Pesquisas Avançadas em IA e Bioconexões). O app Android conecta a pulseira disponibilizada pela equipe (uma Xiaomi Mi Band 3, exibida como *Biosense Pulse*), coleta os sinais e envia à nuvem em tempo real. O participante vê **apenas a instalação guiada e o status** — nenhum dado de saúde, gráfico ou controle. A equipe técnica tem uma área protegida para configuração e testes.

| Pasta | Conteúdo |
| --- | --- |
| `app/` | App Android (Kotlin + Jetpack Compose + Material 3). |
| `cloud/` | Serviço Cloudflare Workers + Durable Objects + D1 ([documentação](cloud/README.md)). |

## Fluxo do app

1. **Abertura** nativa (símbolo + assinatura). A rota sai do estado salvo: primeiro uso → consentimento; consentimento válido sem vínculo → tutorial; instalação concluída → principal.
2. **Participação voluntária**: resumo do programa, termo completo **versionado vindo da nuvem**, checkbox desmarcado. "Concordar e continuar" só conclui quando o servidor grava o aceite (`POST /v1/installations`); sem rede ou com termo desatualizado, nada é dado como aceito. "Não participar" não cria instalação nem coleta nada.
3. **Tutorial (3 etapas)**: permissões nativas do Android (com recuperação após negativa e atalho para as configurações após negativa permanente), busca BLE real só de pulseiras compatíveis, autenticação real com a pulseira (o pedido de toque aparece só quando o handshake pede) e confirmação de conexão com o serviço. "Concluir instalação" exige pulseira autenticada e serviço conectado.
4. **Principal**: "Status do dispositivo" derivado de permissão, Bluetooth, pulseira, nuvem, autorização e confirmação de presença recente (7 estados do guia) + cartão de participação.
5. **Acesso técnico**: 5 toques em até 2,5 s (no máximo 600 ms entre toques) revelam o login. A credencial é validada **só na nuvem**; sessão presa à instalação, expira com 10 min de inatividade e nunca é restaurada após o app ser encerrado.
6. **Configuração e testes**: dados da instalação, autorização/vínculo do participante (escopo `provision`), perfil de coleta definido na nuvem, e testes reais de Bluetooth (leitura BLE), vibração (escrita BLE confirmada; a vibração física precisa ser confirmada visualmente), FC (leitura com horário), histórico e comunicação com a nuvem (REST + WebSocket), com registro da sessão.

A coleta roda num serviço em primeiro plano (notificação obrigatória do Android mostra só o status), reconecta à pulseira e à nuvem indefinidamente, guarda a telemetria numa **fila em arquivo** e só a descarta quando a nuvem confirma a gravação do lote (`stored`). Antes do consentimento, e enquanto a instalação não for autorizada pela equipe, nada é coletado nem enviado (a nuvem também recusa).

## Publicar e entregar

Tudo roda em **https://biosense.deltabots.com.br** (painel em `/admin/`, API em `/v1`). O banco D1 `biosense` já está criado na conta Cloudflare, com as tabelas e o técnico inicial.

1. Em *Settings → Secrets and variables → Actions → Secrets* do repositório, crie:
   - `CLOUDFLARE_API_TOKEN` — token com *Workers Scripts: Edit* e *D1: Edit* (conta) e *Workers Routes: Edit* + *DNS: Edit* na zona `deltabots.com.br`;
   - `CLOUDFLARE_ACCOUNT_ID` — ID da conta;
   - `ADMIN_API_KEY` — chave mestra do painel (≥ 32 caracteres aleatórios).
2. Em *Actions → Deploy BIOSENSE → Run workflow*. O workflow testa, aplica migrações, publica o Worker com o domínio, grava a chave mestra, confere `/v1/health` e gera o APK (artefato `biosense-apk`) apontando para o endereço publicado.
3. No painel `/admin/` (entre com a chave mestra): publique o **termo de participação** revisado (há um rascunho em `docs/termo-participacao-RASCUNHO.md`) e gerencie técnicos.
4. Instale o APK, faça a adesão no celular e autorize a instalação (pelo painel ou pela área técnica do app).

O CI comum (`Android`) também gera um APK (artefato `biosense-debug-apk`) apontando para o domínio oficial e publica capturas de todas as telas (artefato `biosense-screens`) em 360 dp, 412 dp e 412 dp com fonte 1,3×.

## Compilar localmente

```bash
./gradlew testDebugUnitTest                                   # testes JVM
./gradlew recordPaparazziDebug                                # + capturas em app/src/test/snapshots
./gradlew assembleDebug                                       # APK (domínio oficial)
./gradlew assembleDebug -Pbiosense.cloudUrl=http://10.0.2.2:8787  # APK contra um wrangler dev local
```

Requisitos: Android 8.0+ com BLE; Android Studio Ladybug+ (AGP 8.7, Kotlin 2.0, JDK 17). Nenhuma chave administrativa vai no APK.

## Antes do primeiro participante

- **Termo**: publicar no painel a versão revisada (o app não deixa aderir sem termo publicado).
- **Técnicos**: o técnico inicial (Adriano de Oliveira Maria) já existe, com permissão para autorizar instalações. A senha informada deve ser trocada pelo painel (*Técnicos → Nova senha*) assim que o serviço estiver publicado.
- **Autorização**: cada instalação nasce pendente; vincule a referência do participante (código) pelo painel ou pela área técnica do app.

## Protocolo da pulseira

`app/src/main/java/com/miband3/app/ble/`: `MiBandProtocol.kt` (pacotes, testado na JVM), `GattQueue.kt` (fila GATT serializada), `MiBandManager.kt` (conexão, autenticação AES, reconexão, comandos, histórico por minuto). Baseado na engenharia reversa do [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge).

## Pendências e limites conhecidos

Validação feita: testes JVM (protocolo, mensagens, fila persistente, status derivado, gesto, rota inicial, parsers), capturas Paparazzi de todas as telas, 41 testes do serviço no runtime real do Workers, painel testado no navegador contra o Worker local e compilação do APK no CI. **Ainda não houve teste em aparelho Android com a pulseira real**, nem com o serviço publicado.

- **Publicação**: depende dos três segredos acima (não tenho acesso para criar o token da Cloudflare). O domínio exige que a zona `deltabots.com.br` esteja na mesma conta.
- **Termo**: o rascunho precisa de revisão jurídica e dos campos marcados com [PREENCHER] (canal de retirada, DPO, retenção, transferência internacional).
- **Histórico por minuto / sono**: segue o Gadgetbridge, mas não foi validado numa Mi Band 3 real; a classificação de sono é provisória.
- **TalkBack**: os componentes têm rótulos e regiões ao vivo, mas a navegação com leitor de tela precisa ser conferida no aparelho.
- O identificador do pacote continua `com.miband3.app` para permitir atualizar por cima das instalações existentes.
