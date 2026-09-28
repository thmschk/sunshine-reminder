package io.github.thmschk.ibswatch.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MenuAnchorType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.res.painterResource
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import io.github.thmschk.ibswatch.R
import androidx.compose.ui.text.font.FontWeight
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
    var passwordVisible by remember { mutableStateOf(false) }
    // Nach dem ersten Login ist der Zugang eingeklappt — er aendert sich selten.
    var editLogin by remember { mutableStateOf(!store.isConfigured) }

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
                if (!editLogin) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            "Angemeldet als $identifier\n${SduiStore.parseSlink(school)}",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = { editLogin = true }) { Text("Ändern") }
                    }
                }
                if (editLogin) {
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
                    visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                    trailingIcon = {
                        IconButton(onClick = { passwordVisible = !passwordVisible }) {
                            Icon(
                                painter = painterResource(
                                    if (passwordVisible) R.drawable.ic_visibility_off else R.drawable.ic_visibility,
                                ),
                                contentDescription = if (passwordVisible) "Passwort verbergen" else "Passwort anzeigen",
                            )
                        }
                    },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                }
                if (editLogin) {
                    Button(
                        onClick = { editLogin = false; connect() },
                        enabled = !busy && identifier.isNotBlank() && password.isNotBlank() && school.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Verbinden") }
                }
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
                    SubjectDropdown(known, chosen) { chosen = it }
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

/** Eine Stunde in der Zeitleiste; mehrere Eintraege = parallele Kurse. */
data class PlanCell(val short: String, val subject: String, val note: String)

/** Plan aus dem [SduiStore] je Tag und Stundennummer. */
fun parsePlan(lines: List<String>): Map<LocalDate, Map<Int, List<PlanCell>>> =
    lines.mapNotNull { line ->
        val p = line.split("|")
        val date = runCatching { LocalDate.parse(p[0]) }.getOrNull() ?: return@mapNotNull null
        val hour = p.getOrNull(1)?.toIntOrNull() ?: return@mapNotNull null
        Triple(date, hour, PlanCell(p.getOrElse(2) { "" }, p.getOrElse(3) { "" }, p.getOrElse(4) { "" }))
    }
        .groupBy { it.first }
        .mapValues { (_, v) -> v.groupBy({ it.second }, { it.third }) }

/** Blau fuer den Stundenplan — hebt sich vom Gelb/Gruen/Rot des Essens ab. */
private val TimetableHighlight = Color(0xFF14304F)
private val TimetableCell = Color(0xFFEEF1F5)
private val TimetableText = Color(0xFF4D5968)

/**
 * Der Schultag als Leiste gleich breiter Zellen, eine je Stunde 1..[maxHour].
 * Freistunden bleiben als Luecke stehen, damit die Stunden untereinander
 * in allen Zeilen an derselben Stelle liegen. Gewaehlte Faecher sind dunkel.
 */
@Composable
fun TimetableStrip(slots: Map<Int, List<PlanCell>>, maxHour: Int, selected: Set<String>) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
    ) {
        for (hour in 1..maxHour) {
            val cells = slots[hour].orEmpty()
            val hl = cells.any { it.subject in selected }
            val note = cells.any { it.note.isNotBlank() }
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .weight(1f)
                    .height(18.dp)
                    .background(
                        when {
                            cells.isEmpty() -> Color.Transparent
                            hl -> TimetableHighlight
                            else -> TimetableCell
                        },
                        RoundedCornerShape(4.dp),
                    ),
            ) {
                if (cells.isNotEmpty()) {
                    Text(
                        // Parallele Kurse passen nicht in eine Zelle: das gewaehlte (sonst erste) Kuerzel + "+".
                        (cells.firstOrNull { it.subject in selected } ?: cells.first()).short +
                            (if (cells.map { it.short }.distinct().size > 1) "+" else "") +
                            (if (note) "*" else ""),
                        fontSize = 9.sp,
                        fontWeight = if (hl) FontWeight.Bold else null,
                        color = if (hl) Color.White else TimetableText,
                        maxLines = 1,
                        overflow = TextOverflow.Clip,
                    )
                }
            }
        }
    }
}

/** Mehrfachauswahl als Dropdown mit Haken; bleibt beim Antippen offen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SubjectDropdown(known: List<String>, chosen: Set<String>, onChange: (Set<String>) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = known.filter { it in chosen }.joinToString(", ").ifBlank { "keins" },
            onValueChange = {},
            readOnly = true,
            label = { Text("Erinnern an") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            known.forEach { subject ->
                DropdownMenuItem(
                    text = { Text(subject) },
                    leadingIcon = {
                        Checkbox(checked = subject in chosen, onCheckedChange = null)
                    },
                    onClick = { onChange(if (subject in chosen) chosen - subject else chosen + subject) },
                )
            }
        }
    }
}
