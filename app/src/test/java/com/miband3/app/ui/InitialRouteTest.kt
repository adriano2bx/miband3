package com.miband3.app.ui

import com.miband3.app.data.Installation
import org.junit.Assert.assertEquals
import org.junit.Test

class InitialRouteTest {
    private val enrolled = Installation(deviceId = "dev", deviceToken = "mbd_x", consentVersion = "1", setupComplete = true, accepting = true)

    @Test
    fun firstUseGoesToConsent() = assertEquals(Route.Consent, initialRoute(Installation()))

    @Test
    fun declinedStaysDeclined() = assertEquals(Route.Declined, initialRoute(Installation(declined = true)))

    @Test
    fun consentWithoutSetupGoesToTutorial() = assertEquals(Route.Setup(1), initialRoute(enrolled.copy(setupComplete = false)))

    @Test
    fun completeInstallationGoesToMain() = assertEquals(Route.Main, initialRoute(enrolled))

    @Test
    fun newTermVersionReopensConsent() = assertEquals(Route.Consent, initialRoute(enrolled.copy(reconsentRequired = true)))
}
