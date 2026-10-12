package com.miband3.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.CloudClient
import com.miband3.app.cloud.CloudConfig
import com.miband3.app.cloud.CloudStatus
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Configuração do envio de dados em tempo real para o serviço na nuvem. */
@Composable
fun CloudTab() {
    val config by CloudClient.config.collectAsStateWithLifecycle()
    val cloud by CloudClient.state.collectAsStateWithLifecycle()
    val band by MiBandManager.state.collectAsStateWithLifecycle()

    var url by remember { mutableStateOf(config.serverUrl) }
    var token by remember { mutableStateOf(config.deviceToken) }
    val dirty = url.trim() != config.serverUrl || token.trim() != config.deviceToken
    val urlValid = url.isBlank() || CloudConfig.toWebSocketUrl(url) != null

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Monitoramento na nuvem", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Envia em tempo real frequência cardíaca, passos, bateria, eventos e sono ao serviço do seu " +
                        "cuidador/clínica, e permite que ele faça a pulseira vibrar ou mostre mensagens.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Enviar dados à nuvem", Modifier.weight(1f))
                    Switch(checked = config.enabled, onCheckedChange = { CloudClient.updateConfig(config.copy(enabled = it)) })
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Medir FC continuamente ao conectar", Modifier.weight(1f))
                    Switch(checked = config.autoHeartRate, onCheckedChange = { CloudClient.updateConfig(config.copy(autoHeartRate = it)) })
                }
                Text("A medição contínua consome mais bateria da pulseira.", style = MaterialTheme.typography.bodySmall)
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Servidor", style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("Endereço (ex.: miband3-cloud.seu-usuario.workers.dev)") },
                    isError = !urlValid,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = token,
                    onValueChange = { token = it },
                    label = { Text("Token do dispositivo (mbd_…)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "O token é gerado no serviço ao cadastrar a pulseira (POST /v1/devices) e vale só para ela.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(
                    onClick = { CloudClient.updateConfig(config.copy(serverUrl = url.trim(), deviceToken = token.trim())) },
                    enabled = dirty && urlValid,
                ) { Text("Salvar") }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Estado", style = MaterialTheme.typography.titleMedium)
                Text("Nuvem: ${cloud.status.label}")
                cloud.detail?.let {
                    Text(
                        it,
                        color = if (cloud.status == CloudStatus.ERROR) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Text("Pulseira: ${band.connection.label}")
                Text("Aguardando envio: ${cloud.queued}")
                cloud.lastSentMs?.let { Text("Último envio: ${SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(it))}") }
                Text("Comandos recebidos: ${cloud.commandsHandled}")
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = { CloudClient.syncHistoryNow() },
                    enabled = cloud.status == CloudStatus.ONLINE && band.connection == ConnectionState.READY,
                ) { Text("Baixar histórico de sono/atividade agora") }
            }
        }
    }
}
