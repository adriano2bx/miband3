package com.miband3.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Bluetooth
import androidx.compose.material.icons.outlined.CloudQueue
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.Vibration
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.miband3.app.R
import com.miband3.app.ble.Branding
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.CloudClient
import com.miband3.app.cloud.CloudStatus
import com.miband3.app.tech.AuthorizeState
import com.miband3.app.tech.ConfigLoad
import com.miband3.app.tech.TechSession
import com.miband3.app.tech.TechUi
import com.miband3.app.tech.TechViewModel
import com.miband3.app.tech.TestId
import com.miband3.app.tech.TestResult
import com.miband3.app.tech.TestState
import com.miband3.app.ui.components.BiosenseCard
import com.miband3.app.ui.components.CardDivider
import com.miband3.app.ui.components.InfoRow
import com.miband3.app.ui.components.NoticeCard
import com.miband3.app.ui.components.PrimaryButton
import com.miband3.app.ui.components.ScreenLayout
import com.miband3.app.ui.components.SectionLabel
import com.miband3.app.ui.components.SecondaryButton
import com.miband3.app.ui.components.StatusDot
import com.miband3.app.ui.theme.BType
import com.miband3.app.ui.theme.Tokens
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun TechAreaScreen(
    onEnd: () -> Unit,
    // Um ViewModel por sessão: registro e resultados de testes não passam de uma sessão para outra.
    vm: TechViewModel = viewModel(key = "tech-" + (TechSession.session.value?.token?.takeLast(12) ?: "none")),
) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableStateOf(1) }

    ScreenLayout(
        onBack = { vm.endSession(); onEnd() },
        // Qualquer toque conta como atividade (sem consumir o evento).
        modifier = Modifier.pointerInput(Unit) {
            awaitPointerEventScope {
                while (true) {
                    awaitPointerEvent(PointerEventPass.Initial)
                    TechSession.touch()
                }
            }
        },
        bottom = { SecondaryButton(stringResource(R.string.tech_end_session), onClick = { vm.endSession(); onEnd() }) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(stringResource(R.string.tech_area_label), style = BType.secondary)
            Text(stringResource(R.string.tech_area_title), style = BType.screenTitle)
        }
        TabRow(
            selectedTabIndex = tab,
            containerColor = Tokens.Background,
            contentColor = Tokens.Primary,
            indicator = { positions -> TabRowDefaults.SecondaryIndicator(Modifier.tabIndicatorOffset(positions[tab]), color = Tokens.Primary) },
            divider = { androidx.compose.material3.HorizontalDivider(color = Tokens.Outline) },
        ) {
            listOf(R.string.tech_tab_config, R.string.tech_tab_tests).forEachIndexed { i, label ->
                Tab(
                    selected = tab == i,
                    onClick = { tab = i },
                    text = { Text(stringResource(label), style = BType.section.copy(color = if (tab == i) Tokens.Primary else Tokens.TextSecondary)) },
                )
            }
        }
        if (tab == 0) ConfigTab(ui, vm) else TestsTab(ui, vm)
    }
}

private fun formatDate(ms: Long?): String =
    ms?.let { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT, Locale.getDefault()).format(Date(it)) } ?: "—"

@Composable
private fun hrLabel(minutes: Int): String =
    if (minutes == 0) stringResource(R.string.tech_hr_continuous) else stringResource(R.string.tech_every_min, minutes)

@Composable
private fun ServiceValue() {
    val cloud by CloudClient.state.collectAsStateWithLifecycle()
    val (label, color) = when (cloud.status) {
        CloudStatus.ONLINE -> R.string.tech_service_online to Tokens.Primary
        CloudStatus.CONNECTING -> R.string.tech_service_connecting to Tokens.Warning
        CloudStatus.REJECTED -> R.string.tech_service_rejected to Tokens.Error
        CloudStatus.DISABLED -> R.string.tech_service_disabled to Tokens.TextSecondary
    }
    InfoRow(stringResource(R.string.tech_service), stringResource(label), leading = { StatusDot(color) })
}

@Composable
private fun SyncRow(syncing: Boolean, onSync: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(8.dp))
            .clickable(enabled = !syncing, role = Role.Button, onClick = onSync),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (syncing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Tokens.Primary)
        else Icon(Icons.Outlined.Sync, contentDescription = null, tint = Tokens.Primary)
        Spacer(Modifier.width(12.dp))
        Text(stringResource(R.string.tech_sync_config), style = BType.body.copy(color = Tokens.Primary), modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = Tokens.Primary)
    }
}

// ====================================================================== Configuração

