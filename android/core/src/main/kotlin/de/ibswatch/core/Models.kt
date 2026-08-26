package de.ibswatch.core

import java.time.LocalDate

/**
 * Zustand eines Tages im Wochenplan.
 *
 * Sechs statt zwei Zustaende, weil "nicht bestellt" allein zu grob ist: an
 * einem Feiertag ist nichts zu holen, nach Bestellschluss ist nichts mehr zu
 * machen, und ein vergessener Warenkorb sieht dem Vergessen zum Verwechseln
 * aehnlich, hat aber eine andere Ursache.
 */
enum class OrderState {
    /** Mindestens eine Menuelinie ist bestellt. */
    ORDERED,

    /** Im Warenkorb liegengeblieben, nie abgeschickt. */
    IN_CART,

    /** Nichts bestellt, aber noch bestellbar — hier lohnt die Erinnerung. */
    NOT_ORDERED,

    /** Nichts bestellt, Bestellschluss vorbei — Brot einpacken. */
    DEADLINE_PASSED,

    /** Wochenende, Ferien, Feiertag. */
    NO_OFFER,

    /** Unbekannter Statuswert im Markup — niemals stillschweigend als "ok" deuten. */
    UNKNOWN,
}

/** Eine angebotene Menuelinie an einem Tag. */
data class MenuEntry(
    val date: LocalDate,
    val name: String,
    val status: String,
    val quantityOrdered: String,
    val quantityInCart: String,
    /** false, wenn der Button `readonly` traegt — Bestellschluss ist vorbei. */
    val orderable: Boolean,
) {
    val isOrdered: Boolean
        get() = status == STATUS_ORDERED || quantityOrdered.isNotEmpty()

    val isUnderstood: Boolean
        get() = status == STATUS_ORDERED || status == STATUS_NOT_ORDERED

    companion object {
        const val STATUS_ORDERED = "2"
        const val STATUS_NOT_ORDERED = "0"
    }
}

data class DayStatus(
    val date: LocalDate,
    val state: OrderState,
    val orderedItems: List<String> = emptyList(),
    val offeredItems: List<String> = emptyList(),
    val orderable: Boolean = false,
) {
    /** Zustaende, in denen Handeln moeglich UND sinnvoll ist. */
    val isActionable: Boolean
        get() = state == OrderState.NOT_ORDERED || state == OrderState.IN_CART

    val label: String
        get() = when (state) {
            OrderState.ORDERED -> "bestellt"
            OrderState.IN_CART -> "nur im Warenkorb — nicht abgeschickt"
            OrderState.NOT_ORDERED -> "nicht bestellt (noch bestellbar)"
            OrderState.DEADLINE_PASSED -> "nicht bestellt, Bestellschluss vorbei"
            OrderState.NO_OFFER -> "kein Angebot"
            OrderState.UNKNOWN -> "unklar"
        }

    override fun toString(): String {
        val extra = orderedItems.firstOrNull()?.let { " — $it" } ?: ""
        return "${De.short(date)}: $label$extra"
    }
}

data class WeekPlan(
    val days: Map<LocalDate, DayStatus>,
    /** Kalenderwoche laut Seitenkopf ("KW 35") — Gegenprobe zur Anfrage. */
    val displayedWeek: Int?,
) {
    /** Ein Tag, der in einer geladenen Woche fehlt, hat schlicht kein Angebot. */
    fun statusFor(date: LocalDate): DayStatus =
        days[date] ?: DayStatus(date, OrderState.NO_OFFER)
}

/** Was der Login ueber den Inhaber des Kontos verraet. */
data class Profile(
    val name: String,
    val institution: String,
)
