package com.miband3.app.status

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceStatusTest {
    private val now = 1_000_000L
    private val healthy = StatusInputs(
        permissionGranted = true,
        bluetoothOn = true,
        band = BandLink.AUTHENTICATED,
        bandRetrying = true,
        bandAuthRejected = false,
        cloud = CloudLink.ONLINE,
        cloudAuthorized = true,
        lastPresenceMs = now - 10_000,
        nowMs = now,
    )

    @Test
    fun activeOnlyWithBandCloudAuthorizationAndRecentPresence() {
        assertEquals(StatusKind.ACTIVE, deriveStatus(healthy))
        // Socket aberto sem confirmação recente não é "Conexão ativa".
        assertEquals(StatusKind.RECONNECTING, deriveStatus(healthy.copy(lastPresenceMs = now - PRESENCE_FRESH_MS - 1)))
        assertEquals(StatusKind.RECONNECTING, deriveStatus(healthy.copy(lastPresenceMs = null)))
    }

    @Test
    fun systemProblemsTakePrecedence() {
        assertEquals(StatusKind.PERMISSION_REQUIRED, deriveStatus(healthy.copy(permissionGranted = false, bluetoothOn = false)))
        assertEquals(StatusKind.BLUETOOTH_OFF, deriveStatus(healthy.copy(bluetoothOn = false, band = BandLink.DISCONNECTED)))
    }

    @Test
    fun rejectedAuthorizationIsReported() {
        assertEquals(StatusKind.NOT_AUTHORIZED, deriveStatus(healthy.copy(cloud = CloudLink.REJECTED)))
        assertEquals(StatusKind.NOT_AUTHORIZED, deriveStatus(healthy.copy(cloudAuthorized = false)))
        assertEquals(StatusKind.NOT_AUTHORIZED, deriveStatus(healthy.copy(bandAuthRejected = true, band = BandLink.DISCONNECTED)))
    }

    @Test
    fun bandStates() {
        assertEquals(StatusKind.RECONNECTING, deriveStatus(healthy.copy(band = BandLink.CONNECTING)))
        assertEquals(StatusKind.RECONNECTING, deriveStatus(healthy.copy(band = BandLink.DISCONNECTED, bandRetrying = true)))
        assertEquals(StatusKind.BAND_DISCONNECTED, deriveStatus(healthy.copy(band = BandLink.DISCONNECTED, bandRetrying = false)))
    }

    @Test
    fun cloudStatesWithBandAuthenticated() {
        assertEquals(StatusKind.SERVICE_UNAVAILABLE, deriveStatus(healthy.copy(cloud = CloudLink.OFFLINE)))
        assertEquals(StatusKind.RECONNECTING, deriveStatus(healthy.copy(cloud = CloudLink.CONNECTING)))
    }
}
