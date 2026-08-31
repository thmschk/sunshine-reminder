package io.github.thmschk.ibswatch.core

import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Der Plan ist die Stelle, an der die App am teuersten scheitert: ein falsch
 * gerechneter Termin faellt niemandem auf, weil das Ergebnis Schweigen ist.
 *
 * Bezugswoche: Montag 24.08.2026 bis Sonntag 30.08.2026.
 */
class CheckScheduleTest {

    private fun at(day: Int, hour: Int, minute: Int = 0, second: Int = 0) =
        LocalDateTime.of(2026, 8, day, hour, minute, second)

    @Test
    fun `vor der Pruefzeit wird noch heute geprueft`() {
        assertEquals(at(26, 17, 0), CheckSchedule.nextRun(at(26, 9, 30)))
    }

    @Test
    fun `nach der Pruefzeit erst am naechsten Werktag`() {
        assertEquals(at(27, 17, 0), CheckSchedule.nextRun(at(26, 17, 30)))
    }

    /**
     * Regression: der Lauf startet exakt zur Pruefzeit und plant von dort aus
     * neu. Zaehlte dieser Moment noch als "vor der Pruefzeit", plante sich der
     * Waechter auf den Termin, an dem er gerade steht — eine Schleife.
     */
    @Test
    fun `exakt zur Pruefzeit zaehlt als erledigt`() {
        assertEquals(at(27, 17, 0), CheckSchedule.nextRun(at(26, 17, 0)))
    }

    @Test
    fun `Freitagabend springt auf Montag`() {
        assertEquals(at(31, 17, 0), CheckSchedule.nextRun(at(28, 18, 0)))
    }

    @Test
    fun `am Wochenende wird nicht geprueft`() {
        assertEquals(at(31, 17, 0), CheckSchedule.nextRun(at(29, 10, 0)))  // Samstag
        assertEquals(at(31, 17, 0), CheckSchedule.nextRun(at(30, 22, 0)))  // Sonntag
    }

    /**
     * Regression: `Duration.toMinutes()` schneidet ab. Der Job durfte damit bis
     * zu 59 Sekunden VOR der Pruefzeit feuern — und plante sich dann noch
     * einmal auf denselben Tag, weil der Termin aus seiner Sicht noch bevorstand.
     */
    @Test
    fun `der Vorlauf wird aufgerundet, nie abgerundet`() {
        val now = at(26, 16, 59, 1)
        assertEquals(1L, CheckSchedule.delayMinutes(now))
        assertFalse(
            now.plusMinutes(CheckSchedule.delayMinutes(now)).isBefore(CheckSchedule.nextRun(now)),
            "Der Job wuerde vor der Pruefzeit feuern",
        )
    }

    @Test
    fun `Vorlauf ueber mehrere Stunden stimmt auf die Minute`() {
        assertEquals(9 * 60L, CheckSchedule.delayMinutes(at(26, 8, 0)))
        assertEquals(3 * 24 * 60L, CheckSchedule.delayMinutes(at(28, 17, 0)))  // Fr 17:00 -> Mo 17:00
    }

    @Test
    fun `nie ein negativer Vorlauf`() {
        listOf(at(26, 0, 0), at(26, 17, 0), at(29, 23, 59), at(31, 16, 59, 59))
            .forEach { assertTrue(CheckSchedule.delayMinutes(it) >= 0, "negativ bei $it") }
    }

    @Test
    fun `ein frischer Lauf ist nicht ueberfaellig`() {
        assertFalse(CheckSchedule.isOverdue(at(25, 17, 0), at(26, 10, 0)))
    }

    @Test
    fun `ein ausgefallener Tag ist ueberfaellig`() {
        // Letzter Lauf Di 17:00, der Mittwoch faellt aus — Donnerstag frueh
        // steht fest, dass niemand mehr prueft.
        assertTrue(CheckSchedule.isOverdue(at(25, 17, 0), at(27, 6, 0)))
    }

    /** Das Wochenende ist eine geplante Pause und darf nicht als Ausfall gelten. */
    @Test
    fun `ueber das Wochenende kein Fehlalarm`() {
        val friday = at(28, 17, 0)
        assertFalse(CheckSchedule.isOverdue(friday, at(29, 12, 0)))
        assertFalse(CheckSchedule.isOverdue(friday, at(30, 20, 0)))
        assertFalse(CheckSchedule.isOverdue(friday, at(31, 12, 0)))
        // Montag ist geprueft worden oder eben nicht — Dienstag frueh ist es klar.
        assertTrue(CheckSchedule.isOverdue(friday, LocalDateTime.of(2026, 9, 1, 6, 0)))
    }

    @Test
    fun `ohne Lauf keine Aussage`() {
        assertFalse(CheckSchedule.isOverdue(null, at(26, 10, 0)))
    }
}
