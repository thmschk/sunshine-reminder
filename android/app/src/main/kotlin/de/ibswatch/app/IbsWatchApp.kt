package de.ibswatch.app

import android.app.Application
import de.ibswatch.app.data.CredentialStore
import de.ibswatch.app.notify.Notifier
import de.ibswatch.app.work.CheckScheduler

class IbsWatchApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        // WorkManager ueberlebt Neustarts; ein erneutes enqueueUnique mit REPLACE
        // schadet nicht und heilt einen verlorengegangenen Plan.
        if (CredentialStore(this).isConfigured) {
            CheckScheduler.scheduleNext(this)
        }
    }
}
