plugins {
    // AGP 9 bringt Kotlin-Unterstuetzung selbst mit; ein zusaetzliches
    // kotlin("android") wuerde die 'kotlin'-Extension doppelt registrieren.
    id("com.android.application") version "9.3.2"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.0"
}

/**
 * Release-Signierung.
 *
 * Der Schluessel liegt NIE im Repo. Erwartet werden vier Werte, entweder in
 * ~/.gradle/gradle.properties (lokal) oder als Umgebungsvariablen (CI):
 *
 *   SUNSHINE_KEYSTORE, SUNSHINE_KEYSTORE_PASSWORD,
 *   SUNSHINE_KEY_ALIAS, SUNSHINE_KEY_PASSWORD
 *
 * Fehlen sie, faellt der Release-Build auf den Debug-Schluessel zurueck —
 * so laesst sich das Projekt auch ohne Schluessel bauen und pruefen. Nur die
 * so entstandene APK darf nicht verteilt werden, weil den Debug-Schluessel
 * jeder hat.
 */
fun secret(name: String): String? =
    (project.findProperty(name) as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv(name)?.takeIf { it.isNotBlank() }

val keystorePath = secret("SUNSHINE_KEYSTORE")

android {
    namespace = "io.github.thmschk.ibswatch"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.thmschk.ibswatch"
        // Android 8.0. Darunter gibt es keine Notification Channels und
        // WorkManager wird deutlich unzuverlaessiger.
        minSdk = 26
        targetSdk = 37
        // Beide Werte stehen in gradle.properties, damit eine Version an
        // genau einer Stelle hochgezaehlt wird.
        versionCode = (project.property("appVersionCode") as String).toInt()
        versionName = project.property("appVersionName") as String
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = secret("SUNSHINE_KEYSTORE_PASSWORD")
                keyAlias = secret("SUNSHINE_KEY_ALIAS")
                keyPassword = secret("SUNSHINE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")

            // Bewusst aus: R8 wuerde OkHttp, Jsoup und Compose umbauen, und das
            // laesst sich nur auf einem echten Geraet pruefen. Solange die App
            // nicht laenger im Alltag gelaufen ist, ist ein 13-MB-Paket der
            // bessere Tausch gegen eine Klasse von Fehlern, die erst beim
            // Nutzer auftritt.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        jvmToolchain(17)
    }

    buildFeatures {
        compose = true
    }

    sourceSets["main"].java.directories.add("src/main/kotlin")
}

dependencies {
    // Die gesamte Protokoll- und Auswertungslogik — ohne Android-Abhaengigkeiten
    // und deshalb auf der JVM testbar.
    implementation(project(":core"))

    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.work:work-runtime-ktx:2.11.2")

    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
