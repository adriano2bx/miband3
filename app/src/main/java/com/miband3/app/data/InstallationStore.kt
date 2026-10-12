package com.miband3.app.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Estado local da adesão. Só guarda o que o servidor confirmou: a versão do termo
 * aceita vem da resposta da nuvem, nunca apenas do checkbox.
 */
data class Installation(
    val deviceId: String? = null,
    val deviceToken: String? = null,
    /** Versão do termo cujo aceite o servidor gravou. */
    val consentVersion: String? = null,
    /** A nuvem informou que é preciso aceitar uma nova versão do termo. */
    val reconsentRequired: Boolean = false,
    /** Participante escolheu "Não participar" (nada é coletado). */
    val declined: Boolean = false,
    /** Tutorial concluído com pulseira autenticada e serviço conectado. */
    val setupComplete: Boolean = false,
    /** Última posição conhecida do servidor: instalação autorizada e consentimento válido. */
    val accepting: Boolean = false,
    val authorized: Boolean = false,
    val hrIntervalMin: Int = 30,
    val historyIntervalMin: Int = 30,
    val configVersion: Int = 0,
    val configUpdatedAt: Long? = null,
) {
    val enrolled: Boolean get() = deviceToken != null
    val hasValidConsent: Boolean get() = enrolled && consentVersion != null && !reconsentRequired && !declined
}

object InstallationStore {
    private const val PREFS = "installation"
    private lateinit var prefs: SharedPreferences
    private val _state = MutableStateFlow(Installation())
    val state: StateFlow<Installation> = _state.asStateFlow()

    val current: Installation get() = _state.value

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        _state.value = Installation(
            deviceId = prefs.getString("deviceId", null),
            deviceToken = prefs.getString("deviceToken", null),
            consentVersion = prefs.getString("consentVersion", null),
            reconsentRequired = prefs.getBoolean("reconsentRequired", false),
            declined = prefs.getBoolean("declined", false),
            setupComplete = prefs.getBoolean("setupComplete", false),
            accepting = prefs.getBoolean("accepting", false),
            authorized = prefs.getBoolean("authorized", false),
            hrIntervalMin = prefs.getInt("hrIntervalMin", 30),
            historyIntervalMin = prefs.getInt("historyIntervalMin", 30),
            configVersion = prefs.getInt("configVersion", 0),
            configUpdatedAt = prefs.getLong("configUpdatedAt", 0L).takeIf { it > 0 },
        )
    }

    @Synchronized
    fun update(transform: (Installation) -> Installation) {
        val next = transform(_state.value)
        _state.value = next
        prefs.edit()
            .putString("deviceId", next.deviceId)
            .putString("deviceToken", next.deviceToken)
            .putString("consentVersion", next.consentVersion)
            .putBoolean("reconsentRequired", next.reconsentRequired)
            .putBoolean("declined", next.declined)
            .putBoolean("setupComplete", next.setupComplete)
            .putBoolean("accepting", next.accepting)
            .putBoolean("authorized", next.authorized)
            .putInt("hrIntervalMin", next.hrIntervalMin)
            .putInt("historyIntervalMin", next.historyIntervalMin)
            .putInt("configVersion", next.configVersion)
            .putLong("configUpdatedAt", next.configUpdatedAt ?: 0L)
            .apply()
    }

    /** Aplica o estado da instalação informado pela nuvem (welcome/status ou GET /v1/installation). */
    fun applyServer(info: InstallationInfo) = update {
        it.copy(
            deviceId = info.deviceId ?: it.deviceId,
            consentVersion = if (info.consent.valid) info.consent.acceptedVersion else it.consentVersion,
            reconsentRequired = !info.consent.valid,
            authorized = info.authorized,
            accepting = info.authorized && info.consent.valid,
            hrIntervalMin = info.config?.hrIntervalMin ?: it.hrIntervalMin,
            historyIntervalMin = info.config?.historyIntervalMin ?: it.historyIntervalMin,
            configVersion = info.configVersion ?: it.configVersion,
            configUpdatedAt = info.configUpdatedAt ?: it.configUpdatedAt,
        )
    }
}
