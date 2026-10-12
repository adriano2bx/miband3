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

## Compilar

```bash
./gradlew testDebugUnitTest                                              # testes JVM
./gradlew assembleDebug -Pbiosense.cloudUrl=https://SEU-WORKER.workers.dev # APK
```

O endereço do serviço vai para o APK no build (`BuildConfig.CLOUD_URL`; também aceita a variável de ambiente `BIOSENSE_CLOUD_URL`). Não é segredo e **nenhuma chave administrativa vai no APK**. No GitHub Actions, defina a variável de repositório `BIOSENSE_CLOUD_URL` (Settings → Secrets and variables → Actions → Variables); o APK sai no artefato `biosense-debug-apk`. Sem o endereço, o app abre mas informa que o serviço não está configurado.

Requisitos: Android 8.0+ com BLE; Android Studio Ladybug+ (AGP 8.7, Kotlin 2.0, JDK 17).

## Antes do primeiro participante (nuvem)

Veja `cloud/README.md`. Em resumo: publicar o serviço, **publicar o termo de participação real** (`POST /v1/consent/terms` — o app não deixa aderir sem ele), criar as credenciais dos técnicos (`POST /v1/technicians`) e, depois de cada instalação, autorizá-la (pela área técnica do app, com escopo `provision`, ou `POST /v1/devices/{id}/authorize`).

## Protocolo da pulseira

`app/src/main/java/com/miband3/app/ble/`: `MiBandProtocol.kt` (pacotes, testado na JVM), `GattQueue.kt` (fila GATT serializada), `MiBandManager.kt` (conexão, autenticação AES, reconexão, comandos, histórico por minuto). Baseado na engenharia reversa do [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge).

## Pendências e limites conhecidos

Validação feita até aqui: testes JVM (protocolo, mensagens, fila persistente, status derivado, gesto, rota inicial), 41 testes do serviço no runtime real do Workers e compilação do APK no CI. **Nada disso substitui teste em aparelho e pulseira reais**, que ainda não foi feito.

- **Termo de participação**: o conteúdo completo, o meio de solicitar a retirada e o contato precisam ser fornecidos pela equipe responsável e publicados na nuvem. O app não inventa esse texto.
- **Histórico por minuto / sono**: o download segue o Gadgetbridge, mas não foi validado numa Mi Band 3 real; a classificação de sono na nuvem é provisória.
- **Autorização da instalação**: hoje é feita pela área técnica (escopo `provision`) ou pela API; não há painel web.
- **Perfil do usuário na pulseira** (altura, peso, nascimento) usa valores padrão; ainda não vem da nuvem.
- **Acessibilidade e layout**: componentes usam sp/dp, alvos de 48 dp, rolagem e rótulos para TalkBack, mas a verificação em 360 dp, 412 dp, fonte ampliada e TalkBack precisa ser feita no aparelho.
- O identificador do pacote continua `com.miband3.app` para permitir atualizar por cima das instalações existentes.
