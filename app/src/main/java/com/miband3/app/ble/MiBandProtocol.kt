package com.miband3.app.ble

import java.util.Calendar
import java.util.TimeZone
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * Montagem e interpretação dos pacotes da Mi Band 3.
 *
 * Não depende de APIs do Android para poder ser testado na JVM.
 */
object MiBandProtocol {

    // ---------------------------------------------------------------- autenticação

    /** Flag de autenticação da Mi Band 3 (o Amazfit Bip usa 0x08; a Mi Band 3 usa 0x00, como no Gadgetbridge). */
    private const val AUTH_FLAGS: Byte = 0x00

    private const val AUTH_RESPONSE: Byte = 0x10
    private const val AUTH_SEND_KEY: Byte = 0x01
    private const val AUTH_REQUEST_RANDOM: Byte = 0x02
    private const val AUTH_SEND_ENCRYPTED: Byte = 0x03
    private const val AUTH_SUCCESS: Byte = 0x01

    /** Grava uma nova chave na pulseira. A pulseira pede para o usuário tocar na tela para confirmar. */
    fun authSendKey(key: ByteArray): ByteArray {
        require(key.size == 16) { "A chave deve ter 16 bytes" }
        return byteArrayOf(AUTH_SEND_KEY, AUTH_FLAGS) + key
    }

    fun authRequestRandom(): ByteArray = byteArrayOf(AUTH_REQUEST_RANDOM, AUTH_FLAGS)

    /** Responde ao desafio cifrando o número aleatório com AES/ECB usando a chave compartilhada. */
    fun authSendEncrypted(random: ByteArray, key: ByteArray): ByteArray =
        byteArrayOf(AUTH_SEND_ENCRYPTED, AUTH_FLAGS) + aesEncrypt(random, key)

    fun aesEncrypt(data: ByteArray, key: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/ECB/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
        return cipher.doFinal(data)
    }

    sealed class AuthResponse {
        data object KeyAccepted : AuthResponse()
        data object KeyRejected : AuthResponse()
        class RandomReceived(val random: ByteArray) : AuthResponse()
        data object RandomFailed : AuthResponse()
        data object Authenticated : AuthResponse()
        data object AuthFailed : AuthResponse()
    }

    fun parseAuthResponse(data: ByteArray): AuthResponse? {
        if (data.size < 3 || data[0] != AUTH_RESPONSE) return null
        val ok = data[2] == AUTH_SUCCESS
        return when (data[1]) {
            AUTH_SEND_KEY -> if (ok) AuthResponse.KeyAccepted else AuthResponse.KeyRejected
            AUTH_REQUEST_RANDOM ->
                if (ok && data.size >= 19) AuthResponse.RandomReceived(data.copyOfRange(3, 19))
                else AuthResponse.RandomFailed
            AUTH_SEND_ENCRYPTED -> if (ok) AuthResponse.Authenticated else AuthResponse.AuthFailed
            else -> null
        }
    }

    // ---------------------------------------------------------------- leituras

    data class BatteryInfo(val level: Int, val charging: Boolean)

    fun parseBattery(data: ByteArray): BatteryInfo? {
        if (data.size < 3) return null
        val level = data[1].toInt() and 0xff
        return BatteryInfo(level.coerceIn(0, 100), data[2].toInt() == 1)
    }

    data class ActivityInfo(val steps: Int, val meters: Int?, val calories: Int?)

    fun parseSteps(data: ByteArray): ActivityInfo? {
        if (data.size < 5) return null
        val steps = uint32Le(data, 1)
        val meters = if (data.size >= 9) uint32Le(data, 5) else null
        val calories = if (data.size >= 13) uint32Le(data, 9) else null
        return ActivityInfo(steps, meters, calories)
    }

    /** Heart Rate Measurement padrão BLE (0x2A37). */
    fun parseHeartRate(data: ByteArray): Int? {
        if (data.size < 2) return null
        val is16Bit = (data[0].toInt() and 0x01) != 0
        return if (is16Bit) {
            if (data.size < 3) null else (data[1].toInt() and 0xff) or ((data[2].toInt() and 0xff) shl 8)
        } else {
            data[1].toInt() and 0xff
        }
    }

    private fun uint32Le(data: ByteArray, offset: Int): Int =
        (data[offset].toInt() and 0xff) or
            ((data[offset + 1].toInt() and 0xff) shl 8) or
            ((data[offset + 2].toInt() and 0xff) shl 16) or
            ((data[offset + 3].toInt() and 0xff) shl 24)

    // ---------------------------------------------------------------- hora

