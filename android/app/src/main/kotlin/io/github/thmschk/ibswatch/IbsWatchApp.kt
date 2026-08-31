package io.github.thmschk.ibswatch

import android.app.Application
import androidx.work.ExistingWorkPolicy
import io.github.thmschk.ibswatch.data.CredentialStore
import io.github.thmschk.ibswatch.notify.Notifier
import io.github.thmschk.ibswatch.work.CheckScheduler

class IbsWatchApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        if (CredentialStore(this).isConfigured) {
            // KEEP, niemals REPLACE: Android startet den Prozess auch, UM den
            // geplanten Lauf auszufuehren, und onCreate ist dabei als Erstes
            // dran. Ein REPLACE von hier hat genau diesen Job geloescht — die
            // App hat deshalb nie geprueft, solange sie geschlossen war.
            // KEEP laesst einen vorhandenen Plan in Ruhe und legt nur dann
            // einen neuen an, wenn wirklich keiner mehr existiert.
            CheckScheduler.scheduleNext(this, ExistingWorkPolicy.KEEP)
        }
    }
}
