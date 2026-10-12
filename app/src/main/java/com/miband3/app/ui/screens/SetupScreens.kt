package com.miband3.app.ui.screens

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bluetooth
import androidx.compose.material.icons.outlined.BluetoothDisabled
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudQueue
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.NearMe
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.miband3.app.R
import com.miband3.app.ble.Branding
import com.miband3.app.ble.ConnectionState
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.CloudClient
import com.miband3.app.cloud.CloudStatus
import com.miband3.app.data.InstallationStore
import com.miband3.app.status.bluetoothPermissions
import com.miband3.app.status.hasBluetoothPermissions
import com.miband3.app.ui.components.BiosenseCard
import com.miband3.app.ui.components.CardDivider
import com.miband3.app.ui.components.FeatureRow
import com.miband3.app.ui.components.GuidedStepIndicator
import com.miband3.app.ui.components.IconBadge
import com.miband3.app.ui.components.NoticeCard
import com.miband3.app.ui.components.PrimaryButton
import com.miband3.app.ui.components.ScreenLayout
import com.miband3.app.ui.components.ScreenTitle
import com.miband3.app.ui.components.SecondaryButton
import com.miband3.app.ui.theme.BType
import com.miband3.app.ui.theme.Tokens
import kotlinx.coroutines.delay

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private fun openAppSettings(context: Context) {
    context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}

// ====================================================================== Etapa 1

enum class PermissionOutcome { UNKNOWN, DENIED, PERMANENTLY_DENIED }

@Composable
fun SetupPrepareScreen(onReady: () -> Unit) {
    val context = LocalContext.current
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refresh++ }
    val btOn by MiBandManager.bluetoothOn.collectAsStateWithLifecycle()
    val granted = remember(refresh) { hasBluetoothPermissions(context) }
    var outcome by rememberSaveable { mutableStateOf(PermissionOutcome.UNKNOWN) }

    val enableBt = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { refresh++ }
    val requestPerms = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        refresh++
        val btGranted = bluetoothPermissions().all { result[it] == true || hasBluetoothPermissions(context) }
        outcome = when {
            btGranted -> PermissionOutcome.UNKNOWN
            // Sem justificativa após negar = "não perguntar de novo": só pelas configurações.
            bluetoothPermissions().none { p -> context.findActivity()?.shouldShowRequestPermissionRationale(p) == true } -> PermissionOutcome.PERMANENTLY_DENIED
            else -> PermissionOutcome.DENIED
        }
    }

    LaunchedEffect(granted, btOn) {
        if (granted && btOn && outcome != PermissionOutcome.UNKNOWN) outcome = PermissionOutcome.UNKNOWN
    }

    SetupPrepareContent(
        bluetoothOn = btOn,
        permissionGranted = granted,
        outcome = outcome,
        onPrimary = {
            when {
                !granted -> {
                    val perms = bluetoothPermissions().toMutableList()
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) perms += Manifest.permission.POST_NOTIFICATIONS
                    requestPerms.launch(perms.toTypedArray())
                }
                !btOn -> enableBt.launch(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE))
                else -> onReady()
            }
        },
        onOpenSettings = { openAppSettings(context) },
    )
}

@Composable
fun SetupPrepareContent(
    bluetoothOn: Boolean,
    permissionGranted: Boolean,
    outcome: PermissionOutcome,
    onPrimary: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val btOn = bluetoothOn
    val granted = permissionGranted
    ScreenLayout(
        bottom = {
            if (outcome == PermissionOutcome.PERMANENTLY_DENIED && !granted) {
                PrimaryButton(stringResource(R.string.setup_open_settings), onClick = onOpenSettings)
            } else {
                PrimaryButton(
                    text = stringResource(if (granted && btOn) R.string.action_continue else R.string.setup_allow_continue),
                    onClick = onPrimary,
                )
            }
        },
    ) {
        GuidedStepIndicator(1)
        ScreenTitle(stringResource(R.string.setup1_title), stringResource(R.string.setup1_subtitle))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Box(Modifier.size(88.dp).clip(RoundedCornerShape(20.dp)).background(Tokens.PrimarySoft), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Bluetooth, contentDescription = null, tint = Tokens.Primary, modifier = Modifier.size(44.dp))
            }
        }
        BiosenseCard {
            FeatureRow(
                if (btOn) Icons.Outlined.Bluetooth else Icons.Outlined.BluetoothDisabled,
                stringResource(R.string.setup1_bt_title),
                stringResource(if (btOn) R.string.setup1_bt_on else R.string.setup1_bt_text),
                trailing = { if (btOn) DoneIcon() },
            )
            CardDivider()
            FeatureRow(
                Icons.Outlined.NearMe,
                stringResource(R.string.setup1_perm_title),
                stringResource(if (granted) R.string.setup1_perm_granted else R.string.setup1_perm_text),
                trailing = { if (granted) DoneIcon() },
            )
        }
        Text(stringResource(R.string.setup1_hint), style = BType.secondary)
        when {
            outcome == PermissionOutcome.PERMANENTLY_DENIED && !granted -> NoticeCard(
                Icons.Outlined.ErrorOutline, stringResource(R.string.setup1_denied_title), stringResource(R.string.setup1_denied_permanent),
                tint = Tokens.Warning, background = Tokens.WarningSoft,
            )
            outcome == PermissionOutcome.DENIED && !granted -> NoticeCard(
                Icons.Outlined.ErrorOutline, stringResource(R.string.setup1_denied_title), stringResource(R.string.setup1_denied_text),
                tint = Tokens.Warning, background = Tokens.WarningSoft,
            )
        }
    }
}

