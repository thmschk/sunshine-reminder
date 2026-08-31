package io.github.thmschk.ibswatch

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import io.github.thmschk.ibswatch.notify.Notifier
import io.github.thmschk.ibswatch.ui.AppScreen

class MainActivity : ComponentActivity() {

    /**
     * Kommen Erinnerungen beim Nutzer an?
     *
     * Der Zustand kann sich ausserhalb der App aendern (Systemeinstellungen,
     * weggewischte Berechtigung), deshalb wird er bei jedem onResume neu
     * gelesen statt einmal beim Start.
     */
    private val remindersReachUser = mutableStateOf(true)

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Ablehnung ist erlaubt — sie steht dann aber sichtbar in der App.
            remindersReachUser.value = Notifier.remindersReachUser(this)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        remindersReachUser.value = Notifier.remindersReachUser(this)

        // Nur fragen, wenn es etwas zu fragen gibt: nach zweimaliger Ablehnung
        // verwirft Android den Dialog stillschweigend, und dann fuehrt nur noch
        // der Weg ueber die Systemeinstellungen weiter.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !Notifier.remindersReachUser(this)
        ) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            IbsWatchTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    AppScreen(
                        remindersReachUser = remindersReachUser.value,
                        onOpenNotificationSettings = ::openNotificationSettings,
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        remindersReachUser.value = Notifier.remindersReachUser(this)
    }

    private fun openNotificationSettings() {
        startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
        )
    }
}

/**
 * Die Hausfarben des Anbieters: Gelb #F8D800 und Beere #A01850, aus dem Logo
 * ausgezaehlt.
 *
 * Wichtig dabei: Material3 setzt normalerweise weisse Schrift auf `primary`.
 * Auf diesem Gelb waere das unlesbar — deshalb ist `onPrimary` fast schwarz.
 * Wer die Farben aendert, muss die Kontraste mit aendern.
 *
 * Bewusst kein automatisches Dunkelschema: Die App wird kurz aufgerufen, um
 * nachzusehen, was es zu essen gibt. Ein schwarzer Bildschirm ist dafuer der
 * falsche Ton.
 */
private val SunshineColors = lightColorScheme(
    primary = Color(0xFFF8D800),
    onPrimary = Color(0xFF2A2100),
    primaryContainer = Color(0xFFFFF3B0),
    onPrimaryContainer = Color(0xFF241C00),
    secondary = Color(0xFFA01850),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFD9E4),
    onSecondaryContainer = Color(0xFF3E0020),
    background = Color(0xFFFFFCF0),
    onBackground = Color(0xFF1E1B13),
    surface = Color(0xFFFFFCF0),
    onSurface = Color(0xFF1E1B13),
    surfaceVariant = Color(0xFFEAE3C8),
    onSurfaceVariant = Color(0xFF4A4632),
    outline = Color(0xFF7B7761),
    error = Color(0xFFB3261E),
    onError = Color.White,
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

@Composable
private fun IbsWatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = SunshineColors, content = content)
}
