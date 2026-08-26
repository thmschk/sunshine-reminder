pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Laedt bei Bedarf ein passendes JDK herunter (nach ~/.gradle/jdks). Ohne das
// braucht der Build ein vorinstalliertes JDK: eine JRE reicht nicht, weil der
// Android-Teil javac benoetigt.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ibs-order-watch"

// :core ist reines Kotlin/JVM und haengt NICHT am Android-SDK — die gesamte
// Protokoll- und Auswertungslogik laesst sich damit ohne Emulator testen.
include(":core")

// :app braucht das Android-SDK. Ohne SDK wird es gar nicht erst eingebunden,
// damit `gradle :core:test` auf einer frischen Maschine trotzdem durchlaeuft.
val androidSdk = System.getenv("ANDROID_HOME")
    ?: System.getenv("ANDROID_SDK_ROOT")
    ?: file("${System.getProperty("user.home")}/Android/Sdk")
        .takeIf { it.isDirectory }?.absolutePath

if (androidSdk != null) {
    include(":app")
} else {
    gradle.rootProject {
        logger.lifecycle(
            "Hinweis: kein Android-SDK gefunden — nur :core wird gebaut. " +
                "Zum Bauen der App ANDROID_HOME setzen.",
        )
    }
}
