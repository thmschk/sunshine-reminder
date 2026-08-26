package io.github.thmschk.ibswatch.core

import java.time.LocalDate
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class OrderCheckerTest {

    private val server = MockWebServer()

    private val fixture: String =
        checkNotNull(javaClass.getResourceAsStream("/weekplan_kw35.html")).bufferedReader().readText()

    @AfterTest
    fun tearDown() = server.shutdown()

    private fun checker(config: CheckConfig) =
        OrderChecker(IbsClient(baseUrl = server.url("/ibs5").toString()), config)

    @Test
    fun `Wochenenden fallen aus dem Pruefzeitraum`() {
        val dates = OrderChecker(IbsClient(), CheckConfig(daysAhead = 7))
            .targetDates(LocalDate.of(2026, 8, 26))  // Mittwoch
        assertTrue(dates.none { it.dayOfWeek.value > 5 }, "Wochenende im Zeitraum: $dates")
        assertEquals(LocalDate.of(2026, 8, 27), dates.first())
    }

    @Test
    fun `alles bestellt ergibt Ok`() {
        server.enqueue(MockResponse().setBody("""{"token":"t"}"""))
        server.enqueue(MockResponse().setBody(fixture))

        val result = checker(CheckConfig(daysAhead = 2)).run("1", "2", LocalDate.of(2026, 8, 26))

        assertTrue(result is CheckResult.Ok, "war: $result")
        assertEquals(2, result.days.size)
    }

    @Test
    fun `vergessener Tag ergibt Alarm mit Text`() {
        val forgotten = fixture.split("<button").joinToString("<button") { block ->
            if (block.contains("_2026-08-27_")) {
                block.replace("""data-order-status="2"""", """data-order-status="0"""")
                    .replace("""data-quantity-ordered="1"""", """data-quantity-ordered=""""")
            } else block
        }
        server.enqueue(MockResponse().setBody("""{"token":"t"}"""))
        server.enqueue(MockResponse().setBody(forgotten))

        val result = checker(CheckConfig(daysAhead = 1)).run("1", "2", LocalDate.of(2026, 8, 26))

        assertTrue(result is CheckResult.Alarm, "war: $result")
        assertEquals(1, result.actionable.size)
        assertEquals("1 ausstehende Bestellung", AlarmText.title(result))
        assertEquals("1 ausstehende Bestellung für Mia", AlarmText.title(result, "Mia"))
        // Genauer Aufbau der Meldung: Ueberschrift, dann was zu tun ist, dann die Tage.
        assertEquals(
            listOf(
                "1 ausstehende Bestellung für Mia",
                "Bestellen ist noch möglich:",
                "  • Donnerstag, 27.08.2026",
            ),
            AlarmText.full(result, "Mia").lines(),
        )
    }

    /** Ein Netzfehler ist keine Aussage ueber den Bestellstand. */
    @Test
    fun `Serverfehler ergibt Failed, nicht Alarm`() {
        server.enqueue(MockResponse().setBody("""{"token":"t"}"""))
        server.enqueue(MockResponse().setResponseCode(500))

        val result = checker(CheckConfig(daysAhead = 1)).run("1", "2", LocalDate.of(2026, 8, 26))

        assertTrue(result is CheckResult.Failed, "war: $result")
    }

    @Test
    fun `falsche Kalenderwoche ergibt Failed`() {
        server.enqueue(MockResponse().setBody("""{"token":"t"}"""))
        server.enqueue(MockResponse().setBody("""<div id="weekplan">KW 12</div>"""))

        val result = checker(CheckConfig(daysAhead = 1)).run("1", "2", LocalDate.of(2026, 8, 26))

        assertTrue(result is CheckResult.Failed, "war: $result")
        assertTrue(result.reason.contains("KW 12"), result.reason)
    }
}
