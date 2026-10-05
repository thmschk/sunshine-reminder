# happy sunshine

*(bis 0.1.20: „sunshine reminder“ — Repository und Download-Link heißen weiter so)*

Erinnert auf dem Handy daran, wenn im Schulessen-Bestellsystem **IBS5**
(`ibs.sunshine-catering.de`) für die nächsten Tage nichts bestellt ist — und
bestellt, bestellt um oder bestellt ab direkt aus der App. Wer mag, holt sich
dazu den **Stundenplan aus Sdui** und wird am Vortag an Fächer wie Sport
erinnert.

Die App prüft **auf dem Gerät**. Es gibt keinen Server, keine Anmeldung bei
einem Dienst, kein Konto. Die Zugangsdaten verlassen das Handy nur in Richtung
des Bestellsystems bzw. von Sdui selbst.

## Web-Version für iPhone und andere (Test)

Eine native iPhone-App gibt es nicht und wird es nicht geben: iOS entscheidet
selbst, ob und wann eine App im Hintergrund rechnen darf. Eine Prüfung mit
Frist kann Stunden zu spät kommen oder ausfallen. Empfangen kann das iPhone
eine Erinnerung aber tadellos — nur auslösen muss sie jemand anders.

Genau das macht eine Web-Version, die gerade erprobt wird (die Adresse folgt,
sobald sie allgemein offen ist):

* Sie kann, was die App kann: Übersicht der nächsten Tage, bestellen,
  umbestellen, abbestellen. Sie spricht dafür **direkt aus dem Browser** mit
  dem Bestellsystem.
* Für die Erinnerung weckt ein kleiner Server das Gerät werktags zur gewählten
  Uhrzeit mit einer leeren Push-Nachricht. Geprüft wird dann **auf dem Gerät**;
  der Server kennt weder Zugangsdaten noch Bestellstand, nur das Push-Abo und
  die Uhrzeit.
* Zugangsdaten liegen verschlüsselt im Speicher des Browsers, mit einem
  Schlüssel, den der Browser erzeugt und nicht herausgibt.

### Einrichten

1. **Installieren**
   * **iPhone** (Safari): Teilen → „Zum Home-Bildschirm“
   * **Android** (Chrome): ⋮ → „App installieren“ — nicht „Verknüpfung erstellen“
2. **Über das neue Symbol öffnen**, nicht im Browser-Tab.
3. **Anmelden** mit Kundennummer und Passwort von IBS5.
4. **Erinnerung einschalten:** ⚙ → Uhrzeit wählen → „Erinnerung einschalten“.
5. **Ausprobieren:** ⚙ → „Jetzt testen“.

> [!NOTE]
> Auf dem **iPhone** gibt es Erinnerungen nur in der installierten Fassung,
> nicht im normalen Safari-Tab. Auf **Android** müssen Benachrichtigungen für
> Chrome selbst erlaubt sein (Einstellungen → Apps → Chrome →
> Benachrichtigungen), sonst fragt Chrome gar nicht erst.

**Grenzen:** Handy-Browsern liefert IBS5 statt des Wochenplans nur eine
Tagesansicht, also eine Anfrage je Tag. Zu viele Anfragen in kurzer Zeit
quittiert IBS5 mit einer Sperre der IP-Adresse (dann geht auch die normale
Bestellseite eine Weile nicht). Die Web-Version fragt deshalb sparsam: Tage
nacheinander, kurz zwischengespeichert, die Erinnerung höchstens die nächsten
fünf Schultage. Die Erinnerung auf dem iPhone ist noch nicht ausprobiert.

Wer lieber ganz ohne fremden Server auskommt: Die
[Python-Variante](#die-python-variante) läuft auf einem eigenen Rechner, der
ohnehin durchläuft — Raspberry Pi, NAS, Server.

> **Kein offizielles Produkt.** Dieses Projekt steht in keinerlei Verbindung zu
> Sunshine Catering, zum Hersteller von IBS5 oder zur Sdui GmbH. Es benutzt
> dieselben Schnittstellen wie deren Webseiten, mit den Zugangsdaten des
> jeweiligen Nutzers. Bestellt wird nur, wenn man in der App ausdrücklich Gerichte wählt
> und bestätigt — von selbst bestellt oder ändert sie nichts.
> Sdui wird nur gelesen. Die Anbieter können ihre Webseiten jederzeit ändern;
> dann funktioniert die App nicht mehr. Nutzung auf eigene Verantwortung.

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

### Bestellen, umbestellen, abbestellen

Bestellt wird direkt in der App: „Jetzt bestellen" in der Erinnerung, ein Tipp
auf einen Tag der Startseite (die Bestellansicht springt zu genau diesem Tag)
oder „Alle bestellbaren Tage" für alles, wofür schon ein Speiseplan vorliegt
(die App schaut acht Wochen voraus). Offene Tage stehen dort mit „nichts"
vorausgewählt, bestellte mit ihrem Gericht. Wer ein anderes Gericht wählt,
bestellt um, wer „abbestellen" wählt, bestellt ab.

Abgeschickt wird nur, was geändert wurde, und nur, wenn im Warenkorb genau
diese Auswahl liegt — sonst liegt dort etwas Fremdes, und die App schickt
nichts ab. Danach prüft sie im Wochenplan nach, ob jeder Tag so dasteht wie
gewünscht, und sagt es, wenn nicht.

### Stundenplan aus Sdui (freiwillig)

Wer Sdui nicht nutzt, sieht davon nur einen Eintrag in den Einstellungen.
Eingerichtet wird er unter Einstellungen → **Stundenplan (Sdui)** →
„Einrichten …": Schule (die Login-Adresse `sdui.app/<schule>/login` oder nur
das Kürzel), E-Mail und Passwort, dann „Verbinden". Danach wählt man unter
„Erinnern an" die Fächer, an die erinnert werden soll, z. B. Sport und
Schwimmen.

