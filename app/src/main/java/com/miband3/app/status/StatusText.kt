package com.miband3.app.status

import androidx.annotation.StringRes
import com.miband3.app.R

/** Título e mensagem de cada status (textos fixos do guia, em recursos localizáveis). */
@StringRes
fun StatusKind.titleRes(): Int = when (this) {
    StatusKind.ACTIVE -> R.string.status_active_title
    StatusKind.RECONNECTING -> R.string.status_reconnecting_title
    StatusKind.BAND_DISCONNECTED -> R.string.status_band_disconnected_title
    StatusKind.BLUETOOTH_OFF -> R.string.status_bluetooth_off_title
    StatusKind.SERVICE_UNAVAILABLE -> R.string.status_service_unavailable_title
    StatusKind.PERMISSION_REQUIRED -> R.string.status_permission_title
    StatusKind.NOT_AUTHORIZED -> R.string.status_not_authorized_title
}

@StringRes
fun StatusKind.messageRes(): Int = when (this) {
    StatusKind.ACTIVE -> R.string.status_active_message
    StatusKind.RECONNECTING -> R.string.status_reconnecting_message
    StatusKind.BAND_DISCONNECTED -> R.string.status_band_disconnected_message
    StatusKind.BLUETOOTH_OFF -> R.string.status_bluetooth_off_message
    StatusKind.SERVICE_UNAVAILABLE -> R.string.status_service_unavailable_message
    StatusKind.PERMISSION_REQUIRED -> R.string.status_permission_message
    StatusKind.NOT_AUTHORIZED -> R.string.status_not_authorized_message
}
