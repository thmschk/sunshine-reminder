package io.github.thmschk.ibswatch

import android.app.Application
import io.github.thmschk.ibswatch.data.CredentialStore
import io.github.thmschk.ibswatch.notify.Notifier
import io.github.thmschk.ibswatch.work.CheckScheduler

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
