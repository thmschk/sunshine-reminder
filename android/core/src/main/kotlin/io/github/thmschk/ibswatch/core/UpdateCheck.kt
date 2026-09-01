package io.github.thmschk.ibswatch.core

import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Liegt eine neuere Fassung bereit?
 *
 * Die App wird ausserhalb eines Stores verteilt — niemand erfaehrt also von
 * selbst, dass es ein Update gibt. Bei dieser App waere das besonders teuer:
 * ihr Fehlermodus ist Schweigen. Aendert der Anbieter etwas und eine
 * Korrektur erscheint, verlaesst sich jeder mit einer alten Fassung weiter auf
 * einen Waechter, der nichts mehr meldet, und merkt es nicht. Deshalb sieht
 * die App selbst nach.
 *
 * Gefragt wird bewusst **nicht** die GitHub-API: die erlaubt unangemeldet 60
 * Anfragen pro Stunde und IP-Adresse, und hinter dem CGNAT eines
 * Mobilfunkanbieters teilen sich das sehr viele Geraete. Die Weiterleitung von
 * `/releases/latest` kennt kein Limit und nennt den Tag im Location-Header.
 */
object UpdateCheck {

    const val RELEASES_LATEST = "https://github.com/thmschk/sunshine-reminder/releases/latest"

    /** Der Dauerlink — liefert immer die neueste Fassung. */
    const val DOWNLOAD_URL =
        "https://github.com/thmschk/sunshine-reminder/releases/latest/download/sunshine-reminder.apk"

    private val TAG_IN_LOCATION = Regex("""/releases/tag/v?(\d+(?:\.\d+)*)""")

    /**
     * Die angebotene Version, oder null.
     *
     * Null heisst ausdruecklich "keine Aussage" und nicht "aktuell": kein Netz,
     * eine geaenderte Adresse oder ein unerwartetes Format duerfen nicht dazu
     * fuehren, dass ein vorhandener Hinweis verschwindet.
     */
    fun latestVersion(
        http: OkHttpClient = defaultHttpClient(),
        url: String = RELEASES_LATEST,
    ): String? {
        val request = Request.Builder()
            .url(url)
            .head()
            .header("User-Agent", IbsClient.USER_AGENT)
            .build()
        return try {
            http.newCall(request).execute().use { response ->
                val location = response.header("Location") ?: return null
                TAG_IN_LOCATION.find(location)?.groupValues?.get(1)
            }
        } catch (exc: IOException) {
            null
        }
    }

    /**
     * Ist [candidate] neuer als [current]? Verglichen wird zahlenweise, damit
     * 0.1.10 nach 0.1.9 kommt und nicht davor.
     *
     * Laesst sich eine der beiden nicht deuten, lautet die Antwort nein: lieber
     * kein Hinweis als ein Hinweis auf eine Fassung, die es nicht gibt.
     */
    fun isNewer(candidate: String, current: String): Boolean {
        val new = parse(candidate) ?: return false
        val old = parse(current) ?: return false
        for (index in 0 until maxOf(new.size, old.size)) {
            val a = new.getOrElse(index) { 0 }
            val b = old.getOrElse(index) { 0 }
            if (a != b) return a > b
        }
        return false
    }

    private fun parse(version: String): List<Int>? =
        version.trim().removePrefix("v").split('.').map { part ->
            part.toIntOrNull() ?: return null
        }

    /**
     * Ohne Redirect-Verfolgung — die Weiterleitung ist ja die Antwort. Kurze
     * Zeitlimits, weil dieser Aufruf nur Beiwerk ist und den Bestellstand
     * nicht aufhalten darf.
     */
    fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .followRedirects(false)
        .build()
}
