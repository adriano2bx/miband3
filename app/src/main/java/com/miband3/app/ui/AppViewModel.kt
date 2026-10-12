package com.miband3.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.miband3.app.data.Installation
import com.miband3.app.data.InstallationStore
import com.miband3.app.tech.TechSession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class Route {
    data object Consent : Route()
    data object Term : Route()
    data object Declined : Route()
    data class Setup(val step: Int) : Route()
    data object Main : Route()
    data object TechLogin : Route()
    data object TechArea : Route()
}

/** Rota inicial derivada do que está persistido (consentimento confirmado e vínculo). */
fun initialRoute(i: Installation): Route = when {
    !i.enrolled && i.declined -> Route.Declined
    !i.enrolled -> Route.Consent
    i.declined -> Route.Declined
    i.reconsentRequired || i.consentVersion == null -> Route.Consent
    !i.setupComplete -> Route.Setup(1)
    else -> Route.Main
}

/**
 * Navegação do app. Sobrevive à rotação; após o processo morrer a rota é recalculada
 * do estado persistido e a área técnica nunca é restaurada (a sessão vive só na memória).
 */
class AppViewModel : ViewModel() {
    private val _route = MutableStateFlow(initialRoute(InstallationStore.current))
    val route: StateFlow<Route> = _route.asStateFlow()

    init {
        viewModelScope.launch {
            // A nuvem pode pedir novo aceite (termo atualizado) a qualquer momento.
            InstallationStore.state.collect { inst ->
                val r = _route.value
                if (inst.enrolled && inst.reconsentRequired && !inst.declined && r !is Route.Consent && r !is Route.Term) {
                    TechSession.end()
                    _route.value = Route.Consent
                }
            }
        }
        viewModelScope.launch {
            TechSession.session.collect { session ->
                if (session == null && _route.value == Route.TechArea) _route.value = Route.Main
            }
        }
    }

    fun go(route: Route) {
        _route.value = route
    }

    /** Depois do consentimento: segue para o tutorial ou volta à principal (reaceite). */
    fun afterConsent() {
        _route.value = if (InstallationStore.current.setupComplete) Route.Main else Route.Setup(1)
    }

    fun back(): Boolean {
        _route.value = when (val r = _route.value) {
            Route.Term -> Route.Consent
            is Route.Setup -> if (r.step > 1) Route.Setup(r.step - 1) else return false
            Route.TechLogin -> Route.Main
            Route.TechArea -> {
                TechSession.end()
                Route.Main
            }
            else -> return false
        }
        return true
    }
}
