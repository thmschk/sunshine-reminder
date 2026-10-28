# theoretisch satt

*satt … theoretisch.*

Erinnert auf dem Handy daran, wenn im Schulessen-Bestellsystem **IBS5**
(`ibs.sunshine-catering.de`) für die nächsten Tage nichts bestellt ist — und
bestellt, bestellt um oder bestellt ab direkt aus der [Web-App](#web-version).
Sie läuft im Browser auf iPhone und Android; für die Erinnerung weckt ein
kleiner Server das Gerät, ohne die IBS5-Zugangsdaten zu kennen.

**Adresse: <https://sunshine.thomschke.info>** · [Datenschutz](https://sunshine.thomschke.info/datenschutz.html)

> **Die Android-App ist eingestellt.** Es gab bis Oktober 2026 eine eigene
> Android-App. Sie wird nicht mehr weiterentwickelt, ihr Code liegt in der
> Git-Historie (zuletzt in Commit `6160aed`), die letzte Fassung unter
> [Releases](../../releases/latest). Sie funktioniert womöglich nicht mehr
> richtig, seit IBS5 am 09.10.2026 sein Layout geändert hat — bitte die
> Web-Version nehmen.

> **Kein offizielles Produkt.** Dieses Projekt steht in keinerlei Verbindung zu
> Sunshine Catering, zum Hersteller von IBS5 oder zur Sdui GmbH. Es benutzt
> dieselben Schnittstellen wie deren Webseiten, mit deinen Zugangsdaten.
> Bestellt wird nur, wenn du ausdrücklich Gerichte wählst und bestätigst — von
> selbst bestellt oder ändert die App nichts. Sdui wird nur gelesen. Die
> Anbieter können ihre Webseiten jederzeit ändern; dann funktioniert es nicht
> mehr. Nutzung auf eigene Verantwortung.

## Was du wissen solltest

* **Dein IBS5-Passwort liegt auf dem Handy**, verschlüsselt im Browser, weil die
  tägliche Prüfung sich ohne dich anmeldet. Den Code liefert bei jedem Öffnen
  der Server aus — du vertraust also dem Betreiber (mir). Wie man nachprüft,
  was ausgeliefert wird, steht unter [Integrität](#integrität).
* **Bestellungen kosten Geld.** Maßgeblich ist, was in IBS5 steht. Meldet die
  App „nicht bestätigt“, bitte auf der Bestellseite von IBS5 nachsehen.
* **Zu viele Abfragen kann IBS5 mit einer Sperre deiner IP-Adresse
  beantworten**; dann geht auch die normale Bestellseite eine Weile nicht. Die
  App fragt deshalb sparsam und hält bei Verdacht von selbst inne.
* **Meldungen erscheinen auf dem Sperrbildschirm** mit Vornamen, Gerichten und
  gegebenenfalls Schulfächern. Wer das nicht will, stellt in den
  Handy-Einstellungen die Vorschau für diese App ab.
* **iPhone ab iOS 16.4**, und Erinnerungen dort nur in der zum Home-Bildschirm
  hinzugefügten Fassung.

## Web-Version

* Übersicht von heute und den nächsten Tagen, bestellen, umbestellen,
  abbestellen. Sie spricht dafür **direkt aus dem Browser** mit dem
  Bestellsystem. Heute steht abgehoben obenan, nur zum Lesen.
* **Eigene Termine** (＋ oben): Ausflug, Sportfest … mit Erinnerung 1, 2, 3 oder
  7 Tage vorher, in derselben Meldung wie das Essen. Mit „kein Schulessen an dem
  Tag“ gilt der Tag nicht als offen, und ist dort doch bestellt, erinnert sie ans
  Abbestellen. Die Termine liegen nur auf dem Gerät, nicht auf dem Server.
* **Berliner Schulferien** stehen an den Tagen dran. Kurz vor allen Ferien
  (Vorwarnzeit plus zwei Tage) fragt ein Dialog je Kind und Ferienwoche, ob dort
  Essen bestellt wird (etwa im Hort); in Wochen mit „nein“ ist ein offener
  Ferientag kein Alarm, ändern unter ⚙ → Ferien. Ohne Antwort wird erinnert wie
  sonst. Die Bestellansicht hört an einer leeren Ferienwoche nicht auf. Die
  Termine liefert die Seite selbst mit (`web/ferien.json`, aus der
  OpenHolidaysAPI); fremde Dienste fragt sie dafür nicht.
* Für die **Erinnerung** weckt ein kleiner Server das Gerät werktags zur
  gewählten Uhrzeit oder bis zu einer halben Stunde danach (verteilt, damit
  nicht alle Geräte gleichzeitig bei IBS5 anfragen). Geprüft wird dann **auf dem
  Gerät**; der Server kennt weder die IBS5-Zugangsdaten noch den Bestellstand
  (siehe [unten](#was-der-server-sieht-und-speichert)).
* **Morgens, was es heute gibt** (⚙ → „Morgens: Essen von heute“, Standard
  7:00 Uhr, bis zu 9 Minuten später, aus bis zum Einschalten): an denselben
  Tagen wie die Erinnerung ein zweiter Weckruf, das Gerät liest dann nur die
  Bestellhistorie. Ist heute nichts bestellt, kommt „Brot einpacken“; an Tagen
  ohne Schulessen (Termin, Ferienwoche ohne Essen, kein Angebot) „Heute kein
  Schulessen“, auf Android still. Für die Ferien einfach abschalten oder Tage
  abwählen.
* Jeder Weckruf zeigt eine Meldung, auch wenn alles bestellt ist. Browser und
  vor allem iOS verlangen das, sonst kündigen sie das Abo. Auf Android kommt
  „alles bestellt“ still und ersetzt die Meldung vom Vortag; auf dem iPhone
  geht das nicht (Safari kennt weder stille noch ersetzende Meldungen), dort
  klingelt jede. Wem das zu viel ist: unter ⚙ → „Tage“ seltener wecken lassen.
* Zugangsdaten liegen verschlüsselt im Speicher des Browsers, mit einem
  Schlüssel, den der Browser erzeugt und nicht herausgibt. Das schützt davor,
  dass jemand die Speicherdatei kopiert und ausliest, etwa aus einem Backup.
  Gegen Schadcode, der im Namen dieser Seite läuft, hilft es nicht.
* Wer mag, holt sich den **Stundenplan aus Sdui** dazu — siehe
  [unten](#stundenplan-aus-sdui-in-der-web-version).

### Architektur

Was nach dem Eingeben der Zugangsdaten passiert:

1. **Anmelden (auf dem Handy).** Die Seite schickt Kundennummer und Passwort
   direkt vom Handy an IBS5, nicht über unseren Server. IBS5 antwortet mit einem
   Token für die weiteren Abfragen. Mit „Auf diesem Gerät merken“ legt die Seite
   Zugangsdaten und Token verschlüsselt im Speicher des Browsers ab (IndexedDB,
   siehe oben), damit nicht jeder Aufruf neu anmeldet. Ist der Token abgelaufen,
   meldet sich die Seite einmal neu an.
2. **Übersicht laden (auf dem Handy).** Mit dem Token fragt die Seite bei IBS5
   erst die Bestellhistorie für alle bestellten Tage auf einmal ab, dann nur für
   die übrigen Tage den Speiseplan, je Tag eine Anfrage, nacheinander mit kurzen
   Pausen — und zeigt, welche Tage bestellt, offen oder zu spät sind. Ist Sdui
   eingerichtet, kommt der Stundenplan über unseren Server dazu, der die Anfrage
   nur an Sdui weiterreicht.
3. **Erinnerung einschalten (einmalig).** Der Browser erzeugt ein Push-Abo, eine
   zufällige Adresse beim Push-Dienst von Google, Apple oder Mozilla. Die Seite
   schickt nur dieses Abo und die Uhrzeit an unseren Server.
4. **Jeden gewählten Werktag** läuft der Weckruf so (oben zur Einordnung noch
   einmal Schritt 3):

   ```mermaid
   %%{init: {"sequence": {"mirrorActors": false}}}%%
   sequenceDiagram
       participant S as Unser Server
       participant P as Push-Dienst (Google/Apple/Mozilla)
       participant H as Handy (Service Worker)
       participant I as IBS5
       Note over S,H: einmalig: Erinnerung einschalten
       H->>S: Push-Abo und Uhrzeit
       Note over S,I: gewählte Uhrzeit + 0–29 min
       S->>P: Weckruf {"t":"check"} an die Push-Adresse
       P->>H: zustellen
       Note over H: liest Zugangsdaten und Token<br/>verschlüsselt vom Gerät
       opt nur wenn der Token nicht mehr gilt
           H->>I: anmelden
       end
       H->>I: Bestellhistorie, dann Speiseplan der offenen Tage
       I-->>H: Bestellstand
       Note over H: Meldung „2 Tage offen“<br/>oder still „alles bestellt“
       opt nur wenn Sdui eingerichtet und Fächer gewählt
           Note over H: Stundenplan meist aus dem<br/>Gerätespeicher (bis 6 h alt)
           H->>S: sonst Stundenplan abfragen
           Note over S: reicht nur an Sdui durch
           S-->>H: Stundenplan
           Note over H: zweite Meldung „Morgen Sport …“
       end
       Note over S,I: falls eingeschaltet: Morgenzeit + 0–9 min
       S->>P: Weckruf {"t":"today"}
       P->>H: zustellen
       H->>I: Bestellhistorie (ggf. Speiseplan von heute)
       Note over H: „Heute gibt's …“ oder „Brot einpacken“
   ```

   Der Server erfährt dabei nicht, ob bestellt ist. Er weiß nur, dass ein
   Weckruf an eine anonyme Push-Adresse ging.

5. **Bestellen (nur auf Klick).** Vor dem ersten Eingriff lädt die Seite die
   betroffenen Tage frisch; hat sich dort inzwischen etwas geändert, schickt sie
   nichts ab. Liegt im Warenkorb von IBS5 schon etwas an anderen Tagen (etwa auf
   der Webseite hineingelegt und vergessen), zeigt die Rückfrage es an: mitbestellen
   oder verwerfen. Dann legt die Seite die Auswahl in den Warenkorb, zählt nach,
   ob genau das darin liegt, und schickt ab. Danach prüft sie im Speiseplan, ob
   jeder Tag mit Menge 1 so bestellt ist wie gewählt; sonst meldet sie „nicht
   bestätigt“. Auch das läuft direkt vom Handy zu IBS5.

<details>
<summary><b>Was ist ein Push-Abo?</b></summary>

Stell es dir als Postfach für dein Handy vor, das bei Google, Apple oder Mozilla
steht. Dein Browser richtet es beim Einschalten der Erinnerung ein und gibt
unserem Server den Schlüssel zum Einwerfen, sonst niemandem. Was eingeworfen
wird, kann nur dein Handy öffnen. Das Postfach verschwindet, sobald du die
Erinnerung ausschaltest, die Benachrichtigungen entziehst oder die App löschst.

</details>

### Einrichten

1. **Installieren**
   * **iPhone** (Safari, ab iOS 16.4): Teilen → „Zum Home-Bildschirm“
   * **Android** (Chrome): Knopf „Als App installieren“ auf der Seite, sonst
     ⋮ → „App installieren“ — nicht „Verknüpfung erstellen“
   * Aus Instagram, WhatsApp & Co. geöffnet: erst „Im Browser“ bzw. „In Safari
     öffnen“ — deren eingebaute Browser können nicht installieren.
   * Für QR-Codes und Links: `…/?installieren` zeigt die Anleitung zuerst.
2. **Über das neue Symbol öffnen**, nicht im Browser-Tab.
3. **Anmelden** mit Kundennummer und Passwort von IBS5.
   Geschwister mit eigener Kundennummer: ⚙ → „Kind hinzufügen“. Die Übersicht
   bekommt dann oben einen Reiter je Kind, die Erinnerung prüft alle Kinder
   nacheinander und meldet sich mit einer gemeinsamen Nachricht.
4. **Erinnerung:** ist beim Anmelden schon angehakt („Werktags um 17:00 Uhr
   erinnern“), der Browser fragt dann nach der Erlaubnis. Uhrzeit ändern oder
   ausschalten unter ⚙.
   Darunter lässt sich „Morgens: Essen von heute“ zuschalten.
   Unter „Tage“ lassen sich Wochentage abwählen. Jeder Weckruf prüft bis zum
   nächsten, es fällt also kein Tag durch; ein offener Tag fällt nur später auf.
5. **Ausprobieren:** ⚙ → „Jetzt testen“.
6. **Stundenplan (freiwillig):** ⚙ → „Stundenplan (Sdui)“ → „Stundenplan
   einrichten“, dann Schule, E-Mail und Passwort von Sdui. Danach unter
   „Erinnern an“ die Fächer wählen, an die am Vortag erinnert werden soll.

> [!NOTE]
> Auf dem **iPhone** gibt es Erinnerungen nur in der installierten Fassung,
> nicht im normalen Safari-Tab. Auf **Android** müssen Benachrichtigungen für
> Chrome selbst erlaubt sein (Einstellungen → Apps → Chrome →
> Benachrichtigungen), sonst fragt Chrome gar nicht erst.

### Wieder entfernen

1. In der App ⚙ → „Abmelden und alles löschen“. Das löscht Zugangsdaten,
   Schlüssel, Bestellstand, Termine und Stundenplan auf dem Gerät und meldet die
   Erinnerung beim Server ab.
2. Dann das Symbol vom Home-Bildschirm entfernen (Android: App deinstallieren).
3. Ist das Handy verloren oder gestohlen, das Passwort in IBS5 ändern und, falls
   eingerichtet, auch das von Sdui: Der Sdui-Zugangsschlüssel auf dem Gerät gilt
   sonst bis zu einem Jahr.

### Stundenplan aus Sdui in der Web-Version

Mit eingerichtetem Sdui bekommt jeder Tag auf der Startseite eine Zeitleiste:
eine Zelle je Schulstunde mit dem Fachkürzel, gewählte Fächer dunkel,
Freistunden als Lücke. Steht am nächsten Schultag ein gewähltes Fach an, kommt
nach der Essenserinnerung eine zweite Meldung, etwa „Morgen Sport — 1.–2. Stunde“.
An Ferientagen gibt es weder Zeitleiste noch Fächermeldung. Sdui lässt sich nur
für ein Kind einrichten.

Anders als IBS5 lässt Sdui keine Zugriffe von fremden Webseiten zu. Anmeldung
und Abruf laufen deshalb über den Server, der sie nur durchreicht:

| | |
|---|---|
| Was durchläuft | beim Einrichten einmal E-Mail und Passwort, danach bei jedem Abruf der Zugangsschlüssel (Token) und der Stundenplan |
| Was der Server speichert | nichts davon (zur Begrenzung siehe [unten](#was-der-server-sieht-und-speichert)) |
| Was auf dem Gerät bleibt | der Token (verschlüsselt, gilt ein Jahr, danach einmal neu verbinden) sowie der Stundenplan der nächsten zwei Wochen und die Fächerliste (unverschlüsselt, wie Bestellstand und Termine). Das Passwort wird nirgends gespeichert. „Abmelden und alles löschen“ entfernt alles. |
| Was durchgelassen wird | nur Anmeldung, eigenes Konto, Kind und Stundenplan, höchstens 20 Aufrufe in 10 Minuten je Absender |
| Wie oft abgerufen wird | höchstens alle sechs Stunden, der Plan liegt dazwischen auf dem Gerät |

### Was der Server sieht und speichert

<details>
<summary>Ausklappen: Seite laden, Erinnerung, Sdui, Selbstprüfung</summary>

| Anlass | sieht | speichert | wie lange |
|---|---|---|---|
| Seite laden | IP-Adresse, angefragte Datei | nichts; Zugriffs- und Fehlerprotokolle einzelner Anfragen sind abgeschaltet | – |
| Erinnerung einschalten | IP-Adresse, Push-Abo | Push-Adresse und -Schlüssel, Uhrzeit, gegebenenfalls Uhrzeit der Morgenmeldung, Wochentage, Zeitzone, Zufallsverschiebung, Tag des letzten Weckrufs (je Art) | bis zum Ausschalten oder bis der Push-Dienst das Abo als ungültig meldet; nächtliche Sicherungen 14 Tage |
| Sdui (nur wenn eingerichtet) | IP-Adresse, beim Einrichten E-Mail und Passwort, danach Token, Kind-ID im Pfad, Stundenplan | nichts | – |
| Missbrauchsschutz (neue Abos, Sdui) | IP-Adresse | IP-Adresse mit Zeitpunkten, nur im Arbeitsspeicher | höchstens bis zum nächsten Neustart des Dienstes (in der Regel wöchentlich) |
| tägliche Selbstprüfung | – (fragt selbst bei IBS5 und Sdui an, ohne Nutzerdaten, und liest die eigene `ferien.json`) | Ergebnis unter `/api/health` | bis zur nächsten Prüfung |

Name, Kundennummer, Bestellungen und das IBS5-Passwort erreichen den Server nie.
Die Datenschutzerklärung steht unter
[`/datenschutz.html`](https://sunshine.thomschke.info/datenschutz.html).

</details>

**Grenzen:** IBS5 sperrt bei zu vielen Anfragen die IP-Adresse, deshalb fragt
die App sparsam, bremst sich selbst und sagt das auch. Einzelheiten unter
[Technische Notizen](#grenzen-im-detail).

**Damit Schweigen auffällt:** Die Startseite zeigt, wann die Erinnerung zuletzt
erfolgreich geprüft hat, und warnt, wenn das über vier Tage her ist. Jeder
Fehler beim Weckruf führt zu einer Meldung. Der Server prüft zudem jeden Morgen,
ob IBS5 und Sdui sich noch so verhalten, wie die Web-Version es braucht und ob
die Ferientermine noch mindestens ein halbes Jahr reichen, und meldet
Abweichungen an den Betreiber.

#### Integrität

Die Web-Version lädt ihren Code bei jedem Aufruf vom Server. Wer den Server
kontrolliert, könnte also anderen Code ausliefern. Die Seite lädt keine fremden
Skripte, und eine strenge Content-Security-Policy erlaubt nur Code und
Verbindungen der eigenen Adresse und von IBS5. Ob der ausgelieferte Code dem
Repository entspricht, lässt sich in einem aktuellen Klon nachprüfen:

```sh
git fetch
url=https://sunshine.thomschke.info
sha=$(curl -s "$url/version.txt")          # laufender Commit
git ls-tree -r --name-only "$sha" web | grep -v '^web/tests/' | while read -r f; do
  curl -s "$url/${f#web/}" | cmp -s - <(git show "$sha:$f") && echo "ok     $f" || echo "ANDERS $f"
done
```

Die Web-Version spricht direkt aus dem Browser mit IBS5. Das geht nur, weil
IBS5 solche Zugriffe von anderen Webseiten derzeit zulässt. Ändert der
Hersteller das, funktioniert die Web-Version nicht mehr, bis sie umgebaut ist.

Warum keine iPhone-App? iOS entscheidet selbst, ob und wann eine App im
Hintergrund rechnen darf. Eine Prüfung mit Frist kann Stunden zu spät kommen
oder ausfallen. Eine Erinnerung empfangen kann das iPhone aber tadellos — nur
auslösen muss sie jemand anders. Das übernimmt hier der Server.

## Technische Notizen

Betrieb und Server: [`docs/betrieb.md`](docs/betrieb.md), Sicherheitsprüfung:
[`docs/sicherheit-web.md`](docs/sicherheit-web.md).

### Grenzen im Detail

Handy-Browsern liefert IBS5 statt des Wochenplans nur eine Tagesansicht, also
eine Anfrage je Tag. Zu viele Anfragen in kurzer Zeit quittiert IBS5 mit einer
Sperre der IP-Adresse (dann geht auch die normale Bestellseite eine Weile
nicht). Die Web-Version fragt deshalb sparsam:

* Übersicht und Erinnerung holen die bestellten Tage mit einer Anfrage aus der
  Bestellhistorie und laden nur Tage ohne Bestellung einzeln.
* Die Bestellansicht braucht alle Tage einzeln, lädt Woche für Woche, zeigt jede
  sofort und hört auf, wenn Montag und Dienstag einer Woche noch keinen
  Speiseplan haben; erst drei Wochen, weitere drei je Tipp auf „Weitere Wochen
  laden“, höchstens acht.
* Tage nacheinander mit Pausen und etwas Zufall. Geladene Tage bleiben auf dem
  Gerät gespeichert: ohne Angebot eine Stunde, Tage ab nächster Woche sechs
  Stunden, sonst zehn Minuten (auch nach Bestellschluss, weil IBS5 Tage
  zeitweise sperrt). Widerspricht die Bestellhistorie, wird neu geladen.
* Die Erinnerung prüft höchstens die nächsten fünf Schultage.
* Insgesamt gehen höchstens 150 Anfragen je Stunde und Gerät an IBS5
  (CORS-Vorabfragen mitgezählt). Ist das Kontingent voll, sagt die App, dass sie
  selbst bremst, nicht IBS5. Eine Bestellung prüft vorher, ob ihre Anfragen noch
  in die Stunde passen, und läuft dann ohne Bremse durch, damit der Warenkorb nie
  halb gefüllt liegen bleibt.
* Kommt ein 429, ruht die App drei Stunden und sagt das, statt die Sperre durch
  Wiederholungen zu verlängern. Kommt beim Anmelden gar keine Antwort (so sieht
  die Sperre im Browser aus, aber auch ein Aussetzer), ruht sie erst 15 Minuten,
  beim nächsten Mal binnen sechs Stunden drei. Wechselt das Gerät das Netz
  (WLAN ↔ Mobilfunk, auf Android erkennbar), endet die Pause, denn die Sperre
  gilt der IP-Adresse; „Trotzdem jetzt versuchen“ gibt es auf der Übersicht und
  beim Anmelden.
* Ein 403 beim Anmelden heißt „Kundennummer oder Passwort falsch“ (so antwortet
  IBS5 seit dem neuen Layout vom 9. Oktober 2026), eine Weiterleitung oder 401
  gilt als Störung.

### IBS5 und Sdui

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
GET  /ibs5/Mealplan/WeekplanMobile?date=     Tagesansicht für Handy-Browser
GET  /ibs5/Account/Orderhistory?from=&to=&search=
```

Die Bestellhistorie filtert `from`/`to` nach **Bestelldatum**, nicht nach
Liefertag. Ab- und Umbestellungen stehen als eigene Zeilen mit Menge −1, auch
„Bestellungen übertragen“ des Caterers (z. B. Umbuchung auf Kaltverpflegung);
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
GET  /ibs5/Mealplan/UpdateBalanceAndCart   -> {"totalItemsInCart": …}
GET  /ibs5/cart/shoppingcart    Warenkorbseite: Datum, Gericht, Bestellart je Eintrag
POST /ibs5/Cart/Clear           null   („Alle Änderungen verwerfen“)
```

Weil `Cart/Order` immer den ganzen Warenkorb abschickt, liest die App vor der
Rückfrage dessen Inhalt. Liegt dort etwas an anderen Tagen (etwa auf der Webseite
hineingelegt und vergessen), steht es in der Rückfrage: verwerfen oder mitbestellen.
Desktop bekommt die Warenkorbseite als Tabelle, Handy-Browser als Karten
(`class="menu-mobile"`).

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

## Entstehung

Große Teile dieses Codes sind im Dialog mit einem KI-Assistenten entstanden.
Entwurf, Prüfung und Verantwortung liegen bei mir: Die Logik ist durch Tests
abgedeckt (`web/tests/`), gegen echte Antworten des Bestellsystems kalibriert und
auf Geräten erprobt.

Dass das nicht vor Fehlern schützt, hat die frühere Android-App gezeigt: Bis
0.1.0 hat ihr Hintergrundlauf überhaupt nicht ausgelöst. Erwähnt sei die
Entstehung, weil dieses README auch sonst sagt, worauf man sich nicht verlassen
soll.

## Rückmeldung und Änderungen

Fehler, Fragen und Wünsche bitte als
[GitHub-Issue](https://github.com/thmschk/sunshine-reminder/issues). Was sich
geändert hat, steht in der Commit-Historie (`git log`); ein eigenes Changelog
gibt es nicht.

## Danke sagen

Das Projekt ist ein Nebenher und kostet nichts. Wer trotzdem etwas dalassen
möchte: **[paypal.me/LorenzThomschke](https://paypal.me/LorenzThomschke)** —
in der App liegt derselbe Link hinter dem kleinen Herz.

Es ist ein Trinkgeld, keine Bezahlung: Es wird nichts freigeschaltet, und ohne
Spende fehlt nichts.

## Rechtliches

Die Software wird unentgeltlich und ohne Gewähr bereitgestellt (siehe Lizenz).
Soweit gesetzlich zulässig, hafte ich nicht für Fehlbestellungen, vergessene
oder doppelte Bestellungen und deren Kosten; maßgeblich ist allein, was in IBS5
steht. Ob die Nutzungsbedingungen von IBS5
und Sdui den Zugriff über ein fremdes Programm erlauben, ist nicht geprüft. Die
Anbieter könnten solche Zugriffe unterbinden oder deinen Zugang sperren.

## Lizenz

MIT — siehe [LICENSE](LICENSE).

## Frühere Namen

„immerhin.satt“, „happy sunshine“, bis 0.1.20 „sunshine reminder“ — das
Repository heißt weiter `sunshine-reminder`; der lokale Ordner `ibs-order-watch`.