    /**
     * Current Time (0x2A2B) no formato aceito pela Mi Band 3:
     * ano(2, LE), mês, dia, hora, minuto, segundo, dia da semana (1=seg..7=dom),
     * frações, motivo do ajuste, fuso horário em unidades de 15 minutos.
     */
    fun currentTime(calendar: Calendar): ByteArray {
        val year = calendar.get(Calendar.YEAR)
        val dow = calendar.get(Calendar.DAY_OF_WEEK).let { if (it == Calendar.SUNDAY) 7 else it - 1 }
        val tz: TimeZone = calendar.timeZone
        val offsetQuarters = tz.getOffset(calendar.timeInMillis) / (15 * 60 * 1000)
        return byteArrayOf(
            (year and 0xff).toByte(),
            ((year shr 8) and 0xff).toByte(),
            (calendar.get(Calendar.MONTH) + 1).toByte(),
            calendar.get(Calendar.DAY_OF_MONTH).toByte(),
            calendar.get(Calendar.HOUR_OF_DAY).toByte(),
            calendar.get(Calendar.MINUTE).toByte(),
            calendar.get(Calendar.SECOND).toByte(),
            dow.toByte(),
            0,
            0,
            offsetQuarters.toByte(),
        )
    }

    // ---------------------------------------------------------------- frequência cardíaca

    val HR_STOP_CONTINUOUS = byteArrayOf(0x15, 0x01, 0x00)
    val HR_START_CONTINUOUS = byteArrayOf(0x15, 0x01, 0x01)
    val HR_STOP_MANUAL = byteArrayOf(0x15, 0x02, 0x00)
    val HR_START_MANUAL = byteArrayOf(0x15, 0x02, 0x01)

    /** Deve ser enviado a cada ~12 s para manter a medição contínua ativa. */
    val HR_PING = byteArrayOf(0x16)

    // ---------------------------------------------------------------- alertas e mensagens

    object AlertLevel {
        const val NONE: Byte = 0x00
        const val MILD: Byte = 0x01
        const val HIGH: Byte = 0x02
    }

    /** Categorias do perfil Alert Notification (+ categoria customizada da Huami). */
    enum class AlertCategory(val id: Int) {
        SIMPLE(0x00),
        EMAIL(0x01),
        INCOMING_CALL(0x03),
        MISSED_CALL(0x04),
        SMS(0x05),
        CUSTOM_HUAMI(0xfa),
    }

    /** Ícones exibidos pela pulseira quando a categoria é [AlertCategory.CUSTOM_HUAMI]. */
    object Icon {
        const val WECHAT = 0
        const val FACEBOOK = 3
        const val TWITTER = 4
        const val SNAPCHAT = 6
        const val WHATSAPP = 7
        const val APP = 11
        const val INSTAGRAM = 12
        const val CALENDAR = 21
        const val MESSENGER = 22
        const val VIBER = 23
        const val LINE = 24
        const val TELEGRAM = 25
        const val SKYPE = 27
        const val EMAIL = 34
    }

    /** Limite seguro de bytes de texto em um único New Alert. */
    const val MAX_ALERT_TEXT_BYTES = 200

    /**
     * Cria um pacote New Alert (0x2A46).
     * O título e o corpo são separados por um byte nulo, como a pulseira espera.
     */
    fun newAlert(category: AlertCategory, title: String, body: String = "", icon: Int = Icon.APP): ByteArray {
        val text = buildString {
            append(title.take(32))
            if (body.isNotEmpty()) {
                append('\u0000')
                append(body)
            }
        }
        val textBytes = truncateUtf8(text, MAX_ALERT_TEXT_BYTES)
        val header = if (category == AlertCategory.CUSTOM_HUAMI) {
            byteArrayOf(category.id.toByte(), 0x01, icon.toByte())
        } else {
            byteArrayOf(category.id.toByte(), 0x01)
        }
        return header + textBytes
    }

    /** Encerra o alerta de chamada exibido na pulseira. */
    fun stopCallAlert(): ByteArray = byteArrayOf(AlertCategory.INCOMING_CALL.id.toByte(), 0x00)

    /** Trunca uma string em UTF-8 sem cortar um caractere ao meio. */
    fun truncateUtf8(text: String, maxBytes: Int): ByteArray {
        val bytes = text.toByteArray(Charsets.UTF_8)
        if (bytes.size <= maxBytes) return bytes
        var end = maxBytes
        // Recua enquanto o byte em "end" for continuação (10xxxxxx) de um caractere multibyte.
        while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
        return bytes.copyOfRange(0, end)
    }

    // ---------------------------------------------------------------- configurações

    fun timeFormat24h(enabled: Boolean): ByteArray = byteArrayOf(0x06, 0x02, 0x00, if (enabled) 0x01 else 0x00)

    fun liftWristToActivate(enabled: Boolean): ByteArray =
        if (enabled) byteArrayOf(0x06, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00) else byteArrayOf(0x06, 0x05, 0x00, 0x00)

