package com.miband3.app.cloud

import android.content.SharedPreferences

/**
 * Configuração do envio à nuvem. O token identifica a pulseira no serviço
 * (criado em `POST /v1/devices`) e funciona como senha: fica só neste aparelho.
 */
data class CloudConfig(
    val enabled: Boolean = false,
    val serverUrl: String = "",
    val deviceToken: String = "",
    /** Intervalo entre medições de FC, em minutos. 0 = medição contínua (≈1 leitura por segundo, gasta mais bateria). */
    val hrIntervalMin: Int = DEFAULT_HR_INTERVAL_MIN,
) {
    val isUsable: Boolean
        get() = enabled && wsUrl() != null && deviceToken.isNotBlank()

    /** Converte "https://meu.worker.dev" (ou só "meu.worker.dev") em "wss://meu.worker.dev/v1/connect". */
    fun wsUrl(): String? = toWebSocketUrl(serverUrl)

    companion object {
        const val DEFAULT_HR_INTERVAL_MIN = 30
        val HR_INTERVAL_OPTIONS = listOf(5, 10, 30, 60, 0)

        private val SCHEME = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://(.*)$")

        fun toWebSocketUrl(input: String): String? {
            val raw = input.trim()
            if (raw.isEmpty()) return null
            val match = SCHEME.matchEntire(raw)
            val scheme = match?.groupValues?.get(1)?.lowercase() ?: "wss"
            val rest = match?.groupValues?.get(2) ?: raw
            val ws = when (scheme) {
                "wss", "https" -> "wss"
                // Sem criptografia: só para testes na rede local.
                "ws", "http" -> "ws"
                else -> return null
            }
            val hostAndPath = rest.trimEnd('/').removeSuffix("/v1/connect").trimEnd('/')
            if (hostAndPath.substringBefore('/').isBlank()) return null
            return "$ws://$hostAndPath/v1/connect"
        }

        fun load(prefs: SharedPreferences) = CloudConfig(
            enabled = prefs.getBoolean("enabled", false),
            serverUrl = prefs.getString("serverUrl", "") ?: "",
            deviceToken = prefs.getString("deviceToken", "") ?: "",
            hrIntervalMin = prefs.getInt("hrIntervalMin", DEFAULT_HR_INTERVAL_MIN),
        )
    }

    fun save(prefs: SharedPreferences) {
        prefs.edit()
            .putBoolean("enabled", enabled)
            .putString("serverUrl", serverUrl.trim())
            .putString("deviceToken", deviceToken.trim())
            .putInt("hrIntervalMin", hrIntervalMin)
            .apply()
    }
}
