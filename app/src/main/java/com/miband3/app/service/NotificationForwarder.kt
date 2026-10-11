package com.miband3.app.service

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.miband3.app.ble.MiBandManager
import com.miband3.app.ble.MiBandProtocol.Icon

/** Envia as notificações do celular para a pulseira, quando habilitado nas configurações. */
class NotificationForwarder : NotificationListenerService() {

    private val recent = LinkedHashMap<String, Long>()

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!MiBandManager.settings.value.forwardNotifications) return
        if (sbn.packageName == packageName) return
        val n = sbn.notification
        val isCall = n.category == Notification.CATEGORY_CALL
        if (!isCall && (n.flags and Notification.FLAG_ONGOING_EVENT != 0)) return
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val extras = n.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        if (title.isBlank() && text.isBlank()) return

        // Evita repetir a mesma notificação (apps costumam atualizá-las várias vezes).
        val fingerprint = "${sbn.packageName}|$title|$text"
        val now = System.currentTimeMillis()
        recent.entries.removeAll { now - it.value > DEDUP_WINDOW_MS }
        if (recent.containsKey(fingerprint)) return
        recent[fingerprint] = now

        val appName = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
        } catch (e: Exception) {
            sbn.packageName
        }
        MiBandManager.forwardNotification(appName, iconFor(sbn.packageName), title, text, isCall)
    }

    private fun iconFor(pkg: String): Int = when {
        pkg.startsWith("com.whatsapp") -> Icon.WHATSAPP
        pkg.startsWith("org.telegram") -> Icon.TELEGRAM
        pkg == "com.instagram.android" -> Icon.INSTAGRAM
        pkg == "com.facebook.orca" -> Icon.MESSENGER
        pkg.startsWith("com.facebook") -> Icon.FACEBOOK
        pkg == "com.twitter.android" -> Icon.TWITTER
        pkg == "com.snapchat.android" -> Icon.SNAPCHAT
        pkg == "com.viber.voip" -> Icon.VIBER
        pkg == "jp.naver.line.android" -> Icon.LINE
        pkg.startsWith("com.skype") -> Icon.SKYPE
        pkg == "com.tencent.mm" -> Icon.WECHAT
        pkg == "com.google.android.gm" || pkg.contains("mail") -> Icon.EMAIL
        pkg.contains("calendar") -> Icon.CALENDAR
        else -> Icon.APP
    }

    companion object {
        private const val DEDUP_WINDOW_MS = 10_000L

        fun isEnabled(context: Context): Boolean {
            val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
            val component = ComponentName(context, NotificationForwarder::class.java).flattenToString()
            return flat.split(":").any { it == component }
        }
    }
}
