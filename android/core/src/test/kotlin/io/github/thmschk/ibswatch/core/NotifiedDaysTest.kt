package io.github.thmschk.ibswatch.core

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NotifiedDaysTest {

    private val today = LocalDate.of(2026, 8, 26)
    private fun day(day: Int, state: OrderState) =
        DayStatus(LocalDate.of(2026, 8, day), state)

    @Test
    fun `derselbe Tag im selben Zustand klingelt nicht erneut`() {
        val open = listOf(day(27, OrderState.NOT_ORDERED))
        val known = NotifiedDays.remember(emptySet(), open, today)
        assertFalse(NotifiedDays.hasFresh(open, known))
    }

    /**
     * Regression: frueher stand nur das Datum im Gedaechtnis. Ein Tag, dessen
     * Bestellschluss abgelaufen war, galt damit als schon gemeldet — der
     * Uebergang, an dem man das Brot einpacken muss, blieb still.
     */
    @Test
    fun `Wechsel des Zustands ist eine neue Meldung`() {
        val known = NotifiedDays.remember(emptySet(), listOf(day(27, OrderState.NOT_ORDERED)), today)
        assertTrue(NotifiedDays.hasFresh(listOf(day(27, OrderState.DEADLINE_PASSED)), known))
    }

    @Test
    fun `ein neuer Tag ist eine neue Meldung`() {
        val known = NotifiedDays.remember(emptySet(), listOf(day(27, OrderState.NOT_ORDERED)), today)
        assertTrue(NotifiedDays.hasFresh(listOf(day(28, OrderState.NOT_ORDERED)), known))
    }

    @Test
    fun `Vergangenes faellt heraus, sonst waechst die Menge unbegrenzt`() {
        val old = NotifiedDays.remember(emptySet(), listOf(day(20, OrderState.NOT_ORDERED)), LocalDate.of(2026, 8, 20))
        assertEquals(1, old.size)
        assertTrue(NotifiedDays.remember(old, emptyList(), today).isEmpty())
    }

    @Test
    fun `heute bleibt drin, erst was davor liegt faellt heraus`() {
        val known = NotifiedDays.remember(emptySet(), listOf(day(26, OrderState.NOT_ORDERED)), today)
        assertEquals(1, NotifiedDays.remember(known, emptyList(), today).size)
    }

    /** Schluessel aelterer Fassungen bestanden nur aus dem Datum. */
    @Test
    fun `alte Schluessel ohne Zustand stoeren nicht`() {
        val legacy = setOf("2026-08-27", "2026-08-01", "kaputt")
        val kept = NotifiedDays.remember(legacy, emptyList(), today)
        assertEquals(setOf("2026-08-27"), kept)
    }
}
