package io.github.thmschk.ibswatch.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.thmschk.ibswatch.R
import io.github.thmschk.ibswatch.core.AlarmText
import io.github.thmschk.ibswatch.core.IbsClient

/** Lokale Benachrichtigungen — kein Server, kein Push-Dienst, kein Konto. */
object Notifier {

    const val CHANNEL_REMINDER = "reminder"
    const val CHANNEL_PROBLEM = "problem"

    private const val ID_REMINDER = 1
    private const val ID_PROBLEM = 2

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_REMINDER,
                "Bestellerinnerung",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "Meldet, wenn fuer die naechsten Tage kein Essen bestellt ist." },
        )
        manager.createNotificationChannel(
            // Leiser: dass die Pruefung scheiterte, ist wichtig, aber nicht dringend.
            NotificationChannel(
                CHANNEL_PROBLEM,
                "Probleme bei der Pruefung",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Meldet, wenn der Bestellstand nicht geprueft werden konnte." },
        )
    }

    /**
     * @param alert true = darf klingeln. Bei false wird eine bereits liegende
     * Meldung still auf den neuen Stand gebracht — so bleibt sie aktuell, ohne
     * bei jedem Lauf erneut zu vibrieren.
     */
    fun reminder(context: Context, title: String, body: String, alert: Boolean) =
        show(context, CHANNEL_REMINDER, ID_REMINDER, title, body, AlarmText.CALL_TO_ACTION, alert)

    /**
     * Meldung zuruecknehmen.
     *
     * Ohne das bleibt "Noch nichts bestellt" im Benachrichtigungsbereich
     * liegen, auch wenn laengst bestellt ist — eine Meldung, die nicht mehr
     * stimmt, ist schlimmer als gar keine.
     */
    fun clearReminder(context: Context) =
        NotificationManagerCompat.from(context).cancel(ID_REMINDER)

    fun problem(context: Context, title: String, body: String) =
        show(context, CHANNEL_PROBLEM, ID_PROBLEM, title, body)

    private fun show(
        context: Context,
        channel: String,
        id: Int,
        title: String,
        body: String,
        shortLine: String? = null,
        alert: Boolean = true,
    ) {
        // Ohne Berechtigung wuerde notify() still verpuffen — dann lieber nichts
        // tun, als so zu wirken, als sei benachrichtigt worden.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val openPortal = PendingIntent.getActivity(
            context,
            0,
            Intent(Intent.ACTION_VIEW, Uri.parse(IbsClient.WEB_URL)),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            // Eingeklappt zeigt Android nur diese Zeile: dort gehoert hin, was
            // zu tun ist — die Tage stehen im aufgeklappten Text darunter.
            .setContentText(shortLine ?: body.lineSequence().first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openPortal)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .addAction(0, "Bestellseite oeffnen", openPortal)
            .build()

        NotificationManagerCompat.from(context).notify(id, notification)
    }
}
