# ibs-order-watch

Erinnert per E-Mail, wenn im Bestellsystem **IBS5** (`ibs.sunshine-catering.de`)
für die kommenden Tage **kein Essen bestellt** ist.

Status: **Proof of Concept.** Das Login-Protokoll ist implementiert und die
Fehlerantwort gegen den echten Server geprüft; der erfolgreiche Login, die
authentifizierten Endpunkte und der Wochenplan-Parser sind noch ungetestet
(kalibriert an synthetischem Markup, siehe *Offene Punkte*).

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

| Ergebnis | Bedeutung | Reaktion |
|---|---|---|
| OK | jeder relevante Tag ist bestellt oder hat kein Angebot | nichts |
| ALARM | Tag hat Angebot, aber keine Bestellung | Erinnerungsmail |
| FEHLGESCHLAGEN | Login/Netz/Parser-Problem — Zustand unbekannt | separate Fehlermail, Exit 2 |

„Kein Essen bestellt" wird also nur über Tage gesagt, die wirklich geprüft
werden konnten. Ein Login-Fehler löst nie einen Fehlalarm aus. Es wird pro Lauf
**genau ein** Login-Versuch gemacht (die Sperrpolitik des Anbieters ist
unbekannt).

## Offene Punkte

* **Parser kalibrieren.** `ibswatch/parser.py` arbeitet mit Heuristiken über das
  Markup. Einmal `python3 tools/explore.py` laufen lassen (schreibt maskierte
  Dumps nach `dumps/`, git-ignoriert), Selektoren gegen das echte HTML prüfen,
  anonymisierten Ausschnitt als Fixture in `tests/` legen. Dabei mit abhaken:
  * Erwartet `Weekplan?year=&week=` wirklich die ISO-Kalenderwoche?
  * `Account/Orderhistory` bekommt hier ISO-Daten (`2026-08-27`); das eigene
    Frontend schickt `toDateString()` (`Thu Aug 27 2026`) — welches Format gilt?
  * Steht der Bestellschluss in der Antwort, und wie lange ist ein Token gültig?
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
