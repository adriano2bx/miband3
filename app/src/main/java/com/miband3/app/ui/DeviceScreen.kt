package com.miband3.app.ui

import android.app.TimePickerDialog
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.miband3.app.BuildConfig
import com.miband3.app.ble.AlarmConfig
import com.miband3.app.ble.BandState
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.LogEntry
import com.miband3.app.ble.MessageType
import com.miband3.app.ble.MiBandManager
import com.miband3.app.ble.MiBandProtocol.Gender
import com.miband3.app.ble.UserProfile
import com.miband3.app.ble.MiBandProtocol.Days
import com.miband3.app.service.NotificationForwarder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private enum class Tab(val label: String, val icon: ImageVector) {
    DASHBOARD("Painel", Icons.Filled.Home),
    CHAT("Conversar", Icons.Filled.Email),
    ALARMS("Alarmes", Icons.Filled.DateRange),
    CLOUD("Nuvem", Icons.Filled.Share),
    SETTINGS("Ajustes", Icons.Filled.Settings),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceScreen() {
    val state by MiBandManager.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(Tab.DASHBOARD) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(state.name ?: "Mi Band 3")
                        Text(state.connection.label, style = MaterialTheme.typography.bodySmall)
                    }
                },
            )
        },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach {
                    NavigationBarItem(
                        selected = tab == it,
                        onClick = { tab = it },
                        icon = { Icon(it.icon, contentDescription = null) },
                        label = { Text(it.label) },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                Tab.DASHBOARD -> Dashboard(state)
                Tab.CHAT -> Chat(state)
                Tab.ALARMS -> Alarms()
                Tab.CLOUD -> CloudTab()
                Tab.SETTINGS -> SettingsTab(state)
            }
        }
    }

    if (state.awaitingTap) {
        AlertDialog(
            onDismissRequest = {},
            confirmButton = { TextButton(onClick = { MiBandManager.disconnect() }) { Text("Cancelar") } },
            title = { Text("Confirme na pulseira") },
            text = { Text("A pulseira vai vibrar. Toque na tela dela para autorizar o pareamento com este celular.") },
        )
    }
    if (state.findingPhone) {
        AlertDialog(
            onDismissRequest = { MiBandManager.stopFindPhone() },
            confirmButton = { Button(onClick = { MiBandManager.stopFindPhone() }) { Text("Encontrei!") } },
            title = { Text("Procurando o celular") },
            text = { Text("A pulseira pediu para encontrar este celular.") },
        )
    }
}

// ======================================================================= Painel

@Composable
private fun Dashboard(state: BandState) {
    val ready = state.connection == ConnectionState.READY
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val error = state.lastError
        if (error != null && state.connection == ConnectionState.DISCONNECTED) {
            ConnectionErrorCard(error)
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Conexão", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(state.connection)
                    Spacer(Modifier.width(8.dp))
                    Text(state.connection.label)
                    if (state.connection != ConnectionState.READY && state.connection != ConnectionState.DISCONNECTED) {
                        Spacer(Modifier.width(8.dp))
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    }
                }
                state.address?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                Spacer(Modifier.height(12.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.connection == ConnectionState.DISCONNECTED) {
                        Button(onClick = { MiBandManager.connectSaved() }) { Text("Conectar") }
                    } else {
                        OutlinedButton(onClick = { MiBandManager.disconnect() }) { Text("Desconectar") }
                    }
                    FilledTonalButton(onClick = { MiBandManager.vibrate() }, enabled = ready) { Text("Vibrar") }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatCard(
                "Bateria",
                state.battery?.let { "$it%" } ?: "—",
                if (state.charging) "carregando" else null,
                Modifier.weight(1f),
            )
            StatCard("Passos", state.steps?.toString() ?: "—", null, Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatCard(
                "Distância",
                state.meters?.let { if (it >= 1000) "%.2f km".format(it / 1000.0) else "$it m" } ?: "—",
                null,
                Modifier.weight(1f),
            )
            StatCard("Calorias", state.calories?.let { "$it kcal" } ?: "—", null, Modifier.weight(1f))
        }
        OutlinedButton(onClick = { MiBandManager.refreshActivity() }, enabled = ready) {
            Icon(Icons.Filled.Refresh, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Atualizar dados")
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Filled.Favorite, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.width(8.dp))
                    Text("Frequência cardíaca", style = MaterialTheme.typography.titleMedium)
                }
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        state.heartRate?.let { "$it bpm" } ?: "— bpm",
                        style = MaterialTheme.typography.displaySmall,
                        fontWeight = FontWeight.Bold,
                    )
                    if (state.measuringHeartRate) {
                        Spacer(Modifier.width(12.dp))
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Button(
                        onClick = { MiBandManager.measureHeartRate() },
                        enabled = ready && !state.measuringHeartRate,
                    ) { Text("Medir agora") }
                    Spacer(Modifier.weight(1f))
                    Text("Contínuo")
                    Spacer(Modifier.width(8.dp))
                    Switch(
                        checked = state.continuousHeartRate,
                        onCheckedChange = { MiBandManager.setContinuousHeartRate(it) },
                        enabled = ready,
                    )
                }
            }
        }

        if (state.firmware != null || state.hardware != null || state.serial != null) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text("Dispositivo", style = MaterialTheme.typography.titleMedium)
                    state.firmware?.let { Text("Firmware: $it") }
                    state.hardware?.let { Text("Hardware: $it") }
                    state.serial?.let { Text("Série: $it") }
                }
            }
        }
    }
}

