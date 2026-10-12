package com.miband3.app.tech

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecretTapDetectorTest {
    private fun tapsAt(d: SecretTapDetector, vararg times: Long) = times.map { d.onTap(it) }

    @Test
    fun fiveQuickTapsReveal() {
        val d = SecretTapDetector()
        assertEquals(listOf(false, false, false, false, true), tapsAt(d, 0, 300, 600, 900, 1200))
    }

    @Test
    fun gapLongerThan600msRestartsCount() {
        val d = SecretTapDetector()
        val r = tapsAt(d, 0, 300, 600, 1300, 1600, 1900, 2200)
        assertFalse(r.any { it }) // só 4 toques válidos depois da pausa
        assertTrue(d.onTap(2500))
    }

    @Test
    fun sequenceLongerThan2500msDoesNotCount() {
        val d = SecretTapDetector()
        // Intervalos de 590 ms: 5 toques levam 2360 ms (vale); 6º toque recomeça a janela.
        assertEquals(listOf(false, false, false, false, true), tapsAt(d, 0, 590, 1180, 1770, 2360))
        val slow = SecretTapDetector(maxTotalMs = 2_000)
        assertFalse(tapsAt(slow, 0, 590, 1180, 1770, 2360).last())
    }

    @Test
    fun afterRevealCountStartsOver() {
        val d = SecretTapDetector()
        tapsAt(d, 0, 100, 200, 300, 400)
        assertFalse(d.onTap(500))
    }
}
