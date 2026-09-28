package io.github.thmschk.ibswatch.core

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.LocalDate
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

open class IbsException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** Login abgelehnt, oder der Token ist nicht (mehr) gueltig. */
class IbsAuthException(message: String) : IbsException(message)

/**
 * Client fuer die JSON/Bearer-API von IBS5.
 *
 * Zwei Eigenheiten des Servers sind hier ein fuer alle Mal abgefangen — beide
 * haben beim Erkunden Zeit gekostet und sind durch Tests abgesichert:
 *
 *  * Ohne `Accept-Language` antwortet IIS mit **HTTP 500**; `Request.UserLanguages`
 *    ist dann null in `Views/Shared/_Layout.cshtml`.
 *  * Authentifizierte Endpunkte erwarten zusaetzlich `X-Requested-With`,
 *    sonst kommt die SPA-Huelle statt des Fragments zurueck.
 */
class IbsClient(
    baseUrl: String = DEFAULT_BASE_URL,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    private val base: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()
    private val json = Json { ignoreUnknownKeys = true }

    var token: String? = null
        private set

    /**
     * Kundennummer + Passwort gegen einen Bearer-Token tauschen.
     *
     * Bewusst ohne Wiederholung: die Sperrpolitik des Anbieters ist unbekannt,
     * und ein Waechter, der bei Netzproblemen das Login-Formular bombardiert,
     * ist der schnellste Weg zum gesperrten Konto.
     */
    fun login(customerNo: String, password: String): Profile {
        val body = FormBody.Builder()
            .add("identifierValue", customerNo)
            .add("secretValue", password)
            .add("identifierType", "0")
            .add("secretType", "0")
            .build()

        val request = Request.Builder()
            .url(base.newBuilder().addPathSegment("Login").addPathSegment("Login").build())
            .post(body)
            .header("User-Agent", USER_AGENT)
            .header("Accept-Language", ACCEPT_LANGUAGE)
            .header("X-Requested-With", "XMLHttpRequest")
            .build()

        val text = try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw IbsException("Login lieferte HTTP ${response.code}")
                response.body?.string().orEmpty()
            }
        } catch (exc: IOException) {
            throw IbsException("Login-Request fehlgeschlagen: ${exc.message}", exc)
        }

        val obj = try {
            json.parseToJsonElement(text).jsonObject
        } catch (exc: Exception) {
            throw IbsException("Login lieferte kein JSON", exc)
        }

        obj["errorMessage"]?.jsonPrimitive?.contentOrNullSafe()?.let { throw IbsAuthException(it) }

        val newToken = obj["token"]?.jsonPrimitive?.contentOrNullSafe()
            ?: throw IbsException("Login-Antwort enthielt kein Token")

        token = newToken
        return Profile(
            name = obj["name1"]?.jsonPrimitive?.contentOrNullSafe().orEmpty(),
            institution = obj["institutionName1"]?.jsonPrimitive?.contentOrNullSafe().orEmpty(),
        )
    }

    /** Wochenplan als HTML-Fragment; ohne Argumente die laufende Woche. */
    fun weekplan(year: Int? = null, week: Int? = null): String {
        val url = base.newBuilder()
            .addPathSegment("Mealplan")
            .addPathSegment("Weekplan")
            .apply {
                if (year != null) addQueryParameter("year", year.toString())
                if (week != null) addQueryParameter("week", week.toString())
            }
            .build()
        return get(url)
    }

    /** Stand des Warenkorbs (`UpdateBalanceAndCart`). */
    fun cart(): CartResponse = CartResponse.from(
        parseJson(get(path("Mealplan", "UpdateBalanceAndCart")), "UpdateBalanceAndCart"),
    )

    /**
     * Eine Menuelinie fuer einen Tag in den Warenkorb legen — wie ein Klick
     * im Wochenplan (`addToCartWithGroup`, Typ `I` = neu bestellen). Bestellt
     * ist damit noch nichts, siehe [submitCart].
     */
    fun addToCart(entry: MenuEntry): CartResponse = saveOrder(entry, 1, "I")

    /**
     * Abbestellung einer bestellten Menuelinie in den Warenkorb legen (Typ `D`,
     * Menge −1). Wirksam erst mit [submitCart]; bis dahin macht [clearCart]
     * sie rueckgaengig.
     */
    fun cancelInCart(entry: MenuEntry): CartResponse = saveOrder(entry, -1, "D")

    private fun saveOrder(entry: MenuEntry, quantity: Int, type: String): CartResponse = CartResponse.from(
        post(
            path("Mealplan", "SaveOrder"),
            buildJsonObject {
                putJsonObject("mealOrderQuantity") {
                    put("CustomerId", entry.customerId)
                    put("ServeDate", entry.date.toString())
                    put("MenuGroupId", entry.menuGroupId)
                    put("MenuLineId", entry.menuLineId)
                    put("QuantityInShoppingCart", quantity)
                    put("ShoppingCartOrderType", type)
                }
            },
        ),
    )

    /** Warenkorb-Eintraege eines Tages (und einer Gruppe) entfernen. */
    fun clearCart(customerId: String, date: LocalDate, menuGroupId: String): CartResponse =
        CartResponse.from(
            post(
                path("Mealplan", "ClearCart"),
                buildJsonObject {
                    putJsonObject("mealOrderQuantity") {
                        put("CustomerId", customerId)
                        put("ServeDate", date.toString())
                        put("MenuGroupId", menuGroupId)
                    }
                },
            ),
        )

    /**
     * Den **gesamten** Warenkorb verbindlich bestellen (Knopf "Bestaetigen").
     * Der Server kennt kein "nur diese Eintraege" — deshalb prueft
     * [OrderPlacer] vorher, dass nur das Gewollte drinliegt.
     */
    fun submitCart(): CartResponse = CartResponse.from(post(path("Cart", "Order"), JsonNull))

    private fun path(vararg segments: String): HttpUrl =
        base.newBuilder().apply { segments.forEach { addPathSegment(it) } }.build()

    private fun parseJson(text: String, what: String): JsonObject = try {
        json.parseToJsonElement(text).jsonObject
    } catch (exc: Exception) {
        throw IbsException("$what lieferte kein JSON", exc)
    }

    /** JSON-POST wie `infrastructure.doAjaxCall` der Webseite. */
    private fun post(url: HttpUrl, payload: kotlinx.serialization.json.JsonElement): JsonObject {
        val bearer = token ?: throw IbsAuthException("Nicht eingeloggt — erst login() aufrufen")

        val request = Request.Builder()
            .url(url)
            .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))
            .header("User-Agent", USER_AGENT)
            .header("Accept-Language", ACCEPT_LANGUAGE)
            .header("Authorization", "Bearer $bearer")
            .header("X-Requested-With", "XMLHttpRequest")
            .build()

        val text = try {
            http.newCall(request).execute().use { response ->
                when {
                    response.code == 401 || response.code == 403 ->
                        throw IbsAuthException("${url.encodedPath}: Token abgelehnt (HTTP ${response.code})")
                    !response.isSuccessful ->
                        throw IbsException("${url.encodedPath}: HTTP ${response.code}")
                    else -> response.body?.string().orEmpty()
                }
            }
        } catch (exc: IOException) {
            throw IbsException("Request an ${url.encodedPath} fehlgeschlagen: ${exc.message}", exc)
        }
        return parseJson(text, url.encodedPath)
    }

    private fun get(url: HttpUrl): String {
        val bearer = token ?: throw IbsAuthException("Nicht eingeloggt — erst login() aufrufen")

        val request = Request.Builder()
            .url(url)
            .header("User-Agent", USER_AGENT)
            .header("Accept-Language", ACCEPT_LANGUAGE)
            .header("Authorization", "Bearer $bearer")
            .header("X-Requested-With", "XMLHttpRequest")
            .build()

        try {
            http.newCall(request).execute().use { response ->
                when {
                    response.code == 401 || response.code == 403 ->
                        throw IbsAuthException("${url.encodedPath}: Token abgelehnt (HTTP ${response.code})")
                    !response.isSuccessful ->
                        throw IbsException("${url.encodedPath}: HTTP ${response.code}")
                    else -> return response.body?.string().orEmpty()
                }
            }
        } catch (exc: IOException) {
            throw IbsException("Request an ${url.encodedPath} fehlgeschlagen: ${exc.message}", exc)
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://ibs.sunshine-catering.de/ibs5"

        /** Adresse fuer Menschen — die steht in Benachrichtigungen. */
        const val WEB_URL = "https://ibs.sunshine-catering.de/IBS5"

        const val USER_AGENT = "sunshine-reminder (+https://github.com/thmschk/sunshine-reminder)"
        const val ACCEPT_LANGUAGE = "de-DE,de;q=0.9"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

/** `JsonPrimitive.content` liefert bei JSON-null den String "null". */
private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    content.takeIf { it.isNotEmpty() && it != "null" }

/**
 * Antwort der Warenkorb-Endpunkte.
 *
 * Die `Mealplan`-Endpunkte antworten in camelCase (`messageStatus`), `Cart/Order` laut
 * Seiten-JS in PascalCase (`MessageStatus`) — beides wird gelesen.
 */
data class CartResponse(
    val ok: Boolean,
    val message: String?,
    val totalItemsInCart: Int?,
) {
    companion object {
        fun from(obj: JsonObject): CartResponse {
            fun field(name: String) = (obj[name] ?: obj[name.replaceFirstChar { it.uppercase() }])
                ?.let { it as? kotlinx.serialization.json.JsonPrimitive }
            val status = field("messageStatus")?.contentOrNullSafe()
            return CartResponse(
                ok = status == null || status.equals("OK", ignoreCase = true),
                message = field("message")?.contentOrNullSafe(),
                totalItemsInCart = field("totalItemsInCart")?.contentOrNullSafe()?.toIntOrNull(),
            )
        }
    }
}