@Composable
private fun ConnectionErrorCard(message: String) {
    val context = LocalContext.current
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
    ) {
        Column(Modifier.padding(16.dp)) {
            Text("Não foi possível conectar", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(8.dp))
            Text(message, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
                }) { Text("Abrir Bluetooth") }
                Button(onClick = { MiBandManager.connectSaved() }) { Text("Tentar novamente") }
            }
        }
    }
}

@Composable
private fun StatusDot(connection: ConnectionState) {
    val color = when (connection) {
        ConnectionState.READY -> MaterialTheme.colorScheme.primary
        ConnectionState.DISCONNECTED -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.tertiary
    }
    Box(Modifier.size(12.dp).background(color, RoundedCornerShape(50)))
}

@Composable
private fun StatCard(title: String, value: String, subtitle: String?, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.labelLarge)
            Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

// ======================================================================= Conversar

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Chat(state: BandState) {
    val log by MiBandManager.log.collectAsStateWithLifecycle()
    val ready = state.connection == ConnectionState.READY
    var type by rememberSaveable { mutableStateOf(MessageType.SMS) }
    var title by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()

    LaunchedEffect(log.size) {
        if (log.isNotEmpty()) listState.animateScrollToItem(log.size - 1)
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Histórico com a pulseira", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            val context = LocalContext.current
            IconButton(onClick = {
                val send = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, MiBandManager.logAsText())
                context.startActivity(Intent.createChooser(send, "Compartilhar histórico"))
            }) {
                Icon(Icons.Filled.Share, contentDescription = "Compartilhar histórico")
            }
            IconButton(onClick = { MiBandManager.clearLog() }) {
                Icon(Icons.Filled.Delete, contentDescription = "Limpar histórico")
            }
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (log.isEmpty()) {
                item { Text("Nada por aqui ainda. Envie uma mensagem ou interaja com a pulseira.") }
            }
            items(log) { ChatBubble(it) }
        }
        HorizontalDivider()
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MessageType.entries.forEach {
                    FilterChip(selected = type == it, onClick = { type = it }, label = { Text(it.label) })
                }
            }
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text(if (type == MessageType.CALL) "Nome de quem liga" else "Título / remetente") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (type != MessageType.CALL) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = body,
                        onValueChange = { body = it },
                        label = { Text("Mensagem") },
                        modifier = Modifier.weight(1f),
                        maxLines = 3,
                    )
                    IconButton(
                        onClick = {
                            MiBandManager.sendMessage(type, title.ifBlank { "Celular" }, body)
                            body = ""
                        },
                        enabled = ready && (title.isNotBlank() || body.isNotBlank()),
                    ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Enviar") }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { MiBandManager.sendMessage(MessageType.CALL, title.ifBlank { "Desconhecido" }, "") },
                        enabled = ready,
                    ) {
                        Icon(Icons.Filled.Call, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("Simular chamada")
                    }
                    OutlinedButton(onClick = { MiBandManager.stopCall() }, enabled = ready) { Text("Encerrar") }
                }
            }
        }
    }
}