@Composable
private fun ConfigTab(ui: TechUi, vm: TechViewModel) {
    val band by MiBandManager.state.collectAsStateWithLifecycle()
    when (val c = ui.config) {
        ConfigLoad.Loading -> Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Tokens.Primary)
            Spacer(Modifier.width(12.dp))
            Text(stringResource(R.string.tech_loading_config), style = BType.secondary)
        }
        is ConfigLoad.Failed -> NoticeCard(
            Icons.Outlined.ErrorOutline, stringResource(R.string.tech_config_failed), stringResource(c.message),
            action = { SecondaryButton(stringResource(R.string.action_retry), onClick = { vm.loadConfig() }) },
        )
        is ConfigLoad.Loaded -> {
            val info = c.data.info
            BiosenseCard {
                Text(stringResource(R.string.tech_installation_card), style = BType.section)
                Spacer(Modifier.size(8.dp))
                InfoRow(stringResource(R.string.tech_device), "${Branding.PRODUCT_NAME}${band.address?.let { " · ${it.takeLast(5)}" } ?: ""}")
                InfoRow(stringResource(R.string.tech_installation_id), info.deviceId ?: "—")
                InfoRow(stringResource(R.string.tech_participant), info.participantRef ?: stringResource(R.string.tech_participant_none))
                InfoRow(
                    stringResource(R.string.tech_authorization),
                    stringResource(
                        when (info.status) {
                            "active" -> R.string.tech_auth_active
                            "revoked" -> R.string.tech_auth_revoked
                            else -> R.string.tech_auth_pending
                        },
                    ),
                    valueColor = if (info.status == "active") Tokens.Primary else Tokens.Warning,
                )
                InfoRow(
                    stringResource(R.string.tech_consent),
                    if (info.consent.valid) stringResource(R.string.tech_consent_valid, info.consent.acceptedVersion ?: "—")
                    else stringResource(R.string.tech_consent_invalid, info.consent.currentVersion ?: "—"),
                )
                ServiceValue()
                InfoRow(stringResource(R.string.tech_band_state), band.connection.label)
                InfoRow(stringResource(R.string.tech_technician), c.data.technicianName)
            }
            BiosenseCard {
                Text(stringResource(R.string.tech_profile_card), style = BType.section)
                Spacer(Modifier.size(8.dp))
                info.config?.let { cfg ->
                    InfoRow(stringResource(R.string.tech_profile_hr), hrLabel(cfg.hrIntervalMin))
                    InfoRow(stringResource(R.string.tech_profile_history), stringResource(R.string.tech_every_min, cfg.historyIntervalMin))
                }
                InfoRow(stringResource(R.string.tech_profile_version), (info.configVersion ?: 0).toString())
                InfoRow(stringResource(R.string.tech_profile_updated), formatDate(info.configUpdatedAt))
                InfoRow(stringResource(R.string.tech_profile_synced), formatDate(c.syncedAtMs))
                CardDivider()
                SyncRow(ui.syncing) { vm.loadConfig(sync = true) }
            }
            if (info.status == "pending") AuthorizeCard(ui, vm, canProvision = "provision" in c.data.scopes)
        }
    }
}

@Composable
private fun AuthorizeCard(ui: TechUi, vm: TechViewModel, canProvision: Boolean) {
    var ref by rememberSaveable { mutableStateOf("") }
    BiosenseCard {
        Text(stringResource(R.string.tech_authorize_title), style = BType.section)
        Spacer(Modifier.size(4.dp))
        Text(stringResource(if (canProvision) R.string.tech_authorize_text else R.string.tech_authorize_no_scope), style = BType.secondary)
        if (canProvision) {
            Spacer(Modifier.size(12.dp))
            OutlinedTextField(
                value = ref,
                onValueChange = { ref = it.take(120) },
                label = { Text(stringResource(R.string.tech_participant_ref)) },
                singleLine = true,
                enabled = ui.authorize != AuthorizeState.SAVING,
                modifier = Modifier.fillMaxWidth(),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Tokens.Primary, unfocusedBorderColor = Tokens.Outline, focusedLabelColor = Tokens.Primary),
            )
            Spacer(Modifier.size(12.dp))
            PrimaryButton(
                stringResource(R.string.tech_authorize_action),
                onClick = { vm.authorize(ref) },
                enabled = ref.isNotBlank(),
                loading = ui.authorize == AuthorizeState.SAVING,
            )
            ui.authorizeError?.let {
                Spacer(Modifier.size(8.dp))
                Text(stringResource(it), style = BType.secondary.copy(color = Tokens.Error))
            }
        }
    }
}

// ====================================================================== Testes

