package com.miband3.app.ui.screens

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BluetoothDisabled
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.GppBad
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.LockOpen
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.miband3.app.R
import com.miband3.app.status.StatusKind
import com.miband3.app.status.StatusMonitor
import com.miband3.app.status.messageRes
import com.miband3.app.status.titleRes
import com.miband3.app.tech.SecretTapDetector
import com.miband3.app.ui.components.BiosenseCard
import com.miband3.app.ui.components.CardDivider
import com.miband3.app.ui.components.Footer
import com.miband3.app.ui.components.ScreenLayout
import com.miband3.app.ui.components.SectionLabel
import com.miband3.app.ui.theme.BType
import com.miband3.app.ui.theme.Tokens

/**
 * Tela do participante: só status e participação. Sem dados, gráficos ou controles.
 * Cinco toques rápidos em qualquer área (não há controles aqui) revelam o login técnico.
 */
@Composable
fun MainScreen(onSecretGesture: () -> Unit) {
    val status by StatusMonitor.status.collectAsStateWithLifecycle()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { StatusMonitor.refreshPermissions() }
    MainContent(status, onSecretGesture)
}

/** Conteúdo sem estado (usado também nas capturas de tela dos testes). */
@Composable
fun MainContent(status: StatusKind, onSecretGesture: () -> Unit) {
    val detector = remember { SecretTapDetector() }

    Box(
        Modifier.fillMaxSize().pointerInput(Unit) {
            // Toques simples apenas; não consome rolagem nem os gestos do TalkBack.
            detectTapGestures(onTap = { if (detector.onTap(System.currentTimeMillis())) onSecretGesture() })
        },
    ) {
        ScreenLayout(bottom = { Footer() }) {
            SectionLabel(stringResource(R.string.main_status_section))
            ConnectionStatusCard(status)
            Spacer(Modifier.height(4.dp))
            SectionLabel(stringResource(R.string.main_program_section))
            ProgramParticipationCard()
        }
    }
}

private fun StatusKind.visual(): Triple<ImageVector, Color, Boolean> = when (this) {
    StatusKind.ACTIVE -> Triple(Icons.Outlined.CheckCircle, Tokens.Primary, false)
    StatusKind.RECONNECTING -> Triple(Icons.Outlined.Sync, Tokens.Warning, false)
    StatusKind.BAND_DISCONNECTED -> Triple(Icons.Outlined.LinkOff, Tokens.Warning, true)
    StatusKind.BLUETOOTH_OFF -> Triple(Icons.Outlined.BluetoothDisabled, Tokens.Warning, true)
    StatusKind.SERVICE_UNAVAILABLE -> Triple(Icons.Outlined.CloudOff, Tokens.Warning, true)
    StatusKind.PERMISSION_REQUIRED -> Triple(Icons.Outlined.LockOpen, Tokens.Error, true)
    StatusKind.NOT_AUTHORIZED -> Triple(Icons.Outlined.GppBad, Tokens.Error, true)
}

@Composable
fun ConnectionStatusCard(status: StatusKind) {
    val (icon, tint, _) = status.visual()
    BiosenseCard {
        Row(
            verticalAlignment = Alignment.Top,
            // Mudanças de status são anunciadas pelo leitor de tela.
            modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        ) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(24.dp).padding(top = 1.dp))
            Spacer(Modifier.width(16.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(status.titleRes()), style = BType.status)
                Text(stringResource(status.messageRes()), style = BType.body.copy(color = Tokens.TextSecondary))
            }
        }
    }
}

@Composable
fun ProgramParticipationCard() {
    BiosenseCard {
        Text(stringResource(R.string.main_participant_title), style = BType.status)
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.main_participant_text), style = BType.body.copy(color = Tokens.TextSecondary))
        CardDivider()
        Text(stringResource(R.string.ownership_full), style = BType.body.copy(color = Tokens.TextSecondary))
        Spacer(Modifier.height(16.dp))
        Column(Modifier.semantics(mergeDescendants = true) {}) {
            Text(stringResource(R.string.responsible_label), style = BType.secondary)
            Text(stringResource(R.string.responsible_name), style = BType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium))
        }
    }
}