@Composable
private fun ChatBubble(entry: LogEntry) {
    val time = remember(entry.time) { SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(entry.time)) }
    val bandColor = MaterialTheme.colorScheme.secondaryContainer
    val phoneColor = MaterialTheme.colorScheme.primaryContainer
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (entry.fromBand) Arrangement.Start else Arrangement.End,
    ) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .background(if (entry.fromBand) bandColor else phoneColor, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                (if (entry.fromBand) "Pulseira" else "Celular") + " · " + time,
                style = MaterialTheme.typography.labelSmall,
            )
            Text(entry.text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

// ======================================================================= Alarmes

@Composable
private fun Alarms() {
    val alarms by MiBandManager.alarms.collectAsStateWithLifecycle()
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "Os alarmes são gravados na própria pulseira e funcionam mesmo sem o celular por perto.",
            style = MaterialTheme.typography.bodyMedium,
        )
        alarms.forEach { AlarmCard(it) }
    }
}

private val dayLabels = listOf(
    Days.MONDAY to "S", Days.TUESDAY to "T", Days.WEDNESDAY to "Q", Days.THURSDAY to "Q",
    Days.FRIDAY to "S", Days.SATURDAY to "S", Days.SUNDAY to "D",
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AlarmCard(alarm: AlarmConfig) {
    val context = LocalContext.current
    var hour by remember(alarm) { mutableIntStateOf(alarm.hour) }
    var minute by remember(alarm) { mutableIntStateOf(alarm.minute) }
    var days by remember(alarm) { mutableIntStateOf(alarm.days) }
    var enabled by remember(alarm) { mutableStateOf(alarm.enabled) }
    val changed = hour != alarm.hour || minute != alarm.minute || days != alarm.days || enabled != alarm.enabled

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Alarme ${alarm.slot + 1}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Switch(checked = enabled, onCheckedChange = { enabled = it })
            }
            TextButton(onClick = {
                TimePickerDialog(context, { _, h, m -> hour = h; minute = m }, hour, minute, true).show()
            }) {
                Text("%02d:%02d".format(hour, minute), style = MaterialTheme.typography.displaySmall)
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                dayLabels.forEach { (bit, label) ->
                    FilterChip(
                        selected = days and bit != 0,
                        onClick = { days = days xor bit },
                        label = { Text(label) },
                    )
                }
            }
            Text(
                if (days and Days.EVERY_DAY == 0) "Toca apenas uma vez" else "Repete nos dias marcados",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = { MiBandManager.saveAlarm(AlarmConfig(alarm.slot, enabled, hour, minute, days)) },
                enabled = changed,
            ) { Text("Salvar na pulseira") }
        }
    }
}

// ======================================================================= Ajustes

