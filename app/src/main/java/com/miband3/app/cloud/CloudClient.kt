package com.miband3.app.cloud

import android.content.Context
import android.content.SharedPreferences
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
import com.miband3.app.service.MiBandService
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
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.random.Random

enum class CloudStatus(val label: String) {
    DISABLED("Desativada"),
    CONNECTING("Conectando…"),
    ONLINE("Conectada"),
    ERROR("Erro"),
}

data class CloudState(
    val status: CloudStatus = CloudStatus.DISABLED,
    val detail: String? = null,
    /** Itens aguardando envio (acumulam quando o celular está sem internet). */
    val queued: Int = 0,
    val lastSentMs: Long? = null,
    val commandsHandled: Int = 0,
)

/**
 * Mantém um WebSocket com o serviço na nuvem: envia tudo que a pulseira produz
 * (FC, passos, bateria, eventos, histórico de sono/atividade) e executa os comandos
 * recebidos (vibrar, mensagem, medir FC…), confirmando cada um.
 *
 * - Reconecta sozinho (backoff exponencial) e quando a rede volta.
 * - Sem conexão, guarda até [MAX_PENDING] itens em memória e envia em lote depois.
 *   Se o app for encerrado, o que não foi enviado se perde, mas o histórico por minuto
 *   é baixado de novo da pulseira ([MiBandManager.fetchHistory]).
 * - Todo o estado é acessado só na thread principal.
 */
object CloudClient {
    private const val TAG = "CloudClient"
    private const val PREFS = "cloud"
    private const val MAX_PENDING = 20_000
    private const val MAX_BATCH_ITEMS = 200
    private const val MAX_BATCH_CHARS = 200_000
    private const val FLUSH_DELAY_MS = 500L
    private const val APP_PING_MS = 25_000L
    private const val PERIODIC_MS = 60_000L
    private const val REFRESH_EVERY_TICKS = 5
    private const val HISTORY_EVERY_TICKS = 30
    private const val MAX_REMEMBERED_COMMANDS = 200

