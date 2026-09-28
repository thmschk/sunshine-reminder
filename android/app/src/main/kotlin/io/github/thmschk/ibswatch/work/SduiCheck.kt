package io.github.thmschk.ibswatch.work

import android.content.Context
import io.github.thmschk.ibswatch.core.De
import io.github.thmschk.ibswatch.core.IbsAuthException
import io.github.thmschk.ibswatch.core.SduiClient
import io.github.thmschk.ibswatch.core.SubjectReminder
import io.github.thmschk.ibswatch.data.SduiStore
import io.github.thmschk.ibswatch.notify.Notifier
import java.time.LocalDate

/**
 * Erinnerung an ausgewaehlte Faecher am naechsten Schultag.
 *
 * Laeuft im Anschluss an die Essenspruefung und ist davon streng getrennt:
 * ein Sdui-Fehler darf den Bestellstand weder faerben noch aufhalten.
 */
object SduiCheck {

    const val AUTH_ERROR = "Sdui-Anmeldung fehlgeschlagen"

    fun run(context: Context, today: LocalDate = LocalDate.now()) {
        val store = SduiStore(context)
        if (!store.isConfigured || store.subjects.isEmpty()) return
        // Abgelehnter Zugang: nicht bei jedem Lauf erneut versuchen, Fehlversuche
        // koennten das Konto sperren. Erst wieder nach dem Speichern im Dialog.
        if (store.lastError.startsWith(AUTH_ERROR)) return

        val day = SubjectReminder.nextSchoolDay(today)
        try {
            val client = SduiClient()
            client.login(store.identifier, store.password, store.slink)
            // Zwei Wochen fuer die Faecherauswahl (A/B-Wochen), der Treffer kommt aus demselben Abruf.
            val lessons = client.timetable(store.childId, today, today.plusDays(14))
            SubjectReminder.knownSubjects(lessons).takeIf { it.isNotEmpty() }
                ?.let { store.knownSubjects = store.knownSubjects + it }

            val matches = SubjectReminder.matches(lessons, day, store.subjects)
            store.nextDay = day.toString()
            store.nextMatches = matches.map { m ->
                buildString {
                    append(m.subject)
                    if (m.hoursLabel.isNotEmpty()) append(" — ").append(m.hoursLabel)
                    if (m.notes.isNotEmpty()) append(" (").append(m.notes.joinToString("; ")).append(")")
                }
            }
            store.nextLessons = lessons.filter { it.begins.toLocalDate().isEqual(day) }
                .groupBy { it.hour to it.begins }
                .map { (key, ls) ->
                    val (hour, begins) = key
                    listOf(
                        if (hour.isBlank()) "" else "$hour.",
                        "%02d:%02d".format(begins.hour, begins.minute),
                        ls.map { it.subject }.distinct().joinToString(" / "),
                        ls.flatMap { listOfNotNull(it.kind, it.comment.ifBlank { null }) }.distinct().joinToString("; "),
                    ).joinToString("|") { it.replace("|", "/").replace("\n", " ") }
                }
            store.lastError = ""

            val key = "$day:" + matches.joinToString(",") { it.subject }
            if (matches.isNotEmpty() && key != store.notifiedKey) {
                val whenLabel = if (day.isEqual(today.plusDays(1))) "Morgen" else De.weekday(day)
                Notifier.timetable(
                    context,
                    title = "$whenLabel " + matches.joinToString(" und ") { it.subject },
                    body = store.nextMatches.joinToString("\n") +
                        (if (store.childName.isNotBlank()) "\nfür ${store.childName}" else ""),
                )
                store.notifiedKey = key
            }
        } catch (exc: IbsAuthException) {
            store.lastError = "$AUTH_ERROR: ${exc.message}"
            Notifier.problem(context, "Sdui-Anmeldung fehlgeschlagen", "${exc.message}\n\nZugang in den Einstellungen prüfen.")
        } catch (exc: Exception) {
            store.lastError = "Stundenplan nicht geladen: ${exc.message}"
        }
    }
}
