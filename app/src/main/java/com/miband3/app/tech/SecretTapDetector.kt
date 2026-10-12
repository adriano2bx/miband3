package com.miband3.app.tech

/**
 * Reconhece o gesto que revela o login técnico: [taps] toques seguidos, todos dentro de
 * [maxTotalMs] e com no máximo [maxGapMs] entre um toque e o próximo. Qualquer sequência
 * inválida reinicia a contagem. O gesto só revela o login; nunca concede acesso.
 */
class SecretTapDetector(
    private val taps: Int = 5,
    private val maxTotalMs: Long = 2_500,
    private val maxGapMs: Long = 600,
) {
    private val times = ArrayList<Long>()

    /** Registra um toque; devolve true quando o gesto completo foi reconhecido. */
    fun onTap(nowMs: Long): Boolean {
        val last = times.lastOrNull()
        if (last != null && (nowMs - last > maxGapMs || nowMs < last)) times.clear()
        times.add(nowMs)
        if (nowMs - times.first() > maxTotalMs) {
            // A sequência ficou longa demais: recomeça a partir deste toque.
            times.clear()
            times.add(nowMs)
        }
        if (times.size >= taps) {
            times.clear()
            return true
        }
        return false
    }

    fun reset() = times.clear()
}
