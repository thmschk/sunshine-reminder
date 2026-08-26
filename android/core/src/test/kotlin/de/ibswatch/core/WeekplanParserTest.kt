package de.ibswatch.core

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * `weekplan_kw35.html` stammt aus einer echten IBS5-Antwort (Attributstruktur
 * unveraendert, IDs neutralisiert). Die uebrigen Faelle werden daraus
 * abgeleitet — echte Beispiele fuer "vergessen zu bestellen" gab es beim
 * Kalibrieren schlicht nicht, es war alles bestellt.
 */
class WeekplanParserTest {

    private val fixture: String =
        checkNotNull(javaClass.getResourceAsStream("/weekplan_kw35.html")) {
            "Fixture weekplan_kw35.html fehlt in den Test-Ressourcen"
        }.bufferedReader().readText()

    private val mon = LocalDate.of(2026, 8, 24)
    private val thu = LocalDate.of(2026, 8, 27)

    /**
     * Attribute nur in den Buttons eines bestimmten Tages ersetzen.
     *
     * Ein globales replace wuerde den Nachbartag mit treffen — genau dieser
     * Fehler hat die erste Fassung dieser Tests faelschlich gruen gemacht.
     */
    private fun patchDay(html: String, isoDate: String, vararg replacements: Pair<String, String>): String =
        html.split("<button").joinToString("<button") { block ->
            if (block.contains("_${isoDate}_")) {
                replacements.fold(block) { acc, (old, new) -> acc.replace(old, new) }
            } else {
                block
            }
        }

    private fun withoutOrders(html: String, isoDate: String): String = patchDay(
        html, isoDate,
        """data-order-status="2"""" to """data-order-status="0"""",
        """data-quantity-ordered="1"""" to """data-quantity-ordered="""""",
    )

    @Test
    fun `echtes Fixture - alle Tage bestellt`() {
        val plan = WeekplanParser.parse(fixture)
        assertEquals(35, plan.displayedWeek)
        assertEquals(5, plan.days.size)
        assertTrue(plan.days.values.all { it.state == OrderState.ORDERED })
    }

    @Test
    fun `vergessen aber noch bestellbar ist ein Alarm`() {
        val plan = WeekplanParser.parse(withoutOrders(fixture, "2026-08-27"))
        assertEquals(OrderState.NOT_ORDERED, plan.days[thu]?.state)
        assertTrue(plan.days.getValue(thu).orderable)
    }

    @Test
    fun `vergessen nach Bestellschluss ist kein Alarm`() {
        val plan = WeekplanParser.parse(withoutOrders(fixture, "2026-08-24"))
        assertEquals(OrderState.DEADLINE_PASSED, plan.days[mon]?.state)
    }

    @Test
    fun `im Warenkorb liegengeblieben wird erkannt`() {
        val html = patchDay(
            withoutOrders(fixture, "2026-08-27"), "2026-08-27",
            """data-quantity-in-shopping-cart="""" to """data-quantity-in-shopping-cart="1"""",
        )
        assertEquals(OrderState.IN_CART, WeekplanParser.parse(html).days[thu]?.state)
    }

    @Test
    fun `unbekannter Status geht nie stillschweigend durch`() {
        val html = patchDay(
            withoutOrders(fixture, "2026-08-27"), "2026-08-27",
            """data-order-status="0"""" to """data-order-status="7"""",
        )
        assertEquals(OrderState.UNKNOWN, WeekplanParser.parse(html).days[thu]?.state)
    }

    @Test
    fun `Tag ohne Angebot ist keine vergessene Bestellung`() {
        val plan = WeekplanParser.parse(fixture)
        assertEquals(OrderState.NO_OFFER, plan.statusFor(LocalDate.of(2026, 8, 29)).state)  // Samstag
    }

    @Test
    fun `leere Ferienwoche ist kein Fehler`() {
        val plan = WeekplanParser.parse("""<div id="weekplan"><div>KW 30</div></div>""")
        assertTrue(plan.days.isEmpty())
        assertEquals(OrderState.NO_OFFER, plan.statusFor(mon).state)
    }

    @Test
    fun `Fehlerseite wirft statt Alarm zu schlagen`() {
        listOf(
            "<html><body><p>Sitzung abgelaufen</p></body></html>",
            """<div class="login-container">Anmelden</div>""",
        ).forEach { html ->
            assertFailsWith<ParserNotCalibratedException> { WeekplanParser.parse(html) }
        }
    }
}
