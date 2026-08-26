package io.github.thmschk.ibswatch.data

import android.content.Context

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
     * Kurz ist hier besser als lang: erinnert wird an jeden noch bestellbaren
     * Tag im Fenster. Wer wochenweise bestellt, bekaeme bei einem grossen
     * Fenster taeglich Meldungen ueber die noch leere Folgewoche — und
     * gewoehnt sich an, sie wegzuwischen. Der Bestellschluss liegt am Vortag,
     * mehr als drei Tage Vorlauf bringen deshalb nichts.
     */
    var daysAhead: Int
        get() = prefs.getInt(KEY_DAYS_AHEAD, DEFAULT_DAYS_AHEAD)
        set(value) = prefs.edit().putInt(KEY_DAYS_AHEAD, value).apply()

    var dayFilter: DayFilter
        get() = runCatching { DayFilter.valueOf(prefs.getString(KEY_FILTER, "").orEmpty()) }
            .getOrDefault(DayFilter.ALL)
        set(value) = prefs.edit().putString(KEY_FILTER, value.name).apply()

    companion object {
        const val DEFAULT_DAYS_AHEAD = 2
        val CHOICES = listOf(1, 2, 3)
        private const val KEY_DAYS_AHEAD = "days_ahead"
        private const val KEY_FILTER = "day_filter"
    }
}
