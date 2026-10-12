package com.miband3.app.cloud

/** Normalização do endereço do serviço (definido no build, em BuildConfig.CLOUD_URL). */
object CloudConfig {
    private val SCHEME = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*)://(.*)$")

    private fun split(input: String): Pair<Boolean, String>? {
        val raw = input.trim()
        if (raw.isEmpty()) return null
        val match = SCHEME.matchEntire(raw)
        val scheme = match?.groupValues?.get(1)?.lowercase() ?: "https"
        val rest = match?.groupValues?.get(2) ?: raw
        val secure = when (scheme) {
            "wss", "https" -> true
            // Sem criptografia: só para testes na rede local.
            "ws", "http" -> false
            else -> return null
        }
        val hostAndPath = rest.trimEnd('/').removeSuffix("/v1/connect").trimEnd('/')
        if (hostAndPath.substringBefore('/').isBlank()) return null
        return secure to hostAndPath
    }

    /** "meu.workers.dev" ou "https://meu.workers.dev/" -> "wss://meu.workers.dev/v1/connect". */
    fun toWebSocketUrl(input: String): String? = split(input)?.let { (secure, host) -> "${if (secure) "wss" else "ws"}://$host/v1/connect" }

    /** "meu.workers.dev" -> "https://meu.workers.dev". */
    fun toHttpBase(input: String): String? = split(input)?.let { (secure, host) -> "${if (secure) "https" else "http"}://$host" }
}
