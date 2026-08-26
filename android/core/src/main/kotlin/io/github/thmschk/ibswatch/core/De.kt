package io.github.thmschk.ibswatch.core

import java.time.LocalDate

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

    private fun dmy(date: LocalDate): String =
        "%02d.%02d.%d".format(date.dayOfMonth, date.monthValue, date.year)

    fun long(date: LocalDate): String = "${LONG[date.dayOfWeek.value - 1]}, ${dmy(date)}"

    fun short(date: LocalDate): String = "${SHORT[date.dayOfWeek.value - 1]} ${dmy(date)}"
}
