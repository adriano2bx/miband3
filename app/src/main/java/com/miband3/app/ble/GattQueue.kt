package com.miband3.app.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothStatusCodes
import android.os.Build
import android.os.Handler
import android.util.Log
import java.util.UUID

/**
 * O Android só permite uma operação GATT pendente por vez. Esta fila serializa
 * leituras, escritas e inscrições em notificações, avançando quando o callback
 * correspondente chega (ou após um timeout).
 *
 * Todos os métodos devem ser chamados na thread do [handler].
 */
@SuppressLint("MissingPermission")
internal class GattQueue(
    private val handler: Handler,
    private val onError: (String) -> Unit,
) {
    sealed class Op {
        class Read(val uuid: UUID) : Op()
        class Write(val uuid: UUID, val value: ByteArray, val noResponse: Boolean = false) : Op()
        class Notify(val uuid: UUID, val enable: Boolean = true) : Op()
        /** Executa código arbitrário em ordem com as operações BLE. */
        class Action(val block: () -> Unit) : Op()
    }

    var gatt: BluetoothGatt? = null
    private val queue = ArrayDeque<Op>()
    private var current: Op? = null
    private val timeout = Runnable {
        Log.w(TAG, "Timeout na operação GATT ${current?.javaClass?.simpleName}")
        completeCurrent()
    }

    fun enqueue(op: Op) {
        queue.addLast(op)
        if (current == null) next()
    }

    fun clear() {
        handler.removeCallbacks(timeout)
        queue.clear()
        current = null
    }

    /** Chamado pelos callbacks do GATT quando a operação atual termina. */
    fun completeCurrent() {
        handler.removeCallbacks(timeout)
        current = null
        next()
    }

    fun findCharacteristic(uuid: UUID): BluetoothGattCharacteristic? =
        gatt?.services?.firstNotNullOfOrNull { it.getCharacteristic(uuid) }

    private fun next() {
        if (current != null) return
        val g = gatt ?: run { queue.clear(); return }
        val op = queue.removeFirstOrNull() ?: return
        current = op
        val started = try {
            execute(g, op)
        } catch (e: Exception) {
            Log.e(TAG, "Erro executando operação", e)
            false
        }
        if (started) {
            handler.postDelayed(timeout, TIMEOUT_MS)
        } else {
            if (op !is Op.Action) onError("Não foi possível iniciar ${describe(op)}")
            current = null
            handler.post { next() }
        }
    }

    /** Retorna true se a operação ficou aguardando callback. */
    @Suppress("DEPRECATION")
    private fun execute(g: BluetoothGatt, op: Op): Boolean {
        when (op) {
            is Op.Action -> {
                op.block()
                return false
            }
            is Op.Read -> {
                val ch = findCharacteristic(op.uuid) ?: return missing(op.uuid)
                return g.readCharacteristic(ch)
            }
            is Op.Write -> {
                val ch = findCharacteristic(op.uuid) ?: return missing(op.uuid)
                val supportsWithResponse = ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0
                val type = if (op.noResponse || !supportsWithResponse) {
                    BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                } else {
                    BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                }
                return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    g.writeCharacteristic(ch, op.value, type) == BluetoothStatusCodes.SUCCESS
                } else {
                    ch.writeType = type
                    ch.value = op.value
                    g.writeCharacteristic(ch)
                }
            }
            is Op.Notify -> {
                val ch = findCharacteristic(op.uuid) ?: return missing(op.uuid)
                if (!g.setCharacteristicNotification(ch, op.enable)) return false
                val descriptor = ch.getDescriptor(MiBandUuids.CCCD) ?: return false
                val value = when {
                    !op.enable -> BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
                    ch.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0 &&
                        ch.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0 ->
                        BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                    else -> BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                }
                return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    g.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS
                } else {
                    descriptor.value = value
                    g.writeDescriptor(descriptor)
                }
            }
        }
    }

    private fun describe(op: Op): String = when (op) {
        is Op.Read -> "leitura de ${op.uuid}"
        is Op.Write -> "escrita em ${op.uuid}"
        is Op.Notify -> "notificações de ${op.uuid}"
        is Op.Action -> "ação"
    }

    private fun missing(uuid: UUID): Boolean {
        onError("Característica não encontrada: $uuid")
        return false
    }

    companion object {
        private const val TAG = "GattQueue"
        private const val TIMEOUT_MS = 6_000L
    }
}
