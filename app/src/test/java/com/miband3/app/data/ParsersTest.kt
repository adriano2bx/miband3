package com.miband3.app.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ParsersTest {
    @Test
    fun parsesWelcomeStatus() {
        val json = JSONObject(
            """{"t":"welcome","device_id":"dev_1","status":"pending","authorized":false,
               "consent":{"accepted_version":"2026.1","current_version":"2026.1","valid":true},
               "config":{"hr_interval_min":10,"history_interval_min":60,"band_profile":{"birth_year":1980,"gender":"female","height_cm":162,"weight_kg":58,"wrist":"right","step_goal":6000}},"config_version":3,"config_updated_at":null}""",
        )
        val info = Parsers.installation(json)
        assertEquals("dev_1", info.deviceId)
        assertFalse(info.authorized)
        assertTrue(info.consent.valid)
        assertEquals(10, info.config!!.hrIntervalMin)
        assertEquals(3, info.configVersion)
        assertNull(info.configUpdatedAt)
        assertNull(info.participantRef)
        val p = info.config!!.bandProfile!!
        assertEquals(162, p.heightCm)
        assertFalse(p.leftWrist)
        assertEquals(6000, p.stepGoal)
    }

    @Test
    fun parsesTechLogin() {
        val login = Parsers.techLogin(JSONObject("""{"session_token":"mbt_x","expires_at":5,"idle_timeout_s":600,"technician":{"name":"Ana"},"scopes":["tech","provision"]}"""))
        assertEquals("mbt_x", login.token)
        assertEquals("Ana", login.technicianName)
        assertEquals(listOf("tech", "provision"), login.scopes)
    }
}
