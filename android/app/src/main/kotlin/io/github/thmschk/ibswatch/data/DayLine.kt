package io.github.thmschk.ibswatch.data

import io.github.thmschk.ibswatch.core.DayStatus
import io.github.thmschk.ibswatch.core.OrderState
import java.time.LocalDate

/**
 * Ein Tag, wie ihn die Oberflaeche anzeigt.
 *
 * Der letzte Lauf wird als Liste solcher Zeilen abgelegt, damit die App auch
 * ohne Netz zeigen kann, WAS bestellt ist — und nicht nur, DASS etwas bestellt
 * ist. Das Gericht zu sehen ist der Teil, den man taeglich benutzt; der Alarm
 * ist der Teil, den man hoffentlich selten braucht.
 *
 * Serialisiert als eine Zeile "Datum Zustand Menuename". Datum und Zustand
 * enthalten nie ein Leerzeichen, der Menuename ist schlicht der Rest — damit
 * braucht es kein Trennzeichen, das im Text vorkommen koennte.
 */
data class DayLine(
    val date: LocalDate,
    val state: OrderState,
    val item: String,
) {
    fun serialize(): String = "$date ${state.name} ${item.replace('\n', ' ')}"

    companion object {
        fun from(day: DayStatus) = DayLine(
            date = day.date,
            state = day.state,
            item = day.orderedItems.firstOrNull() ?: day.offeredItems.firstOrNull().orEmpty(),
        )

        fun parse(line: String): DayLine? {
            val parts = line.split(" ", limit = 3)
            if (parts.size < 3) return null
            return runCatching {
                DayLine(LocalDate.parse(parts[0]), OrderState.valueOf(parts[1]), parts[2])
            }.getOrNull()
        }
    }
}
