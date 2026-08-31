package io.github.thmschk.ibswatch.core

import java.time.LocalDate
import java.time.temporal.WeekFields

/** Was geprueft werden soll. Bewusst klein — jede Option muss sich rechtfertigen. */
data class CheckConfig(
    /** Wie viele Tage voraus geschaut wird (1 = nur morgen). */
    val daysAhead: Int = 9,
    /** Relevante Wochentage, 1 = Montag … 7 = Sonntag. */
    val weekdays: Set<Int> = setOf(1, 2, 3, 4, 5),
    /** Auch den heutigen Tag pruefen (falls Bestellschluss erst spaeter faellt). */
    val includeToday: Boolean = false,
)

/**
 * Ergebnis eines Laufs.
 *
 * Failed ist bewusst ein eigener Fall und keine leere Alarm-Liste: "nichts
 * bestellt" darf nur ueber Tage gesagt werden, die wirklich geprueft werden
 * konnten. Ein Netzfehler ist keine Aussage ueber den Bestellstand.
 */
sealed interface CheckResult {
    data class Ok(val days: List<DayStatus>) : CheckResult

    data class Alarm(
        /** Nichts bestellt, aber noch bestellbar — hier hilft die Erinnerung. */
        val actionable: List<DayStatus>,
        /** Nichts bestellt, Bestellschluss vorbei — nur noch Information. */
        val tooLate: List<DayStatus>,
        /**
         * Zustand nicht deutbar — muss gemeldet werden, darf aber die klar
         * erkannten Tage nicht mitreissen.
         */
        val unclear: List<DayStatus>,
        val days: List<DayStatus>,
    ) : CheckResult

    data class Failed(
        val reason: String,
        val cause: Throwable? = null,
        /**
         * true = Zugangsdaten abgelehnt. Solche Fehlschlaege duerfen NICHT
         * wiederholt werden: das Passwort wird von allein nicht richtig, und
         * wiederholte Fehlversuche koennen das Konto sperren.
         */
        val isAuthProblem: Boolean = false,
    ) : CheckResult
}

class OrderChecker(
    private val client: IbsClient,
    private val config: CheckConfig = CheckConfig(),
) {
    /** Profil des letzten erfolgreichen Logins — fuer die Anrede in Meldungen. */
    var lastProfile: Profile? = null
        private set

    /** Die Tage, um die es in diesem Lauf geht. */
    fun targetDates(today: LocalDate): List<LocalDate> {
        val first = if (config.includeToday) 0L else 1L
        return (first..config.daysAhead.toLong())
            .map { today.plusDays(it) }
            .filter { it.dayOfWeek.value in config.weekdays }
    }

    fun run(customerNo: String, password: String, today: LocalDate): CheckResult {
        val dates = targetDates(today)
        if (dates.isEmpty()) return CheckResult.Ok(emptyList())

        val days = try {
            lastProfile = client.login(customerNo, password)
            collect(dates)
        } catch (exc: IbsException) {
            return CheckResult.Failed(
                reason = exc.message ?: exc.toString(),
                cause = exc,
                isAuthProblem = exc is IbsAuthException,
            )
        }

        // Ein unklarer Tag ist ein eigener Alarmgrund, kein Grund den Lauf
        // wegzuwerfen: frueher hat ein einziger unbekannter Statuswert die
        // Meldung fuer alle anderen Tage verschluckt — und weil der Worker bei
        // Failed auch die Tagesliste nicht speichert, zeigte die App danach
        // stillschweigend den alten Stand. Genau die Kombination, vor der das
        // Projekt sonst ueberall warnt.
        val actionable = days.filter { it.isActionable }
        val tooLate = days.filter { it.state == OrderState.DEADLINE_PASSED }
        val unclear = days.filter { it.state == OrderState.UNKNOWN }
        return if (actionable.isEmpty() && tooLate.isEmpty() && unclear.isEmpty()) {
            CheckResult.Ok(days)
        } else {
            CheckResult.Alarm(
                actionable = actionable,
                tooLate = tooLate,
                unclear = unclear,
                days = days,
            )
        }
    }

    /** Jede betroffene Kalenderwoche einmal laden und den Tagen zuordnen. */
    private fun collect(dates: List<LocalDate>): List<DayStatus> {
        val weekFields = WeekFields.ISO
        val result = mutableListOf<DayStatus>()

        val weeks = dates
            .map { it.get(weekFields.weekBasedYear()) to it.get(weekFields.weekOfWeekBasedYear()) }
            .distinct()
            .sortedWith(compareBy({ it.first }, { it.second }))

        for ((year, week) in weeks) {
            val plan = WeekplanParser.parse(client.weekplan(year, week))
            if (plan.displayedWeek != null && plan.displayedWeek != week) {
                throw IbsException("Angefragt war KW $week, geliefert wurde KW ${plan.displayedWeek}")
            }
            dates.filter {
                it.get(weekFields.weekBasedYear()) == year &&
                    it.get(weekFields.weekOfWeekBasedYear()) == week
            }.forEach { result.add(plan.statusFor(it)) }
        }

        return result.sortedBy { it.date }
    }
}

/** Text der Benachrichtigung — geteilt von App und Kommandozeile. */
object AlarmText {
    /**
     * Ueberschrift der Meldung.
     *
     * Nennt die Anzahl statt "Noch nichts bestellt": meistens sind ja einige
     * Tage bestellt und nur einzelne offen — eine Meldung, die pauschal das
     * Gegenteil behauptet, verliert schnell ihren Kredit.
     */
    fun title(alarm: CheckResult.Alarm, firstName: String = ""): String {
        val open = alarm.actionable.size
        val what = when {
            open == 1 -> "1 ausstehende Bestellung"
            open > 1 -> "$open ausstehende Bestellungen"
            alarm.tooLate.size == 1 -> "1 Tag ohne Essen"
            alarm.tooLate.size > 1 -> "${alarm.tooLate.size} Tage ohne Essen"
            // Bleibt nur, wenn ausschliesslich unklare Tage uebrig sind.
            else -> "Bestellstatus unklar"
        }
        return if (firstName.isBlank()) what else "$what für $firstName"
    }

    /**
     * Die Zeilen unter der Ueberschrift.
     *
     * Erste Zeile sagt, was zu tun ist — Android zeigt eingeklappt nur sie.
     * Darunter die betroffenen Tage.
     */
    fun body(alarm: CheckResult.Alarm): String = buildString {
        if (alarm.actionable.isNotEmpty()) {
            append("Bestellen ist noch möglich:\n")
            alarm.actionable.forEach { day ->
                append("  • ${De.long(day.date)}")
                if (day.state == OrderState.IN_CART) append(" (liegt im Warenkorb, nicht abgeschickt!)")
                append("\n")
            }
        }
        if (alarm.tooLate.isNotEmpty()) {
            if (isNotEmpty()) append("\n")
            append("Bestellschluss vorbei:\n")
            alarm.tooLate.forEach { append("  • ${De.long(it.date)}\n") }
        }
        if (alarm.unclear.isNotEmpty()) {
            if (isNotEmpty()) append("\n")
            append("Bestellstatus unklar — bitte selbst nachsehen:\n")
            alarm.unclear.forEach { append("  • ${De.long(it.date)}\n") }
        }
    }.trimEnd()

    /** Ueberschrift und Zeilen zusammen — fuer die Anzeige in der App. */
    fun full(alarm: CheckResult.Alarm, firstName: String = ""): String =
        title(alarm, firstName) + "\n" + body(alarm)
}
