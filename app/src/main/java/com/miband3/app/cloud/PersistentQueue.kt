package com.miband3.app.cloud

import java.io.File

/**
 * Fila de telemetria gravada em arquivo: sobrevive ao encerramento do app.
 * Um lote só sai da fila quando a nuvem confirma a gravação ([ack]); se a conexão cair
 * antes, os lotes em trânsito voltam para o início ([requeueInFlight]) e são reenviados —
 * a nuvem ignora duplicatas (chave por horário e id de evento).
 *
 * Não é thread-safe: use sempre na mesma thread.
 */
class PersistentQueue(private val file: File, private val maxItems: Int = 50_000) {
    private val pending = ArrayDeque<String>()
    private val inFlight = LinkedHashMap<Long, List<String>>()
    private var nextSeq = 1L
    var dirty = false
        private set

    /** Itens descartados por excesso (os mais antigos saem primeiro). */
    var dropped = 0
        private set

    val size: Int get() = pending.size + inFlight.values.sumOf { it.size }
    val inFlightBatches: Int get() = inFlight.size

    fun load() {
        pending.clear()
        inFlight.clear()
        if (file.exists()) {
            file.forEachLine { line -> if (line.isNotBlank()) pending.addLast(line) }
        }
        trim()
        dirty = false
    }

    fun add(item: String) {
        require('\n' !in item) { "item com quebra de linha" }
        pending.addLast(item)
        trim()
        dirty = true
    }

    /** Retira o próximo lote (até [maxItems] itens ou [maxChars] caracteres) e o marca como em trânsito. */
    fun nextBatch(maxItems: Int, maxChars: Int): Pair<Long, List<String>>? {
        if (pending.isEmpty()) return null
        val batch = ArrayList<String>()
        var chars = 0
        while (pending.isNotEmpty() && batch.size < maxItems && (batch.isEmpty() || chars + pending.first().length <= maxChars)) {
            val item = pending.removeFirst()
            chars += item.length
            batch.add(item)
        }
        val seq = nextSeq++
        inFlight[seq] = batch
        return seq to batch
    }

    /** A nuvem confirmou (ou recusou definitivamente) o lote: remove de vez. */
    fun ack(seq: Long): Int {
        val removed = inFlight.remove(seq)?.size ?: 0
        if (removed > 0) dirty = true
        return removed
    }

    /** Conexão caiu: lotes sem confirmação voltam ao início, na ordem original. */
    fun requeueInFlight() {
        if (inFlight.isEmpty()) return
        val items = inFlight.values.flatten()
        inFlight.clear()
        items.asReversed().forEach { pending.addFirst(it) }
    }

    fun clear() {
        pending.clear()
        inFlight.clear()
        dirty = true
    }

    /** Grava itens em trânsito + pendentes (ordem de envio) de forma atômica. */
    fun save() {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.bufferedWriter().use { w ->
            inFlight.values.forEach { batch -> batch.forEach { w.write(it); w.newLine() } }
            pending.forEach { w.write(it); w.newLine() }
        }
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
        dirty = false
    }

    private fun trim() {
        while (size > maxItems && pending.isNotEmpty()) {
            pending.removeFirst()
            dropped++
        }
    }
}
