package io.github.thmschk.ibswatch.core

import java.time.Duration
import java.time.LocalDateTime
import java.time.LocalTime
import java.util.Locale

/**
 * Wann der naechste Lauf faellig ist — reine Zeitrechnung, ohne Android.
 *
 * Bewusst in :core und nicht im Scheduler: das sind genau die Faelle, in denen
 * der Waechter frueher still geworden ist (Wochenendsprung, Lauf exakt zur
 * Pruefzeit, ausgefallener Tag). Hier sind sie in Sekunden pruefbar, im
 * Scheduler waeren sie es nur auf einem Geraet.
 */
object CheckSchedule {

    /**
     * Ortszeit, zu der geprueft wird, wenn der Nutzer nichts anderes einstellt.
     *
     * Mittags: frueh genug, um den Nachmittag noch zum Handeln zu haben, und
     * spaet genug, dass das Handy wach ist. Einstellbar ist es trotzdem, weil
     * der Tagesablauf von Familie zu Familie verschieden ist.
     */
    val DEFAULT_CHECK_TIME: LocalTime = LocalTime.of(12, 0)

    /**
     * Luft zwischen "der Lauf haette stattfinden muessen" und "hier stimmt etwas nicht".
     *
     * Ein Handy, das ueber Nacht aus ist oder um 17:00 kein Netz hat, holt den
     * Lauf spaeter nach — das darf keinen Fehlalarm geben. Ein ganzer
     * ausgefallener Tag dagegen schon.
     */
    private val OVERDUE_GRACE: Duration = Duration.ofHours(12)

    /** Naechste Pruefzeit nach [now]; Samstag und Sonntag werden uebersprungen. */
    fun nextRun(now: LocalDateTime, checkTime: LocalTime = DEFAULT_CHECK_TIME): LocalDateTime {
        val todayAtCheckTime = LocalDateTime.of(now.toLocalDate(), checkTime)
        val candidate = if (now < todayAtCheckTime) todayAtCheckTime else todayAtCheckTime.plusDays(1)
        // Samstag und Sonntag ueberspringen: fuer Montag ist der Bestellschluss
        // ohnehin am Freitag, spaetestens am Sonntagabend erreicht uns niemand mehr.
        return generateSequence(candidate) { it.plusDays(1) }
            .first { it.dayOfWeek.value <= 5 }
    }

    /**
     * Vorlauf in Minuten bis zum naechsten Lauf — aufgerundet, nie abgerundet.
     *
     * Abrunden hiesse: der Job darf bis zu 59 Sekunden VOR der Pruefzeit
     * feuern. [nextRun] zielt danach noch einmal auf denselben Termin, und der
     * Tag wird zweimal geprueft.
     */
    fun delayMinutes(now: LocalDateTime, checkTime: LocalTime = DEFAULT_CHECK_TIME): Long {
        val seconds = Duration.between(now, nextRun(now, checkTime)).seconds
        return ((seconds + 59) / 60).coerceAtLeast(0)
    }

    /**
     * Wann der naechste Lauf faellig ist, als Satzteil: "heute gegen 12:00",
     * "morgen gegen 12:00", "Montag gegen 12:00".
     *
     * Die Oberflaeche zeigte bisher nur die eingestellte Uhrzeit. Das ist
     * zweideutig: "gegen 12:00" kann heute oder morgen heissen, und wer nach
     * 12:00 etwas umstellt, wartet den Rest des Tages vergeblich, ohne dass
     * ihm die App einen Hinweis darauf gibt.
     */
    fun nextRunLabel(now: LocalDateTime, checkTime: LocalTime = DEFAULT_CHECK_TIME): String {
        val nextDate = nextRun(now, checkTime).toLocalDate()
        val today = now.toLocalDate()
        // isEqual statt == : java.time-Typen sind wertbasiert, ein Vergleich
        // ueber die Identitaet waere hier bestenfalls zufaellig richtig.
        val day = when {
            nextDate.isEqual(today) -> "heute"
            nextDate.isEqual(today.plusDays(1)) -> "morgen"
            else -> De.weekday(nextDate)
        }
        return "$day gegen %02d:%02d".format(Locale.ROOT, checkTime.hour, checkTime.minute)
    }

    /**
     * Ist der letzte Lauf laenger her, als der Plan erlaubt?
     *
     * Die App kann nicht bemerken, dass Android sie nicht mehr weckt: von innen
     * sieht ein ausgefallener Lauf genauso aus wie "alles bestellt". Also
     * rechnet die Oberflaeche nach, wann der letzte Lauf einen Nachfolger
     * gehabt haben muesste. Ueber das Wochenende ergibt sich die Pause von
     * selbst, weil [nextRun] Samstag und Sonntag ueberspringt.
     *
     * `null` heisst "noch nie gelaufen" — dazu sagt die Oberflaeche schon etwas
     * anderes.
     */
    fun isOverdue(
        lastRun: LocalDateTime?,
        now: LocalDateTime,
        checkTime: LocalTime = DEFAULT_CHECK_TIME,
    ): Boolean = lastRun != null && now.isAfter(nextRun(lastRun, checkTime).plus(OVERDUE_GRACE))
}