@Composable
private fun DoneIcon() {
    Icon(Icons.Outlined.CheckCircle, contentDescription = stringResource(R.string.state_done), tint = Tokens.Primary)
}

// ====================================================================== Etapa 2

@Composable
fun SetupSelectScreen(onBack: () -> Unit, onConnect: () -> Unit) {
    val scanning by MiBandManager.scanning.collectAsStateWithLifecycle()
    val results by MiBandManager.scanResults.collectAsStateWithLifecycle()
    val btOn by MiBandManager.bluetoothOn.collectAsStateWithLifecycle()
    // Só pulseiras compatíveis com o protocolo implementado; nunca uma lista fictícia.
    val devices = results.filter { it.looksLikeMiBand }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var scanStarted by remember { mutableStateOf(false) }

    DisposableEffect(btOn) {
        if (btOn) {
            MiBandManager.startScan()
            scanStarted = true
        }
        onDispose { MiBandManager.stopScan() }
    }
    // A pulseira escolhida sumiu da nova busca: desfaz a seleção.
    LaunchedEffect(devices, scanning) {
        if (selected != null && devices.none { it.address == selected } && !scanning) selected = null
    }

    SetupSelectContent(
        bluetoothOn = btOn,
        scanning = scanning,
        scanStarted = scanStarted,
        addresses = devices.map { it.address },
        selected = selected,
        onSelect = { selected = it },
        onBack = onBack,
        onConnect = {
            val address = selected ?: return@SetupSelectContent
            MiBandManager.stopScan()
            MiBandManager.connect(address, Branding.PRODUCT_NAME)
            onConnect()
        },
        onRescan = {
            selected = null
            MiBandManager.startScan()
        },
    )
}

@Composable
fun SetupSelectContent(
    bluetoothOn: Boolean,
    scanning: Boolean,
    scanStarted: Boolean,
    addresses: List<String>,
    selected: String?,
    onSelect: (String) -> Unit,
    onBack: () -> Unit,
    onConnect: () -> Unit,
    onRescan: () -> Unit,
) {
    val btOn = bluetoothOn
    ScreenLayout(
        onBack = onBack,
        bottom = {
            PrimaryButton(stringResource(R.string.setup2_connect), onClick = onConnect, enabled = selected != null && btOn)
            SecondaryButton(stringResource(R.string.setup2_rescan), onClick = onRescan, enabled = !scanning && btOn)
        },
    ) {
        GuidedStepIndicator(2)
        ScreenTitle(stringResource(R.string.setup2_title), stringResource(R.string.setup2_subtitle))
        when {
            !btOn -> NoticeCard(Icons.Outlined.BluetoothDisabled, stringResource(R.string.status_bluetooth_off_title), stringResource(R.string.status_bluetooth_off_message), tint = Tokens.Warning, background = Tokens.WarningSoft)
            scanning -> BiosenseCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = Tokens.Primary)
                    Spacer(Modifier.width(16.dp))
                    Text(stringResource(R.string.setup2_searching), style = BType.body.copy(color = Tokens.TextSecondary))
                }
            }
            scanStarted && addresses.isEmpty() -> NoticeCard(
                Icons.Outlined.SearchOff, stringResource(R.string.setup2_none_title), stringResource(R.string.setup2_none_text),
                tint = Tokens.Warning, background = Tokens.WarningSoft,
            )
        }
        addresses.forEach { address ->
            val isSelected = selected == address
            BiosenseCard(
                modifier = Modifier.selectable(selected = isSelected, role = Role.RadioButton, onClick = { onSelect(address) }),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = 48.dp)) {
                    RadioButton(selected = isSelected, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = Tokens.Primary))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(Branding.PRODUCT_NAME, style = BType.section)
                        // Final do endereço Bluetooth: distingue pulseiras sem dados pessoais.
                        Text(stringResource(R.string.setup2_device_id, address.takeLast(5)), style = BType.secondary)
                    }
                    Icon(Icons.Outlined.Bluetooth, contentDescription = null, tint = Tokens.Primary)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Info, contentDescription = null, tint = Tokens.TextSecondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text(stringResource(R.string.setup2_confirm_hint), style = BType.secondary)
        }
    }
}

