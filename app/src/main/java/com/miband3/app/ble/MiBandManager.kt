package com.miband3.app.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.SharedPreferences
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.miband3.app.ble.MiBandProtocol.AlertCategory
import com.miband3.app.ble.MiBandProtocol.AuthResponse
import com.miband3.app.ble.MiBandProtocol.DeviceEvent
import com.miband3.app.ble.MiBandProtocol.toHex
import com.miband3.app.service.MiBandService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.security.SecureRandom
import java.util.Calendar
import java.util.UUID

enum class ConnectionState(val label: String) {
    DISCONNECTED("Desconectada"),
    CONNECTING("Conectando…"),
    DISCOVERING("Descobrindo serviços…"),
    AUTHENTICATING("Autenticando…"),
    READY("Conectada"),
}

data class BandState(
    val connection: ConnectionState = ConnectionState.DISCONNECTED,
    val address: String? = null,
    val name: String? = null,
    val battery: Int? = null,
    val charging: Boolean = false,
    val steps: Int? = null,
    val meters: Int? = null,
    val calories: Int? = null,
    val heartRate: Int? = null,
    val measuringHeartRate: Boolean = false,
    val continuousHeartRate: Boolean = false,
    val firmware: String? = null,
    val hardware: String? = null,
    val serial: String? = null,
    val awaitingTap: Boolean = false,
    val findingPhone: Boolean = false,
    /** Motivo da última falha de conexão, com dica de como resolver. */
    val lastError: String? = null,
)

data class ScannedDevice(val address: String, val name: String?, val rssi: Int) {
    val looksLikeMiBand: Boolean
        get() = name?.contains("band", ignoreCase = true) == true
}

data class LogEntry(val time: Long, val text: String, val fromBand: Boolean)

data class BandSettings(
    val time24h: Boolean = true,
    val liftWrist: Boolean = true,
    val forwardNotifications: Boolean = false,
)

data class AlarmConfig(
    val slot: Int,
    val enabled: Boolean = false,
    val hour: Int = 7,
    val minute: Int = 0,
    val days: Int = MiBandProtocol.Days.EVERY_DAY,
)

enum class MessageType(val label: String) { SMS("SMS"), APP("Aplicativo"), CALL("Chamada"), EMAIL("E-mail") }

/**
 * Ponto central do app: varredura BLE, conexão, autenticação e comandos para a Mi Band 3.
 * Toda a lógica BLE roda na thread principal (via [handler]) para evitar condições de corrida.
 */
@SuppressLint("MissingPermission")
object MiBandManager {
    private const val TAG = "MiBandManager"
    private const val PREFS = "miband"
    private const val KEY_AUTH = "auth_key"
    private const val KEY_ADDRESS = "address"
    private const val KEY_NAME = "name"
    private const val SCAN_DURATION_MS = 15_000L
    private const val RECONNECT_DELAY_MS = 5_000L
    private const val DISCOVERY_TIMEOUT_MS = 15_000L
    private const val MAX_FAILED_ATTEMPTS = 4
    private const val HR_PING_INTERVAL_MS = 12_000L
    private const val MAX_LOG = 200
    const val ALARM_SLOTS = 3

    private lateinit var appContext: Context
    private lateinit var prefs: SharedPreferences
    private val handler = Handler(Looper.getMainLooper())
    private val gattQueue = GattQueue(handler) { log(it, fromBand = false) }

    private val _state = MutableStateFlow(BandState())
    val state: StateFlow<BandState> = _state.asStateFlow()

    private val _scanResults = MutableStateFlow<List<ScannedDevice>>(emptyList())
    val scanResults: StateFlow<List<ScannedDevice>> = _scanResults.asStateFlow()

    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning.asStateFlow()

    private val _log = MutableStateFlow<List<LogEntry>>(emptyList())
    val log: StateFlow<List<LogEntry>> = _log.asStateFlow()

    private val _settings = MutableStateFlow(BandSettings())
    val settings: StateFlow<BandSettings> = _settings.asStateFlow()

    private val _alarms = MutableStateFlow<List<AlarmConfig>>(emptyList())
    val alarms: StateFlow<List<AlarmConfig>> = _alarms.asStateFlow()

    private var gatt: BluetoothGatt? = null
    private var userWantsConnection = false
    private var triedSendingKey = false

    /** Tentativas seguidas que caíram antes de a pulseira ficar pronta. */
    private var failedAttempts = 0
    private var ringtone: Ringtone? = null

