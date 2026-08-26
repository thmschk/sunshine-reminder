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
        val outcome = OrderChecker(IbsClient(), CheckConfig(daysAhead = settings.daysAhead))
            .run(credentials.customerNo, credentials.password, LocalDate.now())

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
                results.lastNotifiedSignature = ""
            }

            is CheckResult.Alarm -> {
                results.lastSummary = AlarmText.body(outcome)
                // Dieselben Tage nicht jeden Tag erneut melden.
                val signature = (outcome.actionable + outcome.tooLate)
                    .joinToString(",") { "${it.date}:${it.state}" }
                if (signature != results.lastNotifiedSignature) {
                    Notifier.reminder(applicationContext, AlarmText.title(outcome), AlarmText.body(outcome))
                    results.lastNotifiedSignature = signature
                }
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
