package com.miband3.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.CloudQueue
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.PersonOutline
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.miband3.app.R
import com.miband3.app.ble.MiBandManager
import com.miband3.app.cloud.ApiResult
import com.miband3.app.cloud.BiosenseApi
import com.miband3.app.cloud.CloudClient
import com.miband3.app.data.InstallationStore
import com.miband3.app.data.Term
import com.miband3.app.ui.components.BiosenseCard
import com.miband3.app.ui.components.CardDivider
import com.miband3.app.ui.components.FeatureRow
import com.miband3.app.ui.components.NoticeCard
import com.miband3.app.ui.components.PrimaryButton
import com.miband3.app.ui.components.ScreenLayout
import com.miband3.app.ui.components.ScreenTitle
import com.miband3.app.ui.components.SecondaryButton
import com.miband3.app.ui.theme.BType
import com.miband3.app.ui.theme.Tokens
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed class TermLoad {
    data object Loading : TermLoad()
    data class Loaded(val term: Term) : TermLoad()
    /** Sem termo publicado, sem rede ou serviço não configurado: não há como aderir. */
    data class Unavailable(val reason: Reason) : TermLoad()

    enum class Reason { NOT_PUBLISHED, NETWORK, NOT_CONFIGURED, SERVER }
}

enum class ConsentError { NETWORK, TERM_UPDATED, SERVER }

data class ConsentUiState(
    val term: TermLoad = TermLoad.Loading,
    val checked: Boolean = false,
    val submitting: Boolean = false,
    val error: ConsentError? = null,
)

/** Consentimento: só é considerado aceito quando o servidor grava e confirma. */
class ConsentViewModel : ViewModel() {
    private val _ui = MutableStateFlow(ConsentUiState())
    val ui: StateFlow<ConsentUiState> = _ui.asStateFlow()

    init {
        load()
    }

    fun load() {
        _ui.update { it.copy(term = TermLoad.Loading, error = null) }
        viewModelScope.launch {
            val term = when (val r = BiosenseApi.currentTerm()) {
                is ApiResult.Ok -> TermLoad.Loaded(r.value)
                is ApiResult.Failure -> TermLoad.Unavailable(
                    when {
                        r.kind == ApiResult.Kind.NOT_CONFIGURED -> TermLoad.Reason.NOT_CONFIGURED
                        r.kind == ApiResult.Kind.NETWORK -> TermLoad.Reason.NETWORK
                        r.httpCode == 404 -> TermLoad.Reason.NOT_PUBLISHED
                        else -> TermLoad.Reason.SERVER
                    },
                )
            }
            // Termo novo: o aceite anterior na tela não vale para ele.
            _ui.update { it.copy(term = term, checked = if (term != it.term) false else it.checked) }
        }
    }

    fun setChecked(value: Boolean) = _ui.update { it.copy(checked = value, error = null) }

    fun accept(onDone: () -> Unit) {
        val term = (_ui.value.term as? TermLoad.Loaded)?.term ?: return
        if (!_ui.value.checked || _ui.value.submitting) return
        _ui.update { it.copy(submitting = true, error = null) }
        viewModelScope.launch {
            val install = InstallationStore.current
            val token = install.deviceToken
            val result = if (token == null) {
                when (val r = BiosenseApi.enroll(term.version)) {
                    is ApiResult.Ok -> {
                        val (info, newToken) = r.value
                        InstallationStore.update { it.copy(deviceToken = newToken, declined = false) }
                        InstallationStore.applyServer(info)
                        null
                    }
                    is ApiResult.Failure -> r
                }
            } else {
                when (val r = BiosenseApi.consent(token, term.version, accepted = true)) {
                    is ApiResult.Ok -> {
                        InstallationStore.update { it.copy(declined = false) }
                        InstallationStore.applyServer(r.value)
                        null
                    }
                    is ApiResult.Failure -> r
                }
            }
            if (result == null && InstallationStore.current.hasValidConsent) {
                _ui.update { it.copy(submitting = false) }
                CloudClient.start()
                onDone()
            } else {
                val error = when {
                    result?.kind == ApiResult.Kind.NETWORK -> ConsentError.NETWORK
                    result?.error == "terms_outdated" -> ConsentError.TERM_UPDATED
                    else -> ConsentError.SERVER
                }
                _ui.update { it.copy(submitting = false, error = error) }
                if (error == ConsentError.TERM_UPDATED) load()
            }
        }
    }

