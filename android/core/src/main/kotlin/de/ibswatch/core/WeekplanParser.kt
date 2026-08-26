package de.ibswatch.core

import java.time.LocalDate
import org.jsoup.Jsoup
import org.jsoup.nodes.Element

/** Die Antwort sah nicht nach einem Wochenplan aus. */
class ParserNotCalibratedException(message: String) : IbsException(message)

/**
 * Wandelt das Wochenplan-Fragment in einen Tagesstatus um.
 *
 * Kalibriert an echten Antworten (26.08.2026). Pro angebotener Menuelinie und
 * Tag steht im Markup ein Button:
 *
 * ```
 * <button id="menu_quantity_2026-08-27_16_828" class="menuplan-checkbox"
 *         data-order-status="0"                0 = nicht bestellt, 2 = bestellt
 *         data-quantity-ordered=""             "1" wenn bestellt
 *         data-quantity-in-shopping-cart=""    liegt im Warenkorb
 *         data-date="27.08.2026" data-name="Gefluegelfrikassee …"
 *         readonly="readonly">                 fehlt, solange noch bestellbar
 * ```
 *
 * `readonly` ist der Bestellschluss: der Server sagt selbst, welche Tage noch
 * aenderbar sind. Deshalb muss hier keine Uhrzeit geraten werden — und die
 * Erinnerung geht nur an Tagen raus, an denen Handeln noch etwas bringt.
 */
object WeekplanParser {

    private val ID_DATE = Regex("""_(\d{4}-\d{2}-\d{2})_""")
    private val DE_DATE = Regex("""^(\d{2})\.(\d{2})\.(\d{4})$""")
    private val KW = Regex("""\bKW\s*(\d{1,2})\b""")

    fun parse(html: String): WeekPlan {
        val doc = Jsoup.parse(html)

        // Anker am Container, nicht an der Trefferzahl: eine Ferienwoche ist
        // legitim leer, eine Fehler- oder Login-Seite dagegen nie ein Plan.
        if (doc.getElementById("weekplan") == null) {
            throw ParserNotCalibratedException(
                "Antwort enthaelt keinen Container mit id='weekplan' — vermutlich " +
                    "eine Fehler- oder Login-Seite statt eines Wochenplans.",
            )
        }

        val displayedWeek = KW.find(doc.text())?.groupValues?.get(1)?.toIntOrNull()

        val byDate = LinkedHashMap<LocalDate, MutableList<MenuEntry>>()
        for (tag in doc.select("[data-order-status]")) {
            val date = entryDate(tag) ?: continue
            byDate.getOrPut(date) { mutableListOf() }.add(
                MenuEntry(
                    date = date,
                    name = tag.attr("data-name").trim(),
                    status = tag.attr("data-order-status").trim(),
                    quantityOrdered = tag.attr("data-quantity-ordered").trim(),
                    quantityInCart = tag.attr("data-quantity-in-shopping-cart").trim(),
                    orderable = !tag.hasAttr("readonly"),
                ),
            )
        }

        val days = byDate.mapValues { (date, entries) ->
            DayStatus(
                date = date,
                state = dayState(entries),
                orderedItems = entries.filter { it.isOrdered }.map { it.name },
                offeredItems = entries.map { it.name },
                orderable = entries.any { it.orderable },
            )
        }

        return WeekPlan(days = days, displayedWeek = displayedWeek)
    }

    private fun entryDate(tag: Element): LocalDate? {
        ID_DATE.find(tag.id())?.let { return LocalDate.parse(it.groupValues[1]) }
        DE_DATE.find(tag.attr("data-date").trim())?.let { m ->
            return LocalDate.of(
                m.groupValues[3].toInt(),
                m.groupValues[2].toInt(),
                m.groupValues[1].toInt(),
            )
        }
        return null
    }

    private fun dayState(entries: List<MenuEntry>): OrderState = when {
        entries.any { it.isOrdered } -> OrderState.ORDERED
        entries.any { it.quantityInCart.isNotEmpty() } -> OrderState.IN_CART
        !entries.all { it.isUnderstood } -> OrderState.UNKNOWN
        entries.any { it.orderable } -> OrderState.NOT_ORDERED
        else -> OrderState.DEADLINE_PASSED
    }
}
