package io.github.thmschk.ibswatch.core

import java.time.LocalDate
import java.util.Locale

/**
 * Deutsche Datumsnamen ohne Locale-Abhaengigkeit.
 *
 * Auf Android ist die Locale die des Geraets, auf Servern haeufig gar keine
 * deutsche installiert. Beides wuerde zu englischen Wochentagen in einer
 * deutschsprachigen Benachrichtigung fuehren.
 */
object De {
    private val LONG = arrayOf(
        "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag",
    )
    private val SHORT = arrayOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")

    // Locale.ROOT, sonst richtet sich die Ziffernschreibweise nach dem Geraet
    // — auf einem System mit arabischer Locale kaemen andere Ziffern heraus.
    private fun dmy(date: LocalDate): String =
        "%02d.%02d.%d".format(Locale.ROOT, date.dayOfMonth, date.monthValue, date.year)

    /** Nur der Wochentag — fuer Saetze, in denen das Datum stoeren wuerde. */
    fun weekday(date: LocalDate): String = LONG[date.dayOfWeek.value - 1]

    fun long(date: LocalDate): String = "${weekday(date)}, ${dmy(date)}"

    fun short(date: LocalDate): String = "${SHORT[date.dayOfWeek.value - 1]} ${dmy(date)}"
}
