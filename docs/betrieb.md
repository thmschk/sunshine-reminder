# Betrieb der Web-Version

Wer was wo hostet und wie es auf den Server kommt. Was die Seite für Nutzer tut,
steht im README unter „Architektur“.

```
  Arbeitskopie                          GitHub                       Hetzner Cloud: Server „privat“
  ~/cloud_privat/Apps/             thmschk/sunshine-reminder         Debian 13, CPX12
  ibs-order-watch  ── git push ──▶ (öffentlich, main)
        │                                 │ Tarball des Commits      /srv/caddy     Caddy (Docker)
        │                                 └────────────────────────▶ /srv/sunshine  Web-Dateien + Push-Dienst (Docker)
        └──────── server/deploy.sh (ssh: Commit von main) ─────────▶ (lädt und spielt auf)

  Browser/Handy ──HTTPS──▶ sunshine.thomschke.info (DNS bei Variomedia) ──▶ Caddy
       │                                                                      ├─ statische Seite  /srv/sunshine/web
       │                                                                      └─ /api/*  ──▶  Push-Dienst 127.0.0.1:18080
       └──direkt──▶ IBS5 (Speiseplan, Bestellen)
```

## Hosting

| | |
|---|---|
| Server | Hetzner Cloud CPX12 „privat“, eigenes privates Hetzner-Projekt, Debian 13 |
| Firewall | Hetzner-Firewall: eingehend nur TCP 22, 80, 443 und ICMP |
| Domain | `sunshine.thomschke.info`, A- und AAAA-Eintrag bei Variomedia |
| Zugang | `ssh privat` (Eintrag in `~/.ssh/config`), nur per Schlüssel, Passwort-Login aus |
| Updates | `unattended-upgrades` für Debian und Docker CE |

## Code

- Ein Repository für alles: `thmschk/sunshine-reminder` mit `ibswatch/` (Python-Variante),
  `web/` (Web-App), `server/` (Push-Dienst und Konfiguration), `docs/`.
- Live ist `main` auf GitHub. Auf dem Server liegt kein Git-Klon (und kein Git): `server/deploy.sh` lässt ihn
  den Commit als Tarball von GitHub laden. Uncommittetes oder Ungepushtes geht so nie live. Welcher Commit
  läuft, steht in `/srv/sunshine/DEPLOYED`.

## Was auf dem Server läuft

| Teil | Programm | Ort | Konfiguration |
|---|---|---|---|
| Webserver, HTTPS | Caddy 2 (`caddy:2`), Docker, `network_mode: host` | `/srv/caddy` | `compose.yaml` und `Caddyfile` nur auf dem Server, die Site-Datei kommt aus `server/sunshine.caddy`. Zertifikate holt Caddy bei Let's Encrypt. |
| Web-App | keine Laufzeit: HTML, JavaScript, CSS ohne Build | `/srv/sunshine/web` | aus `web/` |
| Push-Dienst | Python 3.13 (`app.py`: eingebauter HTTP-Server, SQLite, `pywebpush`), Docker | `/srv/sunshine/push`, lauscht nur auf `127.0.0.1:18080` | `server/compose.yaml`, `server/push/Dockerfile` |
| Daten | `push.sqlite` (Abos), `vapid_private.pem` | `/srv/sunshine/data` | entsteht auf dem Server |
| Geheimnisse | `ADMIN_KEY` | `/srv/sunshine/.env` | nur auf dem Server |

Der Push-Dienst nimmt Push-Abos an, verschickt jede Minute die fälligen Weckrufe, reicht Sdui durch,
prüft um 06:30, ob IBS5 und Sdui sich noch wie erwartet verhalten, und meldet das unter `/api/health`.

Caddy schreibt keine Zugriffs- und keine Fehlerprotokolle einzelner Anfragen
(`log default { exclude http.log.error }` im `Caddyfile`).

## Aufspielen

```sh
server/deploy.sh            # Stand von main auf GitHub
server/deploy.sh feature/x  # anderer gepushter Branch oder ein voller Commit-Hash
```

