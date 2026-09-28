package io.github.thmschk.ibswatch.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.thmschk.ibswatch.core.CheckConfig
import io.github.thmschk.ibswatch.core.DayChange
import io.github.thmschk.ibswatch.core.De
import io.github.thmschk.ibswatch.core.DayStatus
import io.github.thmschk.ibswatch.core.IbsClient
import io.github.thmschk.ibswatch.core.IbsException
import io.github.thmschk.ibswatch.core.MenuEntry
import io.github.thmschk.ibswatch.core.OrderChecker
import io.github.thmschk.ibswatch.core.OrderPlacer
import io.github.thmschk.ibswatch.core.OrderState
import io.github.thmschk.ibswatch.core.PlaceResult
import io.github.thmschk.ibswatch.data.CredentialStore
import io.github.thmschk.ibswatch.work.CheckScheduler
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Wie weit die Bestellansicht voraus laedt, wenn "alle" gewuenscht sind.
 * IBS5 stellt Speiseplaene etwa 4–5 Wochen im Voraus ein; eine Woche ohne Plan
 * kostet nur eine Abfrage, und eine Ferienwoche dazwischen schneidet nichts ab.
 */
const val ORDER_HORIZON_ALL_DAYS = 56

/**
 * Bestellen, umbestellen und abbestellen aus der App.
 *
 * Zeigt jeden Tag, der sich noch aendern laesst: offene Tage mit "nichts"
 * vorausgewaehlt, bestellte mit dem bestellten Gericht. Abgeschickt wird nur,
 * was vom Vorausgewaehlten abweicht. Direkt aus der Benachrichtigung
 * bestellen geht nicht, weil ein Gericht gewaehlt werden muss — die Meldung
 * fuehrt deshalb hierher.
 *
 * @param daysAhead 0..n Tage ab heute; heute ist dabei, weil der Server per
 * `readonly` selbst sagt, ob noch geaendert werden darf.
 */
