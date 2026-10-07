# Betrieb der Web-Version

Wer was wo hostet und wie es auf den Server kommt. Was die Seite für Nutzer tut,
steht im README unter „Architektur“.

```
  Arbeitskopie                          GitHub                       Hetzner Cloud: Server „privat“
  ~/cloud_privat/Apps/             thmschk/sunshine-reminder         Debian 13, CPX12
  ibs-order-watch  ── git push ──▶ (öffentlich, main)
        │                                                            /srv/caddy     Caddy (Docker)
        └──────── server/deploy.sh (rsync + ssh) ─────────────────▶ /srv/sunshine  Web-Dateien + Push-Dienst (Docker)

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
- Auf dem Server liegt **kein** Git-Klon. `server/deploy.sh` kopiert per `rsync` aus der Arbeitskopie.

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
server/deploy.sh
```

Kopiert Web-Dateien und Push-Dienst, baut den Push-Container neu, kopiert die Caddy-Site und lädt Caddy
neu, bis die geladene Konfiguration (Admin-API `localhost:2019/config/`) der übersetzten Datei
(`caddy adapt`) entspricht — höchstens dreimal, der erste Reload griff wiederholt nicht. Danach muss die
Seite antworten. Beide Docker-Stacks haben `restart: unless-stopped`.

Auf dem Handy erscheint eine neue Fassung, sobald die App einmal ganz geschlossen und neu geöffnet wird.

## Nachsehen

```sh
curl -s https://sunshine.thomschke.info/api/health          # Selbstprüfung
ssh privat 'cd /srv/sunshine && docker compose logs --tail 50 push'
ssh privat "sqlite3 -readonly -header -column /srv/sunshine/data/push.sqlite \
  'SELECT time, offset_min, weekdays, created, last_sent, is_admin FROM subs'"
```

Ändern an der Datenbank nur bei gestopptem Dienst (`docker compose stop push`).

## Betreiber-Alarme

Abos mit `is_admin = 1` bekommen die Alarme der Selbstprüfung. Ein Gerät markiert sich über
`…/#betreiber` → ⚙ → Erinnerung mit dem Schlüssel aus `ADMIN_KEY`. Austauschen: neuen Wert in `.env`,
dann `docker compose up -d`.

## Tests

| | |
|---|---|
| Server | `ssh privat 'cd /srv/sunshine && docker compose run --rm -T -v /srv/sunshine/push:/app push python -m unittest test_app'` |
| Web | `python3 -m http.server` im Repo, dann `web/tests/test.html`, `web/tests/guard.html`, `web/tests/xss.html` und `web/tests/crypto.html` im Browser |

## Offen

- **Datensicherung** von `/srv/sunshine/data`. Ohne VAPID-Schlüssel sind alle Abos ungültig.
- **Container-Images aktualisieren** (`caddy:2`, `python:3.13-slim`), sie bleiben sonst auf dem Stand vom Einrichten.
- **Deploy nur von gepushtem Stand**, damit der Server immer einem Commit entspricht.
