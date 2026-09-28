package io.github.thmschk.ibswatch.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
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
import io.github.thmschk.ibswatch.data.SettingsStore
import io.github.thmschk.ibswatch.data.ResultStore
import io.github.thmschk.ibswatch.work.CheckScheduler
import java.text.DateFormat
import java.time.Instant
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.util.Date

/**
 * Ziel des Herzens in der Fusszeile.
 *
 * Bewusst ein blosser Link nach draussen und kein In-App-Kauf: die App
 * verkauft nichts und schaltet nichts frei, es ist ein Trinkgeld. Leer lassen
 * heisst, das Herz gar nicht erst anzuzeigen.
 */
private const val DONATE_URL = "https://paypal.me/LorenzThomschke"

/** Das offene Repository — der Weg fuer alle, die mitcoden wollen. */
private const val REPO_URL = "https://github.com/thmschk/sunshine-reminder"

/**
 * Rosa, aus der Hausfarbe Beere (#A01850) aufgehellt.
 *
 * So blass wie moeglich und so kraeftig wie noetig: gegen den cremefarbenen
 * Grund (#FFFCF0) sind das 3,0:1 — genau die Schwelle, die WCAG 1.4.11 fuer
 * Bedienelemente fordert. Das Herz traegt seine Bedeutung allein, es darf also
 * nicht unter diesen Wert.
 */
private val DonatePink = Color(0xFFCA7A98)

@Composable
fun AppScreen(
    remindersReachUser: Boolean = true,
    onOpenNotificationSettings: () -> Unit = {},
    onOpenOrder: (daysAhead: Int) -> Unit = {},
) {
    val context = LocalContext.current
    val credentials = remember { CredentialStore(context) }
    val results = remember { ResultStore(context) }
    val settings = remember { SettingsStore(context) }

    var configured by remember { mutableStateOf(credentials.isConfigured) }
    var showSettings by remember { mutableStateOf(false) }
    var showDonate by remember { mutableStateOf(false) }

    if (showSettings) {
        SettingsDialog(
            settings = settings,
            onDismiss = { showSettings = false },
            onDeleteCredentials = {
                credentials.clear()
                results.clear()
                CheckScheduler.cancel(context)
                configured = false
                showSettings = false
            },
        )
    }
    if (showDonate) {
        DonateDialog(onDismiss = { showDonate = false })
    }

    // Der Worker laeuft in einem anderen Prozesskontext; ohne diese
    // Beobachtung erfaehrt die Oberflaeche nie, dass er fertig ist,
    // und bleibt auf "Noch nicht geprueft" stehen.
    val workInfos by WorkManager.getInstance(context)
        .getWorkInfosForUniqueWorkFlow(CheckScheduler.WORK_NAME_NOW)
        .collectAsState(initial = emptyList())
    val running = workInfos.any { it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.ENQUEUED }

    Column(
        modifier = Modifier
            .fillMaxSize()
            // Ab Android 15 zeichnen Apps unter Status- und Navigationsleiste;
            // ohne diesen Abstand klebt die Ueberschrift an der Uhrzeit.
            .safeDrawingPadding(),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(R.string.app_name),
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.weight(1f),
                )
                // Die Webseite ist nur noch der Ausweg — bestellt wird in der App.
                IconButton(
                    onClick = {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse(IbsClient.WEB_URL))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    },
                ) {
                    Icon(painterResource(R.drawable.ic_open_in_new), contentDescription = "Bestellseite öffnen")
                }
                if (configured) {
                    IconButton(onClick = { CheckScheduler.runNow(context) }, enabled = !running) {
                        Icon(painterResource(R.drawable.ic_refresh), contentDescription = "Jetzt prüfen")
                    }
                    IconButton(onClick = { showSettings = true }) {
                        Icon(painterResource(R.drawable.ic_settings), contentDescription = "Einstellungen")
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
                return@Column
            }

            if (running) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())

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

            // refreshKey erzwingt das Neulesen, sobald sich der Work-Zustand aendert.
            val days = remember(workInfos) { results.lastDays.filter { it.state != OrderState.NO_OFFER } }
            val lastRun = remember(workInfos) { results.lastRunEpochMillis }
            val failed = remember(workInfos) { results.lastFailed }
            val summary = remember(workInfos) { results.lastSummary }
            val firstName = remember(workInfos) { results.firstName }

            HeroCard(
                days = days,
                checked = lastRun > 0L,
                failedReason = summary.takeIf { failed },
                firstName = firstName,
                onOrder = { onOpenOrder(settings.daysAhead) },
            )

            // Die App kann nicht merken, dass Android sie nicht mehr weckt —
            // ein ausgefallener Lauf sieht von innen aus wie "alles bestellt".
            // Also wird nachgerechnet, wann der letzte Lauf faellig gewesen waere.
            val overdue = remember(workInfos) {
                CheckSchedule.isOverdue(
                    lastRun.takeIf { it > 0L }
                        ?.let { LocalDateTime.ofInstant(Instant.ofEpochMilli(it), ZoneId.systemDefault()) },
                    LocalDateTime.now(),
                    settings.checkTime,
                )
            }
            if (overdue) {
                NoticeCard(
                    text = "Die Prüfung läuft nicht mehr von selbst — der letzte Lauf ist " +
                        "überfällig. Häufigste Ursache ist die Akku-Optimierung des " +
                        "Herstellers: Einstellungen → Apps → Akku → „Uneingeschränkt“.",
                    actionLabel = "Prüfung neu einplanen",
                    onAction = {
                        CheckScheduler.scheduleNext(context, ExistingWorkPolicy.REPLACE)
                        CheckScheduler.runNow(context)
                    },
                    container = MaterialTheme.colorScheme.errorContainer,
                    onContainer = MaterialTheme.colorScheme.onErrorContainer,
                )
            }

            if (days.isNotEmpty()) {
                Text(
                    "DIE NÄCHSTEN TAGE",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 4.dp, top = 4.dp),
                )
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = Color.White),
                ) {
                    // Kurz halten: der Blick nach vorn, nicht die ganze Vorwarnzeit.
                    days.take(DAY_LIST_LENGTH).forEachIndexed { i, day ->
                        if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
                        DayRow(day, onOrder = { onOpenOrder(settings.daysAhead) })
                    }
                }
            }

            TextButton(
                onClick = { onOpenOrder(ORDER_HORIZON_ALL_DAYS) },
                modifier = Modifier.align(Alignment.CenterHorizontally),
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.secondary),
            ) { Text("Alle bestellbaren Tage →") }
        }

        if (configured) {
            Footer(
                lastRun = remember(workInfos) { results.lastRunEpochMillis },
                settings = settings,
                onHeart = { showDonate = true },
            )
        }
    }
}

