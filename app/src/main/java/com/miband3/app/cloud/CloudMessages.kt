package com.miband3.app.cloud

import com.miband3.app.ble.BandEvent
import com.miband3.app.ble.MiBandProtocol
import org.json.JSONArray
import org.json.JSONObject

/** Comando recebido da nuvem. `params` é o JSON já validado pelo servidor. */
class CloudCommand(val id: String, val type: String, val params: JSONObject)

/**
 * Montagem e leitura das mensagens JSON trocadas com o serviço na nuvem.
 * Formato documentado em `cloud/src/protocol.ts`.
 */
object CloudMessages {
    /** O servidor aceita até 2000 amostras por mensagem; ficamos bem abaixo. */
    const val ACTIVITY_CHUNK = 500

    fun hr(ts: Long, bpm: Int) = JSONObject().put("t", "hr").put("ts", ts).put("bpm", bpm)

    fun steps(ts: Long, steps: Int, meters: Int?, calories: Int?) =
        JSONObject().put("t", "steps").put("ts", ts).put("steps", steps).apply {
            if (meters != null) put("meters", meters)
            if (calories != null) put("calories", calories)
        }

    fun battery(ts: Long, level: Int, charging: Boolean) =
        JSONObject().put("t", "battery").put("ts", ts).put("level", level).put("charging", charging)

    fun event(ts: Long, type: String, description: String) =
        JSONObject().put("t", "event").put("ts", ts).put("type", type)
            .put("data", JSONObject().put("description", description))

    fun state(ts: Long, connection: String, detail: String? = null) =
        JSONObject().put("t", "state").put("ts", ts).put("connection", connection).apply {
            if (detail != null) put("detail", detail.take(500))
        }

    fun activity(samples: List<MiBandProtocol.ActivitySample>): List<JSONObject> =
        samples.chunked(ACTIVITY_CHUNK).map { chunk ->
            val array = JSONArray()
            chunk.forEach { s ->
                array.put(
                    JSONObject().put("ts", s.ts).put("kind", s.kind).put("intensity", s.intensity).put("steps", s.steps)
                        .apply { if (s.hr != null) put("hr", s.hr) },
                )
            }
            JSONObject().put("t", "activity").put("samples", array)
        }

    fun hello(appVersion: String, os: String, model: String, bandName: String?, address: String?, firmware: String?, hardware: String?, serial: String?) =
        JSONObject().put("t", "hello")
            .put("client", JSONObject().put("app", "miband3").put("version", appVersion).put("os", os).put("model", model))
            .put(
                "band",
                JSONObject().apply {
                    bandName?.let { put("name", it) }
                    address?.let { put("address", it) }
                    firmware?.let { put("firmware", it) }
                    hardware?.let { put("hardware", it) }
                    serial?.let { put("serial", it) }
                },
            )

    fun batch(items: List<JSONObject>) = JSONObject().put("t", "batch").put("items", JSONArray(items))

    fun ack(id: String, ok: Boolean, error: String? = null, result: String? = null) =
        JSONObject().put("t", "ack").put("id", id).put("ok", ok).apply {
            if (error != null) put("error", error.take(500))
            if (result != null) put("result", result)
        }

    fun fromBandEvent(e: BandEvent): List<JSONObject> = when (e) {
        is BandEvent.HeartRate -> listOf(hr(e.ts, e.bpm))
        is BandEvent.Steps -> listOf(steps(e.ts, e.steps, e.meters, e.calories))
        is BandEvent.Battery -> listOf(battery(e.ts, e.level, e.charging))
        is BandEvent.Device -> listOf(event(e.ts, e.type, e.description))
        is BandEvent.Activity -> activity(e.samples)
    }

    /** Lê uma mensagem recebida; devolve o comando se ela for um `command`. */
    fun parseCommand(text: String): CloudCommand? {
        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            return null
        }
        if (json.optString("t") != "command") return null
        val id = json.optString("id").ifEmpty { return null }
        val type = json.optString("type").ifEmpty { return null }
        return CloudCommand(id, type, json.optJSONObject("params") ?: JSONObject())
    }
}