// ====================================================================== Etapa 3

private const val HANDSHAKE_TIMEOUT_MS = 60_000L

/** Estado mostrado na etapa 3 (derivado da pulseira e da nuvem). */
data class ConfirmUi(
    val bandReady: Boolean,
    val awaitingTap: Boolean,
    val authenticating: Boolean,
    val failed: Boolean,
    val timedOut: Boolean,
    val hasErrorDetail: Boolean,
    val serviceReady: Boolean,
    val serviceConnecting: Boolean,
    val serviceRejected: Boolean,
    val serviceUnavailable: Boolean,
    val authorized: Boolean,
    val canFinish: Boolean,
)

@Composable
fun SetupConfirmScreen(onBack: () -> Unit, onChooseAnother: () -> Unit, onFinished: () -> Unit) {
    val band by MiBandManager.state.collectAsStateWithLifecycle()
    val cloud by CloudClient.state.collectAsStateWithLifecycle()
    val install by InstallationStore.state.collectAsStateWithLifecycle()
    var attemptStart by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var timedOut by remember { mutableStateOf(false) }

    val bandReady = band.connection == ConnectionState.READY
    val serviceReady = cloud.status == CloudStatus.ONLINE
    val failed = !bandReady && (band.authRejected || (band.connection == ConnectionState.DISCONNECTED && !band.retrying))

    LaunchedEffect(attemptStart, bandReady) {
        timedOut = false
        if (!bandReady) {
            delay(HANDSHAKE_TIMEOUT_MS)
            if (MiBandManager.state.value.connection != ConnectionState.READY) timedOut = true
        }
    }

    SetupConfirmContent(
        ui = ConfirmUi(
            bandReady = bandReady,
            awaitingTap = band.awaitingTap,
            authenticating = band.connection == ConnectionState.AUTHENTICATING,
            failed = failed,
            timedOut = timedOut,
            hasErrorDetail = band.lastError != null,
            serviceReady = serviceReady,
            serviceConnecting = cloud.status == CloudStatus.CONNECTING && cloud.failures < 2,
            serviceRejected = cloud.status == CloudStatus.REJECTED,
            serviceUnavailable = cloud.failures >= 2,
            authorized = install.authorized,
            // Só com pulseira autenticada e serviço conectado; o vínculo (pulseira salva) já está persistido.
            canFinish = bandReady && serviceReady && MiBandManager.savedAddress != null,
        ),
        onBack = onBack,
        onRetry = {
            attemptStart = System.currentTimeMillis()
            MiBandManager.connectSaved()
        },
        onChooseAnother = {
            MiBandManager.forget()
            onChooseAnother()
        },
        onFinish = {
            InstallationStore.update { it.copy(setupComplete = true) }
            MiBandManager.keepTrying = true
            CloudClient.start()
            onFinished()
        },
    )
}

