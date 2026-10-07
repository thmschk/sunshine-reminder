*satt … theoretisch.*

*(früher „immerhin.satt“ und „happy sunshine“, bis 0.1.20 „sunshine reminder“ — das Repository heißt weiter so)*

Erinnert auf dem Handy daran, wenn im Schulessen-Bestellsystem **IBS5**
(`ibs.sunshine-catering.de`) für die nächsten Tage nichts bestellt ist — und
bestellt, bestellt um oder bestellt ab direkt aus der [Web-App](#web-version).
Sie läuft im Browser auf iPhone und Android; für die Erinnerung weckt ein
kleiner Server das Gerät, ohne die IBS5-Zugangsdaten zu kennen.

> **Die Android-App ist eingestellt.** Es gab bis Oktober 2026 eine eigene
> Android-App. Sie wird nicht mehr weiterentwickelt, ihr Code liegt in der
> Git-Historie (zuletzt in Commit `6160aed`), die letzte Fassung unter
> [Releases](../../releases/latest). Installierte Apps laufen weiter, bekommen
> aber keine Updates mehr.

> **Kein offizielles Produkt.** Dieses Projekt steht in keinerlei Verbindung zu
> Sunshine Catering, zum Hersteller von IBS5 oder zur Sdui GmbH. Es benutzt
> dieselben Schnittstellen wie deren Webseiten, mit den Zugangsdaten des
> jeweiligen Nutzers. Bestellt wird nur, wenn man ausdrücklich Gerichte wählt
> und bestätigt — von selbst bestellt oder ändert nichts.
> Sdui wird nur gelesen. Die Anbieter können ihre Webseiten jederzeit ändern;
> dann funktioniert es nicht mehr. Nutzung auf eigene Verantwortung.

## Web-Version

Die Web-Version wird gerade erprobt. Die Adresse folgt, sobald sie allgemein
offen ist.

* Übersicht der nächsten Tage, bestellen, umbestellen, abbestellen. Sie spricht dafür **direkt aus dem Browser** mit
  dem Bestellsystem.
* Für die Erinnerung weckt ein kleiner Server das Gerät werktags zur gewählten
  Uhrzeit mit einer leeren Push-Nachricht. Geprüft wird dann **auf dem Gerät**.
  Der Server kennt weder die IBS5-Zugangsdaten noch den Bestellstand. Für die
  Erinnerung speichert er nur das Push-Abo und die Uhrzeit. Nur wer Sdui dazunimmt,
  schickt dessen Anmeldung und Abrufe durch ihn (siehe
  [unten](#was-der-server-sieht-und-speichert)).
* Jeder Weckruf zeigt eine Meldung, auch wenn alles bestellt ist — dann still,
  ohne Ton. Browser und vor allem iOS verlangen das, sonst kündigen sie das Abo.
* Zugangsdaten liegen verschlüsselt im Speicher des Browsers, mit einem
  Schlüssel, den der Browser erzeugt und nicht herausgibt. Das schützt davor,
  dass jemand die Speicherdatei kopiert und ausliest, etwa aus einem Backup.
  Gegen Schadcode, der im Namen dieser Seite läuft, hilft es nicht. Das
  IBS5-Passwort muss gespeichert bleiben, weil sich die tägliche Prüfung ohne
  dich anmeldet.
* Wer mag, holt sich den **Stundenplan aus Sdui** dazu — siehe
  [unten](#stundenplan-aus-sdui-in-der-web-version).

### Architektur

Was nach dem Eingeben der Zugangsdaten passiert:

1. **Anmelden (auf dem Handy).** Die Seite schickt Kundennummer und Passwort
   direkt vom Handy an IBS5, nicht über unseren Server. IBS5 antwortet mit einem
   Token für die weiteren Abfragen. Mit „Auf diesem Gerät merken“ legt die Seite
   die Zugangsdaten verschlüsselt im Speicher des Browsers ab (IndexedDB), mit
   einem Schlüssel, den der Browser erzeugt und nicht herausgibt — ebenso den
   Token, damit nicht jeder Aufruf neu anmeldet. Ist er abgelaufen, meldet sich
   die Seite einmal neu an.
2. **Übersicht laden (auf dem Handy).** Mit dem Token fragt die Seite den
   Speiseplan bei IBS5 ab — auf dem Handy erst die Bestellhistorie für alle
   bestellten Tage auf einmal, dann nur für die übrigen Tage je eine Anfrage,
   nacheinander mit kurzen Pausen — und zeigt, welche Tage bestellt, offen oder
   zu spät sind. Ist
   Sdui eingerichtet, kommt der Stundenplan über unseren Server dazu, der die
   Anfrage nur an Sdui weiterreicht.
3. **Erinnerung einschalten (einmalig).** Der Browser erzeugt ein Push-Abo, eine
   zufällige Adresse beim Push-Dienst von Google bzw. Apple. Die Seite schickt
   nur dieses Abo und die Uhrzeit an unseren Server.
4. **Jeden Werktag zur gewählten Zeit** läuft der Weckruf so:

   ```mermaid
   sequenceDiagram
       participant S as Unser Server
       participant P as Push-Dienst (Google/Apple)
       participant H as Handy (Service Worker)
       participant I as IBS5
       S->>P: leerer Weckruf an die Push-Adresse
       P->>H: zustellen
       Note over H: liest die verschlüsselten<br/>Zugangsdaten vom Gerät
       H->>I: anmelden, Speiseplan abfragen
       I-->>H: Bestellstand
       Note over H: Meldung „2 Tage offen“<br/>oder still „satt … theoretisch ✓“
   ```

   Der Server erfährt dabei nicht, ob bestellt ist. Er weiß nur, dass ein
   Weckruf an eine anonyme Push-Adresse ging.

5. **Bestellen (nur auf Klick).** Das gewählte Essen landet bei IBS5 im
   Warenkorb. Abgeschickt wird nur, wenn dort genau die Auswahl liegt, danach
   prüft die Seite im Speiseplan nach. Auch das läuft direkt vom Handy zu IBS5.

Kundennummer, IBS5-Passwort und Bestellungen erreichen den Server nie. Er sieht
das Push-Abo mit Uhrzeit und, nur bei Sdui, die durchgereichten Sdui-Anfragen.

<details>
<summary><b>Was ist ein Push-Abo?</b></summary>

Stell es dir als Postfach für dein Handy vor, das bei Google bzw. Apple steht.
Dein Browser richtet es beim Einschalten der Erinnerung ein und gibt unserem
Server den Schlüssel zum Einwerfen, sonst niemandem. Was eingeworfen wird, kann
nur dein Handy öffnen. Das Postfach verschwindet, sobald du die Erinnerung
ausschaltest, die Benachrichtigungen entziehst oder die App löschst.

</details>

### Einrichten

1. **Installieren**
   * **iPhone** (Safari): Teilen → „Zum Home-Bildschirm“
   * **Android** (Chrome): ⋮ → „App installieren“ — nicht „Verknüpfung erstellen“
2. **Über das neue Symbol öffnen**, nicht im Browser-Tab.
3. **Anmelden** mit Kundennummer und Passwort von IBS5.
4. **Erinnerung einschalten:** ⚙ → Uhrzeit wählen → „Erinnerung einschalten“.
5. **Ausprobieren:** ⚙ → „Jetzt testen“.
6. **Stundenplan (freiwillig):** ⚙ → „Stundenplan (Sdui)“ → „Einrichten …“,
   dann Schule, E-Mail und Passwort von Sdui. Danach unter „Erinnern an“ die
   Fächer wählen, an die am Vortag erinnert werden soll.

> [!NOTE]
> Auf dem **iPhone** gibt es Erinnerungen nur in der installierten Fassung,
> nicht im normalen Safari-Tab. Auf **Android** müssen Benachrichtigungen für
> Chrome selbst erlaubt sein (Einstellungen → Apps → Chrome →
> Benachrichtigungen), sonst fragt Chrome gar nicht erst.

### Stundenplan aus Sdui in der Web-Version

Mit eingerichtetem Sdui bekommt jeder Tag auf der Startseite eine Zeitleiste:
eine Zelle je Schulstunde mit dem Fachkürzel, gewählte Fächer dunkel,
Freistunden als Lücke. Steht am nächsten Schultag ein gewähltes Fach an, kommt
nach der Essenserinnerung eine zweite Meldung, etwa „Morgen Sport — 1.–2. Stunde“.

Anders als IBS5 lässt Sdui keine Zugriffe von fremden Webseiten zu. Anmeldung
und Abruf laufen deshalb über den Server, der sie nur durchreicht:

| | |
|---|---|
| Was durchläuft | beim Einrichten einmal E-Mail und Passwort, danach bei jedem Abruf der Zugangsschlüssel (Token) und der Stundenplan |
| Was der Server speichert | nichts. Für die Begrenzung hält er die IP-Adresse bis zu zehn Minuten im Arbeitsspeicher. |
| Was auf dem Gerät bleibt | nur der Token, verschlüsselt — er gilt ein Jahr, danach einmal neu verbinden. Das Passwort wird nirgends gespeichert. |
| Was durchgelassen wird | nur Anmeldung, eigenes Konto, Kind und Stundenplan, höchstens 20 Aufrufe in 10 Minuten je Absender |
| Wie oft abgerufen wird | höchstens alle sechs Stunden, der Plan liegt dazwischen auf dem Gerät |


### Was der Server sieht und speichert

<details>
<summary>Ausklappen: Seite laden, Erinnerung, Sdui, Selbstprüfung</summary>

| Anlass | sieht | speichert | wie lange |
|---|---|---|---|
| Seite laden | IP-Adresse, angefragte Datei | nichts; Zugriffs- und Fehlerprotokolle einzelner Anfragen sind abgeschaltet | – |
| Erinnerung einschalten | IP-Adresse, Push-Abo | Push-Adresse und -Schlüssel, Uhrzeit, Wochentage, Zeitzone, Zufallsverschiebung, Tag des letzten Weckrufs; IP nur im Arbeitsspeicher für die Begrenzung auf 10 neue Abos je Stunde | Abo bis zum Ausschalten oder bis der Push-Dienst es als ungültig meldet; IP eine Stunde |
| Sdui (nur wenn eingerichtet) | IP-Adresse, beim Einrichten E-Mail und Passwort, danach Token, Kind-ID im Pfad, Stundenplan | nichts; IP nur im Arbeitsspeicher für die Begrenzung auf 20 Aufrufe | IP zehn Minuten |
| tägliche Selbstprüfung | – (fragt selbst bei IBS5 und Sdui an, ohne Nutzerdaten) | Ergebnis unter `/api/health` | bis zur nächsten Prüfung |

Name, Kundennummer, Bestellungen und das IBS5-Passwort erreichen den Server nie.

</details>

**Grenzen:** Handy-Browsern liefert IBS5 statt des Wochenplans nur eine
Tagesansicht, also eine Anfrage je Tag. Zu viele Anfragen in kurzer Zeit
quittiert IBS5 mit einer Sperre der IP-Adresse (dann geht auch die normale
Bestellseite eine Weile nicht). Die Web-Version fragt deshalb sparsam: Übersicht
und Erinnerung holen die bestellten Tage mit einer Anfrage aus der
Bestellhistorie und laden nur Tage ohne Bestellung einzeln. Die Bestellansicht
braucht alle Tage einzeln, lädt Woche für Woche, zeigt jede sofort und hört auf,
wenn Montag und Dienstag einer Woche noch keinen Speiseplan haben. Tage
nacheinander mit Pausen und etwas Zufall; geladene Tage bleiben auf dem Gerät
gespeichert (nach Bestellschluss bis zum Tag selbst, ohne Angebot eine Stunde,
andere Tage ab nächster Woche sechs Stunden, sonst zehn Minuten; widerspricht
die Bestellhistorie, wird neu geladen), die Erinnerung prüft höchstens die
nächsten fünf Schultage, und insgesamt gehen höchstens 150 Anfragen je Stunde
und Gerät an IBS5 (CORS-Vorabfragen mitgezählt). Kommt beim Anmelden ein 429 oder 403, ruht die
App drei Stunden und sagt das, statt die Sperre durch Wiederholungen zu
verlängern. Kommt gar keine Antwort (so sieht die Sperre im Browser aus, aber
auch ein Aussetzer), ruht sie erst 15 Minuten, beim nächsten Mal binnen sechs
Stunden drei. Wechselt das Gerät das Netz (WLAN ↔ Mobilfunk, auf Android
erkennbar), endet die Pause, denn die Sperre gilt der IP-Adresse; „Trotzdem
jetzt versuchen“ gibt es auf der Übersicht und beim Anmelden. Eine Weiterleitung
oder 401/403 beim Anmelden gilt als Störung, nicht als falsches Passwort. Die Erinnerung auf dem
iPhone ist noch nicht ausprobiert.

**Damit Schweigen auffällt:** Die Startseite zeigt, wann die Erinnerung zuletzt
erfolgreich geprüft hat, und warnt, wenn das über vier Tage her ist. Jeder
Fehler beim Weckruf führt zu einer Meldung. Der Server prüft zudem jeden Morgen,
ob IBS5 und Sdui sich noch so verhalten, wie die Web-Version es braucht, und
meldet Abweichungen an den Betreiber.

**Integrität:** Die Web-Version lädt ihren Code bei jedem Aufruf vom Server. Wer den Server kontrolliert, könnte also anderen Code
ausliefern. Die Seite lädt keine fremden Skripte, und eine strenge
Content-Security-Policy erlaubt nur Code und Verbindungen der eigenen Adresse
und von IBS5. Ob der ausgelieferte Code dem Repository entspricht, lässt sich
nachprüfen:

```sh
for f in index.html app.js ibs.js idb.js guard.js session.js sdui.js sw.js style.css; do
  curl -s "https://<adresse>/$f" | cmp -s - "web/$f" && echo "ok    $f" || echo "ANDERS $f"
done
```


Die Web-Version spricht direkt aus dem Browser mit IBS5. Das geht nur, weil
IBS5 solche Zugriffe von anderen Webseiten derzeit zulässt. Ändert der
Hersteller das, funktioniert die Web-Version nicht mehr, bis sie umgebaut ist.
Die Python-Variante ist davon nicht betroffen.

Warum keine iPhone-App? iOS entscheidet selbst, ob und wann eine App im
Hintergrund rechnen darf. Eine Prüfung mit Frist kann Stunden zu spät kommen
oder ausfallen. Eine Erinnerung empfangen kann das iPhone aber tadellos — nur
auslösen muss sie jemand anders. Das übernimmt hier der Server. Wer ganz ohne
fremden Server auskommen will, nimmt die [Python-Variante](#die-python-variante)
auf einem eigenen Rechner, der ohnehin durchläuft.

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

Sdui gibt CORS nur für `https://sdui.app` frei. Der Push-Dienst reicht unter
`/api/sdui/` genau diese Aufrufe an `api.sdui.app/v1` durch:
`POST auth/login`, `GET users/self`, `GET users/<id>` und
`GET timetables/users/<id>/timetable?begins_at=&ends_at=`. Der Login liefert
einen JWT mit `expires_in` von 365 Tagen.

IBS5 ist eine ASP.NET-Anwendung mit einer kleinen JSON-/Bearer-Token-API, die
das eigene Web-Frontend benutzt. Dieses Projekt spricht dieselbe:

```
POST /ibs5/Login/Login
     identifierValue=<Kundennummer>&secretValue=<Passwort>
     &identifierType=0&secretType=0
  -> {"token": …, "name1": …, "institutionName1": …}

GET  /ibs5/Mealplan/Weekplan?year=&week=     Authorization: Bearer <token>
GET  /ibs5/Account/Orderhistory?from=&to=&search=
```

Die Bestellhistorie filtert `from`/`to` nach **Bestelldatum**, nicht nach
Liefertag. Ab- und Umbestellungen stehen als eigene Zeilen mit Menge −1, auch
„Bestellungen übertragen“ des Caterers (z.B. Umbuchung auf Kaltverpflegung);
saldiert je Liefertag und Menülinie ergibt sich der Bestellstand. Desktop
bekommt eine Tabelle (`id="order-history-table"`), Handy-Browser Karten
(`class="rechnung"`) mit denselben Feldern. CORS ist freigegeben.

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
Entwurf, Prüfung und Verantwortung liegen bei mir: Die Logik ist durch Tests
abgedeckt (`web/tests/`), gegen echte Antworten des Bestellsystems kalibriert und
auf Geräten erprobt.

Dass das nicht vor Fehlern schützt, hat die frühere Android-App gezeigt: Bis
0.1.0 hat ihr Hintergrundlauf überhaupt nicht ausgelöst. Erwähnt sei die
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
