package com.miband3.app.status

/** Estados do cartão "Status do dispositivo" (texto e ícone mudam, não só a cor). */
enum class StatusKind {
    ACTIVE,
    RECONNECTING,
    BAND_DISCONNECTED,
    BLUETOOTH_OFF,
    SERVICE_UNAVAILABLE,
    PERMISSION_REQUIRED,
    NOT_AUTHORIZED,
}

enum class BandLink { DISCONNECTED, CONNECTING, AUTHENTICATED }

enum class CloudLink { OFFLINE, CONNECTING, ONLINE, REJECTED }

data class StatusInputs(
    val permissionGranted: Boolean,
    val bluetoothOn: Boolean,
    val band: BandLink,
    /** O app ainda está tentando reconectar à pulseira (não desistiu). */
    val bandRetrying: Boolean,
    /** A pulseira recusou a autenticação (chave inválida, outro app vinculado...). */
    val bandAuthRejected: Boolean,
    val cloud: CloudLink,
    /** A nuvem informou que a instalação está autorizada e com consentimento válido. */
    val cloudAuthorized: Boolean,
    /** Última confirmação de presença (pong) da nuvem, em ms. */
    val lastPresenceMs: Long?,
    val nowMs: Long,
)

const val PRESENCE_FRESH_MS = 75_000L

/**
 * Deriva o status mostrado ao participante. "Conexão ativa" exige pulseira autenticada,
 * serviço autenticado e autorizado E confirmação de presença recente — socket aberto não basta.
 * Ausência de medição não conta como perda de conexão.
 */
fun deriveStatus(i: StatusInputs): StatusKind {
    if (!i.permissionGranted) return StatusKind.PERMISSION_REQUIRED
    if (!i.bluetoothOn) return StatusKind.BLUETOOTH_OFF
    if (i.bandAuthRejected || i.cloud == CloudLink.REJECTED) return StatusKind.NOT_AUTHORIZED
    if (i.cloud == CloudLink.ONLINE && !i.cloudAuthorized) return StatusKind.NOT_AUTHORIZED

    val presenceFresh = i.lastPresenceMs != null && i.nowMs - i.lastPresenceMs <= PRESENCE_FRESH_MS
    return when (i.band) {
        BandLink.CONNECTING -> StatusKind.RECONNECTING
        BandLink.DISCONNECTED -> if (i.bandRetrying) StatusKind.RECONNECTING else StatusKind.BAND_DISCONNECTED
        BandLink.AUTHENTICATED -> when (i.cloud) {
            CloudLink.ONLINE -> if (presenceFresh) StatusKind.ACTIVE else StatusKind.RECONNECTING
            CloudLink.CONNECTING -> StatusKind.RECONNECTING
            CloudLink.OFFLINE -> StatusKind.SERVICE_UNAVAILABLE
            CloudLink.REJECTED -> StatusKind.NOT_AUTHORIZED
        }
    }
}