    private val bluetoothAdapter: BluetoothAdapter?
        get() = (appContext.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter

    val isBluetoothEnabled: Boolean
        get() = bluetoothAdapter?.isEnabled == true

    val savedAddress: String?
        get() = prefs.getString(KEY_ADDRESS, null)

    fun init(context: Context) {
        if (::appContext.isInitialized) return
        appContext = context.applicationContext
        prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        _settings.value = BandSettings(
            time24h = prefs.getBoolean("time24h", true),
            liftWrist = prefs.getBoolean("liftWrist", true),
            forwardNotifications = prefs.getBoolean("forwardNotifications", false),
        )
        _alarms.value = (0 until ALARM_SLOTS).map { loadAlarm(it) }
        _state.update { it.copy(address = savedAddress, name = prefs.getString(KEY_NAME, null)) }
    }

    // =================================================================== varredura

    private var scanCallback: ScanCallback? = null
    private val stopScanRunnable = Runnable { stopScan() }

    fun startScan() {
        val scanner = bluetoothAdapter?.bluetoothLeScanner ?: run {
            log("Bluetooth indisponível", fromBand = false)
            return
        }
        stopScan()
        _scanResults.value = emptyList()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val name = result.scanRecord?.deviceName ?: result.device.name
                val device = ScannedDevice(result.device.address, name, result.rssi)
                _scanResults.update { list ->
                    (list.filterNot { it.address == device.address } + device)
                        .sortedWith(compareByDescending<ScannedDevice> { it.looksLikeMiBand }.thenByDescending { it.rssi })
                }
            }

            override fun onScanFailed(errorCode: Int) {
                log("Falha na varredura (código $errorCode)", fromBand = false)
                _scanning.value = false
            }
        }
        scanCallback = callback
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(null, settings, callback)
        _scanning.value = true
        handler.postDelayed(stopScanRunnable, SCAN_DURATION_MS)
    }

    fun stopScan() {
        handler.removeCallbacks(stopScanRunnable)
        scanCallback?.let { cb ->
            try {
                bluetoothAdapter?.bluetoothLeScanner?.stopScan(cb)
            } catch (e: Exception) {
                Log.w(TAG, "stopScan", e)
            }
        }
        scanCallback = null
        _scanning.value = false
    }

    // =================================================================== conexão

    fun connect(address: String, name: String? = null) {
        stopScan()
        if (address != savedAddress) {
            prefs.edit().putString(KEY_ADDRESS, address).putString(KEY_NAME, name).apply()
        }
        userWantsConnection = true
        failedAttempts = 0
        _state.update { it.copy(lastError = null) }
        MiBandService.start(appContext)
        handler.post { connectInternal(address) }
    }

    fun connectSaved() {
        savedAddress?.let { connect(it, prefs.getString(KEY_NAME, null)) }
    }

    private fun connectInternal(address: String) {
        handler.removeCallbacks(reconnectRunnable)
        closeGatt()
        val adapter = bluetoothAdapter ?: return
        val device: BluetoothDevice = try {
            adapter.getRemoteDevice(address)
        } catch (e: IllegalArgumentException) {
            log("Endereço inválido: $address", fromBand = false)
            return
        }
        triedSendingKey = false
        _state.update {
            it.copy(
                connection = ConnectionState.CONNECTING,
                address = address,
                name = prefs.getString(KEY_NAME, null) ?: device.name,
            )
        }
        val attempt = if (failedAttempts > 0) " (tentativa ${failedAttempts + 1} de $MAX_FAILED_ATTEMPTS)" else ""
        log("Conectando a $address…$attempt", fromBand = false)
        gatt = device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        gattQueue.gatt = gatt
    }

    private fun isBondedInAndroid(): Boolean {
        val address = _state.value.address ?: return false
        return try {
            bluetoothAdapter?.getRemoteDevice(address)?.bondState == BluetoothDevice.BOND_BONDED
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Limpa o cache de serviços GATT do Android (API oculta, usada por várias bibliotecas BLE).
     * Ajuda quando o cache ficou inconsistente depois de um reset da pulseira.
     */
    private fun refreshGattCache(g: BluetoothGatt) {
        try {
            g.javaClass.getMethod("refresh").invoke(g)
        } catch (e: Exception) {
            Log.w(TAG, "refresh() indisponível", e)
        }
    }

    private val discoveryTimeout = Runnable {
        log("A pulseira não respondeu à descoberta de serviços", fromBand = false)
        gatt?.let {
            refreshGattCache(it)
            it.disconnect()
        }
    }

    private fun explainStatus(status: Int, bonded: Boolean): String {
        val reason = when (status) {
            8 -> "Tempo esgotado: a pulseira parou de responder (distância ou interferência)."
            19 -> "A pulseira encerrou a conexão. Normalmente isso acontece quando ela ainda está " +
                "vinculada ao Mi Fit / Zepp Life (neste ou em outro celular) ou quando outro app está conectado a ela."
            5, 15, 22, 137 -> "Falha de segurança no link Bluetooth: o celular e a pulseira não concordam sobre o pareamento."
            62, 133, 257 -> "Erro genérico do Bluetooth do Android ao falar com a pulseira."
            else -> "Conexão perdida (código $status)."
        }
        val tips = buildList {
            if (bonded) {
                add("Este celular tem um pareamento Bluetooth antigo com a pulseira: abra as configurações de Bluetooth, " +
                    "toque na engrenagem da Mi Band 3 e escolha \"Desparear\" / \"Esquecer\".")
            }
            add("Feche (forçar parada) o Zepp Life / Mi Fit e desligue o Bluetooth de outros celulares que já usaram a pulseira.")
            add("Se nada resolver, reinicie a pulseira de fábrica (Mais > Configurações > Restaurar) e pareie de novo.")
        }
        return reason + "\n\n" + tips.joinToString("\n") { "• $it" }
    }

    fun disconnect() {
        userWantsConnection = false
        handler.post {
            handler.removeCallbacks(reconnectRunnable)
            stopHeartRatePing()
            closeGatt()
            _state.update { it.copy(connection = ConnectionState.DISCONNECTED, measuringHeartRate = false, continuousHeartRate = false) }
            log("Desconectado", fromBand = false)
            MiBandService.stop(appContext)
        }
    }

    /** Remove a pulseira salva. Na próxima conexão uma nova chave será gravada. */
    fun forget() {
        val address = savedAddress
        disconnect()
        prefs.edit().apply {
            remove(KEY_ADDRESS)
            remove(KEY_NAME)
            if (address != null) remove(authorizedKey(address))
        }.apply()
        _state.value = BandState()
    }

    private fun closeGatt() {
        gattQueue.clear()
        gatt?.let {
            try {
                it.disconnect()
                it.close()
            } catch (e: Exception) {
                Log.w(TAG, "closeGatt", e)
            }
        }
        gatt = null
        gattQueue.gatt = null
    }

    private val reconnectRunnable = Runnable {
        val address = savedAddress
        if (userWantsConnection && address != null && _state.value.connection == ConnectionState.DISCONNECTED) {
            connectInternal(address)
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (g != gatt) return@post
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        _state.update { it.copy(connection = ConnectionState.DISCOVERING) }
                        g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                        // Com pareamento no Android, a criptografia do link precisa terminar
                        // antes da descoberta; sem ele, uma pequena espera já ajuda.
                        val delay = if (isBondedInAndroid()) 1_600L else 600L
                        if (failedAttempts >= 2) refreshGattCache(g)
                        handler.postDelayed({
                            if (g == gatt) {
                                if (!g.discoverServices()) log("Não foi possível iniciar a descoberta de serviços", fromBand = false)
                                handler.postDelayed(discoveryTimeout, DISCOVERY_TIMEOUT_MS)
                            }
                        }, delay)
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        handler.removeCallbacks(discoveryTimeout)
                        val wasReady = _state.value.connection == ConnectionState.READY
                        stopHeartRatePing()
                        closeGatt()
                        _state.update {
                            it.copy(
                                connection = ConnectionState.DISCONNECTED,
                                measuringHeartRate = false,
                                continuousHeartRate = false,
                                awaitingTap = false,
                            )
                        }
                        log("Conexão perdida (código $status)", fromBand = false)
                        if (!userWantsConnection) return@post
                        if (wasReady) {
                            failedAttempts = 0
                        } else {
                            failedAttempts++
                        }
                        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
                            val explanation = explainStatus(status, isBondedInAndroid())
                            log("Não foi possível conectar após $MAX_FAILED_ATTEMPTS tentativas. $explanation", fromBand = false)
                            userWantsConnection = false
                            _state.update { it.copy(lastError = explanation) }
                            MiBandService.stop(appContext)
                        } else {
                            log("Tentando reconectar em ${RECONNECT_DELAY_MS / 1000}s…", fromBand = false)
                            handler.postDelayed(reconnectRunnable, RECONNECT_DELAY_MS)
                        }
                    }
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            handler.post {
                if (g != gatt) return@post
                handler.removeCallbacks(discoveryTimeout)
                if (status != BluetoothGatt.GATT_SUCCESS || g.services.isNullOrEmpty()) {
                    log("Falha ao descobrir serviços (código $status)", fromBand = false)
                    refreshGattCache(g)
                    g.disconnect()
                    return@post
                }
                log("${g.services.size} serviços encontrados", fromBand = false)
                startAuthentication()
            }
        }

        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
            val copy = value.copyOf()
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS) handleData(ch.uuid, copy)
                gattQueue.completeCurrent()
            }
        }

        @Deprecated("Usado até o Android 12")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            val copy = ch.value?.copyOf() ?: ByteArray(0)
            handler.post {
                if (status == BluetoothGatt.GATT_SUCCESS) handleData(ch.uuid, copy)
                gattQueue.completeCurrent()
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            handler.post {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    log("Falha na escrita em ${ch.uuid} ($status)", fromBand = false)
                }
                gattQueue.completeCurrent()
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            handler.post { gattQueue.completeCurrent() }
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic, value: ByteArray) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
            val copy = value.copyOf()
            handler.post { handleData(ch.uuid, copy) }
        }

        @Deprecated("Usado até o Android 12")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            val copy = ch.value?.copyOf() ?: return
            handler.post { handleData(ch.uuid, copy) }
        }
    }

    // =================================================================== autenticação

    private fun authorizedKey(address: String) = "authorized_$address"

    private fun authKey(): ByteArray {
        prefs.getString(KEY_AUTH, null)?.let { return MiBandProtocol.hexToBytes(it) }
        val key = ByteArray(16).also { SecureRandom().nextBytes(it) }
        prefs.edit().putString(KEY_AUTH, key.toHex()).apply()
        return key
    }

    private fun isAuthorized(): Boolean =
        _state.value.address?.let { prefs.getBoolean(authorizedKey(it), false) } == true

    private fun setAuthorized(value: Boolean) {
        _state.value.address?.let { prefs.edit().putBoolean(authorizedKey(it), value).apply() }
    }

    private fun startAuthentication() {
        _state.update { it.copy(connection = ConnectionState.AUTHENTICATING) }
        if (gattQueue.findCharacteristic(MiBandUuids.CHAR_AUTH) == null) {
            log("Este dispositivo não parece ser uma Mi Band 3 (sem serviço de autenticação)", fromBand = false)
            gatt?.disconnect()
            return
        }
        gattQueue.enqueue(GattQueue.Op.Notify(MiBandUuids.CHAR_AUTH))
        if (isAuthorized()) {
            log("Autenticando com a chave salva…", fromBand = false)
            gattQueue.enqueue(GattQueue.Op.Write(MiBandUuids.CHAR_AUTH, MiBandProtocol.authRequestRandom(), noResponse = true))
        } else {
            sendAuthKey()
        }
    }

    private fun sendAuthKey() {
        triedSendingKey = true
        _state.update { it.copy(awaitingTap = true) }
        log("Pareando: toque na tela da pulseira quando ela vibrar para confirmar.", fromBand = false)
        gattQueue.enqueue(GattQueue.Op.Write(MiBandUuids.CHAR_AUTH, MiBandProtocol.authSendKey(authKey()), noResponse = true))
    }

    private fun handleAuth(data: ByteArray) {
        when (val response = MiBandProtocol.parseAuthResponse(data)) {
            AuthResponse.KeyAccepted -> {
                _state.update { it.copy(awaitingTap = false) }
                setAuthorized(true)
                log("Chave aceita pela pulseira", fromBand = true)
                gattQueue.enqueue(GattQueue.Op.Write(MiBandUuids.CHAR_AUTH, MiBandProtocol.authRequestRandom(), noResponse = true))
            }
            AuthResponse.KeyRejected -> {
                _state.update { it.copy(awaitingTap = false) }
                log("A pulseira recusou a chave. Reinicie a pulseira ou desvincule-a do Mi Fit.", fromBand = true)
                userWantsConnection = false
                gatt?.disconnect()
            }
            is AuthResponse.RandomReceived -> {
                val payload = MiBandProtocol.authSendEncrypted(response.random, authKey())
                gattQueue.enqueue(GattQueue.Op.Write(MiBandUuids.CHAR_AUTH, payload, noResponse = true))
            }
            AuthResponse.RandomFailed, AuthResponse.AuthFailed -> {
                setAuthorized(false)
                if (!triedSendingKey) {
                    log("Chave salva inválida, pareando novamente…", fromBand = false)
                    sendAuthKey()
                } else {
                    log("Falha na autenticação", fromBand = true)
                    userWantsConnection = false
                    gatt?.disconnect()
                }
            }
            AuthResponse.Authenticated -> onAuthenticated()
            null -> Log.d(TAG, "Resposta de autenticação desconhecida: ${data.toHex()}")
        }
    }

    private fun onAuthenticated() {
        failedAttempts = 0
        _state.update { it.copy(connection = ConnectionState.READY, awaitingTap = false, lastError = null) }
        log("Autenticado! Pulseira pronta.", fromBand = true)
        val q = gattQueue
        listOf(
            MiBandUuids.CHAR_DEVICE_EVENT,
            MiBandUuids.CHAR_CONFIG,
            MiBandUuids.CHAR_STEPS,
            MiBandUuids.CHAR_BATTERY,
            MiBandUuids.CHAR_HR_MEASUREMENT,
        ).forEach { q.enqueue(GattQueue.Op.Notify(it)) }
        syncTime()
        applySettings()
        listOf(
            MiBandUuids.CHAR_BATTERY,
            MiBandUuids.CHAR_STEPS,
            MiBandUuids.CHAR_FIRMWARE,
            MiBandUuids.CHAR_HARDWARE,
            MiBandUuids.CHAR_SERIAL,
        ).forEach { q.enqueue(GattQueue.Op.Read(it)) }
    }

    // =================================================================== dados recebidos

    private fun handleData(uuid: UUID, data: ByteArray) {
        when (uuid) {
            MiBandUuids.CHAR_AUTH -> handleAuth(data)
            MiBandUuids.CHAR_BATTERY -> MiBandProtocol.parseBattery(data)?.let { b ->
                _state.update { it.copy(battery = b.level, charging = b.charging) }
            }
            MiBandUuids.CHAR_STEPS -> MiBandProtocol.parseSteps(data)?.let { a ->
                _state.update { it.copy(steps = a.steps, meters = a.meters ?: it.meters, calories = a.calories ?: it.calories) }
            }
            MiBandUuids.CHAR_HR_MEASUREMENT -> MiBandProtocol.parseHeartRate(data)?.let { bpm ->
                if (bpm > 0) log("Frequência cardíaca: $bpm bpm", fromBand = true)
                _state.update {
                    it.copy(heartRate = if (bpm > 0) bpm else it.heartRate, measuringHeartRate = it.continuousHeartRate)
                }
            }
            MiBandUuids.CHAR_DEVICE_EVENT -> handleDeviceEvent(data)
            MiBandUuids.CHAR_FIRMWARE -> _state.update { it.copy(firmware = data.decodeToString().trim('\u0000')) }
            MiBandUuids.CHAR_HARDWARE -> _state.update { it.copy(hardware = data.decodeToString().trim('\u0000')) }
            MiBandUuids.CHAR_SERIAL -> _state.update { it.copy(serial = data.decodeToString().trim('\u0000')) }
            MiBandUuids.CHAR_CONFIG -> Log.d(TAG, "Resposta de configuração: ${data.toHex()}")
            else -> Log.d(TAG, "Dados de $uuid: ${data.toHex()}")
        }
    }

    private fun handleDeviceEvent(data: ByteArray) {
        val event = DeviceEvent.fromData(data)
        if (event == null) {
            log("Evento desconhecido: ${data.toHex()}", fromBand = true)
            return
        }
        when (event) {
            DeviceEvent.FIND_PHONE_START -> startFindPhone()
            DeviceEvent.FIND_PHONE_STOP -> stopFindPhone()
            DeviceEvent.TICK_30MIN -> return // muito frequente para o histórico
            else -> Unit
        }
        log(event.description, fromBand = true)
    }

    // =================================================================== procurar celular

    private fun startFindPhone() {
        _state.update { it.copy(findingPhone = true) }
        if (ringtone?.isPlaying == true) return
        val uri = RingtoneManager.getActualDefaultRingtoneUri(appContext, RingtoneManager.TYPE_RINGTONE)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        ringtone = RingtoneManager.getRingtone(appContext, uri)?.also {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) it.isLooping = true
            it.play()
        }
    }

    fun stopFindPhone() {
        ringtone?.stop()
        ringtone = null
        _state.update { it.copy(findingPhone = false) }
    }

    // =================================================================== comandos

    private val isReady: Boolean
        get() = _state.value.connection == ConnectionState.READY

    private fun requireReady(): Boolean {
        if (!isReady) log("A pulseira não está conectada", fromBand = false)
        return isReady
    }

    private fun write(uuid: UUID, value: ByteArray, noResponse: Boolean = false) {
        handler.post { gattQueue.enqueue(GattQueue.Op.Write(uuid, value, noResponse)) }
    }

    private fun read(uuid: UUID) {
        handler.post { gattQueue.enqueue(GattQueue.Op.Read(uuid)) }
    }

    fun vibrate() {
        if (!requireReady()) return
        write(MiBandUuids.CHAR_ALERT_LEVEL, byteArrayOf(MiBandProtocol.AlertLevel.HIGH), noResponse = true)
        log("Vibrar", fromBand = false)
    }

    fun sendMessage(type: MessageType, title: String, body: String) {
        if (!requireReady()) return
        val payload = when (type) {
            MessageType.SMS -> MiBandProtocol.newAlert(AlertCategory.SMS, title, body)
            MessageType.EMAIL -> MiBandProtocol.newAlert(AlertCategory.EMAIL, title, body)
            MessageType.CALL -> MiBandProtocol.newAlert(AlertCategory.INCOMING_CALL, title)
            MessageType.APP -> MiBandProtocol.newAlert(AlertCategory.CUSTOM_HUAMI, title, body, MiBandProtocol.Icon.APP)
        }
        write(MiBandUuids.CHAR_NEW_ALERT, payload)
        val summary = if (body.isBlank()) title else "$title: $body"
        log("[${type.label}] $summary", fromBand = false)
    }

    fun stopCall() {
        if (!requireReady()) return
        write(MiBandUuids.CHAR_NEW_ALERT, MiBandProtocol.stopCallAlert())
        write(MiBandUuids.CHAR_ALERT_LEVEL, byteArrayOf(MiBandProtocol.AlertLevel.NONE), noResponse = true)
        log("Chamada encerrada", fromBand = false)
    }

    /** Usado pelo [com.miband3.app.service.NotificationForwarder]. */
    fun forwardNotification(appName: String, icon: Int, title: String, body: String, isCall: Boolean) {
        if (!isReady) return
        val payload = if (isCall) {
            MiBandProtocol.newAlert(AlertCategory.INCOMING_CALL, title.ifBlank { appName })
        } else {
            val heading = title.ifBlank { appName }
            MiBandProtocol.newAlert(AlertCategory.CUSTOM_HUAMI, heading, body, icon)
        }
        write(MiBandUuids.CHAR_NEW_ALERT, payload)
        log("Notificação de $appName: ${title.ifBlank { body }}", fromBand = false)
    }

    fun refreshActivity() {
        if (!requireReady()) return
        read(MiBandUuids.CHAR_STEPS)
        read(MiBandUuids.CHAR_BATTERY)
    }

    fun measureHeartRate() {
        if (!requireReady()) return
        _state.update { it.copy(measuringHeartRate = true) }
        write(MiBandUuids.CHAR_HR_CONTROL, MiBandProtocol.HR_STOP_CONTINUOUS)
        write(MiBandUuids.CHAR_HR_CONTROL, MiBandProtocol.HR_STOP_MANUAL)
        write(MiBandUuids.CHAR_HR_CONTROL, MiBandProtocol.HR_START_MANUAL)
        log("Medindo frequência cardíaca… mantenha a pulseira firme no pulso", fromBand = false)
        // A pulseira responde em ~15-20 s; o indicador some se nada chegar.
        handler.postDelayed({
            if (!_state.value.continuousHeartRate) _state.update { it.copy(measuringHeartRate = false) }
        }, 30_000)
    }

    fun setContinuousHeartRate(enabled: Boolean) {
        if (!requireReady()) return
        _state.update { it.copy(continuousHeartRate = enabled, measuringHeartRate = enabled) }
        if (enabled) {
            write(MiBandUuids.CHAR_HR_CONTROL, MiBandProtocol.HR_STOP_MANUAL)
            write(MiBandUuids.CHAR_HR_CONTROL, MiBandProtocol.HR_START_CONTINUOUS)
            handler.postDelayed(hrPingRunnable, HR_PING_INTERVAL_MS)
            log("Monitoramento cardíaco contínuo ativado", fromBand = false)
        } else {
            stopHeartRatePing()
            write(MiBandUuids.CHAR_HR_CONTROL, MiBandProtocol.HR_STOP_CONTINUOUS)
            log("Monitoramento cardíaco contínuo desativado", fromBand = false)
        }
    }

    private val hrPingRunnable = object : Runnable {
        override fun run() {
            if (!isReady || !_state.value.continuousHeartRate) return
            gattQueue.enqueue(GattQueue.Op.Write(MiBandUuids.CHAR_HR_CONTROL, MiBandProtocol.HR_PING))
            handler.postDelayed(this, HR_PING_INTERVAL_MS)
        }
    }

    private fun stopHeartRatePing() {
        handler.removeCallbacks(hrPingRunnable)
    }

    fun syncTime() {
        if (!isReady) return
        write(MiBandUuids.CHAR_CURRENT_TIME, MiBandProtocol.currentTime(Calendar.getInstance()))
        log("Data e hora sincronizadas", fromBand = false)
    }

    private fun applySettings() {
        val s = _settings.value
        write(MiBandUuids.CHAR_CONFIG, MiBandProtocol.timeFormat24h(s.time24h))
        write(MiBandUuids.CHAR_CONFIG, MiBandProtocol.liftWristToActivate(s.liftWrist))
        write(MiBandUuids.CHAR_CONFIG, MiBandProtocol.distanceMetric())
    }

    fun setTime24h(enabled: Boolean) {
        updateSettings { it.copy(time24h = enabled) }
        if (isReady) write(MiBandUuids.CHAR_CONFIG, MiBandProtocol.timeFormat24h(enabled))
    }

    fun setLiftWrist(enabled: Boolean) {
        updateSettings { it.copy(liftWrist = enabled) }
        if (isReady) write(MiBandUuids.CHAR_CONFIG, MiBandProtocol.liftWristToActivate(enabled))
    }

    fun setForwardNotifications(enabled: Boolean) {
        updateSettings { it.copy(forwardNotifications = enabled) }
    }

    private fun updateSettings(transform: (BandSettings) -> BandSettings) {
        val s = transform(_settings.value)
        _settings.value = s
        prefs.edit()
            .putBoolean("time24h", s.time24h)
            .putBoolean("liftWrist", s.liftWrist)
            .putBoolean("forwardNotifications", s.forwardNotifications)
            .apply()
    }

    // =================================================================== alarmes

    private fun loadAlarm(slot: Int): AlarmConfig {
        val raw = prefs.getString("alarm_$slot", null) ?: return AlarmConfig(slot)
        val parts = raw.split(";").mapNotNull { it.toIntOrNull() }
        if (parts.size != 4) return AlarmConfig(slot)
        return AlarmConfig(slot, parts[0] == 1, parts[1], parts[2], parts[3])
    }

    /** Salva o alarme localmente e o envia para a pulseira (se conectada). */
    fun saveAlarm(alarm: AlarmConfig) {
        prefs.edit()
            .putString("alarm_${alarm.slot}", "${if (alarm.enabled) 1 else 0};${alarm.hour};${alarm.minute};${alarm.days}")
            .apply()
        _alarms.update { list -> list.map { if (it.slot == alarm.slot) alarm else it } }
        if (!requireReady()) return
        write(MiBandUuids.CHAR_CONFIG, MiBandProtocol.alarm(alarm.slot, alarm.enabled, alarm.hour, alarm.minute, alarm.days))
        val status = if (alarm.enabled) "ativado" else "desativado"
        log("Alarme ${alarm.slot + 1} %02d:%02d $status".format(alarm.hour, alarm.minute), fromBand = false)
    }

    // =================================================================== histórico

    fun log(text: String, fromBand: Boolean) {
        Log.i(TAG, text)
        _log.update { (it + LogEntry(System.currentTimeMillis(), text, fromBand)).takeLast(MAX_LOG) }
    }

    fun clearLog() {
        _log.value = emptyList()
    }
}
