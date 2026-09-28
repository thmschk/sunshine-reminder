package io.github.thmschk.ibswatch.data

import android.content.Context

/**
 * Der optionale Sdui-Bereich: Zugang, gewaehltes Kind und Faecher, dazu das
 * Ergebnis der letzten Pruefung. Eigene Datei, damit "Sdui entfernen" nichts
 * vom Schulessen mitnimmt.
 */
class SduiStore(context: Context) {

    private val prefs = context.getSharedPreferences("sdui", Context.MODE_PRIVATE)

    var identifier: String
        get() = prefs.getString("identifier", "").orEmpty()
        set(v) = prefs.edit().putString("identifier", v).apply()

    var password: String
        get() = prefs.getString("password", "").orEmpty()
        set(v) = prefs.edit().putString("password", v).apply()

    /** Schulkuerzel aus der Login-Adresse `sdui.app/<slink>/login`. */
    var slink: String
        get() = prefs.getString("slink", "").orEmpty()
        set(v) = prefs.edit().putString("slink", v).apply()

    var childId: Long
        get() = prefs.getLong("child_id", 0L)
        set(v) = prefs.edit().putLong("child_id", v).apply()

    var childName: String
        get() = prefs.getString("child_name", "").orEmpty()
        set(v) = prefs.edit().putString("child_name", v).apply()

    /** Faecher, an die am Vortag erinnert wird. */
    var subjects: Set<String>
        get() = prefs.getStringSet("subjects", emptySet()).orEmpty()
        set(v) = prefs.edit().putStringSet("subjects", v).apply()

    /** Faecher aus dem zuletzt geladenen Stundenplan — die Auswahl klappt so auch offline. */
    var knownSubjects: Set<String>
        get() = prefs.getStringSet("known_subjects", emptySet()).orEmpty()
        set(v) = prefs.edit().putStringSet("known_subjects", v).apply()

    /** Ergebnis der letzten Pruefung: Datum des naechsten Schultags (ISO) … */
    var nextDay: String
        get() = prefs.getString("next_day", "").orEmpty()
        set(v) = prefs.edit().putString("next_day", v).apply()

    /** … und je Treffer eine Zeile "Fach — 1.–2. Stunde (Hinweis)". */
    var nextMatches: List<String>
        get() = prefs.getString("next_matches", "").orEmpty().lines().filter { it.isNotBlank() }
        set(v) = prefs.edit().putString("next_matches", v.joinToString("\n")).apply()

    var lastError: String
        get() = prefs.getString("last_error", "").orEmpty()
        set(v) = prefs.edit().putString("last_error", v).apply()

    /** "Datum:Faecher" der letzten Erinnerung — ein zweiter Lauf am selben Tag klingelt nicht erneut. */
    var notifiedKey: String
        get() = prefs.getString("notified_key", "").orEmpty()
        set(v) = prefs.edit().putString("notified_key", v).apply()

    val isConfigured: Boolean
        get() = identifier.isNotBlank() && password.isNotBlank() && slink.isNotBlank() && childId > 0

    fun clear() = prefs.edit().clear().apply()

    companion object {
        /** Nimmt die ganze Login-Adresse oder nur das Kuerzel. */
        fun parseSlink(input: String): String {
            val t = input.trim().trimEnd('/')
            val afterHost = t.substringAfter("sdui.app/", t)
            return afterHost.substringBefore('/').substringBefore('?').trim()
        }
    }
}
