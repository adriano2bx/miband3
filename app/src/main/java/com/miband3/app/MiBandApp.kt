package com.miband3.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.CloudClient
import com.miband3.app.service.MiBandService

class MiBandApp : Application() {
    override fun onCreate() {
        super.onCreate()
        MiBandManager.init(this)
        val channel = NotificationChannel(
            MiBandService.CHANNEL_ID,
            getString(R.string.channel_connection),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        CloudClient.init(this)
    }
}
