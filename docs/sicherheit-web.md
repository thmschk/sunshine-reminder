# Sicherheits- und Datenschutzprüfung der Web-Version

Anlass war eine externe Durchsicht des README (Commit `399d4f8`) mit neun Befunden.
Hier steht je Befund, was im Code tatsächlich zutraf, was geändert wurde und wie
es geprüft ist. Stand: 2026-10-05.

| | Befund | im Code | Ergebnis |
|---|---|---|---|
| F1 | iOS verlangt bei jedem Push eine Meldung | großteils schon umgesetzt: jeder Pfad meldet sich, „alles bestellt“ still | **behoben**: Ersatzmeldung auch bei unerwarteter Ausnahme (`web/sw.js`, push-Handler). **offen**: iPhone-Test über 14 Werktage |
| F2 | Datenschutzaussagen widersprechen dem Sdui-Relay | traf zu (README „nur Push-Abo und Uhrzeit“, „keine Protokolle“, Startseite) | **behoben**: Texte korrigiert, Tabelle „Was der Server sieht und speichert“, Caddy-Fehlerprotokolle je Anfrage abgeschaltet |
| F3 | Push-Endpoints ungeprüft | https und Host-Liste gab es schon | **behoben**: Schlüsselformat, kein Port/Benutzerinfo, Länge, keine Umleitungen, Timeout, 10 neue Abos je IP und Stunde |
| F4 | Code-Integrität | CSP und Header gab es, mit `style-src 'unsafe-inline'` | **behoben**: CSP ohne `unsafe-inline`, `object-src 'none'`, HSTS mit `includeSubDomains`, COOP; README-Abschnitt mit Prüfbefehl. **nicht umgesetzt**: CI mit Prüfsummen (siehe unten) |
| F5 | Zugangsdaten, XSS | IBS5-Passwort gespeichert (nötig für die Hintergrundprüfung), Fremddaten überall maskiert | **behoben**: „Abmelden“ löscht alles samt Schlüssel und Abo, README ehrlich. **geprüft**: präpariertes `<img onerror>` bleibt Text. **nicht umgesetzt**: DOMParser, Trusted Types (siehe unten) |
| F6 | Sdui-Relay härten | Pfad-Liste, numerische IDs, fester Host, Header-Auswahl, Limit, Timeout gab es | **behoben**: keine Kodierungs-/Traversal-Tricks, Login-Body streng geprüft und neu serialisiert. **nicht umgesetzt**: eigene Subdomain (siehe unten) |
| F7 | Impressum, Datenschutz, Anbieterbedingungen | fehlte | **offen**: Entwürfe liegen vor, Angaben des Betreibers fehlen. Bis dahin bleibt die Web-Version im geschlossenen Test |
| F8 | IP-Sperre durch Last | nacheinander, Pausen, Cache gab es. **Fehler**: bei Sperre meldete sich die Seite erneut an | **behoben**: Schutzschalter (3 h Pause nach Netzfehler beim Login oder 429), 150 Anfragen je Stunde und Gerät (bremst nur, bis wieder Platz ist), Zufall in den Pausen, Anzeige in App und Meldung; Pause bei bloßem Schweigen erst 15 min (3 h erst bei Wiederholung binnen 6 h), endet bei Netzwechsel, Retry auch im Anmeldeformular; Weiterleitung/401/403 beim Login gilt nicht als falsches Passwort |
| F9 | Stilles Versagen | Fehler beim Weckruf meldeten sich schon | **behoben**: letzte erfolgreiche Prüfung sichtbar, Warnung nach vier Tagen ohne Erfolg, tägliche Selbstprüfung des Servers mit Alarm an den Betreiber (`/api/health`) |

## Tests

| Befund | Test |
|---|---|
| F3, F6 | `server/push/test_app.py`: abgelehnte Endpoints (`http://`, `localhost`, `169.254.169.254`, fremder Host, Benutzerinfo, Port, Länge), Schlüsselformat, Begrenzung, Sdui-Pfade (`../`, `%2e%2e`, `12a`, `//`, `\`), Login-Body |
| F5, F8 | `web/tests/guard.html`: Pause nach Netzfehler, keine Anfrage während der Pause, genau ein Folgeversuch, 429, 403, Stundenkontingent, Parser gibt HTML als Text. `web/tests/xss.html`: echte Startseite mit präpariertem Gerichtsnamen |
| F4 | Header am Live-Server geprüft, kein CSP-Verstoß in der Konsole; Prüfbefehl aus dem README gegen den Live-Server: alle Dateien gleich |
| F9 | Selbstprüfung beim Start und täglich 06:30, Ergebnis unter `/api/health` |

## Bewusst nicht umgesetzt

- **CI-Build mit veröffentlichten Prüfsummen (F4):** Der Prüfbefehl im README vergleicht die ausgelieferten Dateien direkt mit dem Repository, das leistet dasselbe ohne Build-Schritt. Gegen einen Betreiber, der selbst anderen Code ausliefert, hilft keine der beiden Varianten, solange niemand vor jedem Öffnen prüft. Das steht offen im README.
- **DOMParser für das IBS5-HTML (F5):** Der Parser muss auch im Service Worker laufen, dort gibt es keinen DOMParser. Er setzt nie HTML ein, sondern liest nur Attribute als Text. Alle Fremddaten gehen vor der Ausgabe durch eine Maskierung.
- **Trusted Types (F5):** würde jede Ausgabe umbauen, bei heute schon vollständig maskierten Daten. Kann später kommen.
- **Sdui-Relay auf eigener Subdomain (F6):** gleiche Maschine, gleicher Betreiber. Der Relay sendet ohnehin keine CORS-Freigabe, fremde Seiten können seine Antworten nicht lesen.
- **GitHub-Issues F1–F9:** nicht angelegt, um offene Lücken nicht vor dem Beheben öffentlich aufzulisten. Dieser Bericht ersetzt sie.

## Nachtrag: viele Nutzer

- Weckrufe derselben Uhrzeit verteilt der Server gleichmäßig über 30 Minuten (am wenigsten belegte Minute), Standard ist 17:00.
- Betreiber-Alarme gehen an Abos mit `is_admin`. Ein Gerät markiert sich über `…/#betreiber` → ⚙ mit dem Schlüssel aus `ADMIN_KEY` in `/srv/sunshine/.env`. Die Markierung überlebt ein Neuanmelden desselben Geräts.

## Offen

- iPhone: Erinnerung über 14 Werktage, mindestens 5 davon „alles bestellt“, Abo muss gültig bleiben.
- Impressum, Datenschutzerklärung, Verzeichnis der Verarbeitungstätigkeiten, Auftragsverarbeitungsvertrag mit Hetzner.
- Nutzungsbedingungen von IBS5 und Sdui zu fremden Programmen prüfen, gegebenenfalls anfragen. Betrifft auch die Android-App.
- IBS5-Token statt Passwort: Der Token wird inzwischen zusätzlich (verschlüsselt) gespeichert, damit nicht jeder Aufruf neu anmeldet; das Passwort bleibt für den Fall nötig, dass er abläuft. Seine Laufzeit ist nicht dokumentiert.
