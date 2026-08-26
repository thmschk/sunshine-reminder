package de.ibswatch.core

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class IbsClientTest {

    private val server = MockWebServer()
    private fun client() = IbsClient(baseUrl = server.url("/ibs5").toString())

    @AfterTest
    fun tearDown() = server.shutdown()

    @Test
    fun `Login schickt die Felder, die IBS5 erwartet`() {
        server.enqueue(MockResponse().setBody("""{"token":"abc","name1":"Muster","institutionName1":"GS Test"}"""))

        val profile = client().login("123456", "geheim")

        assertEquals("Muster", profile.name)
        assertEquals("GS Test", profile.institution)
        val body = server.takeRequest().body.readUtf8()
        listOf("identifierValue=123456", "secretValue=geheim", "identifierType=0", "secretType=0")
            .forEach { assertTrue(body.contains(it), "Feld fehlt im Body: $it — war: $body") }
    }

    /**
     * Regression: ohne Accept-Language antwortet der echte IIS mit HTTP 500,
     * weil Request.UserLanguages null ist. Das hat beim Erkunden Zeit gekostet.
     */
    @Test
    fun `jeder Request traegt Accept-Language`() {
        server.enqueue(MockResponse().setBody("""{"token":"abc"}"""))
        server.enqueue(MockResponse().setBody("""<div id="weekplan">KW 35</div>"""))

        client().apply { login("1", "2") }.weekplan(2026, 35)

        repeat(2) {
            val request = server.takeRequest()
            assertEquals(IbsClient.ACCEPT_LANGUAGE, request.getHeader("Accept-Language"))
        }
    }

    @Test
    fun `authentifizierte Requests tragen Bearer-Token und X-Requested-With`() {
        server.enqueue(MockResponse().setBody("""{"token":"tok123"}"""))
        server.enqueue(MockResponse().setBody("""<div id="weekplan">KW 35</div>"""))

        client().apply { login("1", "2") }.weekplan(2026, 35)

        server.takeRequest()  // Login
        val request = server.takeRequest()
        assertEquals("Bearer tok123", request.getHeader("Authorization"))
        assertEquals("XMLHttpRequest", request.getHeader("X-Requested-With"))
        assertTrue(request.path!!.contains("year=2026"), "Jahr fehlt: ${request.path}")
        assertTrue(request.path!!.contains("week=35"), "Woche fehlt: ${request.path}")
    }

    @Test
    fun `falsche Zugangsdaten werfen IbsAuthException`() {
        server.enqueue(MockResponse().setBody("""{"errorMessage":"Kundennummer und/oder Passwort ungueltig"}"""))
        assertFailsWith<IbsAuthException> { client().login("1", "2") }
    }

    @Test
    fun `abgelehnter Token wirft IbsAuthException statt Alarm`() {
        server.enqueue(MockResponse().setBody("""{"token":"abc"}"""))
        server.enqueue(MockResponse().setResponseCode(401))
        val c = client().apply { login("1", "2") }
        assertFailsWith<IbsAuthException> { c.weekplan(2026, 35) }
    }

    @Test
    fun `ohne Login kein authentifizierter Request`() {
        assertFailsWith<IbsAuthException> { client().weekplan() }
    }
}
