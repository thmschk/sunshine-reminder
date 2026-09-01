# sunshine reminder

Erinnert auf dem Handy daran, wenn im Schulessen-Bestellsystem **IBS5**
(`ibs.sunshine-catering.de`) für die nächsten Tage nichts bestellt ist.

Die App prüft **auf dem Gerät**. Es gibt keinen Server, keine Anmeldung bei
einem Dienst, kein Konto. Die Zugangsdaten verlassen das Handy nur in Richtung
des Bestellsystems selbst.

## Nur für Android — es gibt keine iPhone-Version

Und es wird auch keine geben, die den Zweck erfüllt. Der Grund liegt nicht am
Aufwand, sondern an iOS: Dort entscheidet das System selbst, ob eine App im
Hintergrund rechnen darf, orientiert an den Nutzungsgewohnheiten. Eine Prüfung
kann Stunden zu spät kommen oder tagelang ausbleiben. Für eine Erinnerung mit
Frist ist das keine Grundlage.

Eine iOS-App könnte den Wochenplan anzeigen und beim Öffnen prüfen — aber nicht
zuverlässig um 17:00 aufwachen und warnen. Genau das ist der ganze Zweck: Wer
daran denkt, die App zu öffnen, hätte auch ans Bestellen gedacht.

Für iPhone-Nutzer bleibt der Weg über einen Rechner, der ohnehin durchläuft —
Raspberry Pi, NAS, Server. Empfangen kann das iPhone eine Erinnerung
tadellos, nur auslösen muss sie jemand anders. Dafür ist die
[Python-Variante](#die-python-variante) in diesem Repository da.

> **Kein offizielles Produkt.** Dieses Projekt steht in keinerlei Verbindung zu
> Sunshine Catering oder zum Hersteller von IBS5. Es benutzt dieselbe
> Schnittstelle wie deren Webseite, mit den Zugangsdaten des jeweiligen
> Nutzers, und liest ausschließlich — es bestellt nichts und ändert nichts.
> Der Anbieter kann die Webseite jederzeit ändern; dann funktioniert die App
> nicht mehr. Nutzung auf eigene Verantwortung.

## Was sie tut

Werktags gegen 17:00 meldet sich das Handy, wenn für die kommenden Tage etwas
angeboten, aber nicht bestellt ist:

```
2 ausstehende Bestellungen für Mia
Bestellen ist noch möglich:
  • Donnerstag, 27.08.2026
  • Freitag, 28.08.2026
```

In der App steht zusätzlich der Wochenplan mit den Gerichten — praktisch, wenn
man nur kurz wissen will, was es gibt.

Unterschieden werden sechs Zustände je Tag, damit die Meldung stimmt:

| Zustand | Bedeutung | Reaktion |
|---|---|---|
| bestellt | mindestens eine Menülinie bestellt | nichts |
| nicht bestellt | **noch bestellbar** | Erinnerung |
| nur im Warenkorb | angeklickt, nie abgeschickt | Erinnerung |
| Bestellschluss vorbei | zu spät, nichts mehr zu machen | Hinweis „Brot einpacken" |
| kein Angebot | Wochenende, Ferien, Feiertag | nichts |
| unklar | unbekannter Zustand im Bestellsystem | Fehlermeldung |

Der Bestellschluss wird **nicht geraten**: Das Bestellsystem markiert selbst,
welche Tage noch änderbar sind. Erinnert wird nur, solange Handeln möglich ist.

Über dieselben Tage wird nicht täglich neu geklingelt — nur, wenn ein Tag
dazukommt oder morgen der Bestellschluss abläuft. Sobald alles bestellt ist,
verschwindet die Meldung von selbst.

## Installation

Die App ist **nicht im Play Store**. Sie wird als APK-Datei installiert:

1. Auf dem Handy diesen Link öffnen — er liefert immer die neueste Fassung:
   **[sunshine-reminder.apk](../../releases/latest/download/sunshine-reminder.apk)**
   (alle Versionen einzeln: [Releases](../../releases))
2. Android fragt, ob der Browser Apps installieren darf — das muss einmal
   erlaubt werden.
3. Danach kommt die Warnung „aus unbekannter Quelle". Bestätigen.
4. App öffnen, Kundennummer und Passwort des Bestellsystems eintragen,
   Benachrichtigungen erlauben.

Wer Updates automatisch haben will, kann [Obtainium](https://github.com/ImranR98/Obtainium)
benutzen und dieses Repository als Quelle eintragen.

**Voraussetzung:** Android 8.0 oder neuer.

### Echtheit prüfen

Alle veröffentlichten Dateien sind mit demselben Schlüssel signiert. Wer mag,
kann das nachrechnen — die Datei stammt nur dann aus diesem Projekt, wenn
Folgendes herauskommt:

```
Signer #1 certificate DN: CN=sunshine reminder, O=thmschk
Signer #1 certificate SHA-256 digest:
  75a7fcffc768d867821673c722fb71b93b4a50e85ff86cc2183ca8c5ca078894
```

```bash
apksigner verify --print-certs sunshine-reminder.apk
```

Ein Wechsel dieses Fingerabdrucks wäre ein Grund, misstrauisch zu werden:
Android verweigert dann ohnehin das Update, und eine Neuinstallation von
fremder Hand sollte niemand blind durchwinken.

## Was die App über dich weiß

* **Kundennummer und Passwort** liegen im privaten Speicherbereich der App, auf
  den andere Apps keinen Zugriff haben. Sie werden ausschließlich an
  `ibs.sunshine-catering.de` geschickt, über HTTPS.
* **Es gibt keinen Server dieses Projekts.** Niemand außer dir und dem
  Bestellsystem sieht irgendetwas.
* **Keine Statistik, keine Werbung, keine Fremdbibliotheken zur Auswertung.**

Die App fordert diese Berechtigungen an:

| Berechtigung | Wofür |
|---|---|
| `INTERNET` | das Bestellsystem abfragen |
| `POST_NOTIFICATIONS` | die Erinnerung anzeigen |
| `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE` | bringt Androids WorkManager mit, um die Prüfung im Hintergrund einzuplanen und einen Neustart zu überstehen |

## Stand

Gegen das echte System geprüft: Anmeldung, Abruf, Auswertung, Anzeige und die
Erinnerung selbst — inklusive eines Tests mit einer absichtlich stornierten
Bestellung.

Bis 0.1.0 hat der Hintergrundlauf **nie** ausgelöst, solange die App
geschlossen war: sie hat sich den geplanten Job beim Prozessstart selbst
gelöscht. Weil ein ausgefallener Lauf von außen aussieht wie „alles bestellt",
ist das monatelang nicht aufgefallen. Seit 0.1.1 ist die Ursache behoben, und
die App sagt es selbst, wenn der letzte Lauf überfällig ist oder
Benachrichtigungen ausgeschaltet sind.

Ehrlich dazu, was **nicht** geprüft ist:

* Wie zuverlässig der Hintergrundlauf über Wochen auslöst. Manche Hersteller
  (Xiaomi, Huawei, teils Samsung) beenden Hintergrundarbeit aggressiv. Falls die
  Erinnerung ausbleibt: Einstellungen → Apps → sunshine reminder → Akku →
  „Uneingeschränkt". Dass sie ausbleibt, steht dann in der App.
* Das Verhalten in Schulferien, wenn gar keine Wochenpläne veröffentlicht sind.
* Alles außerhalb einer einzigen Einrichtung — ob andere Schulen dieselbe
  Struktur liefern, ist unbekannt.

**„Beenden erzwingen" legt die App still — anders als ein Neustart.** Android
versetzt sie damit in den *stopped state*: alle geplanten Läufe werden gelöscht,
und sie bekommt keine Broadcasts mehr zugestellt, auch `BOOT_COMPLETED` nicht.
Ein Neustart weckt sie danach also **nicht** wieder auf; erst das nächste Öffnen
von Hand plant alles neu ein. Ein gewöhnlicher Neustart des Handys ohne
vorheriges Erzwingen ist dagegen unkritisch — WorkManager plant seine Läufe beim
Hochfahren selbst neu.

**Der gefährlichste Zustand ist Schweigen.** Wenn der Anbieter etwas ändert,
kann die App verstummen statt zu warnen. Verlass dich nicht blind auf sie.

## Selbst bauen

```bash
cd android
./gradlew :core:test          # Logik prüfen — braucht nur ein JDK 17+
./gradlew :app:assembleDebug  # APK bauen — braucht zusätzlich das Android-SDK
```

Ohne installiertes Android-SDK wird das App-Modul gar nicht erst eingebunden,
`:core:test` läuft trotzdem. Das ist Absicht: Die gesamte Logik, bei der man
sich irren kann — Protokoll, Auswertung, Zustände — liegt in `:core` als reines
Kotlin und ist in Sekunden prüfbar, ohne Emulator.

| Modul | Inhalt | Ohne Android-SDK testbar |
|---|---|---|
| `android/core` | Protokoll, Parser, Auswertung | **ja** |
| `android/app` | Oberfläche, Hintergrundlauf, Benachrichtigungen | nein |
| `ibswatch/` | Python-Variante für die Kommandozeile | ja |

### Release-Build signieren

Der Signierschlüssel gehört nicht ins Repository. Erwartet werden vier Werte,
in `~/.gradle/gradle.properties` oder als Umgebungsvariablen:

```properties
SUNSHINE_KEYSTORE=/pfad/zu/sunshine-reminder.jks
SUNSHINE_KEYSTORE_PASSWORD=…
SUNSHINE_KEY_ALIAS=sunshine
SUNSHINE_KEY_PASSWORD=…
```

Fehlen sie, fällt der Release-Build auf den Debug-Schlüssel zurück. So lässt
sich das Projekt überall bauen — die so entstandene Datei darf aber nicht
verteilt werden, weil den Debug-Schlüssel jeder hat.

## Die Python-Variante

`ibswatch/` ist die Referenzimplementierung, mit der das Protokoll erschlossen
wurde. Sie prüft dasselbe von der Kommandozeile aus und schickt eine E-Mail —
sinnvoll auf einem Rechner, der ohnehin durchläuft (Raspberry Pi, NAS, Server).

```bash
python3 -m pip install -r requirements.txt
cp config.example.toml config.toml     # anpassen
python3 -m ibswatch.check --dry-run
```

Zugangsdaten kommen dort aus `~/.netrc`:

```
machine ibs.sunshine-catering.de login <Kundennummer> password <Passwort>
```

Für den regelmäßigen Lauf liegen in `deploy/` fertige systemd-Timer.

## Technische Notizen

IBS5 ist eine ASP.NET-Anwendung mit einer kleinen JSON-/Bearer-Token-API, die
das eigene Web-Frontend benutzt. Dieses Projekt spricht dieselbe:

```
POST /ibs5/Login/Login
     identifierValue=<Kundennummer>&secretValue=<Passwort>
     &identifierType=0&secretType=0
  -> {"token": …, "name1": …, "institutionName1": …}

GET  /ibs5/Mealplan/Weekplan?year=&week=     Authorization: Bearer <token>
```

Im Wochenplan steht pro angebotener Menülinie und Tag ein Button:

```html
<button id="menu_quantity_2026-08-27_16_828"
        data-order-status="0"               <!-- 0 = nicht bestellt, 2 = bestellt -->
        data-quantity-ordered=""            <!-- "1" wenn bestellt -->
        data-quantity-in-shopping-cart=""   <!-- liegt im Warenkorb -->
        data-date="27.08.2026" data-name="…"
        readonly="readonly">                <!-- fehlt, solange bestellbar -->
```

Zwei Eigenheiten des Servers, die Zeit gekostet haben:

* Ohne `Accept-Language`-Header antwortet der IIS mit **HTTP 500**
  (`Request.UserLanguages` ist dann null in `Views/Shared/_Layout.cshtml`).
* Authentifizierte Endpunkte erwarten zusätzlich `X-Requested-With: XMLHttpRequest`.

Und eine Falle in der Python-Variante: `requests` liest von sich aus `~/.netrc`
und setzt für passende Hosts HTTP-Basic-Auth — das überschreibt den
Bearer-Token, und der Server antwortet mit 500. Da die Zugangsdaten dort per
Design unter genau diesem Hostnamen liegen, trifft das jede Installation.

## Danke sagen

Das Projekt ist ein Nebenher und kostet nichts. Wer trotzdem etwas dalassen
möchte: **[paypal.me/LorenzThomschke](https://paypal.me/LorenzThomschke)** —
in der App liegt derselbe Link hinter dem kleinen Herz.

Es ist ein Trinkgeld, keine Bezahlung: Es wird nichts freigeschaltet, und ohne
Spende fehlt nichts. Wer die Wahl hat, schickt es als „Freunde und Familie" —
dann bleiben die Gebühren aus, und es ist auch das, was es ist.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