* **Auf der Startseite** bekommt jeder Tag eine Zeitleiste: eine gleich breite
  Zelle je Schulstunde mit dem Fachkürzel (einheitlich groß, höchstens drei
  Zeichen), ausgewählte Fächer dunkel. Freistunden bleiben als Lücke stehen.
* **Beim täglichen Prüfen** schaut die App in den Plan des nächsten Schultags
  (freitags: Montag) und meldet sich mit „Morgen Sport — 1.–2. Stunde", wenn
  ein ausgewähltes Fach ansteht. Die Meldung hat einen eigenen Kanal und lässt
  sich getrennt von der Essenserinnerung abschalten.
* Lehnt Sdui die Anmeldung ab, meldet die App das einmal und versucht es erst
  nach erneutem Speichern wieder — Fehlversuche könnten das Konto sperren.

Nicht bekannt ist, wie Sdui Ausfall und Vertretung kennzeichnet; die App
gleicht nur Fachnamen ab und hängt Hinweise zur Stunde an. Bei Wahlfächern in
derselben Stunde (z. B. Lebenskunde / Religion) weiß Sdui nicht, welches das
Kind besucht.

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
3. Dann blockiert Google Play Protect die Installation. **Der große Knopf ist
   der falsche** — siehe den nächsten Abschnitt.
4. App öffnen, Kundennummer und Passwort des Bestellsystems eintragen,
   Benachrichtigungen erlauben.

