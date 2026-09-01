package io.github.thmschk.ibswatch.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Slider
import androidx.compose.material3.TimeInput
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import io.github.thmschk.ibswatch.R
import io.github.thmschk.ibswatch.core.CheckSchedule
import io.github.thmschk.ibswatch.core.De
import io.github.thmschk.ibswatch.core.IbsClient
import io.github.thmschk.ibswatch.core.OrderState
import io.github.thmschk.ibswatch.core.UpdateCheck
import io.github.thmschk.ibswatch.data.CredentialStore
import io.github.thmschk.ibswatch.data.DayLine
import io.github.thmschk.ibswatch.data.DayFilter
import io.github.thmschk.ibswatch.data.SettingsStore
import io.github.thmschk.ibswatch.data.ResultStore
import io.github.thmschk.ibswatch.work.CheckScheduler
import java.text.DateFormat
import java.time.Instant
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.util.Date

@Composable
fun AppScreen(
    remindersReachUser: Boolean = true,
    onOpenNotificationSettings: () -> Unit = {},
) {
    val context = LocalContext.current
    val credentials = remember { CredentialStore(context) }
    val results = remember { ResultStore(context) }
    val settings = remember { SettingsStore(context) }

    var configured by remember { mutableStateOf(credentials.isConfigured) }
    var showSettings by remember { mutableStateOf(false) }

    if (showSettings) {
        SettingsDialog(settings = settings, onDismiss = { showSettings = false })
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            // Ab Android 15 zeichnen Apps unter Status- und Navigationsleiste;
            // ohne diesen Abstand klebt die Ueberschrift an der Uhrzeit.
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
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall)
            // Erst sinnvoll, wenn ueberhaupt geprueft wird.
            if (configured) {
                IconButton(onClick = { showSettings = true }) {
                    Icon(
                        painter = painterResource(R.drawable.ic_settings),
                        contentDescription = "Einstellungen",
                    )
                }
            }
        }

        if (!configured) {
            LoginCard(
                onSave = { customerNo, password ->
                    credentials.customerNo = customerNo
                    credentials.password = password
                    CheckScheduler.scheduleNext(context)
                    CheckScheduler.runNow(context)
                    configured = true
                },
            )
        } else {
            // Der Worker laeuft in einem anderen Prozesskontext; ohne diese
            // Beobachtung erfaehrt die Oberflaeche nie, dass er fertig ist,
            // und bleibt auf "Noch nicht geprueft" stehen.
            val workInfos by WorkManager.getInstance(context)
                .getWorkInfosForUniqueWorkFlow(CheckScheduler.WORK_NAME_NOW)
                .collectAsState(initial = emptyList())
            val running = workInfos.any { it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.ENQUEUED }

            // Ohne diesen Hinweis laeuft die App voellig unauffaellig weiter und
            // meldet ins Leere — von aussen nicht von "alles bestellt" zu
            // unterscheiden.
            if (!remindersReachUser) {
                NoticeCard(
                    text = "Benachrichtigungen sind ausgeschaltet. Die App prüft weiter, " +
                        "aber die Erinnerung erreicht dich nicht.",
                    actionLabel = "Benachrichtigungen einschalten",
                    onAction = onOpenNotificationSettings,
                    container = MaterialTheme.colorScheme.errorContainer,
                    onContainer = MaterialTheme.colorScheme.onErrorContainer,
                )
            }

            // Es gibt keinen Store, der von sich aus Bescheid sagt — und eine
            // veraltete Fassung dieses Waechters schweigt womoeglich, obwohl
            // man sich auf sie verlaesst.
            val available = remember(workInfos) { results.availableVersion }
            if (available.isNotBlank()) {
                NoticeCard(
                    text = "Version $available ist verfügbar — installiert ist " +
                        "${installedVersion(context)}. Die neue Fassung legt sich " +
                        "ohne Umweg über die vorhandene.",
                    actionLabel = "Neue Fassung laden",
                    onAction = {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse(UpdateCheck.DOWNLOAD_URL))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    },
                    container = MaterialTheme.colorScheme.secondaryContainer,
                    onContainer = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }

            StatusCard(results, settings, running = running, refreshKey = workInfos)
            // Der Griff, den man nach einer Erinnerung braucht — bisher gab es
            // ihn nur in der Benachrichtigung, also genau dann nicht, wenn man
            // sie schon weggewischt hatte.
            Button(
                onClick = {
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse(IbsClient.WEB_URL))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Bestellseite öffnen") }

            OutlinedButton(
                onClick = { CheckScheduler.runNow(context) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Jetzt prüfen") }
            TextButton(
                onClick = {
                    credentials.clear()
                    results.clear()
                    CheckScheduler.cancel(context)
                    configured = false
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Zugangsdaten löschen") }
        }
    }
}

/**
 * Die beiden Stellschrauben, die wirklich vom Tagesablauf abhaengen.
 *
 * Bewusst hinter dem Zahnrad und nicht auf der Startseite: die Statuskarte soll
 * beantworten, was es zu essen gibt und ob etwas offen ist — nicht mit
 * Reglern zugestellt sein, die man einmal im Jahr anfasst.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsDialog(settings: SettingsStore, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var daysAhead by remember { mutableStateOf(settings.daysAhead) }
    val timeState = rememberTimePickerState(
        initialHour = settings.checkTime.hour,
        initialMinute = settings.checkTime.minute,
        is24Hour = true,
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Einstellungen") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    "Vorwarnzeit: " + if (daysAhead == 1) "1 Tag" else "$daysAhead Tage",
                    style = MaterialTheme.typography.labelLarge,
                )
                Text(
                    "So weit schaut die App voraus. Ein grosses Fenster meldet auch " +
                        "Tage, deren Bestellschluss noch weit weg ist — erinnert wird " +
                        "aber nur einmal je Tag.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Slider(
                    value = daysAhead.toFloat(),
                    onValueChange = { daysAhead = it.toInt() },
                    valueRange = SettingsStore.MIN_DAYS_AHEAD.toFloat()..SettingsStore.MAX_DAYS_AHEAD.toFloat(),
                    // Rastet auf ganze Tage — Zwischenwerte gaebe es sonst nur optisch.
                    steps = SettingsStore.MAX_DAYS_AHEAD - SettingsStore.MIN_DAYS_AHEAD - 1,
                )

                HorizontalDivider()

                Text("Wann geprüft wird", style = MaterialTheme.typography.labelLarge)
                Text(
                    "Werktags zu dieser Zeit. Ein Richtwert: Android darf den Lauf " +
                        "verschieben, wenn das Gerät gerade schläft.",
                    style = MaterialTheme.typography.bodySmall,
                )
                TimeInput(state = timeState)
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    settings.daysAhead = daysAhead
                    settings.checkTime = LocalTime.of(timeState.hour, timeState.minute)
                    // Der schon eingeplante Lauf zielt sonst weiter auf die alte
                    // Zeit — hier ist REPLACE genau richtig.
                    CheckScheduler.scheduleNext(context, ExistingWorkPolicy.REPLACE)
                    onDismiss()
                },
            ) { Text("Speichern") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

/** Die eigene Version, wie sie im Paket steht — ohne BuildConfig. */
private fun installedVersion(context: Context): String =
    runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName
    }.getOrNull().orEmpty().ifBlank { "?" }

@Composable
private fun LoginCard(onSave: (String, String) -> Unit) {
    var customerNo by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var passwordVisible by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Die Zugangsdaten bleiben auf diesem Gerät und werden nur an das " +
                    "Bestellsystem selbst geschickt.",
                style = MaterialTheme.typography.bodySmall,
            )
            OutlinedTextField(
                value = customerNo,
                onValueChange = { customerNo = it },
                label = { Text("Kundennummer") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Passwort") },
                singleLine = true,
                visualTransformation = if (passwordVisible) {
                    VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
                trailingIcon = {
                    IconButton(onClick = { passwordVisible = !passwordVisible }) {
                        // Eigene Vektor-Icons statt material-icons-extended:
                        // dessen kompletter Icon-Satz kostet 7,5 MB im APK.
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
            Button(
                onClick = { onSave(customerNo.trim(), password) },
                enabled = customerNo.isNotBlank() && password.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Speichern und prüfen") }
        }
    }
}

@Composable
private fun StatusCard(
    results: ResultStore,
    settings: SettingsStore,
    running: Boolean,
    refreshKey: Any,
) {
    val context = LocalContext.current
    var filter by remember { mutableStateOf(settings.dayFilter) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (running) {
                Text("Prüfe …", style = MaterialTheme.typography.bodyLarge)
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            // refreshKey erzwingt das Neulesen, sobald sich der Work-Zustand aendert.
            val summary = remember(refreshKey) { results.lastSummary }
            val days = remember(refreshKey) { results.lastDays }
            val lastRun = remember(refreshKey) { results.lastRunEpochMillis }

            Text(
                text = summary.ifBlank { "Noch nicht geprüft." },
                style = MaterialTheme.typography.bodyLarge,
            )

            // Die App kann nicht merken, dass Android sie nicht mehr weckt —
            // ein ausgefallener Lauf sieht von innen aus wie "alles bestellt".
            // Also wird nachgerechnet, wann der letzte Lauf faellig gewesen waere.
            val overdue = remember(refreshKey) {
                CheckSchedule.isOverdue(
                    lastRun.takeIf { it > 0L }
                        ?.let { LocalDateTime.ofInstant(Instant.ofEpochMilli(it), ZoneId.systemDefault()) },
                    LocalDateTime.now(),
                    settings.checkTime,
                )
            }
            if (overdue) {
                Text(
                    "Die Prüfung läuft nicht mehr von selbst — der letzte Lauf ist " +
                        "überfällig. Häufigste Ursache ist die Akku-Optimierung des " +
                        "Herstellers: Einstellungen → Apps → Akku → „Uneingeschränkt“.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(
                    onClick = {
                        CheckScheduler.scheduleNext(context, ExistingWorkPolicy.REPLACE)
                        CheckScheduler.runNow(context)
                    },
                ) { Text("Prüfung neu einplanen") }
            }

            ChipRow(
                title = "Angezeigte Tage",
                options = DayFilter.entries.map { it to it.label },
                selected = filter,
                onSelect = { filter = it; settings.dayFilter = it },
            )

            val shown = when (filter) {
                DayFilter.ALL -> days
                DayFilter.PENDING -> days.filter {
                    it.state != OrderState.ORDERED && it.state != OrderState.NO_OFFER
                }
                DayFilter.NONE -> emptyList()
            }
            if (shown.isNotEmpty()) {
                HorizontalDivider()
                shown.forEach { DayRow(it) }
                HorizontalDivider()
            } else if (filter == DayFilter.PENDING && days.isNotEmpty()) {
                Text("Nichts offen.", style = MaterialTheme.typography.bodySmall)
            }
            if (lastRun > 0) {
                Text(
                    "Zuletzt geprüft: " +
                        DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                            .format(Date(lastRun)),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                "Geprüft wird werktags gegen ${settings.checkTime}.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/**
 * Etwas, das der Nutzer wissen muss, mit genau einem Knopf.
 *
 * Rot fuer die Zustaende, in denen die App zwar laeuft, aber nichts mehr
 * melden kann — Schweigen ist der gefaehrliche Zustand dieser App, den darf man
 * nicht uebersehen koennen. Ruhig gefaerbt fuer alles, was nur nuetzlich ist.
 */
@Composable
private fun NoticeCard(
    text: String,
    actionLabel: String,
    onAction: () -> Unit,
    container: Color,
    onContainer: Color,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = container, contentColor = onContainer),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(text, style = MaterialTheme.typography.bodyMedium)
            TextButton(
                onClick = onAction,
                // Sonst faerbt Material3 die Schrift in primary — auf dem
                // farbigen Grund dieser Karte waere das unleserlich.
                colors = ButtonDefaults.textButtonColors(contentColor = onContainer),
            ) { Text(actionLabel) }
        }
    }
}

@Composable
private fun DayRow(day: DayLine) {
    var expanded by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
            .padding(vertical = 6.dp),
    ) {
        Text(
            text = (if (expanded) "▾ " else "▸ ") + De.short(day.date) + when (day.state) {
                OrderState.ORDERED -> ""
                OrderState.NOT_ORDERED -> " — nicht bestellt"
                OrderState.IN_CART -> " — nur im Warenkorb!"
                OrderState.DEADLINE_PASSED -> " — nicht bestellt, zu spät"
                OrderState.NO_OFFER -> " — kein Angebot"
                OrderState.UNKNOWN -> " — unklar"
            },
            style = MaterialTheme.typography.labelLarge,
            color = if (day.state == OrderState.ORDERED) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.error
            },
        )
        if (day.item.isNotBlank()) {
            // Die Gerichtsnamen sind teils ueber 200 Zeichen lang (vollstaendige
            // Zutatenliste). Eingeklappt bleibt die Liste ueberschaubar, beim
            // Antippen steht der ganze Text da — wer nach Allergenen sucht,
            // braucht ihn vollstaendig.
            Text(
                text = day.item,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (expanded) Int.MAX_VALUE else 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun <T> ChipRow(
    title: String,
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { (value, label) ->
                FilterChip(
                    selected = selected == value,
                    onClick = { onSelect(value) },
                    label = { Text(label) },
                )
            }
        }
    }
}
