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

/** Wie weit die Bestellansicht voraus laedt, wenn "alle" gewuenscht sind. */
const val ORDER_HORIZON_ALL_DAYS = 28

/**
 * Bestellen aus der App (PoC).
 *
 * Zeigt je offenem Tag die waehlbaren Menuelinien. Direkt aus der
 * Benachrichtigung bestellen geht nicht, weil ein Gericht gewaehlt werden
 * muss — die Meldung fuehrt deshalb hierher.
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
    val choice = remember { mutableStateMapOf<LocalDate, MenuEntry>() }
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
            }.filter { it.isActionable && it.entries.any(MenuEntry::selectable) }
        } catch (exc: IbsException) {
            error = exc.message ?: exc.toString()
        }
        loading = false
    }

    LaunchedEffect(Unit) { load() }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Verbindlich bestellen?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    choice.entries.sortedBy { it.key }.forEach { (date, entry) ->
                        Text("${De.short(date)}: ${entry.name}", maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        busy = true
                        scope.launch {
                            val selection = choice.values.sortedBy { it.date }
                            val outcome = withContext(Dispatchers.IO) {
                                OrderPlacer(client).place(
                                    selection,
                                    dryRun = false,
                                    previouslyInCart = days.flatMap { d -> d.entries.filter { it.quantityInCart.isNotEmpty() } },
                                ) { checker.fetch(it) }
                            }
                            result = when (outcome) {
                                is PlaceResult.Ordered -> "Bestellt: " + outcome.dates.joinToString { De.short(it) }
                                is PlaceResult.DryRunOk -> "Probelauf ok"
                                is PlaceResult.Aborted -> "Nicht bestellt: ${outcome.reason}"
                                is PlaceResult.Unconfirmed ->
                                    "Abgeschickt, aber nicht bestätigt (${outcome.reason}) — bitte auf der " +
                                        "Bestellseite nachsehen: " + outcome.missing.joinToString { De.short(it) }
                            }
                            if (outcome is PlaceResult.Ordered || outcome is PlaceResult.Unconfirmed) {
                                choice.clear()
                                CheckScheduler.runNow(context)
                                load()
                            }
                            busy = false
                        }
                    },
                ) { Text("Jetzt bestellen") }
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
            Text("Keine offenen Tage in den nächsten $daysAhead Tagen.")
        }

        days.forEach { day ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        De.long(day.date) + if (day.state == OrderState.IN_CART) " — liegt im Warenkorb" else "",
                        style = MaterialTheme.typography.labelLarge,
                    )
                    MenuOption("nichts", selected = choice[day.date] == null) { choice.remove(day.date) }
                    day.entries.filter(MenuEntry::selectable).forEach { entry ->
                        MenuOption(entry.name, selected = choice[day.date] == entry) { choice[day.date] = entry }
                    }
                }
            }
        }

        if (days.isNotEmpty()) {
            Button(
                onClick = { confirm = true },
                enabled = choice.isNotEmpty() && !busy && !loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("${choice.size} Essen bestellen")
            }
        }
    }
}

@Composable
private fun MenuOption(label: String, selected: Boolean, onSelect: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onSelect),
    ) {
        RadioButton(selected = selected, onClick = onSelect)
        Text(label, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}
