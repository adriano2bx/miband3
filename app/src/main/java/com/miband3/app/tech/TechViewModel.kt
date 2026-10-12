package com.miband3.app.tech

import android.app.Application
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.miband3.app.R
import com.miband3.app.ble.BandEvent
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.ApiResult
import com.miband3.app.cloud.BiosenseApi
import com.miband3.app.cloud.CloudClient
import com.miband3.app.data.InstallationStore
import com.miband3.app.data.TechInstallation
import com.miband3.app.status.hasBluetoothPermissions
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.coroutines.resume

enum class TestId { BLUETOOTH, VIBRATION, HEART_RATE, HISTORY, CLOUD }

enum class TestState { IDLE, RUNNING, DONE, FAILED, EXPIRED, UNSUPPORTED }

data class TestResult(val state: TestState = TestState.IDLE, val detail: String? = null, val atMs: Long? = null)

data class LogLine(val atMs: Long, val text: String)

sealed class ConfigLoad {
    data object Loading : ConfigLoad()
    data class Loaded(val data: TechInstallation, val syncedAtMs: Long) : ConfigLoad()
    data class Failed(@StringRes val message: Int) : ConfigLoad()
}

enum class AuthorizeState { IDLE, SAVING, SAVED, FAILED }

data class TechUi(
    val config: ConfigLoad = ConfigLoad.Loading,
    val syncing: Boolean = false,
    val tests: Map<TestId, TestResult> = TestId.entries.associateWith { TestResult() },
    val log: List<LogLine> = emptyList(),
    val authorize: AuthorizeState = AuthorizeState.IDLE,
    @StringRes val authorizeError: Int? = null,
    val vibrationCooldownUntil: Long = 0L,
)

/**
 * Ações da área técnica. Cada teste usa o recurso real (BLE ou nuvem) e mostra o que de
 * fato foi confirmado: comando escrito na pulseira não é o mesmo que vibração percebida.
 * Tudo some ao encerrar a sessão (o ViewModel é limpo e o registro não é persistido).
 */
class TechViewModel(app: Application) : AndroidViewModel(app) {
    private val _ui = MutableStateFlow(TechUi())
    val ui: StateFlow<TechUi> = _ui.asStateFlow()
    private val jobs = mutableMapOf<TestId, Job>()

