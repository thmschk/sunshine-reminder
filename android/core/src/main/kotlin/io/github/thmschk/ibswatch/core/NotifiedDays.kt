package io.github.thmschk.ibswatch.core

import java.time.LocalDate

/**
 * Worueber schon gemeldet wurde.
 *
 * Ohne dieses Gedaechtnis meldet ein Fenster von 7 oder 14 Tagen jeden Tag
 * aufs Neue dieselbe offene Folgewoche, weil das Fenster taeglich
 * weiterrutscht. Wer taeglich dieselbe Meldung bekommt, wischt sie bald
 * ungelesen weg — und dann nuetzt der Waechter nichts mehr.
 *
 * Der Schluessel enthaelt den Zustand und nicht nur das Datum: sonst gilt ein
 * Tag, der von "noch bestellbar" nach "Bestellschluss vorbei" wechselt, als
 * schon erledigt. Ausgerechnet der Uebergang, an dem man das Brot einpacken
 * muss, waere damit der leiseste.
 */
object NotifiedDays {

    private const val SEPARATOR = ':'

    fun key(day: DayStatus): String = "${day.date}$SEPARATOR${day.state.name}"

    /** Gibt es einen Tag, ueber den in diesem Zustand noch nicht gemeldet wurde? */
    fun hasFresh(days: List<DayStatus>, alreadyNotified: Set<String>): Boolean =
        days.any { key(it) !in alreadyNotified }

    /**
     * Die bekannten Schluessel plus die neuen, ohne Vergangenes — sonst waechst
     * die Menge unbegrenzt.
     *
     * Schluessel aelterer Fassungen bestanden nur aus dem Datum. Die werden
     * hier mit ausgewertet und verschwinden von selbst, sobald ihr Tag vorbei
     * ist; einmalig meldet die App nach dem Update deshalb erneut.
     */
    fun remember(
        alreadyNotified: Set<String>,
        days: List<DayStatus>,
        today: LocalDate,
    ): Set<String> = (alreadyNotified + days.map { key(it) })
        .filterTo(mutableSetOf()) { entry ->
            runCatching { !LocalDate.parse(entry.substringBefore(SEPARATOR)).isBefore(today) }
                .getOrDefault(false)
        }
}
