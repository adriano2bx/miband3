package com.miband3.app.ble

import com.miband3.app.ble.MiBandProtocol.AlertCategory
import com.miband3.app.ble.MiBandProtocol.AuthResponse
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class MiBandProtocolTest {

    private val key = MiBandProtocol.hexToBytes("30313233343536373839404142434445")

    @Test
    fun authSendKeyHasHeaderAndKey() {
        val packet = MiBandProtocol.authSendKey(key)
        assertEquals(18, packet.size)
        assertEquals(0x01.toByte(), packet[0])
        assertEquals(0x00.toByte(), packet[1])
        assertArrayEquals(key, packet.copyOfRange(2, 18))
    }

    @Test
    fun authEncryptsRandomWithAesEcb() {
        // Vetor de teste FIPS-197 (AES-128).
        val fipsKey = MiBandProtocol.hexToBytes("000102030405060708090a0b0c0d0e0f")
        val plain = MiBandProtocol.hexToBytes("00112233445566778899aabbccddeeff")
        val packet = MiBandProtocol.authSendEncrypted(plain, fipsKey)
        assertEquals(0x03.toByte(), packet[0])
        assertEquals(0x00.toByte(), packet[1])
        assertArrayEquals(MiBandProtocol.hexToBytes("69c4e0d86a7b0430d8cdb78070b4c55a"), packet.copyOfRange(2, 18))
    }

    @Test
    fun parsesAuthResponses() {
        assertEquals(AuthResponse.KeyAccepted, MiBandProtocol.parseAuthResponse(byteArrayOf(0x10, 0x01, 0x01)))
        assertEquals(AuthResponse.KeyRejected, MiBandProtocol.parseAuthResponse(byteArrayOf(0x10, 0x01, 0x04)))
        assertEquals(AuthResponse.Authenticated, MiBandProtocol.parseAuthResponse(byteArrayOf(0x10, 0x03, 0x01)))
        assertEquals(AuthResponse.AuthFailed, MiBandProtocol.parseAuthResponse(byteArrayOf(0x10, 0x03, 0x04)))
        assertEquals(AuthResponse.RandomFailed, MiBandProtocol.parseAuthResponse(byteArrayOf(0x10, 0x02, 0x04)))

        val random = ByteArray(16) { it.toByte() }
        val response = MiBandProtocol.parseAuthResponse(byteArrayOf(0x10, 0x02, 0x01) + random)
        assertTrue(response is AuthResponse.RandomReceived)
        assertArrayEquals(random, (response as AuthResponse.RandomReceived).random)

        assertNull(MiBandProtocol.parseAuthResponse(byteArrayOf(0x01, 0x02)))
    }

    @Test
    fun parsesBattery() {
        val info = MiBandProtocol.parseBattery(byteArrayOf(0x0f, 87, 1, 0, 0))!!
        assertEquals(87, info.level)
        assertTrue(info.charging)
    }

    @Test
    fun parsesSteps() {
        // 1234 passos, 950 m, 45 kcal
        val data = byteArrayOf(0x0c, 0xd2.toByte(), 0x04, 0, 0, 0xb6.toByte(), 0x03, 0, 0, 45, 0, 0, 0)
        val info = MiBandProtocol.parseSteps(data)!!
        assertEquals(1234, info.steps)
        assertEquals(950, info.meters)
        assertEquals(45, info.calories)
    }

    @Test
    fun parsesHeartRate() {
        assertEquals(72, MiBandProtocol.parseHeartRate(byteArrayOf(0x00, 72)))
        assertEquals(300, MiBandProtocol.parseHeartRate(byteArrayOf(0x01, 0x2c, 0x01)))
        assertNull(MiBandProtocol.parseHeartRate(byteArrayOf(0x00)))
    }

    @Test
    fun encodesCurrentTime() {
        val cal = Calendar.getInstance(TimeZone.getTimeZone("America/Sao_Paulo")).apply {
            clear()
            set(2024, Calendar.MARCH, 10, 14, 30, 15) // domingo
        }
        val bytes = MiBandProtocol.currentTime(cal)
        assertEquals(11, bytes.size)
        assertEquals(2024, (bytes[0].toInt() and 0xff) or ((bytes[1].toInt() and 0xff) shl 8))
        assertEquals(3, bytes[2].toInt())
        assertEquals(10, bytes[3].toInt())
        assertEquals(14, bytes[4].toInt())
        assertEquals(30, bytes[5].toInt())
        assertEquals(15, bytes[6].toInt())
        assertEquals(7, bytes[7].toInt()) // domingo = 7
        assertEquals(-12, bytes[10].toInt()) // UTC-3 = -12 * 15 min
    }

    @Test
    fun buildsAlerts() {
        val sms = MiBandProtocol.newAlert(AlertCategory.SMS, "Ana", "Oi")
        assertArrayEquals(byteArrayOf(0x05, 0x01) + "Ana\u0000Oi".toByteArray(), sms)

        val app = MiBandProtocol.newAlert(AlertCategory.CUSTOM_HUAMI, "WhatsApp", "", MiBandProtocol.Icon.WHATSAPP)
        assertArrayEquals(byteArrayOf(0xfa.toByte(), 0x01, 7) + "WhatsApp".toByteArray(), app)
    }

    @Test
    fun truncatesUtf8WithoutBreakingCharacters() {
        val text = "ação".repeat(100)
        val bytes = MiBandProtocol.truncateUtf8(text, 15)
        assertTrue(bytes.size <= 15)
        // Decodificar e recodificar deve ser idempotente se nenhum caractere foi cortado ao meio.
        assertArrayEquals(bytes, bytes.decodeToString().toByteArray())
    }

    @Test
    fun buildsAlarms() {
        val packet = MiBandProtocol.alarm(1, true, 6, 45, MiBandProtocol.Days.MONDAY or MiBandProtocol.Days.FRIDAY)
        assertArrayEquals(byteArrayOf(0x02, 0x81.toByte(), 6, 45, 0x11), packet)

        val once = MiBandProtocol.alarm(0, false, 7, 0, 0)
        assertArrayEquals(byteArrayOf(0x02, 0x00, 7, 0, 0x80.toByte()), once)
    }

    @Test
    fun recognizesDeviceEvents() {
        assertEquals(MiBandProtocol.DeviceEvent.BUTTON_PRESSED, MiBandProtocol.DeviceEvent.fromData(byteArrayOf(0x04)))
        assertEquals(MiBandProtocol.DeviceEvent.FIND_PHONE_START, MiBandProtocol.DeviceEvent.fromData(byteArrayOf(0x08)))
        assertNull(MiBandProtocol.DeviceEvent.fromData(byteArrayOf(0x55)))
    }

    @Test
    fun usesHuamiUuidBase() {
        // Conferido numa Mi Band 3 real (lista de serviços GATT).
        assertEquals("00000009-0000-3512-2118-0009af100700", MiBandUuids.CHAR_AUTH.toString())
        assertEquals("00000010-0000-3512-2118-0009af100700", MiBandUuids.CHAR_DEVICE_EVENT.toString())
    }

    @Test
    fun buildsUserInfo() {
        val p = MiBandProtocol.userInfo(1990, 1, 1, MiBandProtocol.Gender.MALE, 175, 80, 0x01020304)
        assertEquals(16, p.size)
        assertEquals(0x4f.toByte(), p[0])
        assertEquals(1990, (p[3].toInt() and 0xff) or ((p[4].toInt() and 0xff) shl 8))
        assertEquals(175, p[8].toInt() and 0xff)
        assertEquals(80 * 200, (p[10].toInt() and 0xff) or ((p[11].toInt() and 0xff) shl 8))
        assertArrayEquals(byteArrayOf(4, 3, 2, 1), p.copyOfRange(12, 16))
        assertArrayEquals(byteArrayOf(0x10, 0, 0, 0x40, 0x1f, 0, 0), MiBandProtocol.stepGoal(8000))
    }

    @Test
    fun buildsActivityFetchStart() {
        val tz = TimeZone.getTimeZone("America/Sao_Paulo")
        val cal = Calendar.getInstance(tz).apply { clear(); set(2026, Calendar.MARCH, 5, 22, 30, 0) }
        val p = MiBandProtocol.activityFetchStart(cal.timeInMillis, tz)
        assertArrayEquals(byteArrayOf(0x01, 0x01, 0xea.toByte(), 0x07, 3, 5, 22, 30, -12), p)
        assertArrayEquals(byteArrayOf(0x02), MiBandProtocol.activityFetchBegin())
        assertArrayEquals(byteArrayOf(0x03, 0x09), MiBandProtocol.activityFetchAck())
        assertArrayEquals(byteArrayOf(0x03, 0x01), MiBandProtocol.activityFetchAck(keepOnDevice = false))
    }

    @Test
    fun parsesActivityFetchResponses() {
        val tz = TimeZone.getTimeZone("UTC")
        val ready = byteArrayOf(0x10, 0x01, 0x01, 0x40, 0x00, 0x00, 0x00, 0xea.toByte(), 0x07, 3, 5, 22, 30, 0)
        val r = MiBandProtocol.parseFetchResponse(ready, tz) as MiBandProtocol.FetchResponse.Ready
        assertEquals(64L, r.expectedBytes)
        val expected = Calendar.getInstance(tz).apply { clear(); set(2026, Calendar.MARCH, 5, 22, 30, 0) }.timeInMillis
        assertEquals(expected, r.startMs)

        assertEquals(MiBandProtocol.FetchResponse.NoData, MiBandProtocol.parseFetchResponse(byteArrayOf(0x10, 0x01, 0x02), tz))
        assertEquals(MiBandProtocol.FetchResponse.Finished, MiBandProtocol.parseFetchResponse(byteArrayOf(0x10, 0x02, 0x01), tz))
        assertNull(MiBandProtocol.parseFetchResponse(byteArrayOf(0x42, 0x01, 0x01), tz))
    }

    @Test
    fun parsesActivityPacket() {
        // contador 7, duas amostras: (kind 1, intensidade 20, 5 passos, FC 70) e (kind 9, 0, 0, FC 255 = sem leitura)
        val packet = byteArrayOf(7, 1, 20, 5, 70, 9, 0, 0, 0xff.toByte())
        val samples = MiBandProtocol.parseActivityPacket(packet, 1_000_000L)
        assertEquals(2, samples.size)
        assertEquals(MiBandProtocol.ActivitySample(1_000_000L, 1, 20, 5, 70), samples[0])
        assertEquals(MiBandProtocol.ActivitySample(1_060_000L, 9, 0, 0, null), samples[1])
        assertTrue(MiBandProtocol.parseActivityPacket(byteArrayOf(1, 2), 0).isEmpty())
    }
}
