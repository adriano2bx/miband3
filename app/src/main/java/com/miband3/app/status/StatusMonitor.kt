package com.miband3.app.status

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.CloudClient
import com.miband3.app.cloud.CloudStatus
import com.miband3.app.data.InstallationStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Permissões de Bluetooth exigidas pela versão do Android em uso. */
fun bluetoothPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

fun hasBluetoothPermissions(context: Context) = bluetoothPermissions().all {
    ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
}

/** Junta pulseira, Bluetooth, permissões e nuvem no status único mostrado ao participante. */
object StatusMonitor {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var appContext: Context
    private val permission = MutableStateFlow(true)
    private val clock = MutableStateFlow(System.currentTimeMillis())

    lateinit var status: StateFlow<StatusKind>
        private set

    fun init(context: Context) {
        if (::appContext.isInitialized) return
        appContext = context.applicationContext
        refreshPermissions()
        // O relógio reavalia a presença (fica "velha" sem novos eventos) e a permissão.
        scope.launch {
            while (true) {
                delay(5_000)
                clock.value = System.currentTimeMillis()
                refreshPermissions()
            }
        }
        status = combine(
            permission, MiBandManager.bluetoothOn, MiBandManager.state, CloudClient.state, combine(clock, InstallationStore.state) { now, inst -> now to inst },
        ) { perm, bt, band, cloud, (now, inst) ->
            deriveStatus(
                StatusInputs(
                    permissionGranted = perm,
                    bluetoothOn = bt,
                    band = when (band.connection) {
                        ConnectionState.READY -> BandLink.AUTHENTICATED
                        ConnectionState.DISCONNECTED -> BandLink.DISCONNECTED
                        else -> BandLink.CONNECTING
                    },
                    bandRetrying = band.retrying,
                    bandAuthRejected = band.authRejected,
                    cloud = when (cloud.status) {
                        CloudStatus.ONLINE -> CloudLink.ONLINE
                        CloudStatus.REJECTED -> CloudLink.REJECTED
                        CloudStatus.DISABLED -> CloudLink.OFFLINE
                        // Duas falhas seguidas (sem rede ou servidor fora) já contam como indisponível.
                        CloudStatus.CONNECTING -> if (cloud.failures >= 2) CloudLink.OFFLINE else CloudLink.CONNECTING
                    },
                    cloudAuthorized = inst.accepting,
                    lastPresenceMs = cloud.lastPresenceMs,
                    nowMs = now,
                ),
            )
        }.stateIn(scope, SharingStarted.Eagerly, StatusKind.RECONNECTING)
    }

    fun refreshPermissions() {
        permission.value = hasBluetoothPermissions(appContext)
    }
}
