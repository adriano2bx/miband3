package com.miband3.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.miband3.app.cloud.CloudStatus
import com.miband3.app.data.BandProfileInfo
import com.miband3.app.data.CollectionConfig
import com.miband3.app.data.ConsentInfo
import com.miband3.app.data.InstallationInfo
import com.miband3.app.data.TechInstallation
import com.miband3.app.data.Term
import com.miband3.app.status.StatusKind
import com.miband3.app.tech.ConfigLoad
import com.miband3.app.tech.LogLine
import com.miband3.app.tech.TechUi
import com.miband3.app.tech.TestId
import com.miband3.app.tech.TestResult
import com.miband3.app.tech.TestState
import com.miband3.app.ui.components.BrandLockup
import com.miband3.app.ui.screens.ConfirmUi
import com.miband3.app.ui.screens.ConsentContent
import com.miband3.app.ui.screens.ConsentUiState
import com.miband3.app.ui.screens.LoginError
import com.miband3.app.ui.screens.LoginUi
import com.miband3.app.ui.screens.MainContent
import com.miband3.app.ui.screens.PermissionOutcome
import com.miband3.app.ui.screens.SetupConfirmContent
import com.miband3.app.ui.screens.SetupPrepareContent
import com.miband3.app.ui.screens.SetupSelectContent
import com.miband3.app.ui.screens.TechActions
import com.miband3.app.ui.screens.TechAreaContent
import com.miband3.app.ui.screens.TechEnv
import com.miband3.app.ui.screens.TechLoginContent
import com.miband3.app.ui.screens.TermLoad
import com.miband3.app.ui.theme.BiosenseTheme
import com.miband3.app.ui.theme.Tokens
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * Capturas de todas as telas em três configurações: 360 dp, 412 dp (referência do guia)
 * e 412 dp com fonte 1,3x. As imagens saem como artefato do CI ("biosense-screens") para
 * revisão visual. Os estados abaixo são exemplos só para as capturas (nunca usados no app).
 */
