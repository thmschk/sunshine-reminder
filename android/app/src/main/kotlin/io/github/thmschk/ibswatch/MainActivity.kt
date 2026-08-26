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
 * Warme, helle Farben — passend zum Namen und zum Anlass.
 *
 * Bewusst kein automatisches Dunkelschema: Die App wird kurz aufgerufen, um
 * nachzusehen, was es zu essen gibt. Ein schwarzer Bildschirm mit einer
 * Fehlermeldung darauf ist dafuer der falsche Ton.
 */
private val SunshineColors = lightColorScheme(
    primary = Color(0xFFC26A00),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDDB8),
    onPrimaryContainer = Color(0xFF2E1500),
    secondary = Color(0xFF725A42),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFDDB8),
    onSecondaryContainer = Color(0xFF291806),
    background = Color(0xFFFFFBF5),
    onBackground = Color(0xFF211A14),
    surface = Color(0xFFFFFBF5),
    onSurface = Color(0xFF211A14),
    surfaceVariant = Color(0xFFF3DFC9),
    onSurfaceVariant = Color(0xFF514434),
    outline = Color(0xFF837462),
    error = Color(0xFFB3261E),
    onError = Color.White,
)

@Composable
private fun IbsWatchTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = SunshineColors, content = content)
}
