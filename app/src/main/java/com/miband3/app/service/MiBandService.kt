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
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.miband3.app.R
import com.miband3.app.cloud.CloudClient
import com.miband3.app.status.StatusKind
import com.miband3.app.status.StatusMonitor
import com.miband3.app.status.titleRes
import com.miband3.app.status.hasBluetoothPermissions
import com.miband3.app.ui.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Serviço em primeiro plano que mantém a conexão com a pulseira e a nuvem com a tela
 * fechada ou bloqueada. A notificação é exigida pelo Android e mostra só o status da
 * conexão — nenhum dado de saúde e nenhum controle.
 */
class MiBandService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var foregroundStarted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // O aceite do termo acontece antes do pedido de Dispositivos próximos.
        // Revalida também no serviço, caso a permissão mude após start().
        if (!hasBluetoothPermissions(this)) {
            stopSelf()
            return
        }
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(StatusMonitor.status.value), type)
            foregroundStarted = true
        } catch (e: SecurityException) {
            Log.w(CHANNEL_ID, "Permissão insuficiente para iniciar o serviço", e)
            stopSelf()
            return
        } catch (e: IllegalStateException) {
            Log.w(CHANNEL_ID, "Android não permitiu iniciar o serviço neste estado", e)
            stopSelf()
            return
        }
        scope.launch {
            StatusMonitor.status.collect { status ->
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(status))
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int =
        if (foregroundStarted) START_STICKY else START_NOT_STICKY

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun buildNotification(status: StatusKind): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_biosense)
            .setContentTitle(getString(R.string.brand_name))
            .setContentText(getString(status.titleRes()))
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "connection"
        private const val NOTIFICATION_ID = 1

        fun start(context: Context): Boolean {
            // CloudClient.start() é chamado no consentimento e na abertura do app.
            // Não agenda onCreate() antes de conceder as permissões de Bluetooth.
            if (!hasBluetoothPermissions(context)) return false
            return try {
                ContextCompat.startForegroundService(context, Intent(context, MiBandService::class.java))
                true
            } catch (e: SecurityException) {
                Log.w(CHANNEL_ID, "Permissão alterada antes de iniciar o serviço", e)
                false
            } catch (e: IllegalStateException) {
                Log.w(CHANNEL_ID, "Início do serviço indisponível neste estado", e)
                false
            }
        }

        fun stop(context: Context) {
            // Com a instalação ativa o serviço continua: é ele que mantém o monitoramento vivo.
            if (CloudClient.isUsable) return
            context.stopService(Intent(context, MiBandService::class.java))
        }
    }
}
