# ibs-order-watch

Erinnert per E-Mail, wenn im Bestellsystem **IBS5** (`ibs.sunshine-catering.de`)
für die kommenden Tage **kein Essen bestellt** ist.

Status: **Proof of Concept, gegen das echte System verifiziert** (26.08.2026):
Login, alle benutzten Endpunkte und der Wochenplan-Parser laufen end-to-end.
Was noch fehlt, steht unter *Offene Punkte*.

## Wie es funktioniert

IBS5 ist eine ASP.NET-MVC-Anwendung mit einer kleinen JSON-/Bearer-Token-API,
die das eigene Web-Frontend benutzt. Dieses Projekt spricht dieselbe API:

```
POST /ibs5/Login/Login
     identifierValue=<Kundennummer>&secretValue=<Passwort>
     &identifierType=0&secretType=0
  -> {"token": "...", "name1": ..., "institutionName1": ...}
  -> bzw. {"errorMessage": "Kundennummer und/oder Passwort ungültig"}

GET  /ibs5/Mealplan/Weekplan?year=&week=      Authorization: Bearer <token>
GET  /ibs5/Mealplan/WeekplanMobile?date=
GET  /ibs5/Account/Orderhistory?from=&to=&search=
GET  /ibs5/Mealplan/UpdateBalanceAndCart
```

Zwei Eigenheiten des Servers sind im Client bereits abgefangen:

* Ohne `Accept-Language`-Header antwortet IIS mit **HTTP 500**
  (`Request.UserLanguages` ist dann `null` in `Views/Shared/_Layout.cshtml`).
* Authentifizierte Endpunkte erwarten zusätzlich `X-Requested-With: XMLHttpRequest`.

Es wird nur gelesen — das Tool bestellt nichts und ändert nichts.

### Wie „bestellt" im Markup aussieht

Der Wochenplan enthält pro angebotener Menülinie und Tag einen Button:

```html
<button id="menu_quantity_2026-08-27_16_828" class="menuplan-checkbox"
        data-order-status="0"               <!-- 0 = nicht bestellt, 2 = bestellt -->
        data-quantity-ordered=""            <!-- "1" wenn bestellt -->
        data-quantity-in-shopping-cart=""   <!-- liegt im Warenkorb -->
        data-date="27.08.2026" data-name="Geflügelfrikassee …"
        readonly="readonly">                <!-- fehlt, solange bestellbar -->
```

Der Glücksfall: **`readonly` ist der Bestellschluss.** Der Server sagt direkt,
welche Tage noch änderbar sind — dieses Projekt muss keine Uhrzeit raten und
erinnert nur an Tage, an denen Handeln überhaupt noch möglich ist.

### Zwei Fallstricke, die Zeit gekostet haben

* **`requests` liest selbst `~/.netrc`** und setzt für passende Hosts HTTP-Basic-Auth
  — das überschreibt den Bearer-Token, und der Server antwortet mit 500. Da die
  Zugangsdaten hier per Design unter genau diesem Hostnamen liegen, trifft das
  jede Installation. `IbsClient` unterdrückt die Automatik mit einem No-op-`auth`.
* **`netrc`-Syntax:** Das Feld heißt `login`, auch wenn der Wert eine Kundennummer
  ist, und `machine` will einen reinen Hostnamen — keine URL. Ein falsches
  Schlüsselwort macht die *ganze* Datei für alle Tools unlesbar.

## Warum das nicht (nur) im Browser laufen kann

Eine auf den Homescreen gelegte Web-App kann sich **nicht selbst abends
aufwecken**: Browser führen keine geplanten Hintergrundjobs aus, wenn die Seite
zu ist. Die Prüfung muss deshalb auf einer Maschine laufen, die ohnehin läuft
(Cron/systemd-Timer). Die Web-App ist perspektivisch die *Oberfläche* dazu
(Status ansehen, Zeiten und Wochentage einstellen), nicht der Auslöser.

## Installation

```bash
git clone <repo> && cd ibs-order-watch
python3 -m pip install -r requirements.txt      # requests, beautifulsoup4
cp config.example.toml config.toml              # anpassen
```

### Zugangsdaten

Zugangsdaten stehen **ausschliesslich in `~/.netrc`**, nie im Repo:

```
machine ibs.sunshine-catering.de login <Kundennummer> password <Passwort>
machine smtp.example.org         login <SMTP-User>   password <SMTP-Passwort>
```

```bash
chmod 600 ~/.netrc
```

## Benutzung