Wer Updates automatisch haben will, kann [Obtainium](https://github.com/ImranR98/Obtainium)
benutzen und dieses Repository als Quelle eintragen.

**Voraussetzung:** Android 8.0 oder neuer.

### „App wurde zum Schutz deines Geräts blockiert"

<img src="docs/play-protect-blockiert.jpg" alt="Google Play Protect blockiert die Installation" width="320">

Hier hört es für die meisten auf, und das ist kein Zufall: Der große weiße
Knopf heißt **„Ok"** und bricht ab. Weiter geht es nur über die unscheinbare
Zeile darüber, **„Trotzdem installieren"**.

Der Dialog klingt nach einem Fund, ist aber keiner. Er sagt selbst, woran es
liegt: *„Play Protect kennt von diesem Entwickler noch keine anderen Apps."*
Google hat diesen Signierschlüssel schlicht noch nie gesehen. Bei einem
privaten Projekt mit genau einer App bleibt das auch so — die Meldung
verschwindet nicht, wenn die App bekannter wird.

Wer sich darauf nicht verlassen mag, muss es auch nicht: Der Abschnitt
[Echtheit prüfen](#echtheit-prüfen) zeigt, wie sich nachrechnen lässt, dass die
Datei tatsächlich aus diesem Projekt stammt. Das ist die belastbarere Auskunft
als jede Warnung — und die einzige, die auch etwas wert ist, wenn dir jemand
eine APK weiterreicht, die nicht von hier kommt.

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
* **Sdui-Zugangsdaten** (nur wenn eingerichtet) liegen getrennt davon im selben
  privaten Bereich und gehen ausschließlich an `api.sdui.app`, über HTTPS.
  „Sdui entfernen" löscht sie samt Stundenplan.
* **Die App braucht keinen Server dieses Projekts.** Niemand außer dir und dem
  Bestellsystem sieht irgendetwas. (Nur die [Web-Version](#web-version-für-iphone-und-andere-test)
  nutzt einen Server, und der sieht ausschließlich Push-Abo und Uhrzeit.)
* **Keine Statistik, keine Werbung, keine Fremdbibliotheken zur Auswertung.**

Die App fordert diese Berechtigungen an:

| Berechtigung | Wofür |
|---|---|
| `INTERNET` | das Bestellsystem (und ggf. Sdui) abfragen |
| `POST_NOTIFICATIONS` | die Erinnerung anzeigen |
| `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`, `FOREGROUND_SERVICE` | bringt Androids WorkManager mit, um die Prüfung im Hintergrund einzuplanen und einen Neustart zu überstehen |

## Stand

Gegen das echte System geprüft: Anmeldung, Abruf, Auswertung, Anzeige und die
Erinnerung selbst — inklusive eines Tests mit einer absichtlich stornierten
Bestellung. Bestellen, Um- und Abbestellen aus der App sowie Anmeldung und
Stundenplan bei Sdui sind an einem echten Konto ausprobiert.

Bis 0.1.0 hat der Hintergrundlauf **nie** ausgelöst, solange die App
geschlossen war: sie hat sich den geplanten Job beim Prozessstart selbst
gelöscht. Weil ein ausgefallener Lauf von außen aussieht wie „alles bestellt",
ist das monatelang nicht aufgefallen. Seit 0.1.1 ist die Ursache behoben, und
die App sagt es selbst, wenn der letzte Lauf überfällig ist oder
Benachrichtigungen ausgeschaltet sind.

Ehrlich dazu, was **nicht** geprüft ist:

* Wie zuverlässig der Hintergrundlauf über Wochen auslöst. Manche Hersteller
  (Xiaomi, Huawei, teils Samsung) beenden Hintergrundarbeit aggressiv. Falls die
  Erinnerung ausbleibt: Einstellungen → Apps → happy sunshine → Akku →
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

**Web-Version** (`web/`, Server in `server/`): Mit Handy-User-Agent liefert
`/Mealplan/Weekplan` auch mit `year`/`week` nur die Tagesansicht von heute
(`id="dayplan"`, Bestellschluss als `data-readonly="true"`); geladen wird dann
je Tag über `/Mealplan/WeekplanMobile?date=`. Kaltverpflegung sperrt IBS5 dort
nur im eigenen Seiten-JS (Name enthält M5, KV oder Kaltverpflegung) — die
Web-Version übernimmt diese Regel. CORS gibt IBS5 frei (`Allow-Origin: *`);
der Preflight auf `/Login/Login` ohne `Accept-Language` bekommt allerdings 302,
deshalb schickt der Login kein `X-Requested-With` und bleibt eine einfache
Anfrage ohne Preflight.

IBS5 ist eine ASP.NET-Anwendung mit einer kleinen JSON-/Bearer-Token-API, die
das eigene Web-Frontend benutzt. Dieses Projekt spricht dieselbe:

```
POST /ibs5/Login/Login
     identifierValue=<Kundennummer>&secretValue=<Passwort>
     &identifierType=0&secretType=0
  -> {"token": …, "name1": …, "institutionName1": …}

GET  /ibs5/Mealplan/Weekplan?year=&week=     Authorization: Bearer <token>
```

Bestellt wird wie auf der Webseite in zwei Schritten — erst der Warenkorb, dann
das Abschicken des **ganzen** Warenkorbs:

```
POST /ibs5/Mealplan/SaveOrder   {"mealOrderQuantity": {CustomerId, ServeDate,
                                 MenuGroupId, MenuLineId,
                                 QuantityInShoppingCart, ShoppingCartOrderType}}
       Typ "I" mit Menge 1  = bestellen (bei bestelltem Tag: umbestellen,
                              der Server legt die Abbestellung selbst dazu)
       Typ "D" mit Menge −1 = abbestellen
POST /ibs5/Mealplan/ClearCart   {"mealOrderQuantity": {CustomerId, ServeDate, MenuGroupId}}
POST /ibs5/Cart/Order           null
```

Sdui (`api.sdui.app/v1`, ebenfalls JSON mit Bearer-Token, nur lesend):

```
POST /auth/login                          {"identifier", "password", "slink"}
GET  /users/self                          -> child_pivot[].user_id
GET  /timetables/users/<id>/timetable?begins_at=YYYY-MM-DD&ends_at=YYYY-MM-DD
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

## Entstehung

Große Teile dieses Codes sind im Dialog mit einem KI-Assistenten entstanden.
Entwurf, Prüfung und Verantwortung liegen bei mir: Die Logik in `:core` ist
durch Tests abgedeckt, gegen echte Antworten des Bestellsystems kalibriert und
auf einem Gerät erprobt.

Dass das nicht vor Fehlern schützt, steht weiter oben unter [Stand](#stand):
Bis 0.1.0 hat der Hintergrundlauf überhaupt nicht ausgelöst. Erwähnt sei die
Entstehung, weil dieses README auch sonst sagt, worauf man sich nicht verlassen
soll. Wer etwas findet, das daneben liegt, möge es melden; das gilt hier wie
bei jedem anderen Code.

## Danke sagen

Das Projekt ist ein Nebenher und kostet nichts. Wer trotzdem etwas dalassen
möchte: **[paypal.me/LorenzThomschke](https://paypal.me/LorenzThomschke)** —
in der App liegt derselbe Link hinter dem kleinen Herz.

Es ist ein Trinkgeld, keine Bezahlung: Es wird nichts freigeschaltet, und ohne
Spende fehlt nichts. Wer die Wahl hat, schickt es als „Freunde und Familie" —
dann bleiben die Gebühren aus, und es ist auch das, was es ist.

## Lizenz

MIT — siehe [LICENSE](LICENSE).
