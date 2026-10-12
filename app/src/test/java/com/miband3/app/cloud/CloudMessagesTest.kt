package com.miband3.app.cloud

import com.miband3.app.ble.BandEvent
import com.miband3.app.ble.MiBandProtocol
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudMessagesTest {

    @Test
    fun buildsHeartRateAndStepsMessages() {
        val hr = CloudMessages.hr(1000, 72)
        assertEquals("hr", hr.getString("t"))
        assertEquals(72, hr.getInt("bpm"))

        val steps = CloudMessages.steps(1000, 4200, null, 120)
        assertEquals(4200, steps.getInt("steps"))
        assertFalse(steps.has("meters")) // ausente, não "null": o servidor aceita só omitido
        assertEquals(120, steps.getInt("calories"))
    }

    @Test
    fun splitsActivityIntoChunksUnderServerLimit() {
        val samples = (0 until 1200).map { MiBandProtocol.ActivitySample(it * 60_000L, 9, 1, 0, if (it % 2 == 0) 55 else null) }
        val messages = CloudMessages.activity(samples)
        assertEquals(3, messages.size)
        assertEquals(500, messages[0].getJSONArray("samples").length())
        assertEquals(200, messages[2].getJSONArray("samples").length())
        val first = messages[0].getJSONArray("samples").getJSONObject(0)
        assertEquals(55, first.getInt("hr"))
        assertFalse(messages[0].getJSONArray("samples").getJSONObject(1).has("hr"))
    }

    @Test
    fun mapsBandEvents() {
        val events = CloudMessages.fromBandEvent(BandEvent.Device(5, "BUTTON_PRESSED", "Botão"))
        assertEquals("event", events.single().getString("t"))
        assertEquals("BUTTON_PRESSED", events.single().getString("type"))
        assertEquals("battery", CloudMessages.fromBandEvent(BandEvent.Battery(5, 80, true)).single().getString("t"))
    }

    @Test
    fun parsesCommands() {
        val cmd = CloudMessages.parseCommand("""{"t":"command","id":"cmd_1","type":"vibrate","params":{"count":3,"durationMs":800}}""")
        assertNotNull(cmd)
        assertEquals("cmd_1", cmd!!.id)
        assertEquals(3, cmd.params.getInt("count"))
        assertNull(CloudMessages.parseCommand("""{"t":"welcome"}"""))
        assertNull(CloudMessages.parseCommand("não é json"))
        assertNull(CloudMessages.parseCommand("""{"t":"command","type":"vibrate"}""")) // sem id
    }

    @Test
    fun buildsAckAndBatch() {
        val ack = CloudMessages.ack("cmd_1", false, "pulseira desconectada")
        assertEquals(false, ack.getBoolean("ok"))
        assertEquals("pulseira desconectada", ack.getString("error"))
        val batch = CloudMessages.batch(listOf(CloudMessages.hr(1, 60), CloudMessages.hr(2, 61)))
        assertEquals(2, batch.getJSONArray("items").length())
    }

    @Test
    fun normalizesServerUrl() {
        assertEquals("wss://x.workers.dev/v1/connect", CloudConfig.toWebSocketUrl("x.workers.dev"))
        assertEquals("wss://x.workers.dev/v1/connect", CloudConfig.toWebSocketUrl("https://x.workers.dev/"))
        assertEquals("wss://x.workers.dev/v1/connect", CloudConfig.toWebSocketUrl("  wss://x.workers.dev/v1/connect "))
        assertEquals("ws://192.168.0.5:8787/v1/connect", CloudConfig.toWebSocketUrl("http://192.168.0.5:8787"))
        assertEquals("https://x.workers.dev", CloudConfig.toHttpBase("x.workers.dev/"))
        assertEquals("http://10.0.2.2:8787", CloudConfig.toHttpBase("ws://10.0.2.2:8787/v1/connect"))
        assertNull(CloudConfig.toWebSocketUrl(""))
        assertNull(CloudConfig.toWebSocketUrl("ftp://x"))
        assertNull(CloudConfig.toHttpBase("https://"))
    }

    @Test
    fun eventsCarryUniqueIdsForDeduplication() {
        val a = CloudMessages.event(1, "BUTTON_PRESSED", "Botão")
        val b = CloudMessages.event(1, "BUTTON_PRESSED", "Botão")
        assertTrue(a.getString("id").isNotBlank())
        assertTrue(a.getString("id") != b.getString("id"))
    }

    @Test
    fun buildsSequencedBatch() {
        val raw = CloudMessages.batchRaw(7, listOf(CloudMessages.hr(1, 60).toString(), CloudMessages.hr(2, 61).toString()))
        val json = org.json.JSONObject(raw)
        assertEquals(7L, json.getLong("seq"))
        assertEquals(2, json.getJSONArray("items").length())
        assertEquals(61, json.getJSONArray("items").getJSONObject(1).getInt("bpm"))
    }
}
