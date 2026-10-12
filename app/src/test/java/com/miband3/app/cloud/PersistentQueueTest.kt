package com.miband3.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PersistentQueueTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun itemsLeaveOnlyAfterAck() {
        val q = PersistentQueue(tmp.newFile("q.jsonl"))
        repeat(5) { q.add("""{"n":$it}""") }
        val (seq, batch) = q.nextBatch(maxItems = 3, maxChars = 10_000)!!
        assertEquals(3, batch.size)
        assertEquals(5, q.size) // em trânsito ainda conta
        q.ack(seq)
        assertEquals(2, q.size)
    }

    @Test
    fun unackedBatchesReturnInOriginalOrderAfterDisconnect() {
        val q = PersistentQueue(tmp.newFile("q.jsonl"))
        listOf("a", "b", "c", "d").forEach { q.add("\"$it\"") }
        q.nextBatch(2, 10_000)
        q.nextBatch(1, 10_000)
        q.requeueInFlight()
        val (_, all) = q.nextBatch(10, 10_000)!!
        assertEquals(listOf("\"a\"", "\"b\"", "\"c\"", "\"d\""), all)
    }

    @Test
    fun survivesRestartIncludingInFlight() {
        val file = tmp.newFile("q.jsonl")
        val q = PersistentQueue(file)
        listOf("1", "2", "3").forEach { q.add(it) }
        q.nextBatch(2, 10_000) // enviado, sem confirmação
        q.save()

        val reloaded = PersistentQueue(file)
        reloaded.load()
        assertEquals(3, reloaded.size)
        assertEquals(listOf("1", "2", "3"), reloaded.nextBatch(10, 10_000)!!.second)
        assertNull(reloaded.nextBatch(10, 10_000))
    }

    @Test
    fun dropsOldestWhenFull() {
        val q = PersistentQueue(tmp.newFile("q.jsonl"), maxItems = 3)
        listOf("1", "2", "3", "4").forEach { q.add(it) }
        assertEquals(3, q.size)
        assertEquals(1, q.dropped)
        assertEquals(listOf("2", "3", "4"), q.nextBatch(10, 10_000)!!.second)
    }

    @Test
    fun batchRespectsCharacterLimitButAlwaysTakesOne() {
        val q = PersistentQueue(tmp.newFile("q.jsonl"))
        q.add("x".repeat(50))
        q.add("y".repeat(50))
        assertEquals(1, q.nextBatch(10, 60)!!.second.size)
        assertEquals(1, q.nextBatch(10, 10)!!.second.size) // item maior que o limite ainda sai sozinho
    }
}
