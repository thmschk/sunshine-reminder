package io.github.thmschk.ibswatch.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import io.github.thmschk.ibswatch.core.CheckSchedule
import java.time.LocalDateTime
import java.util.concurrent.TimeUnit

/**
 * Plant den naechsten Lauf.
 *
 * Bewusst eine sich selbst neu einplanende OneTimeWorkRequest statt einer
 * PeriodicWorkRequest: nur so laesst sich eine Tageszeit ansteuern. Exakte
 * Alarme (`SCHEDULE_EXACT_ALARM`) waeren die Alternative, brauchen aber eine
 * eigene Berechtigung — unnoetig, denn der Bestellschluss liegt einen ganzen
 * Tag vor der Mahlzeit. Ein paar Stunden Ungenauigkeit schaden hier nicht.
 *
 * Die Zeitrechnung selbst steht in [CheckSchedule] (Modul :core) und ist dort
 * ohne Geraet testbar.
 */
object CheckScheduler {

    const val WORK_NAME = "ibs-order-check"

    /** Eigener Name fuer den Knopf "Jetzt pruefen" — beobachtbar von der Oberflaeche. */
    const val WORK_NAME_NOW = "ibs-order-check-now"

    /**
     * Plant den naechsten Lauf.
     *
     * [policy] ist die heikelste Angabe der ganzen App.
     *
     * `REPLACE` bricht bestehende, noch nicht abgeschlossene Arbeit unter
     * demselben Namen ab — und "bestehend" schliesst den Lauf ein, der gerade
     * anlaufen will. Weckt Android den Prozess um 17:00 fuer genau diesen Job,
     * laeuft `Application.onCreate` vollstaendig, BEVOR irgendeine Komponente
     * startet. Ein `REPLACE` von dort loescht deshalb zuverlaessig den Job, fuer
     * den der Prozess ueberhaupt erst geweckt wurde: die App hat im
     * geschlossenen Zustand nie geprueft, und weil ein ausgefallener Lauf von
     * aussen wie "alles bestellt" aussieht, ist das nie aufgefallen.
     *
     * Deshalb beim Prozessstart `KEEP` (heilt einen verlorenen Plan, ohne einen
     * vorhandenen zu toeten) und ueberall sonst `REPLACE` — auch am Ende von
     * [CheckWorker], wo `KEEP` gar nichts einplanen wuerde, weil der eigene Lauf
     * dort noch als "nicht abgeschlossen" gilt und die Kette damit stehenbliebe.
     */
    fun scheduleNext(
        context: Context,
        policy: ExistingWorkPolicy = ExistingWorkPolicy.REPLACE,
        now: LocalDateTime = LocalDateTime.now(),
    ) {
        val request = OneTimeWorkRequestBuilder<CheckWorker>()
            .setInitialDelay(CheckSchedule.delayMinutes(now), TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
            .addTag(WORK_NAME)
            .build()

        WorkManager.getInstance(context)
            .enqueueUniqueWork(WORK_NAME, policy, request)
    }

    /** Sofort pruefen — der Knopf in der App. */
    fun runNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<CheckWorker>()
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(WORK_NAME_NOW, ExistingWorkPolicy.REPLACE, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
    }
}
