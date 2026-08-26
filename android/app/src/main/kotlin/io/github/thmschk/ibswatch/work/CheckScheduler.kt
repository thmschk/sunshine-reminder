package io.github.thmschk.ibswatch.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.util.concurrent.TimeUnit

/**
 * Plant den naechsten Lauf.
 *
 * Bewusst eine sich selbst neu einplanende OneTimeWorkRequest statt einer
 * PeriodicWorkRequest: nur so laesst sich eine Tageszeit ansteuern. Exakte
 * Alarme (`SCHEDULE_EXACT_ALARM`) waeren die Alternative, brauchen aber eine
 * eigene Berechtigung — unnoetig, denn der Bestellschluss liegt einen ganzen
 * Tag vor der Mahlzeit. Ein paar Stunden Ungenauigkeit schaden hier nicht.
 */
object CheckScheduler {

    const val WORK_NAME = "ibs-order-check"

    /** Ortszeit, zu der geprueft wird — frueh genug, um abends noch zu handeln. */
    val CHECK_TIME: LocalTime = LocalTime.of(17, 0)

    fun scheduleNext(context: Context, now: LocalDateTime = LocalDateTime.now()) {
        val next = nextRun(now)
        val delay = Duration.between(now, next)

        val request = OneTimeWorkRequestBuilder<CheckWorker>()
            .setInitialDelay(delay.toMinutes(), TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
            .addTag(WORK_NAME)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    /** Sofort pruefen — der Knopf in der App. */
    fun runNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<CheckWorker>()
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork("$WORK_NAME-now", ExistingWorkPolicy.REPLACE, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }

    internal fun nextRun(now: LocalDateTime): LocalDateTime {
        val todayAtCheckTime = LocalDateTime.of(now.toLocalDate(), CHECK_TIME)
        val candidate = if (now < todayAtCheckTime) todayAtCheckTime else todayAtCheckTime.plusDays(1)
        // Samstag und Sonntag ueberspringen: fuer Montag ist der Bestellschluss
        // ohnehin am Freitag, spaetestens am Sonntagabend erreicht uns niemand mehr.
        return generateSequence(candidate) { it.plusDays(1) }
            .first { it.dayOfWeek.value <= 5 }
    }

    fun isWeekday(date: LocalDate): Boolean = date.dayOfWeek.value <= 5
}
