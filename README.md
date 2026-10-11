# Mi Band 3 — app Android

App Android (Kotlin + Jetpack Compose) que pareia, controla e troca mensagens com uma **Xiaomi Mi Band 3** via Bluetooth Low Energy, sem depender do Mi Fit / Zepp Life.

## Funcionalidades

| Área | O que faz |
| --- | --- |
| **Pareamento** | Procura dispositivos BLE, grava uma chave AES própria na pulseira (você confirma tocando na tela dela) e autentica sozinho nas próximas conexões. Reconecta automaticamente se a conexão cair. |
| **Painel** | Bateria (e se está carregando), passos, distância e calorias em tempo real, firmware/hardware/número de série, botão para vibrar. |
| **Frequência cardíaca** | Medição sob demanda ou monitoramento contínuo. |
| **Conversar** | Envia SMS, notificação de app, e-mail ou chamada simulada (com nome de quem liga) para a tela da pulseira. Um histórico em formato de chat mostra o que o celular enviou e os eventos que a pulseira mandou de volta: botão pressionado, chamada rejeitada, meta de passos, pulseira retirada etc. |
| **Procurar celular** | Quando você usa "Encontrar celular" na pulseira, o celular toca até você confirmar. |
| **Alarmes** | Três alarmes gravados na própria pulseira, com dias da semana ou "apenas uma vez". |
| **Ajustes** | Relógio de 12/24 h, acender a tela ao levantar o pulso, sincronizar data e hora, encaminhar automaticamente as notificações do celular (WhatsApp, Telegram, Instagram, chamadas… cada uma com o ícone certo na pulseira). |

Um serviço em primeiro plano mantém a conexão ativa com o app em segundo plano.

## Requisitos

- Android 8.0 (API 26) ou superior, com Bluetooth LE.
- Android Studio Ladybug ou mais recente (AGP 8.7, Kotlin 2.0, JDK 17).

## Como compilar

```bash
./gradlew assembleDebug          # gera app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest      # testes do protocolo
```

Ou abra a pasta no Android Studio e clique em *Run*. O workflow do GitHub Actions (`.github/workflows/android.yml`) também gera o APK a cada push e o publica como artefato `miband3-debug-apk`.

## Primeiro uso

1. Se a pulseira estiver vinculada ao Mi Fit / Zepp Life, **desvincule-a** antes (ou faça um reset de fábrica na pulseira). Ela aceita só um app pareado por vez.
2. Abra o app, conceda as permissões de Bluetooth e ligue o Bluetooth.
3. Toque na Mi Band 3 na lista (ela aparece destacada).
4. Quando a pulseira vibrar, **toque na tela dela** para autorizar.
5. Para encaminhar notificações: em **Ajustes**, ative a opção e libere o acesso às notificações.

## Como funciona (protocolo)

O código fica em `app/src/main/java/com/miband3/app/ble/`:

- `MiBandUuids.kt`: serviços e características GATT (`FEE0`/`FEE1` da Huami + serviços BLE padrão).
- `MiBandProtocol.kt`: monta e interpreta os pacotes. É código puro, coberto por testes JVM.
  - **Autenticação** (característica `0009`): `01 08 <chave>` grava a chave, `02 08` pede um número aleatório, `03 08 <AES-ECB(aleatório)>` responde ao desafio. As respostas chegam como `10 xx 01`.
  - **Mensagens**: *New Alert* (`2A46`) com categoria (SMS `05`, chamada `03`, e-mail `01`, app customizado `FA` + ícone) e o texto `título\0corpo` em UTF-8.
  - **Vibrar**: *Alert Level* (`2A06`).
  - **Frequência cardíaca**: controle `2A39` (`15 02 01` manual, `15 01 01` contínuo + ping `16` a cada 12 s), leitura em `2A37`.
  - **Bateria / passos**: características `0006` / `0007`.
  - **Eventos da pulseira**: notificações em `0010`.
  - **Alarmes e ajustes**: característica de configuração `0003`.
- `GattQueue.kt`: fila que serializa as operações GATT, já que o Android só permite uma por vez.
- `MiBandManager.kt`: conexão, máquina de estados da autenticação, comandos e estado exposto via `StateFlow` para a UI.

O protocolo foi baseado no trabalho de engenharia reversa do projeto [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge).

## Limitações conhecidas

- Não baixa o histórico de atividade e sono, nem atualiza firmware. Mostra só os dados em tempo real.
- Textos muito longos são truncados (cerca de 200 bytes) e a pulseira só exibe caracteres que a fonte dela suporta.
