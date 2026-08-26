package io.github.thmschk.ibswatch.data

import android.content.Context

/** Einstellungen, die der Nutzer drehen kann. Bewusst wenige. */
class SettingsStore(context: Context) {

    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /**
     * Wie viele Tage im Voraus geprueft wird.
     *
     * Kurz ist hier besser als lang: erinnert wird an jeden noch bestellbaren
     * Tag im Fenster, und wenn man ohnehin wochenweise bestellt, meldet ein
     * grosses Fenster taeglich dieselbe noch offene Folgewoche. Zwei Tage
     * decken den Bestellschluss ab, ohne zu nerven.
     */
    var daysAhead: Int
        get() = prefs.getInt(KEY_DAYS_AHEAD, DEFAULT_DAYS_AHEAD)
        set(value) = prefs.edit().putInt(KEY_DAYS_AHEAD, value).apply()

    companion object {
        const val DEFAULT_DAYS_AHEAD = 2
        val CHOICES = listOf(1, 2, 5, 9)
        private const val KEY_DAYS_AHEAD = "days_ahead"
    }
}
