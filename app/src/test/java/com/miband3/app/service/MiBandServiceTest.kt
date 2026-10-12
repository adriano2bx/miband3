package com.miband3.app.service

import android.Manifest
import android.app.Application
import android.app.Service
import android.content.ComponentName
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34, 35], application = Application::class)
class MiBandServiceTest {
    private class LaunchContext : ContextWrapper(RuntimeEnvironment.getApplication()) {
        val permissions = mutableSetOf<String>()
        var launches = 0
        var failure: RuntimeException? = null

        override fun checkPermission(permission: String, pid: Int, uid: Int): Int =
            if (permission in permissions) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED

        override fun startForegroundService(service: Intent): ComponentName? {
            launches++
            failure?.let { throw it }
            return service.component
        }

        fun grantBluetooth() {
            permissions += Manifest.permission.BLUETOOTH_CONNECT
            permissions += Manifest.permission.BLUETOOTH_SCAN
        }
    }

    @Test
    fun consentWithoutNearbyDevicePermissionDoesNotLaunchService() {
        val context = LaunchContext()
        assertFalse(MiBandService.start(context))
        assertEquals(0, context.launches)
    }

    @Test
    fun setupCanLaunchAfterNearbyDevicePermissionIsGranted() {
        val context = LaunchContext()
        assertFalse(MiBandService.start(context))
        context.grantBluetooth()
        assertTrue(MiBandService.start(context))
        assertEquals(1, context.launches)
    }

    @Test
    fun permissionRevokedDuringLaunchDoesNotCrashCaller() {
        val context = LaunchContext().apply {
            grantBluetooth()
            failure = SecurityException("Bluetooth permission revoked")
        }
        assertFalse(MiBandService.start(context))
    }

    @Test
    fun backgroundLaunchRestrictionDoesNotCrashCaller() {
        val context = LaunchContext().apply {
            grantBluetooth()
            failure = IllegalStateException("Foreground service start not allowed")
        }
        assertFalse(MiBandService.start(context))
    }

    @Test
    fun serviceRecreatedWithoutBluetoothPermissionStopsWithoutRestarting() {
        shadowOf(RuntimeEnvironment.getApplication()).denyPermissions(
            Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN,
        )
        val controller = Robolectric.buildService(MiBandService::class.java).create()
        assertEquals(Service.START_NOT_STICKY, controller.get().onStartCommand(null, 0, 1))
        controller.destroy()
    }
}
