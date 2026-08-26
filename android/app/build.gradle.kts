plugins {
    id("com.android.application") version "9.3.2"
    kotlin("android") version "2.2.0"
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.0"
}

android {
    namespace = "io.github.thmschk.ibswatch"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.thmschk.ibswatch"
        // Android 8.0. Darunter gibt es keine Notification Channels und
        // WorkManager wird deutlich unzuverlaessiger.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    sourceSets["main"].java.srcDirs("src/main/kotlin")
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
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
