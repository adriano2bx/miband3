package com.miband3.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.miband3.app.ble.MiBandManager
import com.miband3.app.ble.ScannedDevice

@Composable
fun ScanScreen() {
    val devices by MiBandManager.scanResults.collectAsStateWithLifecycle()
    val scanning by MiBandManager.scanning.collectAsStateWithLifecycle()

    DisposableEffect(Unit) {
        MiBandManager.startScan()
        onDispose { MiBandManager.stopScan() }
    }

    Column(Modifier.fillMaxSize().statusBarsPadding().padding(16.dp)) {
        Text("Parear Mi Band 3", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(4.dp))
        Text(
            "Deixe a pulseira próxima ao celular. Se ela estiver vinculada ao Mi Fit / Zepp Life, " +
                "desvincule-a antes. Ao conectar, toque na tela da pulseira para confirmar o pareamento.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = { MiBandManager.startScan() }, enabled = !scanning) {
                Icon(Icons.Filled.Search, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text(if (scanning) "Procurando…" else "Procurar novamente")
            }
            if (scanning) {
                Spacer(Modifier.width(16.dp))
                CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            }
        }
        Spacer(Modifier.height(16.dp))
        if (devices.isEmpty() && !scanning) {
            Text("Nenhum dispositivo encontrado.", style = MaterialTheme.typography.bodyMedium)
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(devices, key = { it.address }) { device ->
                DeviceRow(device) { MiBandManager.connect(device.address, device.name) }
            }
        }
    }
}

@Composable
private fun DeviceRow(device: ScannedDevice, onClick: () -> Unit) {
    val colors = if (device.looksLikeMiBand) {
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    } else {
        CardDefaults.cardColors()
    }
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick), colors = colors) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            if (device.looksLikeMiBand) {
                Icon(Icons.Filled.Star, contentDescription = "Provável Mi Band")
                Spacer(Modifier.width(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(device.name ?: "(sem nome)", style = MaterialTheme.typography.titleMedium)
                Text(device.address, style = MaterialTheme.typography.bodySmall)
            }
            Text("${device.rssi} dBm", style = MaterialTheme.typography.bodySmall)
        }
    }
}
