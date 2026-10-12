package com.miband3.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudQueue
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.miband3.app.R
import com.miband3.app.cloud.ApiResult
import com.miband3.app.cloud.BiosenseApi
import com.miband3.app.data.InstallationStore
import com.miband3.app.tech.TechSession
import com.miband3.app.ui.components.BiosenseCard
import com.miband3.app.ui.components.CardDivider
import com.miband3.app.ui.components.NoticeCard
import com.miband3.app.ui.components.PrimaryButton
import com.miband3.app.ui.components.ScreenLayout
import com.miband3.app.ui.components.ScreenTitle
import com.miband3.app.ui.components.SecondaryButton
import com.miband3.app.ui.components.Tag
import com.miband3.app.ui.theme.BType
import com.miband3.app.ui.theme.Tokens
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed class LoginError {
    data class Invalid(val attemptsLeft: Int?) : LoginError()
    data object Locked : LoginError()
    data object Network : LoginError()
    data object NoInstallation : LoginError()
    data object NotConfigured : LoginError()
    data object Rejected : LoginError()
}

data class LoginUi(val sending: Boolean = false, val error: LoginError? = null)

/** Login técnico: a credencial é sempre validada na nuvem; nada é aceito offline. */
class TechLoginViewModel : ViewModel() {
    private val _ui = MutableStateFlow(LoginUi())
    val ui: StateFlow<LoginUi> = _ui.asStateFlow()
    private var job: Job? = null

    fun submit(credential: String, password: String, onAuthorized: () -> Unit) {
        if (credential.isBlank() || password.isEmpty() || job?.isActive == true) return
        _ui.value = LoginUi(sending = true)
        job = viewModelScope.launch {
            when (val r = BiosenseApi.techLogin(credential.trim(), password, InstallationStore.current.deviceToken)) {
                is ApiResult.Ok -> {
                    TechSession.begin(r.value)
                    _ui.value = LoginUi()
                    onAuthorized()
                }
                is ApiResult.Failure -> _ui.value = LoginUi(
                    error = when {
                        r.kind == ApiResult.Kind.NOT_CONFIGURED -> LoginError.NotConfigured
                        r.kind == ApiResult.Kind.NETWORK -> LoginError.Network
                        r.httpCode == 401 -> LoginError.Invalid(r.body?.optInt("attempts_left", -1)?.takeIf { it >= 0 })
                        r.httpCode == 429 -> LoginError.Locked
                        r.httpCode == 403 -> LoginError.NoInstallation
                        else -> LoginError.Rejected
                    },
                )
            }
        }
    }

    fun clearError() = _ui.update { it.copy(error = null) }

    override fun onCleared() {
        job?.cancel()
    }
}

@Composable
fun TechLoginScreen(onBack: () -> Unit, onAuthorized: () -> Unit, vm: TechLoginViewModel = viewModel()) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    var credential by rememberSaveable { mutableStateOf("") }
    // A senha não é salva no estado restaurável (nem em logs).
    var password by androidx.compose.runtime.remember { mutableStateOf("") }
    var showPassword by androidx.compose.runtime.remember { mutableStateOf(false) }
    val canSubmit = credential.isNotBlank() && password.isNotEmpty() && !ui.sending
    val submit = { vm.submit(credential, password) { password = ""; onAuthorized() } }

    ScreenLayout(onBack = onBack) {
        BiosenseCard {
            Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Tag(stringResource(R.string.tech_tag))
                ScreenTitle(stringResource(R.string.tech_login_title), stringResource(R.string.tech_login_subtitle))
                OutlinedTextField(
                    value = credential,
                    onValueChange = { credential = it; vm.clearError() },
                    label = { Text(stringResource(R.string.tech_credential)) },
                    placeholder = { Text(stringResource(R.string.tech_credential_hint)) },
                    singleLine = true,
                    enabled = !ui.sending,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; vm.clearError() },
                    label = { Text(stringResource(R.string.tech_password)) },
                    singleLine = true,
                    enabled = !ui.sending,
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { if (canSubmit) submit() }),
                    trailingIcon = {
                        IconButton(onClick = { showPassword = !showPassword }) {
                            Icon(
                                if (showPassword) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility,
                                contentDescription = stringResource(if (showPassword) R.string.tech_hide_password else R.string.tech_show_password),
                            )
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors(),
                )
                PrimaryButton(stringResource(R.string.tech_submit), onClick = submit, enabled = canSubmit, loading = ui.sending)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.CloudQueue, contentDescription = null, tint = Tokens.TextSecondary, modifier = Modifier.size(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Text(stringResource(if (ui.sending) R.string.tech_validating else R.string.tech_cloud_note), style = BType.secondary)
                }
            }
            CardDivider()
            Text(stringResource(R.string.tech_restricted), style = BType.secondary)
            Spacer(Modifier.size(12.dp))
            SecondaryButton(stringResource(R.string.tech_back_main), onClick = onBack)
        }
        ui.error?.let { e ->
            val message = when (e) {
                is LoginError.Invalid -> if (e.attemptsLeft != null) stringResource(R.string.tech_error_invalid_left, e.attemptsLeft) else stringResource(R.string.tech_error_invalid)
                LoginError.Locked -> stringResource(R.string.tech_error_locked)
                LoginError.Network -> stringResource(R.string.tech_error_network)
                LoginError.NoInstallation -> stringResource(R.string.tech_error_no_installation)
                LoginError.NotConfigured -> stringResource(R.string.consent_term_not_configured)
                LoginError.Rejected -> stringResource(R.string.tech_error_rejected)
            }
            NoticeCard(Icons.Outlined.ErrorOutline, stringResource(R.string.tech_error_title), message)
        }
    }
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Tokens.Primary,
    unfocusedBorderColor = Tokens.Outline,
    focusedLabelColor = Tokens.Primary,
    cursorColor = Tokens.Primary,
)
