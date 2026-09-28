package io.github.thmschk.ibswatch.core

import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * `sdui_timetable.json` hat die Struktur einer echten Antwort (28.09.2026),
 * Namen und IDs sind ersetzt, die Stunden fuer den Test zusammengestellt.
 */
class SduiClientTest {

    private val server = MockWebServer()
    private val zone = ZoneId.of("Europe/Berlin")
    private fun client() = SduiClient(baseUrl = server.url("/v1").toString(), zone = zone)
    private val fixture = checkNotNull(javaClass.getResourceAsStream("/sdui_timetable.json")).bufferedReader().readText()

    @AfterTest
    fun tearDown() = server.shutdown()

    private fun loggedIn(): SduiClient {
        server.enqueue(MockResponse().setBody("""{"data":{"token_type":"Bearer","access_token":"tok","expires_in":1}}"""))
        return client().also { it.login("a@b.de", "pw", "meine-schule"); server.takeRequest() }
    }

    @Test
    fun `Login schickt identifier, password und slink`() {
        server.enqueue(MockResponse().setBody("""{"data":{"access_token":"tok"}}"""))
        client().login("a@b.de", "pw", "meine-schule")
        val req = server.takeRequest()
        assertEquals("/v1/auth/login", req.path)
        assertEquals("""{"identifier":"a@b.de","password":"pw","slink":"meine-schule"}""", req.body.readUtf8())
    }

    @Test
    fun `abgelehnter Login ist ein Auth-Fehler`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"data":[],"meta":{"errors":["Falsches Passwort"]}}"""))
        val exc = assertFailsWith<IbsAuthException> { client().login("a", "b", "c") }
        assertTrue(exc.message!!.contains("Falsches Passwort"))
    }

    @Test
    fun `Stundenplan wird gelesen und traegt den Token`() {
        val c = loggedIn()
        server.enqueue(MockResponse().setBody(fixture))
        val lessons = c.timetable(42, LocalDate.of(2026, 10, 1), LocalDate.of(2026, 10, 9))
        val req = server.takeRequest()
        assertEquals("/v1/timetables/users/42/timetable?begins_at=2026-10-01&ends_at=2026-10-09", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals(9, lessons.size)
        assertEquals(8, lessons.first().begins.hour)
        assertEquals("Sp", lessons.first().short)
    }

    @Test
    fun `Kinder kommen aus child_pivot`() {
        val c = loggedIn()
        server.enqueue(MockResponse().setBody("""{"data":{"id":1,"child_pivot":[{"user_id":7}]}}"""))
        server.enqueue(MockResponse().setBody("""{"data":{"id":7,"meta":{"displayname":"Mia Muster"}}}"""))
        assertEquals(listOf(SduiChild(7, "Mia Muster")), c.children())
    }

    @Test
    fun `Treffer fassen Doppelstunden zusammen und tragen Hinweise mit`() {
        val c = loggedIn()
        server.enqueue(MockResponse().setBody(fixture))
        val lessons = c.timetable(42, LocalDate.of(2026, 10, 1), LocalDate.of(2026, 10, 9))

        val thu = SubjectReminder.matches(lessons, LocalDate.of(2026, 10, 1), setOf("Sport", "Schwimmen"))
        assertEquals(1, thu.size)
        assertEquals("1.–2. Stunde", thu.single().hoursLabel)

        val mon = SubjectReminder.matches(lessons, LocalDate.of(2026, 10, 5), setOf("Sport", "Schwimmen"))
        assertEquals(listOf("Bus 7:45"), mon.single().notes)

        assertTrue(SubjectReminder.matches(lessons, LocalDate.of(2026, 10, 2), setOf("Sport")).isEmpty())
        assertEquals(
            listOf("Deutsch", "Englisch", "isl. Religion", "Lebenskunde", "Schwimmen", "Sport"),
            SubjectReminder.knownSubjects(lessons),
        )
    }

    @Test
    fun `naechster Schultag springt uebers Wochenende`() {
        assertEquals(LocalDate.of(2026, 10, 5), SubjectReminder.nextSchoolDay(LocalDate.of(2026, 10, 2))) // Fr → Mo
        assertEquals(LocalDate.of(2026, 9, 30), SubjectReminder.nextSchoolDay(LocalDate.of(2026, 9, 29)))
    }
}