Lädt den Commit auf dem Server von GitHub und prüft zuerst die Caddy-Site mit `caddy validate`
(besteht sie nicht, bleibt alles beim alten Stand). Dann baut es den Push-Container; erst wenn das klappt,
kopiert es Web-Dateien, Caddy-Site, `update-images.sh`, `backup-data.sh` und `/etc/cron.d/sunshine`, startet den Container
neu und lädt Caddy
neu, bis die geladene Konfiguration (Admin-API `localhost:2019/config/`) der übersetzten Datei
(`caddy adapt`) entspricht — höchstens dreimal, der erste Reload griff wiederholt nicht. Danach muss
`/version.txt` den deployten Commit zeigen (auf dem Server zusätzlich in `/srv/sunshine/DEPLOYED`). Beide Docker-Stacks haben `restart: unless-stopped`.

Auf dem Handy erscheint eine neue Fassung, sobald die App einmal ganz geschlossen und neu geöffnet wird.

## Nachsehen

```sh
curl -s https://sunshine.thomschke.info/api/health          # Selbstprüfung
curl -s https://sunshine.thomschke.info/version.txt         # laufender Commit
ssh privat 'journalctl -t sunshine-update -n 20'           # letzte Image-Aktualisierung
ssh privat 'ls -l /srv/sunshine/backup'                    # nächtliche Datenkopien
ssh privat 'cd /srv/sunshine && docker compose logs --tail 50 push'
ssh privat "sqlite3 -readonly -header -column /srv/sunshine/data/push.sqlite \
  'SELECT time, offset_min, weekdays, created, last_sent, is_admin FROM subs'"
```

Ändern an der Datenbank nur bei gestopptem Dienst (`docker compose stop push`).

## Betreiber-Alarme

Abos mit `is_admin = 1` bekommen die Alarme der Selbstprüfung. Ein Gerät markiert sich über
`…/#betreiber` → ⚙ → Erinnerung mit dem Schlüssel aus `ADMIN_KEY`. Austauschen: neuen Wert in `.env`,
dann `docker compose up -d`.

## Container-Images

`/etc/cron.d/sunshine` startet am ersten Sonntag im Monat um 04:15 `/srv/sunshine/update-images.sh`:
`caddy:2` und `python:3.13-slim` neu holen, Container neu starten, danach müssen Seite und
`/api/health` antworten. Caddy ist dabei für alle Sites einige Sekunden weg. Von Hand:
`ssh privat /srv/sunshine/update-images.sh`.

## Datensicherung

Jede Nacht um 03:40 legt `/srv/sunshine/backup-data.sh` (aus `/etc/cron.d/sunshine`) eine konsistente
Kopie von `push.sqlite` (per `sqlite3 .backup`) und `vapid_private.pem` als
`/srv/sunshine/backup/sunshine-data-<datum>.tar.gz` ab und behält 14 Stände. Vom Server weg bringt sie
das Hetzner-Backup des Servers (eingeschaltet, tägliches Abbild). Fehler: `journalctl -t sunshine-backup`.

Wiederherstellen (bei verlorenem Server zuerst das Hetzner-Backup einspielen oder die Datei daraus holen):

```sh
ssh privat 'cd /srv/sunshine && docker compose stop push \
  && tar -xzf backup/sunshine-data-<datum>.tar.gz -C data \
  && chown 1000:1000 data/* && chmod 600 data/vapid_private.pem && docker compose start push'
```

Danach muss `/api/vapid` denselben Schlüssel zeigen wie vorher; Abos und Uhrzeiten bleiben dann gültig.

## Ferientermine

`web/ferien.json` (Berliner Schulferien) erzeugt `python3 tools/ferien.py` aus der OpenHolidaysAPI, bis
zum Ende der letzten bekannten Sommerferien. Reicht die Datei keine 180 Tage mehr, meldet die Selbstprüfung
das; dann das Skript laufen lassen, Diff ansehen, committen und `server/deploy.sh`.

## Tests

| | |
|---|---|
| Server | `ssh privat 'cd /srv/sunshine && docker compose run --rm -T -v /srv/sunshine/push:/app push python -m unittest test_app'` oder lokal in einem venv mit `server/push/requirements.txt`: `cd server/push && python -m unittest test_app` |
| Python-Variante | `python3 -m unittest discover -s tests` |
| Web | `python3 -m http.server` im Repo, dann `web/tests/test.html`, `web/tests/guard.html`, `web/tests/xss.html`, `web/tests/kinder.html`, `web/tests/ferien.html`, `web/tests/anmelden.html?mode=granted|denied|off`, `web/tests/ui.html` und `web/tests/crypto.html` im Browser |
