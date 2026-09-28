package io.github.thmschk.ibswatch.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.github.thmschk.ibswatch.core.De
import io.github.thmschk.ibswatch.core.IbsException
import io.github.thmschk.ibswatch.core.SduiChild
import io.github.thmschk.ibswatch.core.SduiClient
import io.github.thmschk.ibswatch.core.SubjectReminder
import io.github.thmschk.ibswatch.data.SduiStore
import io.github.thmschk.ibswatch.work.CheckScheduler
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Einrichten des optionalen Stundenplan-Bereichs.
 *
 * Erst verbinden (Anmeldung + Stundenplan der naechsten zwei Wochen laden),
 * dann Kind und Faecher waehlen. Wer Sdui nicht nutzt, sieht davon nur den
 * Eintrag in den Einstellungen.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SduiSetupDialog(onDismiss: () -> Unit, onChanged: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val store = remember { SduiStore(context) }

    var identifier by remember { mutableStateOf(store.identifier) }
    var password by remember { mutableStateOf(store.password) }
    var school by remember { mutableStateOf(store.slink) }
    var children by remember {
        mutableStateOf(if (store.childId > 0) listOf(SduiChild(store.childId, store.childName)) else emptyList())
    }
    var childId by remember { mutableStateOf(store.childId) }
    var known by remember { mutableStateOf(store.knownSubjects.sortedWith(String.CASE_INSENSITIVE_ORDER)) }
    var chosen by remember { mutableStateOf(store.subjects) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val connected = children.isNotEmpty() && known.isNotEmpty()

    fun connect() {
        busy = true
        error = null
        scope.launch {
            try {
                val slink = SduiStore.parseSlink(school)
                val (kids, subjects) = withContext(Dispatchers.IO) {
                    val client = SduiClient()
                    client.login(identifier.trim(), password, slink)
                    val kids = client.children()
                    val first = kids.firstOrNull { it.id == childId } ?: kids.firstOrNull()
                    val today = LocalDate.now()
                    val lessons = first?.let { client.timetable(it.id, today, today.plusDays(14)) }.orEmpty()
                    kids to SubjectReminder.knownSubjects(lessons)
                }
                school = slink
                children = kids
                if (kids.none { it.id == childId }) childId = kids.firstOrNull()?.id ?: 0
                known = (subjects + chosen).distinct().sortedWith(String.CASE_INSENSITIVE_ORDER)
                if (kids.isEmpty()) error = "Kein Kind am Konto gefunden."
                else if (subjects.isEmpty()) error = "In den nächsten zwei Wochen steht kein Unterricht im Stundenplan."
            } catch (exc: IbsException) {
                error = exc.message ?: exc.toString()
            }
            busy = false
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Stundenplan (Sdui)") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    "Erinnert beim täglichen Prüfen an ausgewählte Fächer am nächsten " +
                        "Schultag, z. B. Sport. Die Zugangsdaten bleiben auf dem Gerät und " +
                        "gehen nur an Sdui.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(
                    value = school,
                    onValueChange = { school = it },
                    label = { Text("Schule (Login-Adresse oder Kürzel)") },
                    placeholder = { Text("sdui.app/meine-schule/login") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = identifier,
                    onValueChange = { identifier = it },
                    label = { Text("E-Mail oder Benutzername") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Passwort") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = ::connect,
                    enabled = !busy && identifier.isNotBlank() && password.isNotBlank() && school.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (connected) "Neu laden" else "Verbinden") }
                if (busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }

                if (children.size > 1) {
                    HorizontalDivider()
                    Text("Kind", style = MaterialTheme.typography.labelLarge)
                    children.forEach { kid ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().clickable { childId = kid.id },
                        ) {
                            RadioButton(selected = childId == kid.id, onClick = { childId = kid.id })
                            Text(kid.name)
                        }
                    }
                }

                if (known.isNotEmpty()) {
                    HorizontalDivider()
                    Text("Erinnern an", style = MaterialTheme.typography.labelLarge)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        known.forEach { subject ->
                            FilterChip(
                                selected = subject in chosen,
                                onClick = { chosen = if (subject in chosen) chosen - subject else chosen + subject },
                                label = { Text(subject) },
                            )
                        }
                    }
                }

                if (store.isConfigured) {
                    HorizontalDivider()
                    TextButton(
                        onClick = {
                            store.clear()
                            onChanged()
                            onDismiss()
                        },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                    ) { Text("Sdui entfernen") }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = connected && childId > 0 && !busy,
                onClick = {
                    store.identifier = identifier.trim()
                    store.password = password
                    store.slink = SduiStore.parseSlink(school)
                    store.childId = childId
                    store.childName = children.firstOrNull { it.id == childId }?.name.orEmpty()
                    store.knownSubjects = known.toSet()
                    store.subjects = chosen
                    // Neuer Zugang, neues Glueck: eine gesperrte Anmeldung wird erst hier freigegeben.
                    store.lastError = ""
                    store.notifiedKey = ""
                    CheckScheduler.runNow(context)
                    onChanged()
                    onDismiss()
                },
            ) { Text("Speichern") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

/** Startseiten-Karte, nur wenn Sdui eingerichtet ist. */
@Composable
fun SduiCard(refreshKey: Any, onEdit: () -> Unit) {
    val context = LocalContext.current
    val store = remember { SduiStore(context) }
    val configured = remember(refreshKey) { store.isConfigured }
    if (!configured) return

    val subjects = remember(refreshKey) { store.subjects.sortedWith(String.CASE_INSENSITIVE_ORDER) }
    val day = remember(refreshKey) { store.nextDay.let { runCatching { LocalDate.parse(it) }.getOrNull() } }
    val matches = remember(refreshKey) { store.nextMatches }
    val error = remember(refreshKey) { store.lastError }

    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onEdit),
        colors = CardDefaults.cardColors(containerColor = Color.White),
    ) {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                "STUNDENPLAN" + (store.childName.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            when {
                error.isNotBlank() -> Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                subjects.isEmpty() -> Text("Noch kein Fach ausgewählt — antippen zum Einrichten.", style = MaterialTheme.typography.bodyMedium)
                day == null -> Text("Noch nicht geprüft.", style = MaterialTheme.typography.bodyMedium)
                matches.isEmpty() -> Text(
                    "${De.chip(day)}: nichts davon (${subjects.joinToString(", ")})",
                    style = MaterialTheme.typography.bodyMedium,
                )
                else -> {
                    Text(De.long(day), style = MaterialTheme.typography.labelLarge)
                    matches.forEach { Text(it, style = MaterialTheme.typography.bodyLarge) }
                }
            }
        }
    }
}
