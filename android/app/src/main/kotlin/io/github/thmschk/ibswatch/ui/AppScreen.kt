package io.github.thmschk.ibswatch.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.work.WorkInfo
import androidx.work.WorkManager
import io.github.thmschk.ibswatch.data.CredentialStore
import io.github.thmschk.ibswatch.data.ResultStore
import io.github.thmschk.ibswatch.work.CheckScheduler
import java.text.DateFormat
import java.util.Date

@Composable
fun AppScreen() {
    val context = LocalContext.current
    val credentials = remember { CredentialStore(context) }
    val results = remember { ResultStore(context) }

    var configured by remember { mutableStateOf(credentials.isConfigured) }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("IBS Bestellwächter", style = MaterialTheme.typography.headlineSmall)

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

            StatusCard(results, running = running, refreshKey = workInfos)
            Button(
                onClick = { CheckScheduler.runNow(context) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Jetzt prüfen") }
            TextButton(
                onClick = {
                    credentials.clear()
                    CheckScheduler.cancel(context)
                    configured = false
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Zugangsdaten löschen") }
        }
    }
}

@Composable
private fun LoginCard(onSave: (String, String) -> Unit) {
    var customerNo by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

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
                visualTransformation = PasswordVisualTransformation(),
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
private fun StatusCard(results: ResultStore, running: Boolean, refreshKey: Any) {
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
            val lastRun = remember(refreshKey) { results.lastRunEpochMillis }
            Text(
                text = summary.ifBlank { "Noch nicht geprüft." },
                style = MaterialTheme.typography.bodyLarge,
            )
            if (lastRun > 0) {
                Text(
                    "Zuletzt geprüft: " +
                        DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                            .format(Date(lastRun)),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                "Geprüft wird werktags gegen ${CheckScheduler.CHECK_TIME}.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}
