package com.miband3.app.cloud

import android.os.Build
import com.miband3.app.BuildConfig
import com.miband3.app.data.InstallationInfo
import com.miband3.app.data.Parsers
import com.miband3.app.data.TechInstallation
import com.miband3.app.data.TechLogin
import com.miband3.app.data.Term
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/** Resultado de uma chamada à nuvem. Falhas distinguem rede, HTTP e serviço não configurado. */
sealed class ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>()
    data class Failure(val kind: Kind, val httpCode: Int? = null, val error: String? = null, val message: String? = null, val body: JSONObject? = null) : ApiResult<Nothing>()

    enum class Kind { NOT_CONFIGURED, NETWORK, HTTP }
}

/**
 * Chamadas REST ao serviço BIOSENSE (contratos em cloud/src/participant-api.ts).
 * O endereço vem do build (BuildConfig.CLOUD_URL); nenhuma chave administrativa fica no APK.
 */
object BiosenseApi {
    private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    val baseUrl: String? get() = CloudConfig.toHttpBase(BuildConfig.CLOUD_URL)
    val isConfigured: Boolean get() = baseUrl != null

    fun clientInfo(): JSONObject = JSONObject()
        .put("app", "biosense")
        .put("version", BuildConfig.VERSION_NAME)
        .put("os", "Android ${Build.VERSION.RELEASE}")
        .put("model", "${Build.MANUFACTURER} ${Build.MODEL}".take(64))

    suspend fun currentTerm(): ApiResult<Term> =
        call("GET", "/v1/consent/terms/current", null, null) { Parsers.term(it) }

    /** Primeira adesão: o servidor grava o aceite e devolve a instalação com o token. */
    suspend fun enroll(termVersion: String): ApiResult<Pair<InstallationInfo, String>> =
        call("POST", "/v1/installations", null, JSONObject().put("consent_version", termVersion).put("accepted", true).put("client", clientInfo())) {
            Parsers.installation(it) to it.getString("device_token")
        }

    suspend fun consent(deviceToken: String, termVersion: String, accepted: Boolean): ApiResult<InstallationInfo> =
        call("POST", "/v1/consent", deviceToken, JSONObject().put("version", termVersion).put("accepted", accepted).put("client", clientInfo())) {
            Parsers.installation(it)
        }

    suspend fun installation(deviceToken: String): ApiResult<InstallationInfo> =
        call("GET", "/v1/installation", deviceToken, null) { Parsers.installation(it) }

    suspend fun techLogin(credential: String, password: String, deviceToken: String?): ApiResult<TechLogin> =
        call("POST", "/v1/tech/login", null, JSONObject().put("credential", credential).put("password", password).apply {
            if (deviceToken != null) put("device_token", deviceToken)
        }) { Parsers.techLogin(it) }

    suspend fun techLogout(session: String): ApiResult<Unit> = call("POST", "/v1/tech/logout", session, JSONObject()) { }

    suspend fun techInstallation(session: String): ApiResult<TechInstallation> =
        call("GET", "/v1/tech/installation", session, null) { Parsers.techInstallation(it) }

    suspend fun techPing(session: String): ApiResult<Long> =
        call("GET", "/v1/tech/ping", session, null) { it.optLong("server_time") }

    suspend fun techAuthorize(session: String, participantRef: String): ApiResult<TechInstallation> =
        call("POST", "/v1/tech/installation/authorize", session, JSONObject().put("participant_ref", participantRef)) {
            Parsers.techInstallation(it)
        }

    private suspend fun <T> call(method: String, path: String, bearer: String?, body: JSONObject?, parse: (JSONObject) -> T): ApiResult<T> {
        val base = baseUrl ?: return ApiResult.Failure(ApiResult.Kind.NOT_CONFIGURED, message = "Endereço do serviço não configurado nesta versão do aplicativo.")
        val request = Request.Builder()
            .url(base + path)
            .method(method, body?.toString()?.toRequestBody(JSON_TYPE) ?: if (method == "GET") null else "{}".toRequestBody(JSON_TYPE))
            .apply { if (bearer != null) header("Authorization", "Bearer $bearer") }
            .build()
        return suspendCancellableCoroutine { cont ->
            val call = http.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (cont.isActive) cont.resume(ApiResult.Failure(ApiResult.Kind.NETWORK, message = "Sem conexão com o serviço."))
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = response.use { r ->
                        val text = r.body?.string().orEmpty()
                        val json = try { if (text.isBlank()) JSONObject() else JSONObject(text) } catch (e: Exception) { null }
                        when {
                            r.isSuccessful && json != null -> try {
                                ApiResult.Ok(parse(json))
                            } catch (e: Exception) {
                                ApiResult.Failure(ApiResult.Kind.HTTP, r.code, "bad_response", "Resposta inesperada do serviço.")
                            }
                            else -> ApiResult.Failure(ApiResult.Kind.HTTP, r.code, json?.optString("error"), json?.optString("message")?.ifBlank { null }, json)
                        }
                    }
                    if (cont.isActive) cont.resume(result)
                }
            })
        }
    }
}
