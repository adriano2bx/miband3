package com.miband3.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.CloudClient
import com.miband3.app.data.InstallationStore
import com.miband3.app.service.MiBandService
import com.miband3.app.status.StatusMonitor

class MiBandApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(
            MiBandService.CHANNEL_ID,
            getString(R.string.channel_connection),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        InstallationStore.init(this)
        MiBandManager.init(this)
        StatusMonitor.init(this)
        CloudClient.init(this)
    }
}
