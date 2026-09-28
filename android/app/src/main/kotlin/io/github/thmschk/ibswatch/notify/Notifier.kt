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
import io.github.thmschk.ibswatch.MainActivity
import io.github.thmschk.ibswatch.R
import io.github.thmschk.ibswatch.core.IbsClient
import io.github.thmschk.ibswatch.core.UpdateCheck

/** Lokale Benachrichtigungen — kein Server, kein Push-Dienst, kein Konto. */
object Notifier {

    const val CHANNEL_REMINDER = "reminder"
    const val CHANNEL_PROBLEM = "problem"
    const val CHANNEL_UPDATE = "update"
    const val CHANNEL_TIMETABLE = "timetable"

    /** Oeffnet die Bestellansicht der App (PoC). */
    const val ACTION_ORDER = "io.github.thmschk.ibswatch.ORDER"

    private const val ID_REMINDER = 1
    private const val ID_PROBLEM = 2
    private const val ID_UPDATE = 3
    private const val ID_TIMETABLE = 4

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
        manager.createNotificationChannel(
            // Eigener Kanal: wer den Stundenplan-Hinweis nicht will, schaltet
            // ihn ab, ohne die Essenserinnerung stillzulegen.
            NotificationChannel(
                CHANNEL_TIMETABLE,
                "Stundenplan",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "Erinnert am Vortag an ausgewählte Fächer (Sdui)." },
        )
        manager.createNotificationChannel(
            // Noch leiser, und als eigener Kanal, damit man genau das
            // abschalten kann, ohne die Erinnerung mit stillzulegen.
            NotificationChannel(
                CHANNEL_UPDATE,
                "Neue Fassung",
                NotificationManager.IMPORTANCE_LOW,
            ).apply { description = "Meldet, wenn eine neuere Fassung der App bereitliegt." },
        )
    }

    /**
     * Kann eine Erinnerung ueberhaupt beim Nutzer ankommen?
     *
     * Ist die Berechtigung verweigert oder der Kanal stummgeschaltet, laeuft
     * die App weiter voellig unauffaellig — sie prueft, findet einen offenen
     * Tag, meldet ihn, und niemand sieht es. Von aussen ist dieser Zustand von
     * "alles bestellt" nicht zu unterscheiden. Deshalb fragt die Oberflaeche
     * hier nach und sagt es hin.
     */
    fun remindersReachUser(context: Context): Boolean {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return false
        val channel = manager.getNotificationChannel(CHANNEL_REMINDER) ?: return true
        return channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    /**
     * @param alert true = darf klingeln. Bei false wird eine bereits liegende
     * Meldung still auf den neuen Stand gebracht — so bleibt sie aktuell, ohne
     * bei jedem Lauf erneut zu vibrieren.
     */
    fun reminder(context: Context, title: String, body: String, alert: Boolean, orderable: Boolean = false) =
        show(
            context, CHANNEL_REMINDER, ID_REMINDER, title, body, alert = alert,
            orderAction = if (orderable) orderIntent(context) else null,
            // Bestellt wird in der App; die Webseite ist dort nur noch ein Symbol.
            appTarget = true,
        )

    /** Die App mit offener Bestellansicht — ein Gericht muss dort noch gewaehlt werden. */
    private fun orderIntent(context: Context): PendingIntent = PendingIntent.getActivity(
        context,
        ID_REMINDER + 100,
        Intent(context, MainActivity::class.java)
            .setAction(ACTION_ORDER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /**
     * Meldung zuruecknehmen.
     *
     * Ohne das bleibt "Noch nichts bestellt" im Benachrichtigungsbereich
     * liegen, auch wenn laengst bestellt ist — eine Meldung, die nicht mehr
     * stimmt, ist schlimmer als gar keine.
     */
    fun clearReminder(context: Context) =
        NotificationManagerCompat.from(context).cancel(ID_REMINDER)

    /** Erinnerung an ein Fach am naechsten Schultag — tippt man sie an, oeffnet sich die App. */
    fun timetable(context: Context, title: String, body: String) = show(
        context, CHANNEL_TIMETABLE, ID_TIMETABLE, title, body,
        appTarget = true,
    )

    fun problem(context: Context, title: String, body: String) =
        show(context, CHANNEL_PROBLEM, ID_PROBLEM, title, body)

    /**
     * Es liegt eine neuere Fassung bereit.
     *
     * Ohne Store erfaehrt das sonst niemand — und ein veralteter Waechter
     * schweigt womoeglich, obwohl man sich auf ihn verlaesst.
     */
    fun update(context: Context, latest: String, current: String) = show(
        context,
        CHANNEL_UPDATE,
        ID_UPDATE,
        "Neue Fassung $latest",
        "Installiert ist $current. Die neue Fassung legt sich ohne Umweg darüber.",
        url = UpdateCheck.DOWNLOAD_URL,
        actionLabel = "Herunterladen",
        alert = false,
    )

    private fun show(
        context: Context,
        channel: String,
        id: Int,
        title: String,
        body: String,
        shortLine: String? = null,
        url: String = IbsClient.WEB_URL,
        actionLabel: String = "Bestellseite oeffnen",
        alert: Boolean = true,
        orderAction: PendingIntent? = null,
        appTarget: Boolean = false,
    ) {
        // Ohne Berechtigung wuerde notify() still verpuffen — dann lieber nichts
        // tun, als so zu wirken, als sei benachrichtigt worden.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val openTarget = PendingIntent.getActivity(
            context,
            // Eigener Request-Code je Meldung, damit sich die Ziele nicht
            // gegenseitig ueberschreiben.
            id,
            if (appTarget) {
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            // Eingeklappt zeigt Android nur diese Zeile: dort gehoert hin, was
            // zu tun ist — die Tage stehen im aufgeklappten Text darunter.
            .setContentText(shortLine ?: body.lineSequence().first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openTarget)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .apply { if (orderAction != null) addAction(0, "Jetzt bestellen", orderAction) }
            .apply { if (!appTarget) addAction(0, actionLabel, openTarget) }
            .build()

        NotificationManagerCompat.from(context).notify(id, notification)
    }
}
