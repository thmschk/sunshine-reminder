package io.github.thmschk.ibswatch.data

import android.content.Context

/**
 * Was der letzte Lauf ergeben hat — fuer die Anzeige und zur
 * Doppelmeldungs-Sperre.
 *
 * Ohne diese Sperre meldet jeder Lauf denselben vergessenen Tag erneut; nach
 * zwei Tagen wischt man die Meldung weg, ohne hinzusehen, und genau dann ist
 * der Waechter wertlos.
 */
class ResultStore(context: Context) {

    private val prefs = context.getSharedPreferences("results", Context.MODE_PRIVATE)

    var lastSummary: String
        get() = prefs.getString(KEY_SUMMARY, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_SUMMARY, value).apply()

    var lastRunEpochMillis: Long
        get() = prefs.getLong(KEY_LAST_RUN, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_RUN, value).apply()

    /** Der letzte Lauf, Tag fuer Tag — damit die App zeigt, WAS bestellt ist. */
    var lastDays: List<DayLine>
        get() = prefs.getString(KEY_DAYS, "").orEmpty()
            .lineSequence().filter { it.isNotBlank() }.mapNotNull { DayLine.parse(it) }.toList()
        set(value) = prefs.edit()
            .putString(KEY_DAYS, value.joinToString("\n") { it.serialize() })
            .apply()

    /**
     * Tage, ueber die schon gemeldet wurde (ISO-Datum).
     *
     * Ohne dieses Gedaechtnis meldet ein Fenster von 7 oder 14 Tagen jeden Tag
     * aufs Neue dieselbe offene Folgewoche, weil das Fenster taeglich
     * weiterrutscht. Wer taeglich dieselbe Meldung bekommt, wischt sie bald
     * ungelesen weg — und dann nuetzt der Waechter nichts mehr.
     */
    var notifiedDates: Set<String>
        get() = prefs.getStringSet(KEY_NOTIFIED, emptySet()).orEmpty()
        set(value) = prefs.edit().putStringSet(KEY_NOTIFIED, value).apply()

    private companion object {
        const val KEY_SUMMARY = "last_summary"
        const val KEY_LAST_RUN = "last_run"
        const val KEY_NOTIFIED = "notified_dates"
        const val KEY_DAYS = "last_days"
    }
}
