package com.miband3.app.cloud

import com.miband3.app.ble.AlarmConfig
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.MessageType
import com.miband3.app.ble.MiBandManager

/** Resultado de um comando: `error == null` significa sucesso. */
class CommandResult(val error: String? = null, val info: String? = null) {
    val ok: Boolean get() = error == null
}

/**
 * Traduz os comandos vindos da nuvem em chamadas ao [MiBandManager].
 * Os parâmetros já foram validados e preenchidos com valores padrão pelo servidor.
 * Deve ser chamado na thread principal.
 */
object CommandExecutor {
    fun execute(command: CloudCommand, done: (CommandResult) -> Unit) {
        if (MiBandManager.state.value.connection != ConnectionState.READY) {
            return done(CommandResult(error = "pulseira desconectada do celular"))
        }
        val p = command.params
        try {
            when (command.type) {
                "vibrate" -> {
                    MiBandManager.vibratePattern(
                        count = p.optInt("count", 1),
                        durationMs = p.optLong("durationMs", 800),
                        pauseMs = p.optLong("pauseMs", 500),
                        high = p.optString("level", "high") != "mild",
                    )
                    done(CommandResult())
                }
                "message" -> {
                    val type = when (p.optString("kind", "app")) {
                        "sms" -> MessageType.SMS
                        "call" -> MessageType.CALL
                        "email" -> MessageType.EMAIL
                        else -> MessageType.APP
                    }
                    MiBandManager.sendMessage(type, p.optString("title"), p.optString("body"))
                    done(CommandResult())
                }
                "stop_call" -> { MiBandManager.stopCall(); done(CommandResult()) }
                "measure_hr" -> { MiBandManager.measureHeartRate(); done(CommandResult()) }
                "hr_continuous" -> { MiBandManager.setContinuousHeartRate(p.optBoolean("enabled")); done(CommandResult()) }
                "sync_time" -> { MiBandManager.syncTime(); done(CommandResult()) }
                "refresh" -> { MiBandManager.refreshActivity(); done(CommandResult()) }
                "fetch_history" -> {
                    val since = if (p.has("sinceMs")) p.optLong("sinceMs") else null
                    MiBandManager.fetchHistory(since) { ok, msg ->
                        done(if (ok) CommandResult(info = msg) else CommandResult(error = msg))
                    }
                }
                "set_alarm" -> {
                    MiBandManager.saveAlarm(
                        AlarmConfig(
                            slot = p.getInt("slot"),
                            enabled = p.getBoolean("enabled"),
                            hour = p.getInt("hour"),
                            minute = p.getInt("minute"),
                            days = p.optInt("days", 127),
                        ),
                    )
                    done(CommandResult())
                }
                else -> done(CommandResult(error = "comando não suportado por esta versão do app: ${command.type}"))
            }
        } catch (e: Exception) {
            done(CommandResult(error = "erro executando ${command.type}: ${e.message}"))
        }
    }
}
