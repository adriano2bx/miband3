package com.miband3.app.cloud

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.miband3.app.BuildConfig
import com.miband3.app.ble.BandEvent
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.MiBandManager
import com.miband3.app.data.InstallationStore
import com.miband3.app.data.Parsers
import com.miband3.app.service.MiBandService
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.random.Random

enum class CloudStatus { DISABLED, CONNECTING, ONLINE, REJECTED }

data class CloudState(
    val status: CloudStatus = CloudStatus.DISABLED,
    /** Tentativas seguidas que falharam (sem rede, servidor fora...). */
    val failures: Int = 0,
    /** Itens aguardando confirmação de gravação (persistidos no celular). */
    val queued: Int = 0,
    val lastStoredMs: Long? = null,
    /** Última confirmação de presença recebida da nuvem. */
    val lastPresenceMs: Long? = null,
    val detail: String? = null,
)

/**
 * Mantém o WebSocket autenticado com a nuvem BIOSENSE.
 *
 * - Só coleta e envia telemetria se a nuvem informou instalação autorizada e consentimento válido.
 * - Telemetria vai para uma fila em arquivo; cada lote só sai da fila após `stored` da nuvem.
 * - Executa comandos recebidos e confirma cada um.
 * - Perfil de coleta (intervalo de FC e de histórico) vem da nuvem.
 * Todo o estado é acessado na thread principal.
 */
object CloudClient {
    private const val TAG = "CloudClient"
    private const val MAX_BATCH_ITEMS = 200
    private const val MAX_BATCH_CHARS = 200_000
    private const val FLUSH_DELAY_MS = 500L
    private const val SAVE_DELAY_MS = 2_000L
    private const val APP_PING_MS = 25_000L
    private const val PERIODIC_MS = 60_000L
    private const val REFRESH_EVERY_MIN = 5
    private const val HR_WINDOW_MS = 60_000L
    private const val MAX_REMEMBERED_COMMANDS = 200

    private lateinit var appContext: Context
    private lateinit var queue: PersistentQueue
    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow(CloudState())
    val state: StateFlow<CloudState> = _state.asStateFlow()

    private var socket: WebSocket? = null
    private var generation = 0
    private var welcomed = false
    private var started = false
    private var rejected = false
    private var minutes = 0
    private var hrWindowUntil = 0L
    private var lastHelloKey: String? = null
    private val handled = LinkedHashMap<String, JSONObject>()
    private val pongWaiters = mutableListOf<CompletableDeferred<Long>>()

    /** A instalação existe e o participante não recusou: mantém conexão e serviço. */
    val isUsable: Boolean
        get() = ::appContext.isInitialized && InstallationStore.current.enrolled && !InstallationStore.current.declined

    private val collecting: Boolean
        get() = isUsable && InstallationStore.current.accepting && InstallationStore.current.hasValidConsent

    fun init(context: Context) {
        if (::appContext.isInitialized) return
        appContext = context.applicationContext
        queue = PersistentQueue(File(appContext.filesDir, "telemetry_queue.jsonl"))
        try { queue.load() } catch (e: Exception) { debug("Fila local ilegível; descartada") }
        _state.update { it.copy(queued = queue.size) }
        observeBand()
        registerNetworkCallback()
        handler.postDelayed(periodic, PERIODIC_MS)
        start()
    }

    /** Liga a conexão quando a instalação existe (chamado na inicialização e após a adesão). */
    fun start() {
        if (!isUsable) {
            stop(clearQueue = false)
            return
        }
        started = true
        MiBandManager.keepTrying = InstallationStore.current.setupComplete
        try {
            MiBandService.start(appContext)
        } catch (e: Exception) {
            debug("Serviço em primeiro plano não iniciado: ${e.javaClass.simpleName}")
        }
        if (InstallationStore.current.setupComplete) MiBandManager.reconnectIfSaved()
        if (socket == null && !rejected) connect()
    }