@Composable
fun SetupConfirmContent(ui: ConfirmUi, onBack: () -> Unit, onRetry: () -> Unit, onChooseAnother: () -> Unit, onFinish: () -> Unit) {
    val stuck = (ui.failed || ui.timedOut) && !ui.bandReady
    ScreenLayout(
        onBack = onBack,
        bottom = {
            if (stuck) {
                PrimaryButton(stringResource(R.string.action_retry), onClick = onRetry)
                SecondaryButton(stringResource(R.string.setup3_choose_another), onClick = onChooseAnother)
            } else {
                PrimaryButton(stringResource(R.string.setup3_finish), onClick = onFinish, enabled = ui.canFinish)
            }
        },
    ) {
        GuidedStepIndicator(3)
        ScreenTitle(
            stringResource(R.string.setup3_title),
            stringResource(
                when {
                    ui.bandReady -> R.string.setup3_subtitle_done
                    ui.awaitingTap -> R.string.setup3_subtitle_tap
                    else -> R.string.setup3_subtitle_wait
                },
            ),
        )
        // A ilustração só aparece quando o handshake real pede o toque na pulseira.
        if (ui.awaitingTap && !ui.bandReady) TapIllustration()

        BiosenseCard {
            StepRow(
                done = ui.bandReady,
                running = !ui.bandReady && !ui.failed && !ui.timedOut,
                failed = stuck,
                title = stringResource(R.string.setup3_band_title),
                detail = stringResource(
                    when {
                        ui.bandReady -> R.string.setup3_band_done
                        ui.awaitingTap -> R.string.setup3_band_tap
                        ui.timedOut -> R.string.setup3_band_timeout
                        ui.failed -> R.string.setup3_band_failed
                        ui.authenticating -> R.string.setup3_band_authenticating
                        else -> R.string.setup3_band_connecting
                    },
                ),
            )
            CardDivider()
            StepRow(
                done = ui.serviceReady,
                running = !ui.serviceReady && ui.serviceConnecting,
                failed = ui.serviceRejected,
                title = stringResource(R.string.setup3_service_title),
                detail = stringResource(
                    when {
                        ui.serviceReady && !ui.authorized -> R.string.setup3_service_pending_authorization
                        ui.serviceReady -> R.string.setup3_service_done
                        ui.serviceRejected -> R.string.status_not_authorized_message
                        ui.serviceUnavailable -> R.string.setup3_service_unavailable
                        else -> R.string.setup3_service_connecting
                    },
                ),
            )
            if (ui.bandReady && ui.serviceReady) {
                CardDivider()
                Text(stringResource(R.string.setup3_ready), style = BType.secondary)
            }
        }
        if (ui.failed && ui.hasErrorDetail) {
            NoticeCard(Icons.Outlined.ErrorOutline, stringResource(R.string.setup3_band_failed), stringResource(R.string.setup3_failed_help))
        }
    }
}

@Composable
private fun StepRow(done: Boolean, running: Boolean, failed: Boolean, title: String, detail: String) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics(mergeDescendants = true) {}) {
        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
            when {
                done -> Icon(Icons.Outlined.CheckCircle, contentDescription = stringResource(R.string.state_done), tint = Tokens.Primary, modifier = Modifier.size(28.dp))
                failed -> Icon(Icons.Outlined.ErrorOutline, contentDescription = stringResource(R.string.state_failed), tint = Tokens.Error, modifier = Modifier.size(28.dp))
                running -> CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp, color = Tokens.Primary)
                else -> Icon(Icons.Outlined.HourglassEmpty, contentDescription = stringResource(R.string.state_pending), tint = Tokens.TextSecondary, modifier = Modifier.size(24.dp))
            }
        }
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = BType.section)
            Text(detail, style = BType.secondary)
        }
    }
}

/** Desenho simples da pulseira com indicação de toque na tela (contornos, sem imagem). */
@Composable
private fun TapIllustration() {
    val description = stringResource(R.string.setup3_illustration)
    Box(Modifier.fillMaxWidth().height(150.dp).semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(width = 120.dp, height = 150.dp)) {
            val stroke = Stroke(width = 2.dp.toPx())
            val w = size.width
            val h = size.height
            // pulseira
            drawRoundRect(Tokens.TextSecondary, topLeft = Offset(w * 0.30f, 0f), size = Size(w * 0.40f, h), cornerRadius = CornerRadius(w * 0.18f), style = stroke)
            // cápsula / tela
            drawRoundRect(Tokens.TextPrimary, topLeft = Offset(w * 0.36f, h * 0.18f), size = Size(w * 0.28f, h * 0.64f), cornerRadius = CornerRadius(w * 0.14f))
            // ponto de toque
            drawCircle(Tokens.Surface, radius = w * 0.07f, center = Offset(w * 0.5f, h * 0.70f), style = stroke)
            // ondas de toque
            for (i in 1..2) {
                drawArc(
                    Tokens.Primary, startAngle = -40f, sweepAngle = 80f, useCenter = false,
                    topLeft = Offset(w * 0.5f - w * 0.12f * i, h * 0.70f - w * 0.12f * i),
                    size = Size(w * 0.24f * i, w * 0.24f * i), style = stroke,
                )
            }
        }
    }
}