    private lateinit var appContext: Context
    private lateinit var prefs: SharedPreferences
    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS) // detecta conexão morta do lado do app
        .build()

    private val _config = MutableStateFlow(CloudConfig())
    val config: StateFlow<CloudConfig> = _config.asStateFlow()

    private val _state = MutableStateFlow(CloudState())
    val state: StateFlow<CloudState> = _state.asStateFlow()

    private var socket: WebSocket? = null
    private var generation = 0
    private var welcomed = false
    private var attempt = 0
    private var fatalError = false
    private var ticks = 0
    private val pending = ArrayDeque<JSONObject>()
    private var lastHelloKey: String? = null

    /** Resultado dos últimos comandos, para responder de novo sem executar duas vezes se o servidor reenviar. */
    private val handled = LinkedHashMap<String, JSONObject>()

    val isUsable: Boolean get() = ::appContext.isInitialized && _config.value.isUsable

    fun init(context: Context) {
        if (::appContext.isInitialized) return
        appContext = context.applicationContext
        prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        _config.value = CloudConfig.load(prefs)
        observeBand()
        registerNetworkCallback()
        applyConfig()
    }

    fun updateConfig(newConfig: CloudConfig) {
        val old = _config.value
        _config.value = newConfig
        newConfig.save(prefs)
        if (old.serverUrl != newConfig.serverUrl || old.deviceToken != newConfig.deviceToken || old.enabled != newConfig.enabled) {
            attempt = 0
            fatalError = false
            closeSocket("configuração alterada")
            lastHelloKey = null
        }
        applyConfig()
    }

    /** Baixa agora o histórico por minuto da pulseira (sono/atividade) e envia à nuvem. */
    fun syncHistoryNow() {
        MiBandManager.fetchHistory()
    }

    // ------------------------------------------------------------------ ciclo de vida

    private fun applyConfig() {
        val cfg = _config.value
        if (!cfg.isUsable) {
            handler.removeCallbacksAndMessages(null)
            flushScheduled = false
            pending.clear()
            _state.value = CloudState(status = CloudStatus.DISABLED, detail = if (cfg.enabled) "Informe o endereço e o token." else null)
            return
        }
        // Mantém o app vivo em segundo plano e tenta reconectar a pulseira após o processo ser recriado.
        try {
            MiBandService.start(appContext)
        } catch (e: Exception) {
            Log.w(TAG, "Não foi possível iniciar o serviço em primeiro plano", e)
        }
        MiBandManager.reconnectIfSaved()
        if (socket == null && !fatalError) connect()
        handler.removeCallbacks(periodic)
        handler.postDelayed(periodic, PERIODIC_MS)
    }

    private fun connect() {
        val cfg = _config.value
        val url = cfg.wsUrl() ?: return
        val gen = ++generation
        welcomed = false
        _state.update { it.copy(status = CloudStatus.CONNECTING, detail = null, queued = pending.size) }
        val request = try {
            Request.Builder().url(url.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://"))
                .header("Authorization", "Bearer ${cfg.deviceToken}")
                .build()
        } catch (e: IllegalArgumentException) {
            fail("Endereço inválido: ${e.message}")
            return
        }
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                handler.post { if (gen == generation) onText(text) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handler.post { if (gen == generation) onDisconnected(code, reason, null) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val code = response?.code
                handler.post { if (gen == generation) onDisconnected(null, t.message, code) }
            }
        })
    }

    private fun closeSocket(reason: String) {
        generation++ // ignora callbacks do socket antigo
        welcomed = false
        handler.removeCallbacks(appPing)
        handler.removeCallbacks(flushRunnable)
        flushScheduled = false
        handler.removeCallbacks(reconnectRunnable)
        socket?.close(1000, reason)
        socket = null
    }

    private fun onDisconnected(code: Int?, reason: String?, httpStatus: Int?) {
        socket = null
        welcomed = false
        handler.removeCallbacks(appPing)
        handler.removeCallbacks(flushRunnable)
        flushScheduled = false
        when {
            httpStatus == 401 || code == 4001 -> {
                fail(if (code == 4001) "Token revogado no servidor. Gere um novo token." else "Token do dispositivo inválido (401).")
                return
            }
            code == 4000 -> Log.i(TAG, "Substituída por outra conexão do mesmo token")
        }
        if (!_config.value.isUsable) return
        val delayMs = minOf(60_000L, 1_000L shl minOf(attempt, 6)) + Random.nextLong(0, 1_000)
        attempt++
        _state.update { it.copy(status = CloudStatus.CONNECTING, detail = "Sem conexão (${reason ?: httpStatus ?: code ?: "?"}); tentando em ${delayMs / 1000}s") }
        handler.postDelayed(reconnectRunnable, delayMs)
    }

    private fun fail(message: String) {
        fatalError = true
        socket = null
        _state.update { it.copy(status = CloudStatus.ERROR, detail = message) }
    }

    private val reconnectRunnable = Runnable { if (socket == null && _config.value.isUsable && !fatalError) connect() }

    private fun registerNetworkCallback() {
        val cm = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    // Rede voltou: não espera o backoff.
                    handler.post {
                        if (socket == null && _config.value.isUsable && !fatalError) {
                            handler.removeCallbacks(reconnectRunnable)
                            attempt = 0
                            connect()
                        }
                    }
                }
            })
        } catch (e: Exception) {
            Log.w(TAG, "Sem monitor de rede", e)
        }
    }

    // ------------------------------------------------------------------ mensagens do servidor

    private fun onText(text: String) {
        if (text == "pong") return
        val json = try { JSONObject(text) } catch (e: Exception) { return }
        when (json.optString("t")) {
            "welcome" -> onWelcome()
            "command" -> CloudMessages.parseCommand(text)?.let(::onCommand)
            "error" -> Log.w(TAG, "Servidor recusou uma mensagem: $text")
        }
    }

    private fun onWelcome() {
        welcomed = true
        attempt = 0
        _state.update { it.copy(status = CloudStatus.ONLINE, detail = null) }
        sendHello()
        enqueueSnapshot()
        flush()
        handler.removeCallbacks(appPing)
        handler.postDelayed(appPing, APP_PING_MS)
    }

    private fun onCommand(cmd: CloudCommand) {
        handled[cmd.id]?.let { // reenvio do servidor: repete a resposta sem executar de novo
            sendRaw(it.toString())
            return
        }
        CommandExecutor.execute(cmd) { result ->
            handler.post {
                val ack = CloudMessages.ack(cmd.id, result.ok, result.error, result.info)
                handled[cmd.id] = ack
                if (handled.size > MAX_REMEMBERED_COMMANDS) handled.remove(handled.keys.first())
                _state.update { it.copy(commandsHandled = it.commandsHandled + 1) }
                sendRaw(ack.toString())
            }
        }
    }

    // ------------------------------------------------------------------ envio

    private fun sendHello() {
        val b = MiBandManager.state.value
        lastHelloKey = listOf(b.name, b.address, b.firmware, b.hardware, b.serial).joinToString("|")
        val hello = CloudMessages.hello(BuildConfig.VERSION_NAME, "Android ${Build.VERSION.RELEASE}", "${Build.MANUFACTURER} ${Build.MODEL}", b.name, b.address, b.firmware, b.hardware, b.serial)
        sendRaw(hello.toString())
    }

    private fun enqueueSnapshot() {
        val now = System.currentTimeMillis()
        val b = MiBandManager.state.value
        enqueue(CloudMessages.state(now, b.connection.name, b.lastError))
        b.battery?.let { enqueue(CloudMessages.battery(now, it, b.charging)) }
        b.steps?.let { enqueue(CloudMessages.steps(now, it, b.meters, b.calories)) }
    }

    fun enqueue(item: JSONObject, urgent: Boolean = false) {
        if (!_config.value.isUsable) return
        if (pending.size >= MAX_PENDING) pending.removeFirst() // descarta o mais antigo
        pending.addLast(item)
        _state.update { it.copy(queued = pending.size) }
        if (!welcomed) return
        if (urgent) {
            flush()
        } else if (!flushScheduled) {
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
        while (pending.isNotEmpty()) {
            val chunk = ArrayList<JSONObject>()
            var chars = 0
            while (pending.isNotEmpty() && chunk.size < MAX_BATCH_ITEMS && chars < MAX_BATCH_CHARS) {
                val item = pending.removeFirst()
                chars += item.toString().length
                chunk.add(item)
            }
            if (!sock.send(CloudMessages.batch(chunk).toString())) {
                chunk.asReversed().forEach { pending.addFirst(it) } // devolve à fila
                break
            }
            _state.update { it.copy(lastSentMs = System.currentTimeMillis()) }
        }
        _state.update { it.copy(queued = pending.size) }
    }

    private fun sendRaw(text: String) {
        if (welcomed) socket?.send(text)
    }

    private val appPing = object : Runnable {
        override fun run() {
            // "ping" em texto é respondido pelo Durable Object sem acordá-lo e serve de sinal de vida.
            if (welcomed) socket?.send("ping")
            handler.postDelayed(this, APP_PING_MS)
        }
    }

    // ------------------------------------------------------------------ rotinas periódicas

    /** A cada minuto: atualiza bateria/passos (a cada 5 min) e baixa o histórico (a cada 30 min). */
    private val periodic = object : Runnable {
        override fun run() {
            if (!_config.value.isUsable) return
            ticks++
            if (MiBandManager.state.value.connection == ConnectionState.READY) {
                if (ticks % REFRESH_EVERY_TICKS == 0) MiBandManager.refreshActivity()
                if (ticks % HISTORY_EVERY_TICKS == 0) MiBandManager.fetchHistory()
            }
            handler.postDelayed(this, PERIODIC_MS)
        }
    }

    // ------------------------------------------------------------------ observação da pulseira

    private fun observeBand() {
        scope.launch {
            MiBandManager.events.collect { e ->
                if (!_config.value.isUsable) return@collect
                CloudMessages.fromBandEvent(e).forEach { enqueue(it, urgent = e is BandEvent.Device) }
            }
        }
        scope.launch {
            MiBandManager.state.map { it.connection }.distinctUntilChanged().collect { connection ->
                if (!_config.value.isUsable) return@collect
                val b = MiBandManager.state.value
                enqueue(CloudMessages.state(System.currentTimeMillis(), connection.name, b.lastError), urgent = true)
                if (connection == ConnectionState.READY) onBandReady()
            }
        }
        scope.launch {
            // Firmware/serial chegam depois de a pulseira ficar pronta: reenvia o "hello" com os dados completos.
            MiBandManager.state.map { listOf(it.name, it.address, it.firmware, it.hardware, it.serial).joinToString("|") }
                .distinctUntilChanged().collect { key ->
                    if (welcomed && key != lastHelloKey) sendHello()
                }
        }
    }

    private fun onBandReady() {
        if (!_config.value.autoHeartRate) return
        handler.postDelayed({
            val s = MiBandManager.state.value
            if (_config.value.isUsable && s.connection == ConnectionState.READY && !s.continuousHeartRate) {
                MiBandManager.setContinuousHeartRate(true)
            }
        }, 4_000)
        // Recupera o que a pulseira gravou enquanto o celular estava longe.
        handler.postDelayed({ if (_config.value.isUsable) MiBandManager.fetchHistory() }, 10_000)
    }
}
