package io.github.thmschk.ibswatch

import android.Manifest
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import io.github.thmschk.ibswatch.ui.AppScreen

class MainActivity : ComponentActivity() {

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* Ablehnung ist erlaubt */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            IbsWatchTheme {
                Surface(color = MaterialTheme.colorScheme.background) {
                    AppScreen()
                }
            }
        }
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
)

@Composable
private fun IbsWatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = SunshineColors, content = content)
}