@Composable
fun OrderScreen(daysAhead: Int, onClose: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val credentials = remember { CredentialStore(context) }

    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var days by remember { mutableStateOf<List<DayStatus>>(emptyList()) }
    // Nur abweichende Wahl steht hier drin; fehlt ein Tag, gilt der Ist-Stand.
    val picks = remember { mutableStateMapOf<LocalDate, Pick>() }
    var confirm by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }

    // Ein Client fuer Laden und Bestellen: der Token aus dem Login gilt fuer beides.
    val client = remember { IbsClient() }
    val checker = remember { OrderChecker(client, CheckConfig(daysAhead = daysAhead, includeToday = true)) }

    suspend fun load() {
        loading = true
        error = null
        try {
            days = withContext(Dispatchers.IO) {
                client.login(credentials.customerNo, credentials.password)
                checker.fetch(checker.targetDates(LocalDate.now()))
            }.filter(::isChangeable)
        } catch (exc: IbsException) {
            error = exc.message ?: exc.toString()
        }
        loading = false
    }

    LaunchedEffect(Unit) { load() }

    val changes = days
        .map { day -> DayChange(day.date, current = day.ordered(), target = chosen(picks, day)) }
        .filter { it.kind != DayChange.Kind.NONE }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Verbindlich abschicken?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    changes.forEach { Text(describe(it), maxLines = 3, overflow = TextOverflow.Ellipsis) }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        busy = true
                        val requested = changes
                        scope.launch {
                            val outcome = withContext(Dispatchers.IO) {
                                OrderPlacer(client).place(
                                    requested,
                                    dryRun = false,
                                    previouslyInCart = days.flatMap { d -> d.entries.filter { it.quantityInCart == "1" } },
                                ) { checker.fetch(it) }
                            }
                            result = when (outcome) {
                                is PlaceResult.Done -> "Erledigt:\n" + outcome.changes.joinToString("\n") { describe(it) }
                                is PlaceResult.DryRunOk -> "Probelauf ok"
                                is PlaceResult.Aborted -> "Nichts abgeschickt: ${outcome.reason}"
                                is PlaceResult.Unconfirmed ->
                                    "Abgeschickt, aber nicht bestätigt (${outcome.reason}) — bitte auf der " +
                                        "Bestellseite nachsehen: " + outcome.missing.joinToString { De.short(it) }
                            }
                            if (outcome is PlaceResult.Done || outcome is PlaceResult.Unconfirmed) {
                                picks.clear()
                                CheckScheduler.runNow(context)
                                load()
                            }
                            busy = false
                        }
                    },
                ) { Text("Abschicken") }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Abbrechen") } },
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, end = 24.dp, bottom = 24.dp, top = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Bestellen", style = MaterialTheme.typography.headlineSmall)
            TextButton(onClick = onClose) { Text("Zurück") }
        }

        if (loading || busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        result?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }

        if (!loading && error == null && days.isEmpty()) {
            Text("Keine Tage, die sich noch ändern lassen.")
        }

        days.forEach { day ->
            val current = day.ordered()
            val chosen = chosen(picks, day)
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        De.long(day.date) + when {
                            current != null -> " — bestellt"
                            day.state == OrderState.IN_CART -> " — liegt im Warenkorb"
                            else -> " — offen"
                        },
                        style = MaterialTheme.typography.labelLarge,
                    )
                    day.entries.filter(MenuEntry::selectable).forEach { entry ->
                        MenuOption(
                            entry.name,
                            selected = chosen?.menuLineId == entry.menuLineId,
                            marked = entry.menuLineId == current?.menuLineId,
                        ) { picks[day.date] = Pick(entry) }
                    }
                    MenuOption(
                        if (current != null) "abbestellen" else "nichts",
                        selected = chosen == null,
                    ) { picks[day.date] = Pick(null) }
                }
            }
        }

        if (days.isNotEmpty()) {
            Button(
                onClick = { confirm = true },
                enabled = changes.isNotEmpty() && !busy && !loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    when {
                        changes.isEmpty() -> "Nichts geändert"
                        changes.all { it.kind == DayChange.Kind.ORDER } -> "${changes.size} Essen bestellen"
                        changes.size == 1 -> "1 Änderung abschicken"
                        else -> "${changes.size} Änderungen abschicken"
                    },
                )
            }
        }
    }
}

/** Gewaehlte Linie eines Tages; `entry == null` heisst "nichts" bzw. "abbestellen". */
private data class Pick(val entry: MenuEntry?)

/**
 * Gewaehlte Linie eines Tages. Ohne Eintrag gilt der Ist-Stand; ein Eintrag mit
 * `entry == null` ist eine bewusste Wahl ("abbestellen") und darf nicht auf den
 * Ist-Stand zurueckfallen.
 */
private fun chosen(picks: Map<LocalDate, Pick>, day: DayStatus): MenuEntry? =
    if (day.date in picks) picks.getValue(day.date).entry else day.ordered()

/** Die bestellte Linie, falls sie sich noch aendern laesst. */
private fun DayStatus.ordered(): MenuEntry? = entries.firstOrNull { it.isOrdered && it.selectable }

private fun isChangeable(day: DayStatus): Boolean = when (day.state) {
    OrderState.NOT_ORDERED, OrderState.IN_CART -> day.entries.any(MenuEntry::selectable)
    OrderState.ORDERED -> day.ordered() != null
    else -> false
}

private fun describe(change: DayChange): String {
    val day = De.chip(change.date)
    return when (change.kind) {
        DayChange.Kind.ORDER -> "$day bestellen: ${change.target?.name}"
        DayChange.Kind.SWITCH -> "$day umbestellen auf: ${change.target?.name}"
        DayChange.Kind.CANCEL -> "$day abbestellen: ${change.current?.name}"
        DayChange.Kind.NONE -> day
    }
}

@Composable
private fun MenuOption(label: String, selected: Boolean, marked: Boolean = false, onSelect: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelect),
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(
            if (marked) "$label (bestellt)" else label,
            style = MaterialTheme.typography.bodySmall,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