```bash
python3 -m ibswatch.check --dry-run           # prüfen, Mail nur ausgeben
python3 -m ibswatch.check                     # prüfen und ggf. mailen
python3 -m ibswatch.check --today 2026-09-01  # anderes "heute" simulieren
```

Exit-Codes: `0` = geprüft (ggf. Erinnerung verschickt), `2` = Prüfung
**nicht** durchführbar (Login, Netz, Parser, Konfiguration).

### Regelmässig laufen lassen

systemd-User-Timer (werktags 17:30):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/ibs-order-watch.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ibs-order-watch.timer
systemctl --user list-timers ibs-order-watch.timer
```

Oder klassisch per Cron:

```cron
30 17 * * 1-5 cd $HOME/cloud_privat/Apps/ibs-order-watch && /usr/bin/python3 -m ibswatch.check
```

## Verhalten im Fehlerfall

Der Checker unterscheidet drei Ergebnisse und vermischt sie nicht:

Pro Tag werden sechs Zustände unterschieden:

| Zustand | Bedeutung | Reaktion |
|---|---|---|
| `ORDERED` | mindestens eine Menülinie bestellt | nichts |
| `NOT_ORDERED` | nichts bestellt, **noch bestellbar** | Erinnerung |
| `IN_CART` | im Warenkorb liegengeblieben, nie abgeschickt | Erinnerung (eigener Hinweis) |
| `DEADLINE_PASSED` | nichts bestellt, Bestellschluss vorbei | Hinweis „Brot einpacken" |
| `NO_OFFER` | Wochenende, Ferien, Feiertag | nichts |
| `UNKNOWN` | unbekannter Statuswert im Markup | Fehlermail, Exit 2 |

„Kein Essen bestellt" wird also nur über Tage gesagt, die wirklich geprüft
werden konnten. Ein Login-Fehler löst nie einen Fehlalarm aus. Es wird pro Lauf
**genau ein** Login-Versuch gemacht (die Sperrpolitik des Anbieters ist
unbekannt).

## Offene Punkte

* **Der Alarm-Pfad ist nie in freier Wildbahn aufgetreten.** Beim Kalibrieren war
  jeder Tag bestellt; `NOT_ORDERED`, `IN_CART` und `DEADLINE_PASSED` sind aus dem
  echten Markup abgeleitet und in `tests/` abgedeckt, aber nicht live beobachtet.
* **Push statt Mail.** Ein Notifier-Interface mit [ntfy](https://ntfy.sh) wäre der
  nächste Schritt — eine Bestellerinnerung ist zeitkritisch und geht im Postfach unter.
* **Wiederholungen unterdrücken:** aktuell meldet jeder Lauf denselben Tag erneut.
  Braucht einen kleinen Zustand (SQLite), sobald mehrmals täglich geprüft wird.
* **Ungeklärt / nie beobachtet:**
  * Bedeutung von `data-order-status="1"`.
  * Wie lange ein Token gültig ist.
  * Noch nicht veröffentlichte Wochen (Ferien) liefern einen leeren Wochenplan →
    alle Tage `NO_OFFER` → stiller OK-Lauf. Das ist gewollt (nichts veröffentlicht
    = nichts bestellbar); liefert der Server stattdessen die aktuelle Woche, greift
    die KW-Gegenprobe in `collect_status`.
  * Die Linie „Kaltverpflegung" ist immer `readonly`. Ein Tag, an dem *nur* sie
    angeboten wird, käme als `DEADLINE_PASSED` heraus, nicht als `NO_OFFER`.
* **Bestellschluss** berücksichtigen — sinnvoll ist die Erinnerung nur *vor*
  der Deadline. Diese steht vermutlich in der Wochenplan-Antwort.
* **Web-App (PWA):** kleine Statusseite + Einstellungen, per Manifest auf den
  Homescreen legbar.
* **Play Store:** die PWA als TWA (Trusted Web Activity) verpacken; erst
  sinnvoll, wenn die Server-Seite steht.
* **Mehrbenutzerbetrieb:** sobald nicht mehr nur lokal, brauchen fremde
  Zugangsdaten Verschlüsselung at rest — `~/.netrc` reicht dann nicht mehr.

## Tests

```bash
python3 tests/test_parser.py
```

## Datenschutz

Zugangsdaten liegen nur in `~/.netrc` (Mode 0600) und werden nie geloggt.
`tools/explore.py` maskiert Token, Mailadressen und IBAN-artige Strings, bevor
etwas auf die Platte geht. Dumps und `config.toml` sind git-ignoriert —
authentifizierte Seiten enthalten Name, Einrichtung und Kontostand und gehören
nicht ins öffentliche Repo.

## Lizenz

MIT — siehe `LICENSE`.
