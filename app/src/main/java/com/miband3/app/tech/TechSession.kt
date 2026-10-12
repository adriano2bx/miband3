package com.miband3.app.tech

import android.os.Handler
import android.os.Looper
import com.miband3.app.cloud.BiosenseApi
import com.miband3.app.data.TechLogin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class TechSessionInfo(val token: String, val technicianName: String, val scopes: List<String>)

/**
 * Sessão técnica emitida pela nuvem. Fica só na memória: se o app for encerrado, a sessão
 * some (nunca é restaurada). Expira após inatividade; ao expirar ou encerrar, avisa a nuvem.
 */
object TechSession {
    const val IDLE_TIMEOUT_MS = 10 * 60_000L

    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _session = MutableStateFlow<TechSessionInfo?>(null)
    val session: StateFlow<TechSessionInfo?> = _session.asStateFlow()

    private val expire = Runnable { end() }

    fun begin(login: TechLogin) {
        _session.value = TechSessionInfo(login.token, login.technicianName, login.scopes)
        touch(timeoutMs = minOf(IDLE_TIMEOUT_MS, login.idleTimeoutS * 1000L))
    }

    /** Registra atividade do técnico e adia a expiração por inatividade. */
    fun touch(timeoutMs: Long = IDLE_TIMEOUT_MS) {
        if (_session.value == null) return
        handler.removeCallbacks(expire)
        handler.postDelayed(expire, timeoutMs)
    }

    /** Encerra localmente na hora e revoga na nuvem em segundo plano. */
    fun end() {
        val token = _session.value?.token ?: return
        handler.removeCallbacks(expire)
        _session.value = null
        scope.launch { BiosenseApi.techLogout(token) }
    }

    /** A nuvem recusou a sessão (expirada/revogada): só limpa localmente. */
    fun invalidate() {
        handler.removeCallbacks(expire)
        _session.value = null
    }
}