    /** "Não participar": nada é coletado. Se já havia instalação, a recusa é registrada na nuvem. */
    fun decline(onDone: () -> Unit) {
        val term = (_ui.value.term as? TermLoad.Loaded)?.term
        val token = InstallationStore.current.deviceToken
        viewModelScope.launch {
            if (token != null && term != null) BiosenseApi.consent(token, term.version, accepted = false)
            InstallationStore.update { it.copy(declined = true, accepting = false) }
            CloudClient.stop(clearQueue = true)
            MiBandManager.keepTrying = false
            MiBandManager.disconnect()
            onDone()
        }
    }
}

@Composable
fun ConsentScreen(onAccepted: () -> Unit, onDeclined: () -> Unit, onReadTerm: () -> Unit, vm: ConsentViewModel = viewModel()) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    ConsentContent(
        ui = ui,
        onCheckedChange = vm::setChecked,
        onAccept = { vm.accept(onAccepted) },
        onDecline = { vm.decline(onDeclined) },
        onReadTerm = onReadTerm,
        onRetry = vm::load,
    )
}

@Composable
fun ConsentContent(
    ui: ConsentUiState,
    onCheckedChange: (Boolean) -> Unit,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
    onReadTerm: () -> Unit,
    onRetry: () -> Unit,
) {
    val term = (ui.term as? TermLoad.Loaded)?.term

    ScreenLayout(
        bottom = {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .toggleable(value = ui.checked, enabled = term != null && !ui.submitting, role = Role.Checkbox, onValueChange = onCheckedChange),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(
                    checked = ui.checked,
                    onCheckedChange = null,
                    enabled = term != null && !ui.submitting,
                    colors = CheckboxDefaults.colors(checkedColor = Tokens.Primary),
                )
                Spacer(Modifier.width(12.dp))
                Text(stringResource(R.string.consent_checkbox), style = BType.body)
            }
            PrimaryButton(
                text = stringResource(R.string.consent_accept),
                onClick = onAccept,
                enabled = term != null && ui.checked,
                loading = ui.submitting,
            )
            SecondaryButton(text = stringResource(R.string.consent_decline), onClick = onDecline, enabled = !ui.submitting)
        },
    ) {
        ScreenTitle(stringResource(R.string.consent_title), stringResource(R.string.consent_subtitle))

        BiosenseCard {
            Text(stringResource(R.string.consent_program_title), style = BType.status)
            Spacer(Modifier.padding(top = 4.dp))
            Text(stringResource(R.string.consent_program_text), style = BType.body.copy(color = Tokens.TextSecondary))
            CardDivider()
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                FeatureRow(Icons.Outlined.BarChart, stringResource(R.string.consent_data_title), stringResource(R.string.consent_data_text))
                FeatureRow(Icons.Outlined.CloudQueue, stringResource(R.string.consent_use_title), stringResource(R.string.consent_use_text))
                FeatureRow(Icons.Outlined.PersonOutline, stringResource(R.string.consent_choice_title), stringResource(R.string.consent_choice_text))
            }
            CardDivider()
            Text(stringResource(R.string.ownership_short), style = BType.secondary)
            Spacer(Modifier.padding(top = 8.dp))
            Text(stringResource(R.string.responsible_label), style = BType.secondary)
            Text(stringResource(R.string.responsible_name), style = BType.body)
            Spacer(Modifier.padding(top = 8.dp))
            when (val t = ui.term) {
                TermLoad.Loading -> Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.padding(end = 8.dp).width(16.dp), strokeWidth = 2.dp)
                    Text(stringResource(R.string.consent_term_loading), style = BType.secondary)
                }
                is TermLoad.Loaded -> Text(
                    stringResource(R.string.consent_read_term, t.term.version),
                    style = BType.body.copy(color = Tokens.Primary, textDecoration = TextDecoration.Underline),
                    modifier = Modifier.heightIn(min = 48.dp).clickable(role = Role.Button, onClick = onReadTerm).padding(vertical = 12.dp),
                )
                is TermLoad.Unavailable -> Unit
            }
        }

        (ui.term as? TermLoad.Unavailable)?.let { u ->
            val message = when (u.reason) {
                TermLoad.Reason.NOT_PUBLISHED -> R.string.consent_term_not_published
                TermLoad.Reason.NETWORK -> R.string.consent_term_network
                TermLoad.Reason.NOT_CONFIGURED -> R.string.consent_term_not_configured
                TermLoad.Reason.SERVER -> R.string.consent_term_server
            }
            NoticeCard(
                icon = if (u.reason == TermLoad.Reason.NETWORK) Icons.Outlined.CloudOff else Icons.Outlined.ErrorOutline,
                title = stringResource(R.string.consent_term_unavailable_title),
                message = stringResource(message),
                tint = Tokens.Warning,
                background = Tokens.WarningSoft,
                action = { SecondaryButton(stringResource(R.string.action_retry), onClick = onRetry) },
            )
        }

        ui.error?.let { e ->
            NoticeCard(
                icon = Icons.Outlined.ErrorOutline,
                title = stringResource(R.string.consent_error_title),
                message = stringResource(
                    when (e) {
                        ConsentError.NETWORK -> R.string.consent_error_network
                        ConsentError.TERM_UPDATED -> R.string.consent_error_term_updated
                        ConsentError.SERVER -> R.string.consent_error_server
                    },
                ),
            )
        }
    }
}