    fun stop(clearQueue: Boolean) {
        started = false
        closeSocket("parado")
        if (clearQueue) {
            queue.clear()
            saveQueue()
        }
        _state.value = CloudState(status = CloudStatus.DISABLED, queued = queue.size)
    }

    /** Pede uma medição de FC e libera o envio da primeira leitura que chegar. */
    fun measureHeartRateNow() {
        if (MiBandManager.state.value.connection != ConnectionState.READY) return
        hrWindowUntil = System.currentTimeMillis() + HR_WINDOW_MS
        MiBandManager.measureHeartRate()
    }

    /** Teste técnico: ida e volta pelo WebSocket. Devolve o tempo em ms ou null se não houve resposta. */
    suspend fun roundTrip(timeoutMs: Long = 10_000): Long? {
        val sock = socket ?: return null
        if (!welcomed) return null
        val waiter = CompletableDeferred<Long>()
        pongWaiters += waiter
        val start = System.currentTimeMillis()
        sock.send("""{"t":"ping"}""")
        val result = withTimeoutOrNull(timeoutMs) { waiter.await() - start }
        pongWaiters -= waiter
        return result
    }

    // ------------------------------------------------------------------ conexão

    private fun connect() {
        val url = CloudConfig.toWebSocketUrl(BuildConfig.CLOUD_URL)
        val token = InstallationStore.current.deviceToken
        if (url == null || token == null) {
            _state.update { it.copy(status = CloudStatus.CONNECTING, detail = "Serviço não configurado nesta versão") }
            return
        }
        val gen = ++generation
        welcomed = false
        _state.update { it.copy(status = CloudStatus.CONNECTING) }
        val request = Request.Builder()
            .url(url.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://"))
            .header("Authorization", "Bearer $token")
            .build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                handler.post { if (gen == generation) onText(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handler.post { if (gen == generation) onDisconnected(code, null) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                handler.post { if (gen == generation) onDisconnected(null, code) }
            }
        })
    }

    private fun closeSocket(reason: String) {
        generation++
        welcomed = false
        handler.removeCallbacks(appPing)
        handler.removeCallbacks(flushRunnable)
        handler.removeCallbacks(reconnectRunnable)
        flushScheduled = false
        socket?.close(1000, reason)
        socket = null
        queue.requeueInFlight()
    }

    private fun onDisconnected(closeCode: Int?, httpStatus: Int?) {
        socket = null
        welcomed = false
        handler.removeCallbacks(appPing)
        queue.requeueInFlight()
        if (httpStatus == 401 || httpStatus == 403 || closeCode == 4001 || closeCode == 4003) {
            // Token inválido, instalação bloqueada ou revogada: só a equipe técnica resolve.
            rejected = true
            _state.update { it.copy(status = CloudStatus.REJECTED, detail = "Instalação não autorizada pela nuvem") }
            return
        }
        if (!started || !isUsable) return
        val failures = _state.value.failures + 1
        val delayMs = minOf(60_000L, 1_000L shl minOf(failures, 6)) + Random.nextLong(0, 1_000)
        _state.update { it.copy(status = CloudStatus.CONNECTING, failures = failures, detail = null) }
        handler.postDelayed(reconnectRunnable, delayMs)
    }

    private val reconnectRunnable = Runnable { if (socket == null && started && isUsable && !rejected) connect() }

    private fun registerNetworkCallback() {
        val cm = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    handler.post {
                        if (socket == null && started && isUsable && !rejected) {
                            handler.removeCallbacks(reconnectRunnable)
                            connect()
                        }
                    }
                }
            })
        } catch (e: Exception) {
            debug("Sem monitor de rede")
        }
    }

    // ------------------------------------------------------------------ mensagens da nuvem

    private fun onText(text: String) {
        if (text == "pong") return onPresence()
        val json = try { JSONObject(text) } catch (e: Exception) { return }
        when (json.optString("t")) {
            "welcome" -> onWelcome(json)
            "status" -> applyServerStatus(json)
            "stored" -> onStored(json)
            "pong" -> {
                onPresence()
                val now = System.currentTimeMillis()
                pongWaiters.toList().forEach { it.complete(now) }
            }
            "command" -> CloudMessages.parseCommand(text)?.let(::onCommand)
            "error" -> debug("Servidor recusou uma mensagem")
        }
    }

    private fun onPresence() {
        _state.update { it.copy(lastPresenceMs = System.currentTimeMillis()) }
    }

    private fun onWelcome(json: JSONObject) {
        welcomed = true
        _state.update { it.copy(status = CloudStatus.ONLINE, failures = 0, detail = null, lastPresenceMs = System.currentTimeMillis()) }
        applyServerStatus(json)
        sendHello()
        if (collecting) enqueueSnapshot()
        flush()
        handler.removeCallbacks(appPing)
        handler.postDelayed(appPing, APP_PING_MS)
    }

    private fun applyServerStatus(json: JSONObject) {
        val before = InstallationStore.current
        InstallationStore.applyServer(Parsers.installation(json))
        val after = InstallationStore.current
        onPresence()
        if (before.hrIntervalMin != after.hrIntervalMin && MiBandManager.state.value.connection == ConnectionState.READY) {
            applyHeartRateMode()
        }
        if (!after.accepting && queue.size > 0) {
            // Instalação deixou de estar autorizada: nada pendente deve ser enviado depois.
            queue.clear()
            scheduleSave()
            _state.update { it.copy(queued = 0) }
        }
    }

    private fun onStored(json: JSONObject) {
        val seq = json.optLong("seq", -1)
        if (seq < 0) return
        queue.ack(seq)
        if (!json.optBoolean("accepted", true)) debug("Lote recusado pela nuvem: ${json.optString("reason")}")
        _state.update { it.copy(queued = queue.size, lastStoredMs = System.currentTimeMillis(), lastPresenceMs = System.currentTimeMillis()) }
        scheduleSave()
        flush()
    }

    private fun onCommand(cmd: CloudCommand) {
        handled[cmd.id]?.let {
            sendRaw(it.toString())
            return
        }
        CommandExecutor.execute(cmd) { result ->
            handler.post {
                val ack = CloudMessages.ack(cmd.id, result.ok, result.error, result.info)
                handled[cmd.id] = ack
                if (handled.size > MAX_REMEMBERED_COMMANDS) handled.remove(handled.keys.first())
                sendRaw(ack.toString())
            }
        }
    }

    // ------------------------------------------------------------------ envio

    private fun sendHello() {
        val b = MiBandManager.state.value
        lastHelloKey = listOf(b.name, b.address, b.firmware, b.hardware, b.serial).joinToString("|")
        sendRaw(CloudMessages.hello(BuildConfig.VERSION_NAME, "Android ${Build.VERSION.RELEASE}", "${Build.MANUFACTURER} ${Build.MODEL}", b.name, b.address, b.firmware, b.hardware, b.serial).toString())
    }

    private fun enqueueSnapshot() {
        val now = System.currentTimeMillis()
        val b = MiBandManager.state.value
        enqueue(CloudMessages.state(now, b.connection.name, null))
        b.battery?.let { enqueue(CloudMessages.battery(now, it, b.charging)) }
        b.steps?.let { enqueue(CloudMessages.steps(now, it, b.meters, b.calories)) }
    }

    private fun enqueue(item: JSONObject, urgent: Boolean = false) {
        if (!collecting) return
        queue.add(item.toString())
        _state.update { it.copy(queued = queue.size) }
        scheduleSave()
        if (!welcomed) return
        if (urgent) flush() else if (!flushScheduled) {
            flushScheduled = true
            handler.postDelayed(flushRunnable, FLUSH_DELAY_MS)
        }
    }

    private var flushScheduled = false
    private val flushRunnable = Runnable { flush() }

    private fun flush() {
        flushScheduled = false
        handler.removeCallbacks(flushRunnable)
        val sock = socket ?: return
        if (!welcomed) return
        // Uma janela pequena de lotes sem confirmação evita reenvios grandes se a conexão cair.
        while (queue.inFlightBatches < 4) {
            val (seq, items) = queue.nextBatch(MAX_BATCH_ITEMS, MAX_BATCH_CHARS) ?: break
            if (!sock.send(CloudMessages.batchRaw(seq, items))) {
                queue.requeueInFlight()
                break
            }
        }
        _state.update { it.copy(queued = queue.size) }
    }

    private fun sendRaw(text: String) {
        if (welcomed) socket?.send(text)
    }

    private var saveScheduled = false
    private fun scheduleSave() {
        if (saveScheduled) return
        saveScheduled = true
        handler.postDelayed({ saveQueue() }, SAVE_DELAY_MS)
    }

    private fun saveQueue() {
        saveScheduled = false
        try {
            if (queue.dirty) queue.save()
        } catch (e: Exception) {
            debug("Falha ao gravar a fila local")
        }
    }

    private val appPing = object : Runnable {
        override fun run() {
            // "ping" em texto: respondido pela nuvem sem custo e serve de confirmação de presença.
            if (welcomed) socket?.send("ping")
            handler.postDelayed(this, APP_PING_MS)
        }
    }

    // ------------------------------------------------------------------ rotinas periódicas

    private val periodic = object : Runnable {
        override fun run() {
            handler.postDelayed(this, PERIODIC_MS)
            if (!collecting) return
            minutes++
            val install = InstallationStore.current
            if (MiBandManager.state.value.connection == ConnectionState.READY) {
                if (install.hrIntervalMin > 0 && minutes % install.hrIntervalMin == 0) measureHeartRateNow()
                if (minutes % REFRESH_EVERY_MIN == 0) MiBandManager.refreshActivity()
                if (minutes % install.historyIntervalMin.coerceAtLeast(15) == 0) MiBandManager.fetchHistory()
            }
        }
    }

    private fun applyHeartRateMode() {
        val s = MiBandManager.state.value
        if (!collecting || s.connection != ConnectionState.READY) return
        if (InstallationStore.current.hrIntervalMin == 0) {
            if (!s.continuousHeartRate) MiBandManager.setContinuousHeartRate(true)
        } else {
            if (s.continuousHeartRate) MiBandManager.setContinuousHeartRate(false)
            measureHeartRateNow()
        }
    }

    // ------------------------------------------------------------------ observação da pulseira

    private fun observeBand() {
        scope.launch {
            MiBandManager.events.collect { e ->
                if (!collecting) return@collect
                if (e is BandEvent.HeartRate && InstallationStore.current.hrIntervalMin > 0) {
                    if (System.currentTimeMillis() > hrWindowUntil) return@collect
                    hrWindowUntil = 0L
                }
                CloudMessages.fromBandEvent(e).forEach { enqueue(it, urgent = e is BandEvent.Device) }
            }
        }
        scope.launch {
            MiBandManager.state.map { it.connection }.distinctUntilChanged().collect { connection ->
                if (!collecting) return@collect
                enqueue(CloudMessages.state(System.currentTimeMillis(), connection.name, null), urgent = true)
                if (connection == ConnectionState.READY) {
                    handler.postDelayed({ applyHeartRateMode() }, 4_000)
                    handler.postDelayed({ if (collecting) MiBandManager.fetchHistory() }, 10_000)
                }
            }
        }
        scope.launch {
            MiBandManager.state.map { listOf(it.name, it.address, it.firmware, it.hardware, it.serial).joinToString("|") }
                .distinctUntilChanged().collect { key -> if (welcomed && key != lastHelloKey) sendHello() }
        }
    }

    private fun debug(text: String) {
        if (BuildConfig.DEBUG) Log.d(TAG, text)
    }
}