/**
 * Was hinter der App steckt, und der Hut, der danebenliegt.
 *
 * Die Ziele stecken in den Woertern selbst: "mitcoden" und "PayPal.Me" sagen
 * bereits, wohin sie fuehren. Der Satz steht damit vor dem Griff nach
 * draussen — wer das Herz antippt, liest erst, worum es geht.
 */
@Composable
private fun DonateDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current

    // Ohne eigenen Listener oeffnet Compose den Link selbst und laesst den
    // Dialog stehen — man kaeme aus dem Browser auf eine Frage zurueck, die
    // schon beantwortet ist.
    val openAndClose = LinkInteractionListener { link ->
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse((link as LinkAnnotation.Url).url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        onDismiss()
    }
    // Farbe allein traegt die Information nicht (WCAG 1.4.1), deshalb zusaetzlich
    // unterstrichen.
    val linkStyles = TextLinkStyles(
        style = SpanStyle(
            color = MaterialTheme.colorScheme.primary,
            textDecoration = TextDecoration.Underline,
        ),
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                painter = painterResource(R.drawable.ic_heart),
                contentDescription = null,
                tint = DonatePink,
                modifier = Modifier.size(28.dp),
            )
        },
        title = { Text("Über diese App") },
        text = {
            Text(
                buildAnnotatedString {
                    append(
                        "Diese App wurde mithilfe eines KI-Agenten in meiner Freizeit " +
                            "entwickelt. Ich freue mich über Feedback. Wer will, darf " +
                            "gerne auch ",
                    )
                    withLink(LinkAnnotation.Url(REPO_URL, linkStyles, openAndClose)) {
                        append("mitcoden")
                    }
                    append(
                        ". Wer mir unbedingt einen Espresso spendieren möchte, darf " +
                            "das per ",
                    )
                    withLink(LinkAnnotation.Url(DONATE_URL, linkStyles, openAndClose)) {
                        append("PayPal.Me")
                    }
                    append(" machen.")
                },
                style = MaterialTheme.typography.bodyMedium,
            )
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Schließen") } },
    )
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
private fun SettingsDialog(
    settings: SettingsStore,
    onDismiss: () -> Unit,
    onDeleteCredentials: () -> Unit,
) {
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

                HorizontalDivider()

                // Selten und endgueltig — deshalb hier und nicht auf der Startseite.
                TextButton(
                    onClick = onDeleteCredentials,
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) { Text("Zugangsdaten löschen") }
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

/** So viele Tage zeigt die Liste auf der Startseite. */
private const val DAY_LIST_LENGTH = 5

/** Gelb = offen, Gruen = erledigt, Rot = zu spaet oder unklar. */
private val OkGreen = Color(0xFF2E7D32)
private val OkContainer = Color(0xFFDDF0DC)

/**
 * Die eine Aussage der Startseite, mit hoechstens einem Knopf.
 *
 * Reihenfolge der Faelle = Dringlichkeit: was man noch aendern kann, kommt
 * vor dem, was nur noch Information ist.
 */
@Composable
private fun HeroCard(
    days: List<DayLine>,
    checked: Boolean,
    failedReason: String?,
    firstName: String,
    onOrder: () -> Unit,
) {
    val open = days.filter { it.state == OrderState.NOT_ORDERED || it.state == OrderState.IN_CART }
    val late = days.filter { it.state == OrderState.DEADLINE_PASSED }
    val unclear = days.filter { it.state == OrderState.UNKNOWN }
    val forName = if (firstName.isBlank()) "" else " für $firstName"
    val scheme = MaterialTheme.colorScheme

    val (container, onContainer) = when {
        failedReason != null || !checked -> scheme.surfaceVariant to scheme.onSurfaceVariant
        open.isNotEmpty() -> scheme.primaryContainer to scheme.onPrimaryContainer
        late.isNotEmpty() || unclear.isNotEmpty() -> scheme.errorContainer to scheme.onErrorContainer
        else -> OkContainer to scheme.onSurface
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = container, contentColor = onContainer),
    ) {
        Column(
            modifier = Modifier.padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val big = MaterialTheme.typography.headlineSmall
            when {
                !checked -> Text("Noch nicht geprüft", style = big)

                failedReason != null -> {
                    Text("Bestellstand unbekannt", style = big)
                    // Die Tagesliste darunter ist dann der alte Stand.
                    Text(
                        "$failedReason\nDie Liste unten zeigt den letzten erfolgreichen Stand.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }

                open.isNotEmpty() -> {
                    Text(
                        (if (open.size == 1) "1 Tag offen" else "${open.size} Tage offen") + forName,
                        style = big,
                    )
                    Text(
                        if (open.any { it.state == OrderState.IN_CART }) {
                            "Bestellen ist noch möglich — etwas liegt nur im Warenkorb."
                        } else {
                            "Bestellen ist noch möglich."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier
                            .horizontalScroll(rememberScrollState())
                            .padding(top = 4.dp),
                    ) {
                        open.forEach { day ->
                            Text(
                                De.chip(day.date),
                                style = MaterialTheme.typography.labelLarge,
                                modifier = Modifier
                                    .background(Color.White, RoundedCornerShape(14.dp))
                                    .padding(horizontal = 10.dp, vertical = 5.dp),
                            )
                        }
                    }
                    Button(
                        onClick = onOrder,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 8.dp),
                    ) { Text("Jetzt bestellen") }
                }

                late.isNotEmpty() -> {
                    Text(
                        (if (late.size == 1) "1 Tag ohne Essen" else "${late.size} Tage ohne Essen") + forName,
                        style = big,
                    )
                    Text(
                        "Bestellschluss vorbei: " + late.joinToString { De.chip(it.date) } + " — Brot einpacken.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }

                unclear.isNotEmpty() -> {
                    Text("Bestellstatus unklar", style = big)
                    Text(
                        unclear.joinToString { De.chip(it.date) } + " — bitte auf der Bestellseite nachsehen.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }

                days.isEmpty() -> Text("Keine Schultage im Prüfzeitraum", style = big)

                else -> {
                    Text("Alles bestellt ✓", style = big)
                    Text("bis ${De.long(days.last().date)}", style = MaterialTheme.typography.bodyMedium)
                    // Was als Naechstes auf den Tisch kommt — der taeglich genutzte Teil.
                    val next = days.first()
                    Text(
                        "Als Nächstes · ${De.chip(next.date)}",
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    Text(next.item, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun DayRow(day: DayLine, onOrder: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val open = day.state == OrderState.NOT_ORDERED || day.state == OrderState.IN_CART
    val scheme = MaterialTheme.colorScheme

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { if (open) onOrder() else expanded = !expanded }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(
            modifier = Modifier.width(40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(De.weekdayShort(day.date), style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant)
            Text(day.date.dayOfMonth.toString(), style = MaterialTheme.typography.titleMedium)
        }
        Column(modifier = Modifier.weight(1f)) {
            // Die Gerichtsnamen sind teils ueber 200 Zeichen lang (vollstaendige
            // Zutatenliste). Antippen zeigt den ganzen Text — wer nach
            // Allergenen sucht, braucht ihn vollstaendig.
            Text(
                text = when (day.state) {
                    OrderState.NOT_ORDERED -> "Gericht wählen"
                    OrderState.DEADLINE_PASSED -> "nicht bestellt"
                    else -> day.item
                },
                style = MaterialTheme.typography.bodyMedium,
                maxLines = if (expanded) Int.MAX_VALUE else 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = when (day.state) {
                    OrderState.ORDERED -> "bestellt"
                    OrderState.NOT_ORDERED -> "offen · Tippen zum Bestellen"
                    OrderState.IN_CART -> "nur im Warenkorb · Tippen zum Bestellen"
                    OrderState.DEADLINE_PASSED -> "Bestellschluss vorbei · Brot einpacken"
                    OrderState.NO_OFFER -> "kein Angebot"
                    OrderState.UNKNOWN -> "unklar · bitte selbst nachsehen"
                },
                style = MaterialTheme.typography.bodySmall,
                color = when {
                    open -> Color(0xFF7A5D00)
                    day.state == OrderState.ORDERED -> scheme.onSurfaceVariant
                    else -> scheme.error
                },
            )
        }
        val (symbol, bg, fg) = when {
            day.state == OrderState.ORDERED -> Triple("✓", OkContainer, OkGreen)
            open -> Triple("!", scheme.primary, scheme.onPrimary)
            else -> Triple("✕", scheme.errorContainer, scheme.error)
        }
        Box(
            modifier = Modifier
                .size(26.dp)
                .background(bg, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(symbol, color = fg, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/**
 * Prueflauf-Zeiten klein am Rand, dazu das Herz.
 *
 * Bewusst der naechste Lauf und nicht die eingestellte Zeit: "gegen 12:00"
 * kann heute oder morgen heissen, und wer nach 12:00 etwas umstellt, wartet
 * sonst den Rest des Tages ahnungslos.
 */
@Composable
private fun Footer(lastRun: Long, settings: SettingsStore, onHeart: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 8.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val last = if (lastRun > 0) {
            "Geprüft " + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(lastRun)) + " · "
        } else {
            ""
        }
        Text(
            last + "nächste Prüfung " + CheckSchedule.nextRunLabel(LocalDateTime.now(), settings.checkTime),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        // Das Herz allein hiesse in Apps "Favorit" — was gemeint ist, sagt der
        // Dialog dahinter.
        if (DONATE_URL.isNotBlank()) {
            IconButton(onClick = onHeart) {
                Icon(
                    painter = painterResource(R.drawable.ic_heart),
                    contentDescription = "Über diese App",
                    tint = DonatePink,
                    modifier = Modifier.size(18.dp),
                )
            }
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