/** Termo completo e versionado, exatamente como publicado pela equipe na nuvem. */
@Composable
fun TermScreen(onBack: () -> Unit, vm: ConsentViewModel = viewModel()) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { if (ui.term !is TermLoad.Loaded) vm.load() }
    ScreenLayout(onBack = onBack, bottom = { SecondaryButton(stringResource(R.string.action_back), onClick = onBack) }) {
        when (val t = ui.term) {
            is TermLoad.Loaded -> {
                ScreenTitle(t.term.title, stringResource(R.string.term_version, t.term.version))
                BiosenseCard {
                    SelectionContainer { Text(t.term.content, style = BType.body) }
                }
            }
            TermLoad.Loading -> CircularProgressIndicator(color = Tokens.Primary)
            is TermLoad.Unavailable -> NoticeCard(
                icon = Icons.Outlined.CloudOff,
                title = stringResource(R.string.consent_term_unavailable_title),
                message = stringResource(R.string.consent_term_network),
                tint = Tokens.Warning,
                background = Tokens.WarningSoft,
                action = { SecondaryButton(stringResource(R.string.action_retry), onClick = vm::load) },
            )
        }
    }
}

@Composable
fun DeclinedScreen(onReview: () -> Unit) {
    ScreenLayout(bottom = { SecondaryButton(stringResource(R.string.declined_review), onClick = onReview) }) {
        ScreenTitle(stringResource(R.string.declined_title), stringResource(R.string.declined_subtitle))
        BiosenseCard {
            Text(stringResource(R.string.declined_text), style = BType.body)
            CardDivider()
            Text(stringResource(R.string.ownership_short), style = BType.secondary)
            Spacer(Modifier.padding(top = 8.dp))
            Text(stringResource(R.string.responsible_label), style = BType.secondary)
            Text(stringResource(R.string.responsible_name), style = BType.body)
        }
    }
}
