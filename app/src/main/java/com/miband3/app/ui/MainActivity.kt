package com.miband3.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.miband3.app.ui.screens.ConsentScreen
import com.miband3.app.ui.screens.DeclinedScreen
import com.miband3.app.ui.screens.MainScreen
import com.miband3.app.ui.screens.SetupConfirmScreen
import com.miband3.app.ui.screens.SetupPrepareScreen
import com.miband3.app.ui.screens.SetupSelectScreen
import com.miband3.app.ui.screens.TechAreaScreen
import com.miband3.app.ui.screens.TechLoginScreen
import com.miband3.app.ui.screens.TermScreen
import com.miband3.app.ui.theme.BiosenseTheme
import com.miband3.app.ui.theme.Tokens

class MainActivity : ComponentActivity() {
    private val app: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        // Abertura nativa; a rota já é conhecida a partir do estado local, sem espera artificial.
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            BiosenseTheme {
                val route by app.route.collectAsStateWithLifecycle()
                BackHandler(enabled = route != Route.Main && route != Route.Consent && route != Route.Declined && route != Route.Setup(1)) {
                    app.back()
                }
                Box(Modifier.fillMaxSize().background(Tokens.Background)) {
                    when (val r = route) {
                        Route.Consent -> ConsentScreen(onAccepted = app::afterConsent, onDeclined = { app.go(Route.Declined) }, onReadTerm = { app.go(Route.Term) })
                        Route.Term -> TermScreen(onBack = { app.go(Route.Consent) })
                        Route.Declined -> DeclinedScreen(onReview = { app.go(Route.Consent) })
                        is Route.Setup -> when (r.step) {
                            1 -> SetupPrepareScreen(onReady = { app.go(Route.Setup(2)) })
                            2 -> SetupSelectScreen(onBack = { app.go(Route.Setup(1)) }, onConnect = { app.go(Route.Setup(3)) })
                            else -> SetupConfirmScreen(
                                onBack = { app.go(Route.Setup(2)) },
                                onChooseAnother = { app.go(Route.Setup(2)) },
                                onFinished = { app.go(Route.Main) },
                            )
                        }
                        Route.Main -> MainScreen(onSecretGesture = { app.go(Route.TechLogin) })
                        Route.TechLogin -> TechLoginScreen(onBack = { app.go(Route.Main) }, onAuthorized = { app.go(Route.TechArea) })
                        Route.TechArea -> TechAreaScreen(onEnd = { app.back() })
                    }
                }
            }
        }
    }
}