    private fun str(@StringRes id: Int, vararg args: Any): String = getApplication<Application>().getString(id, *args)
    private fun time(ms: Long): String = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(ms))

    init {
        loadConfig()
    }

    private val session: String? get() = TechSession.session.value?.token

    private fun log(text: String) {
        _ui.update { it.copy(log = (it.log + LogLine(System.currentTimeMillis(), text)).takeLast(100)) }
    }

    /** Resposta 401: sessão expirada ou revogada na nuvem; volta à principal. */
    private fun handleFailure(r: ApiResult.Failure): Int {
        if (r.httpCode == 401) {
            TechSession.invalidate()
            return R.string.tech_session_expired
        }
        return if (r.kind == ApiResult.Kind.NETWORK) R.string.tech_error_network else R.string.tech_error_rejected
    }

    fun loadConfig(sync: Boolean = false) {
        val token = session ?: return
        TechSession.touch()
        _ui.update { it.copy(syncing = true, config = if (sync && it.config is ConfigLoad.Loaded) it.config else ConfigLoad.Loading) }
        viewModelScope.launch {
            when (val r = BiosenseApi.techInstallation(token)) {
                is ApiResult.Ok -> {
                    // Aplica no app o perfil efetivo vindo da nuvem (mesma fonte do WebSocket).
                    InstallationStore.current.deviceToken?.let { t ->
                        (BiosenseApi.installation(t) as? ApiResult.Ok)?.let { InstallationStore.applyServer(it.value) }
                    }
                    _ui.update { it.copy(config = ConfigLoad.Loaded(r.value, System.currentTimeMillis()), syncing = false) }
                    if (sync) log(str(R.string.log_config_synced, r.value.info.configVersion ?: 0))
                }
                is ApiResult.Failure -> {
                    val msg = handleFailure(r)
                    _ui.update { it.copy(config = if (it.config is ConfigLoad.Loaded) it.config else ConfigLoad.Failed(msg), syncing = false) }
                    if (sync) log(str(R.string.log_config_failed))
                }
            }
        }
    }

    fun authorize(participantRef: String) {
        val token = session ?: return
        val ref = participantRef.trim()
        if (ref.isEmpty() || _ui.value.authorize == AuthorizeState.SAVING) return
        TechSession.touch()
        _ui.update { it.copy(authorize = AuthorizeState.SAVING, authorizeError = null) }
        viewModelScope.launch {
            when (val r = BiosenseApi.techAuthorize(token, ref)) {
                is ApiResult.Ok -> {
                    _ui.update { it.copy(authorize = AuthorizeState.SAVED, config = ConfigLoad.Loaded(r.value, System.currentTimeMillis())) }
                    log(str(R.string.log_authorized))
                }
                is ApiResult.Failure -> {
                    val msg = if (r.httpCode == 403) R.string.tech_authorize_forbidden else handleFailure(r)
                    _ui.update { it.copy(authorize = AuthorizeState.FAILED, authorizeError = msg) }
                }
            }
        }
    }

    // ------------------------------------------------------------------ testes

    private fun set(id: TestId, state: TestState, detail: String? = null) {
        _ui.update { it.copy(tests = it.tests + (id to TestResult(state, detail, System.currentTimeMillis()))) }
    }

    private fun bandReady() = MiBandManager.state.value.connection == ConnectionState.READY

    fun run(id: TestId) {
        if (jobs[id]?.isActive == true) return
        TechSession.touch()
        set(id, TestState.RUNNING)
        jobs[id] = viewModelScope.launch {
            when (id) {
                TestId.BLUETOOTH -> testBluetooth()
                TestId.VIBRATION -> testVibration()
                TestId.HEART_RATE -> testHeartRate()
                TestId.HISTORY -> testHistory()
                TestId.CLOUD -> testCloud()
            }
        }
    }

    private suspend fun testBluetooth() {
        val ctx = getApplication<Application>()
        when {
            !hasBluetoothPermissions(ctx) -> finish(TestId.BLUETOOTH, TestState.FAILED, str(R.string.test_bt_no_permission))
            !MiBandManager.bluetoothOn.value -> finish(TestId.BLUETOOTH, TestState.FAILED, str(R.string.test_bt_off))
            !bandReady() -> finish(TestId.BLUETOOTH, TestState.FAILED, str(R.string.test_band_not_ready))
            else -> {
                val level = withTimeoutOrNull(10_000) {
                    suspendCancellableCoroutine<Int?> { cont -> MiBandManager.readBatteryNow { if (cont.isActive) cont.resume(it) } }
                }
                when {
                    level != null -> finish(TestId.BLUETOOTH, TestState.DONE, str(R.string.test_bt_ok, level))
                    else -> finish(TestId.BLUETOOTH, TestState.EXPIRED, str(R.string.test_no_response))
                }
            }
        }
    }

    private suspend fun testVibration() {
        if (!bandReady()) return finish(TestId.VIBRATION, TestState.FAILED, str(R.string.test_band_not_ready))
        // Uma única vibração curta, com intervalo mínimo entre testes.
        _ui.update { it.copy(vibrationCooldownUntil = System.currentTimeMillis() + 5_000) }
        MiBandManager.vibratePattern(count = 1, durationMs = 800, pauseMs = 300, high = true)
        val ok = withTimeoutOrNull(8_000) {
            suspendCancellableCoroutine<Boolean> { cont -> MiBandManager.afterPendingOperations { if (cont.isActive) cont.resume(it) } }
        }
        when (ok) {
            true -> finish(TestId.VIBRATION, TestState.DONE, str(R.string.test_vibration_written))
            false -> finish(TestId.VIBRATION, TestState.FAILED, str(R.string.test_write_failed))
            null -> finish(TestId.VIBRATION, TestState.EXPIRED, str(R.string.test_no_response))
        }
    }

    private suspend fun testHeartRate() {
        if (!bandReady()) return finish(TestId.HEART_RATE, TestState.FAILED, str(R.string.test_band_not_ready))
        val start = System.currentTimeMillis()
        val reading = withTimeoutOrNull(45_000) {
            MiBandManager.measureHeartRate()
            MiBandManager.events.filterIsInstance<BandEvent.HeartRate>().first { it.ts >= start }
        }
        if (reading != null) {
            finish(TestId.HEART_RATE, TestState.DONE, str(R.string.test_hr_ok, reading.bpm, time(reading.ts)))
        } else {
            finish(TestId.HEART_RATE, TestState.EXPIRED, str(R.string.test_hr_timeout))
        }
    }

    private suspend fun testHistory() {
        if (!bandReady()) return finish(TestId.HISTORY, TestState.FAILED, str(R.string.test_band_not_ready))
        val result = withTimeoutOrNull(90_000) {
            suspendCancellableCoroutine<Pair<Boolean, String>> { cont ->
                MiBandManager.fetchHistory(null) { ok, msg -> if (cont.isActive) cont.resume(ok to msg) }
            }
        }
        when {
            result == null -> finish(TestId.HISTORY, TestState.EXPIRED, str(R.string.test_no_response))
            result.first -> finish(TestId.HISTORY, TestState.DONE, str(R.string.test_history_ok, result.second))
            else -> finish(TestId.HISTORY, TestState.FAILED, result.second)
        }
    }

    private suspend fun testCloud() {
        val token = session ?: return
        val started = System.currentTimeMillis()
        val rest = BiosenseApi.techPing(token)
        val restMs = System.currentTimeMillis() - started
        if (rest is ApiResult.Failure) {
            return finish(TestId.CLOUD, TestState.FAILED, str(handleFailure(rest)))
        }
        val wsMs = CloudClient.roundTrip()
        if (wsMs == null) {
            finish(TestId.CLOUD, TestState.FAILED, str(R.string.test_cloud_ws_down, restMs))
        } else {
            finish(TestId.CLOUD, TestState.DONE, str(R.string.test_cloud_ok, restMs, wsMs))
        }
    }

    private fun finish(id: TestId, state: TestState, detail: String) {
        set(id, state, detail)
        val label = str(
            when (id) {
                TestId.BLUETOOTH -> R.string.test_bluetooth
                TestId.VIBRATION -> R.string.test_vibration
                TestId.HEART_RATE -> R.string.test_heart_rate
                TestId.HISTORY -> R.string.test_history
                TestId.CLOUD -> R.string.test_cloud
            },
        )
        log("$label · $detail")
        if (id == TestId.VIBRATION) viewModelScope.launch {
            delay((_ui.value.vibrationCooldownUntil - System.currentTimeMillis()).coerceAtLeast(0))
            _ui.update { it.copy(vibrationCooldownUntil = 0) }
        }
    }

    fun endSession() {
        jobs.values.forEach { it.cancel() }
        TechSession.end()
    }
}
