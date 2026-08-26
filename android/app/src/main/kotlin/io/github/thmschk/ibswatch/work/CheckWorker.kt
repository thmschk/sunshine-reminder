package io.github.thmschk.ibswatch.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import io.github.thmschk.ibswatch.data.CredentialStore
import io.github.thmschk.ibswatch.data.DayLine
import io.github.thmschk.ibswatch.data.ResultStore
import io.github.thmschk.ibswatch.data.SettingsStore
import io.github.thmschk.ibswatch.notify.Notifier
import io.github.thmschk.ibswatch.core.AlarmText
import io.github.thmschk.ibswatch.core.CheckConfig
import io.github.thmschk.ibswatch.core.CheckResult
import io.github.thmschk.ibswatch.core.De
import io.github.thmschk.ibswatch.core.IbsClient
import io.github.thmschk.ibswatch.core.OrderChecker
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Der eigentliche Waechter: laeuft im Hintergrund, auch wenn die App zu ist.
 *
 * Am Ende jedes Laufs plant er sich selbst neu ein (siehe [CheckScheduler]).
 * Eine PeriodicWorkRequest waere naheliegend, kann aber keine Tageszeit
 * treffen — sie kennt nur Intervalle und driftet unter Doze weg.
 */
class CheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private companion object {
        /** So oft wird ein Netzfehler still wiederholt, bevor er gemeldet wird. */
        const val MAX_ATTEMPTS = 3
    }


    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val credentials = CredentialStore(applicationContext)
        val results = ResultStore(applicationContext)

        if (!credentials.isConfigured) {
            return@withContext Result.success()  // noch nicht eingerichtet
        }

        val settings = SettingsStore(applicationContext)
        val checker = OrderChecker(IbsClient(), CheckConfig(daysAhead = settings.daysAhead))
        val today = LocalDate.now()
        val outcome = checker.run(credentials.customerNo, credentials.password, today)

        results.lastRunEpochMillis = System.currentTimeMillis()

        // Tagesliste in beiden Erfolgsfaellen sichern — sie ist der Inhalt,
        // den die Oberflaeche anzeigt, unabhaengig davon ob etwas fehlt.
        when (outcome) {
            is CheckResult.Ok -> results.lastDays = outcome.days.map { DayLine.from(it) }
            is CheckResult.Alarm -> results.lastDays = outcome.days.map { DayLine.from(it) }
            is CheckResult.Failed -> Unit
        }

        when (outcome) {
            is CheckResult.Ok -> {
                results.lastSummary = if (outcome.days.isEmpty()) {
                    "Keine relevanten Tage im Pruefzeitraum."
                } else {
                    "Alles bestellt bis ${De.short(outcome.days.last().date)}."
                }
                // Alles bestellt: vergessen, worueber gewarnt wurde — faellt ein
                // Tag spaeter wieder aus, soll erneut gemeldet werden. Und die
                // alte Meldung zuruecknehmen, sonst steht dort weiter etwas
                // Falsches.
                results.notifiedDates = emptySet()
                Notifier.clearReminder(applicationContext)
            }

            is CheckResult.Alarm -> {
                results.lastSummary = AlarmText.body(outcome)

                val affected = (outcome.actionable + outcome.tooLate).map { it.date }
                val alreadyNotified = results.notifiedDates
                val fresh = affected.any { it.toString() !in alreadyNotified }
                // Letzte Chance: laeuft morgen der Bestellschluss ab, wird auch
                // dann gemeldet, wenn der Tag schon einmal dran war.
                val lastChance = outcome.actionable.any { !it.date.isAfter(today.plusDays(1)) }

                // Immer auf den aktuellen Stand bringen — klingeln aber nur,
                // wenn es etwas Neues gibt oder morgen Schluss ist.
                Notifier.reminder(
                    applicationContext,
                    AlarmText.title(outcome, checker.lastProfile?.firstName.orEmpty()),
                    AlarmText.body(outcome),
                    alert = fresh || lastChance,
                )
                // Vergangenes vergessen, sonst waechst die Menge unbegrenzt.
                results.notifiedDates = (alreadyNotified + affected.map { it.toString() })
                    .filter { runCatching { !LocalDate.parse(it).isBefore(today) }.getOrDefault(false) }
                    .toSet()
            }

            is CheckResult.Failed -> {
                results.lastSummary = "Prüfung fehlgeschlagen: ${outcome.reason}"

                if (outcome.isAuthProblem) {
                    // Zugangsdaten stimmen nicht — das heilt kein Wiederholen,
                    // und Fehlversuche koennten das Konto sperren.
                    Notifier.problem(
                        applicationContext,
                        "Anmeldung fehlgeschlagen",
                        "${outcome.reason}\n\nZugangsdaten in der App prüfen.",
                    )
                    CheckScheduler.scheduleNext(applicationContext)
                    return@withContext Result.success()
                }

                // Sonst meist ein Funkloch: ein paar Mal still wiederholen und
                // erst dann melden — sonst piept die App bei jedem U-Bahn-Tunnel.
                if (runAttemptCount < MAX_ATTEMPTS) {
                    return@withContext Result.retry()
                }
                Notifier.problem(
                    applicationContext,
                    "Bestellstand unbekannt",
                    "Der Bestellstand konnte nicht geprüft werden:\n${outcome.reason}",
                )
                CheckScheduler.scheduleNext(applicationContext)
                return@withContext Result.failure()
            }
        }

        CheckScheduler.scheduleNext(applicationContext)
        Result.success()
    }
}
