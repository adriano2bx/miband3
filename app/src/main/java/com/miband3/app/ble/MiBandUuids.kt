package com.miband3.app.ble

import java.util.UUID

/** UUIDs de serviços e características usados pela Mi Band 3 (protocolo Huami). */
object MiBandUuids {
    private fun std(short: String): UUID = UUID.fromString("0000$short-0000-1000-8000-00805f9b34fb")
    private fun huami(short: String): UUID = UUID.fromString("0000$short-0000-3512-2155-6e6f69746365")

    val SERVICE_MIBAND: UUID = std("fee0")
    val SERVICE_AUTH: UUID = std("fee1")

    /** Autenticação (escrita sem resposta + notificação). */
    val CHAR_AUTH: UUID = huami("0009")

    /** Configurações: alarmes, formato de hora, levantar pulso etc. */
    val CHAR_CONFIG: UUID = huami("0003")
    val CHAR_BATTERY: UUID = huami("0006")
    val CHAR_STEPS: UUID = huami("0007")

    /** Eventos gerados pela pulseira (botão, procurar celular, chamada rejeitada...). */
    val CHAR_DEVICE_EVENT: UUID = huami("0010")

    val CHAR_CURRENT_TIME: UUID = std("2a2b")

    val CHAR_HR_MEASUREMENT: UUID = std("2a37")
    val CHAR_HR_CONTROL: UUID = std("2a39")

    /** Immediate Alert: faz a pulseira vibrar. */
    val CHAR_ALERT_LEVEL: UUID = std("2a06")

    /** Alert Notification / New Alert: mensagens, chamadas e notificações de apps. */
    val CHAR_NEW_ALERT: UUID = std("2a46")

    val CHAR_SERIAL: UUID = std("2a25")
    val CHAR_FIRMWARE: UUID = std("2a26")
    val CHAR_HARDWARE: UUID = std("2a27")

    /** Client Characteristic Configuration Descriptor. */
    val CCCD: UUID = std("2902")
}