    fun distanceMetric(): ByteArray = byteArrayOf(0x06, 0x03, 0x00, 0x00)

    object Gender {
        const val MALE = 0
        const val FEMALE = 1
        const val OTHER = 2
    }

    /**
     * Perfil do usuário (característica 0008). Uma pulseira recém-pareada fica na tela
     * "conecte um dispositivo" até recebê-lo; também é usado no cálculo de calorias e distância.
     */
    fun userInfo(
        birthYear: Int,
        birthMonth: Int,
        birthDay: Int,
        gender: Int,
        heightCm: Int,
        weightKg: Int,
        userId: Int,
    ): ByteArray {
        val weight = weightKg * 200
        return byteArrayOf(
            0x4f, 0x00, 0x00,
            (birthYear and 0xff).toByte(),
            ((birthYear shr 8) and 0xff).toByte(),
            birthMonth.toByte(),
            birthDay.toByte(),
            gender.toByte(),
            (heightCm and 0xff).toByte(),
            ((heightCm shr 8) and 0xff).toByte(),
            (weight and 0xff).toByte(),
            ((weight shr 8) and 0xff).toByte(),
            (userId and 0xff).toByte(),
            ((userId shr 8) and 0xff).toByte(),
            ((userId shr 16) and 0xff).toByte(),
            ((userId shr 24) and 0xff).toByte(),
        )
    }

    /** Pulso em que a pulseira é usada (característica 0008). */
    fun wearLocation(leftWrist: Boolean): ByteArray =
        byteArrayOf(0x20, 0x00, 0x00, if (leftWrist) 0x02 else 0x82.toByte())

    /** Meta diária de passos (característica 0008). */
    fun stepGoal(steps: Int): ByteArray =
        byteArrayOf(0x10, 0x00, 0x00, (steps and 0xff).toByte(), ((steps shr 8) and 0xff).toByte(), 0x00, 0x00)

    /** Bits dos dias da semana usados nos alarmes. */
    object Days {
        const val MONDAY = 0x01
        const val TUESDAY = 0x02
        const val WEDNESDAY = 0x04
        const val THURSDAY = 0x08
        const val FRIDAY = 0x10
        const val SATURDAY = 0x20
        const val SUNDAY = 0x40
        const val ONCE = 0x80
        const val EVERY_DAY = 0x7f
    }

    /**
     * Configura um dos alarmes da pulseira (posições 0..9).
     * [daysMask] = 0 é tratado como "apenas uma vez".
     */
    fun alarm(slot: Int, enabled: Boolean, hour: Int, minute: Int, daysMask: Int): ByteArray {
        require(slot in 0..9) { "Posição de alarme inválida: $slot" }
        val flags = (if (enabled) 0x80 else 0x00) or slot
        val days = if (daysMask and Days.EVERY_DAY == 0) Days.ONCE else daysMask and Days.EVERY_DAY
        return byteArrayOf(0x02, flags.toByte(), hour.toByte(), minute.toByte(), days.toByte())
    }

    // ---------------------------------------------------------------- eventos da pulseira

    enum class DeviceEvent(val code: Int, val description: String) {
        FELL_ASLEEP(0x01, "Usuário adormeceu"),
        WOKE_UP(0x02, "Usuário acordou"),
        STEPS_GOAL_REACHED(0x03, "Meta de passos atingida!"),
        BUTTON_PRESSED(0x04, "Botão da pulseira pressionado"),
        START_NONWEAR(0x06, "Pulseira retirada do pulso"),
        CALL_REJECTED(0x07, "Chamada rejeitada na pulseira"),
        FIND_PHONE_START(0x08, "A pulseira está procurando o celular"),
        CALL_IGNORED(0x09, "Chamada silenciada na pulseira"),
        ALARM_TOGGLED(0x0a, "Alarme ligado/desligado na pulseira"),
        BUTTON_PRESSED_LONG(0x0b, "Botão da pulseira pressionado longamente"),
        TICK_30MIN(0x0e, "Marcação de 30 minutos"),
        FIND_PHONE_STOP(0x0f, "Busca do celular encerrada"),
        MTU_REQUEST(0x16, "Pulseira solicitou ajuste de MTU"),
        MUSIC_CONTROL(0xfe, "Controle de música");

        companion object {
            fun fromData(data: ByteArray): DeviceEvent? {
                if (data.isEmpty()) return null
                val code = data[0].toInt() and 0xff
                return entries.firstOrNull { it.code == code }
            }
        }
    }

    // ---------------------------------------------------------------- utilidades

    fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    fun hexToBytes(hex: String): ByteArray {
        val clean = hex.replace(" ", "").lowercase()
        require(clean.length % 2 == 0) { "Hex inválido" }
        return ByteArray(clean.length / 2) { i -> clean.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}
