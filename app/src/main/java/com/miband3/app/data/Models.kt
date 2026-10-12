package com.miband3.app.data

import org.json.JSONObject

/** Termo de participação vigente, publicado pela equipe responsável na nuvem. */
data class Term(val version: String, val title: String, val content: String, val requiresReconsent: Boolean)

data class ConsentInfo(val acceptedVersion: String?, val currentVersion: String?, val valid: Boolean)

/** Perfil físico que a pulseira usa para estimar calorias e distância. */
data class BandProfileInfo(
    val birthYear: Int,
    val gender: String,
    val heightCm: Int,
    val weightKg: Int,
    val leftWrist: Boolean,
    val stepGoal: Int,
)

data class CollectionConfig(val hrIntervalMin: Int, val historyIntervalMin: Int, val bandProfile: BandProfileInfo? = null)

data class InstallationInfo(
    val deviceId: String?,
    val status: String?,
    val authorized: Boolean,
    val participantRef: String?,
    val consent: ConsentInfo,
    val config: CollectionConfig?,
    val configVersion: Int?,
    val configUpdatedAt: Long?,
    val online: Boolean?,
    val lastSeenAt: Long?,
)

data class TechLogin(val token: String, val expiresAt: Long, val idleTimeoutS: Int, val technicianName: String, val scopes: List<String>)

data class TechInstallation(
    val info: InstallationInfo,
    val name: String?,
    val technicianName: String,
    val scopes: List<String>,
    val sessionExpiresAt: Long,
)

/** Leitura das respostas JSON da nuvem (funções puras, testadas na JVM). */
object Parsers {
    private fun JSONObject.optStringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) optString(key) else null

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (has(key) && !isNull(key)) optLong(key) else null

    fun term(json: JSONObject) = Term(
        version = json.getString("version"),
        title = json.optString("title"),
        content = json.optString("content"),
        requiresReconsent = json.optBoolean("requires_reconsent", true),
    )

    fun installation(json: JSONObject): InstallationInfo {
        val consent = json.optJSONObject("consent")
        val config = json.optJSONObject("config")
        return InstallationInfo(
            deviceId = json.optStringOrNull("device_id"),
            status = json.optStringOrNull("status"),
            authorized = json.optBoolean("authorized", false),
            participantRef = json.optStringOrNull("participant_ref"),
            consent = ConsentInfo(
                acceptedVersion = consent?.optStringOrNull("accepted_version"),
                currentVersion = consent?.optStringOrNull("current_version"),
                valid = consent?.optBoolean("valid", false) ?: false,
            ),
            config = config?.let { c ->
                CollectionConfig(
                    hrIntervalMin = c.optInt("hr_interval_min", 30),
                    historyIntervalMin = c.optInt("history_interval_min", 30),
                    bandProfile = c.optJSONObject("band_profile")?.let { p ->
                        BandProfileInfo(
                            birthYear = p.optInt("birth_year", 1990),
                            gender = p.optString("gender", "other"),
                            heightCm = p.optInt("height_cm", 170),
                            weightKg = p.optInt("weight_kg", 70),
                            leftWrist = p.optString("wrist", "left") != "right",
                            stepGoal = p.optInt("step_goal", 8000),
                        )
                    },
                )
            },
            configVersion = if (json.has("config_version")) json.optInt("config_version") else null,
            configUpdatedAt = json.optLongOrNull("config_updated_at"),
            online = if (json.has("online")) json.optBoolean("online") else null,
            lastSeenAt = json.optLongOrNull("last_seen_at"),
        )
    }

    fun techLogin(json: JSONObject) = TechLogin(
        token = json.getString("session_token"),
        expiresAt = json.optLong("expires_at"),
        idleTimeoutS = json.optInt("idle_timeout_s", 600),
        technicianName = json.optJSONObject("technician")?.optString("name").orEmpty(),
        scopes = json.optJSONArray("scopes")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList(),
    )

    fun techInstallation(json: JSONObject) = TechInstallation(
        info = installation(json),
        name = json.optStringOrNull("name"),
        technicianName = json.optString("technician"),
        scopes = json.optJSONArray("scopes")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList(),
        sessionExpiresAt = json.optLong("session_expires_at"),
    )
}
