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

    /** Signatur der zuletzt gemeldeten Tage — identische Meldung nicht wiederholen. */
    var lastNotifiedSignature: String
        get() = prefs.getString(KEY_SIGNATURE, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_SIGNATURE, value).apply()

    private companion object {
        const val KEY_SUMMARY = "last_summary"
        const val KEY_LAST_RUN = "last_run"
        const val KEY_SIGNATURE = "last_signature"
        const val KEY_DAYS = "last_days"
    }
}
