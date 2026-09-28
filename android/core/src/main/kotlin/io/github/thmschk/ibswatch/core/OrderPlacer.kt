package io.github.thmschk.ibswatch.core

import java.time.LocalDate

/**
 * Gewuenschte Aenderung an einem Tag.
 *
 * `current` = die bestellte Linie (oder null), `target` = die gewuenschte
 * (oder null fuer "nichts"). Daraus ergibt sich, was zu tun ist.
 */
data class DayChange(val date: LocalDate, val current: MenuEntry?, val target: MenuEntry?) {
    enum class Kind { ORDER, SWITCH, CANCEL, NONE }

    val kind: Kind
        get() = when {
            current == null && target != null -> Kind.ORDER
            current != null && target == null -> Kind.CANCEL
            current != null && target != null && current.menuLineId != target.menuLineId -> Kind.SWITCH
            else -> Kind.NONE
        }
}

/** Ergebnis eines Bestellversuchs. */
sealed interface PlaceResult {
    /** Abgeschickt und im Wochenplan so wiedergefunden wie gewuenscht. */
    data class Done(val changes: List<DayChange>) : PlaceResult

    /** Nur Probelauf: alles lag korrekt im Warenkorb und wurde wieder entfernt. */
    data class DryRunOk(val changes: List<DayChange>) : PlaceResult

    /** Nichts abgeschickt; was hinzugefuegt wurde, ist wieder entfernt. */
    data class Aborted(val reason: String) : PlaceResult

    /**
     * Abgeschickt, aber der Wochenplan zeigt nicht alles wie gewuenscht — das
     * muss der Nutzer selbst ansehen, die App darf hier nichts behaupten.
     */
    data class Unconfirmed(val reason: String, val missing: List<LocalDate>) : PlaceResult
}

/**
 * Bestellt, bestellt um oder bestellt ab: Warenkorb fuellen, pruefen, abschicken.
 *
 * `Cart/Order` schickt den ganzen Warenkorb ab. Deshalb wird je Tag erst die
 * Gruppe geleert (ersetzt einen liegengebliebenen Warenkorb-Eintrag desselben
 * Tages) und vor dem Abschicken verglichen, ob exakt die Auswahl im Warenkorb
 * liegt. Weicht die Zahl ab, liegt dort etwas Fremdes — dann wird nicht
 * abgeschickt.
 *
 * Umbestellen schickt wie die Webseite nur die neue Linie mit Typ `I`; die
 * Abbestellung der alten legt der Server selbst in den Warenkorb (dann zwei
 * Eintraege). Dass danach nur die neue bestellt ist, prueft die Nachkontrolle.
 */
class OrderPlacer(private val client: IbsClient) {

    /**
     * @param previouslyInCart Eintraege, die vorher schon im Warenkorb lagen;
     * sie werden beim Zuruecknehmen (Probelauf, Abbruch) wiederhergestellt.
     * @param reload laedt nach dem Abschicken den Wochenplan-Stand der Tage neu.
     */
    fun place(
        requested: List<DayChange>,
        dryRun: Boolean,
        previouslyInCart: List<MenuEntry> = emptyList(),
        reload: (List<LocalDate>) -> List<DayStatus>,
    ): PlaceResult {
        val changes = requested.filter { it.kind != DayChange.Kind.NONE }
        if (changes.isEmpty()) return PlaceResult.Aborted("Nichts geändert.")
        if (changes.map { it.date }.distinct().size != changes.size) {
            return PlaceResult.Aborted("Je Tag nur eine Änderung.")
        }
        changes.firstOrNull { c -> listOfNotNull(c.current, c.target).any { !it.selectable } }?.let {
            return PlaceResult.Aborted("${De.short(it.date)}: nicht mehr änderbar.")
        }

        val touched = mutableListOf<MenuEntry>()
        fun rollback() {
            touched.forEach { runCatching { client.clearCart(it.customerId, it.date, it.menuGroupId) } }
            previouslyInCart.filter { old -> touched.any { it.date.isEqual(old.date) } }
                .forEach { runCatching { client.addToCart(it) } }
        }

        try {
            var total: Int? = null
            for (change in changes) {
                val anchor = checkNotNull(change.target ?: change.current)
                touched += anchor
                client.clearCart(anchor.customerId, anchor.date, anchor.menuGroupId)
                val added = when (change.kind) {
                    DayChange.Kind.CANCEL -> client.cancelInCart(checkNotNull(change.current))
                    else -> client.addToCart(checkNotNull(change.target))
                }
                if (!added.ok) {
                    rollback()
                    return PlaceResult.Aborted(
                        "${De.short(change.date)}: ${added.message ?: "vom Bestellsystem abgelehnt"}",
                    )
                }
                total = added.totalItemsInCart
            }

            // Beim Umbestellen legt der Server selbst die Abbestellung der alten
            // Linie dazu — das sind zwei Eintraege.
            val expected = changes.sumOf { if (it.kind == DayChange.Kind.SWITCH) 2 else 1 }
            if (total != expected) {
                rollback()
                return PlaceResult.Aborted(
                    "Im Warenkorb liegen ${total ?: "?"} statt $expected Einträge — " +
                        "vermutlich noch etwas anderes. Nichts abgeschickt.",
                )
            }

            if (dryRun) {
                rollback()
                return PlaceResult.DryRunOk(changes)
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

        val dates = changes.map { it.date }
        val after = try {
            reload(dates)
        } catch (exc: IbsException) {
            return PlaceResult.Unconfirmed("Nachprüfung fehlgeschlagen: ${exc.message}", dates)
        }
        val missing = changes.filter { c -> !asRequested(c, after.firstOrNull { it.date.isEqual(c.date) }) }.map { it.date }
        return if (missing.isEmpty()) {
            PlaceResult.Done(changes)
        } else {
            PlaceResult.Unconfirmed("Nicht alle Tage stehen so im Wochenplan wie gewünscht.", missing)
        }
    }

    /** Genau die Ziel-Linie bestellt — bzw. beim Abbestellen gar keine. */
    private fun asRequested(change: DayChange, day: DayStatus?): Boolean {
        // Eine Linie mit liegengebliebener Abbestellung (Status 3) gilt weiter als bestellt.
        val ordered = day?.entries.orEmpty().filter { it.isOrdered }
        return when (val target = change.target) {
            null -> ordered.isEmpty()
            else -> ordered.map { it.menuLineId } == listOf(target.menuLineId)
        }
    }
}
