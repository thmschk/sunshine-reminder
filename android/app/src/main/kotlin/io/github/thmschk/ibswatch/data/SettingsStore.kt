package io.github.thmschk.ibswatch.data

import android.content.Context
import io.github.thmschk.ibswatch.core.CheckSchedule
import java.time.LocalTime

/** Welche Tage die Wochenliste zeigt. */
enum class DayFilter(val label: String) {
    ALL("Alle"),
    PENDING("Nur offene"),
    NONE("Keine"),
}

/** Einstellungen, die der Nutzer drehen kann. Bewusst wenige. */
class SettingsStore(context: Context) {

    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /**
     * Wie viele Tage im Voraus geprueft wird.
     *
     * Erinnert wird an jeden noch bestellbaren, nicht bestellten Tag im
     * Fenster. Ein grosses Fenster meldet auch Tage, deren Bestellschluss
     * noch weit weg ist — damit das nicht taeglich nervt, merkt sich
     * [ResultStore.notifiedDates], worueber schon gemeldet wurde.
     */
    var daysAhead: Int
        get() = prefs.getInt(KEY_DAYS_AHEAD, DEFAULT_DAYS_AHEAD)
        set(value) = prefs.edit().putInt(KEY_DAYS_AHEAD, value).apply()

    /**
     * Ortszeit, zu der geprueft wird.
     *
     * Gespeichert als Minuten seit Mitternacht: das laesst sich nicht
     * missverstehen und braucht keine Locale. Wer sie aendert, muss den
     * geplanten Lauf neu einplanen — der vorhandene zielt sonst weiter auf die
     * alte Zeit.
     */
    var checkTime: LocalTime
        get() = prefs.getInt(KEY_CHECK_TIME, -1)
            .takeIf { it in 0..(24 * 60 - 1) }
            ?.let { LocalTime.of(it / 60, it % 60) }
            ?: CheckSchedule.DEFAULT_CHECK_TIME
        set(value) = prefs.edit()
            .putInt(KEY_CHECK_TIME, value.hour * 60 + value.minute)
            .apply()

    var dayFilter: DayFilter
        get() = runCatching { DayFilter.valueOf(prefs.getString(KEY_FILTER, "").orEmpty()) }
            .getOrDefault(DayFilter.ALL)
        set(value) = prefs.edit().putString(KEY_FILTER, value.name).apply()

    companion object {
        const val DEFAULT_DAYS_AHEAD = 7
        const val MIN_DAYS_AHEAD = 1
        const val MAX_DAYS_AHEAD = 14
        private const val KEY_DAYS_AHEAD = "days_ahead"
        private const val KEY_FILTER = "day_filter"
        private const val KEY_CHECK_TIME = "check_time_minutes"
    }
}
