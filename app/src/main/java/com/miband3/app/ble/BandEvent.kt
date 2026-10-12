package com.miband3.app.ble

/** Dados e acontecimentos da pulseira, publicados para quem quiser acompanhar (ex.: envio à nuvem). */
sealed class BandEvent {
    abstract val ts: Long
    data class HeartRate(override val ts: Long, val bpm: Int) : BandEvent()
    data class Steps(override val ts: Long, val steps: Int, val meters: Int?, val calories: Int?) : BandEvent()
    data class Battery(override val ts: Long, val level: Int, val charging: Boolean) : BandEvent()
    data class Device(override val ts: Long, val type: String, val description: String) : BandEvent()
    data class Activity(override val ts: Long, val samples: List<MiBandProtocol.ActivitySample>) : BandEvent()
}
