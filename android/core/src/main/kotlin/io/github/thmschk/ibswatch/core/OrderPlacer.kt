package io.github.thmschk.ibswatch.core

import java.time.LocalDate

/** Ergebnis eines Bestellversuchs. */
sealed interface PlaceResult {
    /** Abgeschickt und im Wochenplan als bestellt wiedergefunden. */
    data class Ordered(val dates: List<LocalDate>) : PlaceResult

    /** Nur Probelauf: alles lag korrekt im Warenkorb und wurde wieder entfernt. */
    data class DryRunOk(val dates: List<LocalDate>) : PlaceResult

    /** Nichts abgeschickt; was hinzugefuegt wurde, ist wieder entfernt. */
    data class Aborted(val reason: String) : PlaceResult

    /**
     * Abgeschickt, aber der Wochenplan zeigt nicht alles als bestellt — das
     * muss der Nutzer selbst ansehen, die App darf hier nichts behaupten.
     */
    data class Unconfirmed(val reason: String, val missing: List<LocalDate>) : PlaceResult
}

/**
 * Bestellt ausgewaehlte Menuelinien: Warenkorb fuellen, pruefen, abschicken.
 *
 * `Cart/Order` schickt den ganzen Warenkorb ab. Deshalb wird je Tag erst die
 * Gruppe geleert (ersetzt einen liegengebliebenen Warenkorb-Eintrag desselben
 * Tages) und vor dem Abschicken verglichen, ob exakt die Auswahl im Warenkorb
 * liegt. Weicht die Zahl ab, liegt dort etwas Fremdes — dann wird nicht
 * abgeschickt.
 */
class OrderPlacer(private val client: IbsClient) {

    /** @param reload laedt nach dem Abschicken den Wochenplan-Stand der Tage neu. */
    fun place(
        selection: List<MenuEntry>,
        dryRun: Boolean,
        reload: (List<LocalDate>) -> List<DayStatus>,
    ): PlaceResult {
        if (selection.isEmpty()) return PlaceResult.Aborted("Nichts ausgewählt.")
        if (selection.map { it.date }.distinct().size != selection.size) {
            return PlaceResult.Aborted("Je Tag nur ein Essen.")
        }
        selection.firstOrNull { !it.selectable }?.let {
            return PlaceResult.Aborted("${De.short(it.date)}: nicht bestellbar.")
        }

        val touched = mutableListOf<MenuEntry>()
        fun rollback() = touched.forEach {
            runCatching { client.clearCart(it.customerId, it.date, it.menuGroupId) }
        }

        try {
            var total: Int? = null
            for (entry in selection) {
                touched += entry
                client.clearCart(entry.customerId, entry.date, entry.menuGroupId)
                val added = client.addToCart(entry)
                if (!added.ok) {
                    rollback()
                    return PlaceResult.Aborted(
                        "${De.short(entry.date)}: ${added.message ?: "vom Bestellsystem abgelehnt"}",
                    )
                }
                total = added.totalItemsInCart
            }

            if (total != selection.size) {
                rollback()
                return PlaceResult.Aborted(
                    "Im Warenkorb liegen ${total ?: "?"} statt ${selection.size} Einträge — " +
                        "vermutlich noch etwas anderes. Nichts abgeschickt.",
                )
            }

            if (dryRun) {
                rollback()
                return PlaceResult.DryRunOk(selection.map { it.date })
            }

            val sent = client.submitCart()
            if (!sent.ok) {
                rollback()
                return PlaceResult.Aborted(sent.message ?: "Bestellung abgelehnt.")
            }
        } catch (exc: IbsException) {
            rollback()
            return PlaceResult.Aborted(exc.message ?: exc.toString())
        }

        val dates = selection.map { it.date }
        val after = try {
            reload(dates)
        } catch (exc: IbsException) {
            return PlaceResult.Unconfirmed("Nachprüfung fehlgeschlagen: ${exc.message}", dates)
        }
        val missing = dates.filter { d -> after.none { it.date == d && it.state == OrderState.ORDERED } }
        return if (missing.isEmpty()) {
            PlaceResult.Ordered(dates)
        } else {
            PlaceResult.Unconfirmed("Nicht alle Tage erscheinen als bestellt.", missing)
        }
    }
}
