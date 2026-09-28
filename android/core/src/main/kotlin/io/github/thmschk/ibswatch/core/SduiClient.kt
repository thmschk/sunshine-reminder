package io.github.thmschk.ibswatch.core

import java.io.IOException
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Ein Kind am Elternkonto. */
data class SduiChild(val id: Long, val name: String)

/** Eine Unterrichtsstunde aus dem Sdui-Stundenplan (Quelle ist dort meist WebUntis). */
data class Lesson(
    val begins: LocalDateTime,
    val ends: LocalDateTime,
    val subject: String,
    /** "2" = 2. Stunde; leer, wenn Sdui keine Stundennummer liefert. */
    val hour: String,
    /** Art der Abweichung; bisher nur null gesehen, Werte fuer Ausfall/Vertretung unbekannt. */
    val kind: String?,
    val comment: String,
)

/**
 * Minimaler, nur lesender Client fuer die interne JSON-API von Sdui
 * (`api.sdui.app/v1`) — dieselbe, die Web- und Handy-App benutzen. Es gibt
 * keine offizielle Schnittstelle; die Pfade stammen aus der Web-App.
 */
class SduiClient(
    baseUrl: String = DEFAULT_BASE_URL,
    private val http: OkHttpClient = IbsClient.defaultHttpClient(),
    private val zone: ZoneId = ZoneId.systemDefault(),
) {
    private val base: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()
    private val json = Json { ignoreUnknownKeys = true }

    var token: String? = null
        private set

    /**
     * E-Mail/Benutzername, Passwort und Schulkuerzel (`slink`, der Teil der
     * Login-Adresse nach `sdui.app/`) gegen einen Bearer-Token tauschen.
     * Bewusst ohne Wiederholung — wie bei IBS5 ist die Sperrpolitik unbekannt.
     */
    fun login(identifier: String, password: String, slink: String) {
        val body = buildJsonObject {
            put("identifier", identifier)
            put("password", password)
            put("slink", slink)
        }
        val obj = call(url("auth", "login"), body, authenticated = false)
        val data = obj["data"] as? JsonObject
        val newToken = (data?.get("access_token") as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() && it != "null" }
            ?: throw IbsAuthException(errors(obj) ?: "Sdui-Anmeldung abgelehnt")
        token = newToken
    }

    /** Die Kinder am eigenen Konto; ein Schuelerkonto liefert sich selbst. */
    fun children(): List<SduiChild> {
        val self = data(call(url("users", "self"))) as JsonObject
        val ids = (self["child_pivot"] as? JsonArray).orEmpty()
            .mapNotNull { (it.jsonObject["user_id"] as? JsonPrimitive)?.content?.toLongOrNull() }
        if (ids.isEmpty()) {
            val id = (self["id"] as? JsonPrimitive)?.content?.toLongOrNull() ?: return emptyList()
            return listOf(SduiChild(id, displayName(self)))
        }
        return ids.map { id ->
            val user = runCatching { data(call(url("users", id.toString()))) as JsonObject }.getOrNull()
            SduiChild(id, user?.let(::displayName).orEmpty().ifBlank { "Kind $id" })
        }
    }

    /** Stunden von `from` bis `to` (beide einschliesslich), nach Beginn sortiert. */
    fun timetable(userId: Long, from: LocalDate, to: LocalDate): List<Lesson> {
        val u = base.newBuilder()
            .addPathSegments("timetables/users/$userId/timetable")
            .addQueryParameter("begins_at", from.toString())
            .addQueryParameter("ends_at", to.toString())
            .build()
        val lessons = (data(call(u)) as? JsonObject)?.get("lessons") as? JsonArray ?: return emptyList()
        return lessons.mapNotNull { runCatching { lesson(it.jsonObject) }.getOrNull() }.sortedBy { it.begins }
    }

    private fun lesson(o: JsonObject): Lesson {
        val meta = o["meta"] as? JsonObject
        fun s(obj: JsonObject?, key: String) =
            (obj?.get(key) as? JsonPrimitive)?.content?.takeIf { it != "null" }.orEmpty()
        return Lesson(
            begins = time(o["begins_at"]),
            ends = time(o["ends_at"]),
            subject = s(meta, "displayname").ifBlank { s(meta, "shortname") },
            hour = s(meta, "displayname_hour"),
            kind = s(o, "kind").ifBlank { null },
            comment = s(o, "comment"),
        )
    }

    private fun time(e: JsonElement?): LocalDateTime =
        LocalDateTime.ofInstant(Instant.ofEpochSecond((e as JsonPrimitive).content.toLong()), zone)

    private fun displayName(user: JsonObject): String {
        val meta = user["meta"] as? JsonObject
        return (meta?.get("displayname") as? JsonPrimitive)?.content
            ?: listOfNotNull(
                (user["firstname"] as? JsonPrimitive)?.content,
                (user["lastname"] as? JsonPrimitive)?.content,
            ).joinToString(" ")
    }

    private fun data(obj: JsonObject): JsonElement =
        obj["data"] ?: throw IbsException("Sdui-Antwort ohne data")

    private fun errors(obj: JsonObject): String? =
        ((obj["meta"] as? JsonObject)?.get("errors") as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.content }?.joinToString("; ")?.ifBlank { null }

    private fun url(vararg segments: String): HttpUrl =
        base.newBuilder().apply { segments.forEach { addPathSegment(it) } }.build()

    private fun call(url: HttpUrl, body: JsonObject? = null, authenticated: Boolean = true): JsonObject {
        val builder = Request.Builder().url(url)
            .header("Accept", "application/json")
            .header("User-Agent", IbsClient.USER_AGENT)
        if (authenticated) {
            val bearer = token ?: throw IbsAuthException("Sdui: nicht eingeloggt")
            builder.header("Authorization", "Bearer $bearer")
        }
        if (body != null) builder.post(body.toString().toRequestBody(JSON))

        val text = try {
            http.newCall(builder.build()).execute().use { response ->
                val t = response.body?.string().orEmpty()
                when {
                    response.code == 401 || response.code == 403 -> {
                        val msg = runCatching { errors(json.parseToJsonElement(t).jsonObject) }.getOrNull()
                        throw IbsAuthException("Sdui: ${msg ?: "HTTP ${response.code}"}")
                    }
                    !response.isSuccessful -> throw IbsException("Sdui ${url.encodedPath}: HTTP ${response.code}")
                    else -> t
                }
            }
        } catch (exc: IOException) {
            throw IbsException("Sdui nicht erreichbar: ${exc.message}", exc)
        }
        return try {
            json.parseToJsonElement(text).jsonObject
        } catch (exc: Exception) {
            throw IbsException("Sdui ${url.encodedPath}: kein JSON", exc)
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://api.sdui.app/v1"
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

/** Was fuer den naechsten Schultag an ausgewaehlten Faechern ansteht. */
object SubjectReminder {

    /** Naechster Werktag nach `today` — am Freitag also der Montag. */
    fun nextSchoolDay(today: LocalDate): LocalDate {
        var d = today.plusDays(1)
        while (d.dayOfWeek == DayOfWeek.SATURDAY || d.dayOfWeek == DayOfWeek.SUNDAY) d = d.plusDays(1)
        return d
    }

    /** Ein Fach mit seinen Stunden an diesem Tag. */
    data class Match(val subject: String, val hours: List<String>, val notes: List<String>) {
        /** "1.–2. Stunde", "3. Stunde" oder leer. */
        val hoursLabel: String
            get() {
                val n = hours.mapNotNull { it.toIntOrNull() }.distinct().sorted()
                return when {
                    n.isEmpty() -> ""
                    n.size == 1 -> "${n[0]}. Stunde"
                    n.zipWithNext().all { (a, b) -> b == a + 1 } -> "${n.first()}.–${n.last()}. Stunde"
                    else -> n.joinToString(", ") { "$it." } + " Stunde"
                }
            }
    }

    /**
     * Die ausgewaehlten Faecher an `date`. Doppelte Zeilen (parallele Kurse,
     * Wahlfaecher) werden je Fach zusammengefasst. `kind` und `comment` wandern
     * als Hinweis mit, damit ein Ausfall nicht als normale Stunde erinnert wird,
     * solange die Werte fuer Ausfall/Vertretung unbekannt sind.
     */
    fun matches(lessons: List<Lesson>, date: LocalDate, subjects: Set<String>): List<Match> =
        lessons.filter { it.begins.toLocalDate().isEqual(date) && it.subject in subjects }
            .groupBy { it.subject }
            .map { (subject, ls) ->
                Match(
                    subject = subject,
                    hours = ls.map { it.hour },
                    notes = ls.flatMap { listOfNotNull(it.kind, it.comment.ifBlank { null }) }.distinct(),
                )
            }

    /** Alle Faecher eines Zeitraums, alphabetisch — fuer die Auswahl. */
    fun knownSubjects(lessons: List<Lesson>): List<String> =
        lessons.map { it.subject }.filter { it.isNotBlank() }.distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)
}
