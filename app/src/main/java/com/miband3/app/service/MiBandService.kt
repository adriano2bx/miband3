package com.miband3.app.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.miband3.app.R
import com.miband3.app.ble.BandState
import com.miband3.app.ble.Branding
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.CloudClient
import com.miband3.app.cloud.CloudStatus
import com.miband3.app.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Serviço em primeiro plano que mantém o processo vivo enquanto a pulseira
 * está conectada, para que eventos e notificações continuem funcionando
 * com o app em segundo plano.
 */
class MiBandService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(MiBandManager.state.value), type)
        scope.launch {
            MiBandManager.state
                .combine(CloudClient.state.map { it.status }.distinctUntilChanged()) { s, cloud -> listOf(s.connection, s.battery, s.steps, cloud) }
                .distinctUntilChanged()
                .collect {
                    getSystemService(NotificationManager::class.java)
                        .notify(NOTIFICATION_ID, buildNotification(MiBandManager.state.value))
                }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            MiBandManager.disconnect()
            // Com o envio à nuvem ligado o serviço continua para manter o WebSocket vivo.
            if (!CloudClient.isUsable) stopSelf()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun buildNotification(state: BandState): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val disconnect = PendingIntent.getService(
            this, 1, Intent(this, MiBandService::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val cloud = CloudClient.state.value
        val details = buildList {
            state.battery?.let { add("Bateria $it%") }
            state.steps?.let { add("$it passos") }
            if (cloud.status != CloudStatus.DISABLED) add("Nuvem: ${cloud.status.label}")
        }.joinToString(" · ")
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_band)
            .setContentTitle("${state.name ?: Branding.PRODUCT_NAME}: ${state.connection.label}")
            .setContentText(details.ifEmpty { null })
            .setContentIntent(openApp)
            .addAction(0, "Desconectar", disconnect)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "connection"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_DISCONNECT = "com.miband3.app.DISCONNECT"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, MiBandService::class.java))
        }

        fun stop(context: Context) {
            if (CloudClient.isUsable) return
            context.stopService(Intent(context, MiBandService::class.java))
        }
    }
}
