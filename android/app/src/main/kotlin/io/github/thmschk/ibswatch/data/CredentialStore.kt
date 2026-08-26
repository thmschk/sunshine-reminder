package io.github.thmschk.ibswatch.data

import android.content.Context

/**
 * Zugangsdaten fuer IBS5 — bleiben auf dem Geraet.
 *
 * Bewusst schlichte private SharedPreferences statt EncryptedSharedPreferences:
 * letzteres ist von Google als deprecated markiert, und der Gewinn waere gering.
 * Die Datei liegt in der App-Sandbox, auf die keine andere App zugreifen kann,
 * und moderne Android-Geraete verschluesseln den Nutzerspeicher ohnehin auf
 * Dateisystemebene. Wer das Geraet entsperrt in der Hand haelt, kaeme genauso
 * an die im Browser gespeicherte Anmeldung.
 *
 * Der Klartext verlaesst das Geraet ausschliesslich Richtung IBS5 (HTTPS).
 */
class CredentialStore(context: Context) {

    private val prefs = context.getSharedPreferences("credentials", Context.MODE_PRIVATE)

    var customerNo: String
        get() = prefs.getString(KEY_CUSTOMER, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_CUSTOMER, value).apply()

    var password: String
        get() = prefs.getString(KEY_PASSWORD, "").orEmpty()
        set(value) = prefs.edit().putString(KEY_PASSWORD, value).apply()

    val isConfigured: Boolean
        get() = customerNo.isNotBlank() && password.isNotBlank()

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val KEY_CUSTOMER = "customer_no"
        const val KEY_PASSWORD = "password"
    }
}