@Composable
private fun TestsTab(ui: TechUi, vm: TechViewModel) {
    val band by MiBandManager.state.collectAsStateWithLifecycle()
    val cloud by CloudClient.state.collectAsStateWithLifecycle()
    val ready = band.connection == ConnectionState.READY
    val loaded = ui.config as? ConfigLoad.Loaded

    BiosenseCard {
        Text(stringResource(R.string.tech_current_config), style = BType.section)
        Spacer(Modifier.size(8.dp))
        InfoRow(stringResource(R.string.tech_device), Branding.PRODUCT_NAME)
        InfoRow(
            stringResource(R.string.tech_collection),
            loaded?.data?.info?.config?.let { stringResource(R.string.tech_collection_value, hrLabel(it.hrIntervalMin)) } ?: stringResource(R.string.tech_collection_unknown),
        )
        ServiceValue()
        CardDivider()
        SyncRow(ui.syncing) { vm.loadConfig(sync = true) }
    }

    SectionLabel(stringResource(R.string.tech_tests_title))
    BiosenseCard(padding = 8.dp) {
        val unavailable = stringResource(R.string.test_band_not_ready)
        TestRow(Icons.Outlined.Bluetooth, R.string.test_bluetooth, R.string.test_action_check, ui.tests.getValue(TestId.BLUETOOTH), enabled = true) { vm.run(TestId.BLUETOOTH) }
        CardDivider()
        TestRow(
            Icons.Outlined.Vibration, R.string.test_vibration, R.string.test_action_test, ui.tests.getValue(TestId.VIBRATION),
            enabled = ready && System.currentTimeMillis() >= ui.vibrationCooldownUntil,
            disabledReason = if (!ready) unavailable else null,
        ) { vm.run(TestId.VIBRATION) }
        CardDivider()
        TestRow(Icons.Outlined.FavoriteBorder, R.string.test_heart_rate, R.string.test_action_measure, ui.tests.getValue(TestId.HEART_RATE), enabled = ready, disabledReason = if (!ready) unavailable else null) { vm.run(TestId.HEART_RATE) }
        CardDivider()
        TestRow(Icons.Outlined.Description, R.string.test_history, R.string.test_action_sync, ui.tests.getValue(TestId.HISTORY), enabled = ready, disabledReason = if (!ready) unavailable else null) { vm.run(TestId.HISTORY) }
        CardDivider()
        TestRow(
            Icons.Outlined.CloudQueue, R.string.test_cloud, R.string.test_action_test, ui.tests.getValue(TestId.CLOUD),
            enabled = cloud.status != CloudStatus.DISABLED,
        ) { vm.run(TestId.CLOUD) }
    }

    BiosenseCard {
        Text(stringResource(R.string.tech_log_title), style = BType.section)
        Spacer(Modifier.size(8.dp))
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Tokens.Background).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (ui.log.isEmpty()) {
                Text(stringResource(R.string.tech_log_empty), style = BType.secondary)
            } else {
                val fmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
                ui.log.asReversed().forEach { line ->
                    Text("${fmt.format(Date(line.atMs))}  •  ${line.text}", style = BType.mono)
                }
            }
        }
    }
}

@Composable
private fun TestRow(
    icon: ImageVector,
    label: Int,
    action: Int,
    result: TestResult,
    enabled: Boolean,
    disabledReason: String? = null,
    onRun: () -> Unit,
) {
    val running = result.state == TestState.RUNNING
    Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 48.dp)) {
            Icon(icon, contentDescription = null, tint = Tokens.TextPrimary, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) {}) {
                Text(stringResource(label), style = BType.body)
                val stateText = when (result.state) {
                    TestState.IDLE -> disabledReason?.takeIf { !enabled }
                    TestState.RUNNING -> stringResource(R.string.test_state_running)
                    TestState.UNSUPPORTED -> stringResource(R.string.test_state_unsupported)
                    else -> result.detail
                }
                if (stateText != null) {
                    Text(
                        stateText,
                        style = BType.secondary.copy(
                            color = when (result.state) {
                                TestState.DONE -> Tokens.Primary
                                TestState.FAILED -> Tokens.Error
                                TestState.EXPIRED -> Tokens.Warning
                                else -> Tokens.TextSecondary
                            },
                        ),
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            OutlinedButton(
                onClick = onRun,
                enabled = enabled && !running,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.heightIn(min = 48.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, if (enabled && !running) Tokens.Primary else Tokens.Outline),
            ) {
                if (running) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Tokens.Primary)
                else Text(stringResource(action), style = BType.body.copy(color = if (enabled) Tokens.Primary else Tokens.TextSecondary))
            }
        }
    }
}
