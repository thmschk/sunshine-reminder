package io.github.thmschk.ibswatch.core

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class UpdateCheckTest {

    private val server = MockWebServer()

    @AfterTest
    fun tearDown() = server.shutdown()

    private fun latestFrom(response: MockResponse): String? {
        server.enqueue(response)
        return UpdateCheck.latestVersion(UpdateCheck.defaultHttpClient(), server.url("/latest").toString())
    }

    @Test
    fun `die Weiterleitung nennt die Version`() {
        val version = latestFrom(
            MockResponse().setResponseCode(302).setHeader(
                "Location",
                "https://github.com/thmschk/sunshine-reminder/releases/tag/v0.1.3",
            ),
        )
        assertEquals("0.1.3", version)
    }

    @Test
    fun `ein Tag ohne v wird auch verstanden`() {
        val version = latestFrom(
            MockResponse().setResponseCode(302)
                .setHeader("Location", "/thmschk/sunshine-reminder/releases/tag/1.2.0"),
        )
        assertEquals("1.2.0", version)
    }

    /**
     * Kein Netz, geaenderte Adresse, unerwartetes Format: alles heisst "keine
     * Aussage" und darf nicht als "du bist aktuell" durchgehen.
     */
    @Test
    fun `unbrauchbare Antworten ergeben keine Aussage`() {
        assertNull(latestFrom(MockResponse().setResponseCode(200)))
        assertNull(latestFrom(MockResponse().setResponseCode(302).setHeader("Location", "/irgendwohin")))
        assertNull(latestFrom(MockResponse().setResponseCode(500)))
    }

    @Test
    fun `neuer ist neuer`() {
        assertTrue(UpdateCheck.isNewer("0.1.3", "0.1.2"))
        assertTrue(UpdateCheck.isNewer("0.2.0", "0.1.9"))
        assertTrue(UpdateCheck.isNewer("1.0", "0.9.9"))
        assertTrue(UpdateCheck.isNewer("v0.1.3", "0.1.2"))
    }

    /** Zahlenweise vergleichen, sonst stuende 0.1.10 vor 0.1.9. */
    @Test
    fun `zweistellige Zaehler sortieren richtig`() {
        assertTrue(UpdateCheck.isNewer("0.1.10", "0.1.9"))
        assertFalse(UpdateCheck.isNewer("0.1.9", "0.1.10"))
    }

    @Test
    fun `gleich oder aelter ist kein Update`() {
        assertFalse(UpdateCheck.isNewer("0.1.2", "0.1.2"))
        assertFalse(UpdateCheck.isNewer("0.1.1", "0.1.2"))
        // Unterschiedlich lang, aber wertgleich.
        assertFalse(UpdateCheck.isNewer("0.1", "0.1.0"))
        assertTrue(UpdateCheck.isNewer("0.1.1", "0.1"))
    }

    @Test
    fun `unlesbare Versionen loesen keinen Hinweis aus`() {
        assertFalse(UpdateCheck.isNewer("nightly", "0.1.2"))
        assertFalse(UpdateCheck.isNewer("0.1.3", "unbekannt"))
        assertFalse(UpdateCheck.isNewer("", "0.1.2"))
    }
}