@Composable
private fun SettingsTab(state: BandState) {
    val settings by MiBandManager.settings.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val ready = state.connection == ConnectionState.READY
    var listenerEnabled by remember { mutableStateOf(NotificationForwarder.isEnabled(context)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { listenerEnabled = NotificationForwarder.isEnabled(context) }
    var confirmForget by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ProfileCard(settings.profile, ready)

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Pulseira", style = MaterialTheme.typography.titleMedium)
                SettingSwitch("Relógio de 24 horas", settings.time24h) { MiBandManager.setTime24h(it) }
                SettingSwitch("Levantar o pulso para acender a tela", settings.liftWrist) { MiBandManager.setLiftWrist(it) }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = { MiBandManager.syncTime() }, enabled = ready) {
                    Text("Sincronizar data e hora")
                }
            }
        }

        if (BuildConfig.NOTIFICATION_FORWARDING) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Notifications, contentDescription = null)
                        Spacer(Modifier.width(8.dp))
                        Text("Notificações do celular", style = MaterialTheme.typography.titleMedium)
                    }
                    SettingSwitch("Encaminhar notificações para a pulseira", settings.forwardNotifications) {
                        MiBandManager.setForwardNotifications(it)
                    }
                    if (!listenerEnabled) {
                        Text(
                            "Para encaminhar notificações (WhatsApp, Telegram, chamadas...) é preciso liberar o acesso às notificações.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Spacer(Modifier.height(8.dp))
                        FilledTonalButton(onClick = {
                            context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                        }) { Text("Liberar acesso às notificações") }
                    } else {
                        Text("Acesso às notificações liberado.", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Pareamento", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Esquecer a pulseira remove o vínculo deste app. Para usar outra pulseira, esqueça a atual.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = { confirmForget = true }) { Text("Esquecer pulseira") }
            }
        }
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            confirmButton = {
                TextButton(onClick = { confirmForget = false; MiBandManager.forget() }) { Text("Esquecer") }
            },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("Cancelar") } },
            title = { Text("Esquecer pulseira?") },
            text = { Text("Você precisará parear novamente tocando na tela da pulseira.") },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProfileCard(profile: UserProfile, ready: Boolean) {
    var birthYear by remember(profile) { mutableStateOf(profile.birthYear.toString()) }
    var height by remember(profile) { mutableStateOf(profile.heightCm.toString()) }
    var weight by remember(profile) { mutableStateOf(profile.weightKg.toString()) }
    var goal by remember(profile) { mutableStateOf(profile.stepGoal.toString()) }
    var gender by remember(profile) { mutableIntStateOf(profile.gender) }
    var leftWrist by remember(profile) { mutableStateOf(profile.leftWrist) }

    val edited = UserProfile(
        birthYear = birthYear.toIntOrNull()?.coerceIn(1900, 2100) ?: profile.birthYear,
        gender = gender,
        heightCm = height.toIntOrNull()?.coerceIn(50, 250) ?: profile.heightCm,
        weightKg = weight.toIntOrNull()?.coerceIn(20, 300) ?: profile.weightKg,
        leftWrist = leftWrist,
        stepGoal = goal.toIntOrNull()?.coerceIn(100, 60000) ?: profile.stepGoal,
    )
    val numbers = KeyboardOptions(keyboardType = KeyboardType.Number)

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Perfil", style = MaterialTheme.typography.titleMedium)
            Text(
                "Usado pela pulseira para calcular calorias e distância. Enviá-lo também tira a pulseira da tela de pareamento.",
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    birthYear, { birthYear = it.filter(Char::isDigit).take(4) },
                    label = { Text("Ano nasc.") }, singleLine = true, keyboardOptions = numbers,
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    goal, { goal = it.filter(Char::isDigit).take(5) },
                    label = { Text("Meta de passos") }, singleLine = true, keyboardOptions = numbers,
                    modifier = Modifier.weight(1f),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    height, { height = it.filter(Char::isDigit).take(3) },
                    label = { Text("Altura (cm)") }, singleLine = true, keyboardOptions = numbers,
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    weight, { weight = it.filter(Char::isDigit).take(3) },
                    label = { Text("Peso (kg)") }, singleLine = true, keyboardOptions = numbers,
                    modifier = Modifier.weight(1f),
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(gender == Gender.MALE, { gender = Gender.MALE }, label = { Text("Masculino") })
                FilterChip(gender == Gender.FEMALE, { gender = Gender.FEMALE }, label = { Text("Feminino") })
                FilterChip(gender == Gender.OTHER, { gender = Gender.OTHER }, label = { Text("Outro") })
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(leftWrist, { leftWrist = true }, label = { Text("Pulso esquerdo") })
                FilterChip(!leftWrist, { leftWrist = false }, label = { Text("Pulso direito") })
            }
            Button(onClick = { MiBandManager.saveProfile(edited) }, enabled = edited != profile || ready) {
                Text(if (ready) "Salvar e enviar à pulseira" else "Salvar")
            }
        }
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