@RunWith(Parameterized::class)
class ScreenshotTest(private val label: String, config: DeviceConfig) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun configs() = listOf(
            arrayOf("360dp", DeviceConfig.NEXUS_5),
            arrayOf("412dp", DeviceConfig.PIXEL_6),
            arrayOf("412dp_fonte130", DeviceConfig.PIXEL_6.copy(fontScale = 1.3f)),
        )
    }

    @get:Rule
    val paparazzi = Paparazzi(deviceConfig = config, showSystemUi = false, maxPercentDifference = 0.1)

    private fun shot(name: String, content: @Composable () -> Unit) =
        paparazzi.snapshot("${name}_$label") { BiosenseTheme { content() } }

    private val term = Term("2026.1", "Termo de participação voluntária", "Texto do termo.", true)
    private val noop = {}

    @Test
    fun s01_abertura() = shot("01_abertura") {
        Box(Modifier.fillMaxSize().background(Tokens.Background), contentAlignment = Alignment.Center) { BrandLockup() }
    }

    @Test
    fun s02_consentimento() {
        shot("02_consentimento") { ConsentContent(ConsentUiState(term = TermLoad.Loaded(term)), {}, noop, noop, noop, noop) }
        shot("02_consentimento_marcado") { ConsentContent(ConsentUiState(term = TermLoad.Loaded(term), checked = true), {}, noop, noop, noop, noop) }
        shot("02_consentimento_sem_termo") {
            ConsentContent(ConsentUiState(term = TermLoad.Unavailable(TermLoad.Reason.NOT_PUBLISHED)), {}, noop, noop, noop, noop)
        }
    }

    @Test
    fun s03_preparacao() {
        shot("03_preparacao") { SetupPrepareContent(false, false, PermissionOutcome.UNKNOWN, noop, noop) }
        shot("03_preparacao_negada") { SetupPrepareContent(true, false, PermissionOutcome.PERMANENTLY_DENIED, noop, noop) }
    }

    @Test
    fun s04_selecao() {
        shot("04_selecao") {
            SetupSelectContent(true, true, true, listOf("C8:0F:10:AA:3F:A2", "D1:22:9B:0C:71:5E"), "C8:0F:10:AA:3F:A2", {}, noop, noop, noop)
        }
        shot("04_selecao_nenhuma") { SetupSelectContent(true, false, true, emptyList(), null, {}, noop, noop, noop) }
    }

    private val confirmBase = ConfirmUi(
        bandReady = false, awaitingTap = false, authenticating = false, failed = false, timedOut = false, hasErrorDetail = false,
        serviceReady = false, serviceConnecting = true, serviceRejected = false, serviceUnavailable = false, authorized = false, canFinish = false,
    )

    @Test
    fun s05_confirmacao() {
        shot("05_confirmacao_toque") { SetupConfirmContent(confirmBase.copy(awaitingTap = true), noop, noop, noop, noop) }
        shot("05_confirmacao_pronta") {
            SetupConfirmContent(confirmBase.copy(bandReady = true, serviceReady = true, serviceConnecting = false, authorized = true, canFinish = true), noop, noop, noop, noop)
        }
        shot("05_confirmacao_tempo_esgotado") { SetupConfirmContent(confirmBase.copy(timedOut = true, serviceReady = true), noop, noop, noop, noop) }
    }

    @Test
    fun s06_principal() {
        shot("06_principal_ativa") { MainContent(StatusKind.ACTIVE) {} }
        shot("06_principal_servico_indisponivel") { MainContent(StatusKind.SERVICE_UNAVAILABLE) {} }
        shot("06_principal_nao_autorizada") { MainContent(StatusKind.NOT_AUTHORIZED) {} }
    }

    @Test
    fun s07_login_tecnico() {
        shot("07_login") { TechLoginContent(LoginUi(), "", {}, "", {}, noop, noop) }
        shot("07_login_recusado") { TechLoginContent(LoginUi(error = LoginError.Invalid(3)), "tecnico", {}, "senha-errada", {}, noop, noop) }
    }

    private val installation = TechInstallation(
        info = InstallationInfo(
            deviceId = "dev_7e1a5888b72046c593e8", status = "pending", authorized = false, participantRef = null,
            consent = ConsentInfo("2026.1", "2026.1", true),
            config = CollectionConfig(30, 30, BandProfileInfo(1985, "female", 165, 60, true, 8000)),
            configVersion = 2, configUpdatedAt = 1_791_820_000_000, online = true, lastSeenAt = 1_791_820_000_000,
        ),
        name = "Instalação 46c593e8", technicianName = "Técnico", scopes = listOf("tech", "provision"), sessionExpiresAt = 0,
    )
    private val actions = TechActions({}, {}, {}, {})
    private val env = TechEnv(CloudStatus.ONLINE, true, "Conectada", "C8:0F:10:AA:3F:A2")

    @Test
    fun s08_area_tecnica() {
        val tests = TestId.entries.associateWith { TestResult() } +
            mapOf(
                TestId.BLUETOOTH to TestResult(TestState.DONE, "Leitura BLE concluída (bateria 82%)"),
                TestId.VIBRATION to TestResult(TestState.RUNNING),
                TestId.HEART_RATE to TestResult(TestState.EXPIRED, "Sem leitura em 45 s. Verifique se a pulseira está firme no pulso."),
            )
        val ui = TechUi(
            config = ConfigLoad.Loaded(installation, 1_791_820_000_000),
            tests = tests,
            log = listOf(LogLine(1_791_820_000_000, "Bluetooth · Leitura BLE concluída (bateria 82%)")),
        )
        shot("08_tecnico_testes") { TechAreaContent(ui, env, 1, {}, actions, noop, noop) }
        shot("08_tecnico_configuracao") { TechAreaContent(ui, env, 0, {}, actions, noop, noop) }
    }
}
