package de.ibswatch.app.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import de.ibswatch.app.data.CredentialStore
import de.ibswatch.app.data.ResultStore
import de.ibswatch.app.notify.Notifier
import de.ibswatch.core.AlarmText
import de.ibswatch.core.CheckConfig
import de.ibswatch.core.CheckResult
import de.ibswatch.core.De
import de.ibswatch.core.IbsClient
import de.ibswatch.core.OrderChecker
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

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val credentials = CredentialStore(applicationContext)
        val results = ResultStore(applicationContext)

        if (!credentials.isConfigured) {
            return@withContext Result.success()  // noch nicht eingerichtet
        }

        val outcome = OrderChecker(IbsClient(), CheckConfig())
            .run(credentials.customerNo, credentials.password, LocalDate.now())

        results.lastRunEpochMillis = System.currentTimeMillis()

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
                results.lastSummary = "Pruefung fehlgeschlagen: ${outcome.reason}"
                // Ein einzelner Fehlschlag ist meist ein Funkloch. Erst wenn der
                // naechste Lauf ebenfalls scheitert, ist es eine Meldung wert —
                // WorkManager wiederholt den Job dafuer von selbst.
                return@withContext Result.retry()
            }
        }

        CheckScheduler.scheduleNext(applicationContext)
        Result.success()
    }
}
