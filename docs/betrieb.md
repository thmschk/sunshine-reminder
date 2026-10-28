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

- Ein Repository für alles: `thmschk/sunshine-reminder` mit `web/` (Web-App), `server/` (Push-Dienst
  und Konfiguration), `tools/` (Ferientermine), `docs/`.
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
prüft bei jedem Container-Start und täglich um 06:30, ob IBS5 und Sdui sich noch wie erwartet verhalten
und `ferien.json` noch reicht, und meldet das unter `/api/health`.

Caddy schreibt keine Zugriffs- und keine Fehlerprotokolle einzelner Anfragen
(`log default { exclude http.log.error }` im `Caddyfile`).

## Aufspielen

```sh
server/deploy.sh            # Stand von main auf GitHub
server/deploy.sh feature/x  # anderer gepushter Branch oder ein voller Commit-Hash
```

Deployt wird nur, wenn der lokal ausgecheckte HEAD genau dem Stand auf GitHub entspricht (also erst
pushen bzw. pullen); `server/deploy.sh --abweichend <ref>` übergeht das ausdrücklich.

Lädt den Commit auf dem Server von GitHub und prüft zuerst die Caddy-Site mit `caddy validate`
(besteht sie nicht, bleibt alles beim alten Stand). Dann baut es den Push-Container; erst wenn das klappt,
kopiert es Web-Dateien, Caddy-Site, `backup-data.sh` und `/etc/cron.d/sunshine`, startet den Container
neu und lädt Caddy
neu, bis die geladene Konfiguration (Admin-API `localhost:2019/config/`) der übersetzten Datei
(`caddy adapt`) entspricht — höchstens dreimal, der erste Reload griff wiederholt nicht. Danach muss
`/version.txt` den deployten Commit zeigen (auf dem Server zusätzlich in `/srv/sunshine/DEPLOYED`). Beide Docker-Stacks haben `restart: unless-stopped`.

Auf dem Handy erscheint eine neue Fassung, sobald die App einmal ganz geschlossen und neu geöffnet wird.

## Nachsehen

```sh
curl -s https://sunshine.thomschke.info/api/health          # Selbstprüfung
curl -s https://sunshine.thomschke.info/version.txt         # laufender Commit
ssh privat 'journalctl -t docker-images -n 30'             # letzte Image-Aktualisierung
ssh privat 'ls -l /srv/sunshine/backup'                    # nächtliche Datenkopien
ssh privat 'cd /srv/sunshine && docker compose logs --tail 50 push'
ssh privat "sqlite3 -readonly -header -column /srv/sunshine/data/push.sqlite \
  'SELECT id, time, offset_min, weekdays, created, last_sent, is_admin FROM subs'"
```

Ändern an der Datenbank nur bei gestopptem Dienst (`docker compose stop push`).

## Betreiber-Alarme

Abos mit `is_admin = 1` bekommen die Alarme der Selbstprüfung. Ein Gerät markiert sich über
`…/#betreiber` → ⚙ → Erinnerung mit dem Schlüssel aus `ADMIN_KEY`; der Betreiber-Bereich erscheint dort
nur bei eingeschalteter Erinnerung. Die Markierung überlebt ein Neuanmelden desselben Geräts.

`ADMIN_KEY` austauschen: neuen Wert in `.env`, dann `docker compose up -d`. Das verhindert nur neue
Markierungen; bereits markierte Geräte bleiben Betreiber. Entziehen bei gestopptem Dienst (auf dem
Server, `id` aus der Abfrage unter [Nachsehen](#nachsehen)):

```sh
cd /srv/sunshine && docker compose stop push
sqlite3 data/push.sqlite "UPDATE subs SET is_admin = 0 WHERE id = '<id>'"
docker compose start push
```

## Fehlersuche

| Zeichen | Bedeutung, Vorgehen |
|---|---|
| Alarm „Selbstprüfung: Abweichung“, `selfcheck.ok: false` in `/api/health`, im Log `Selbstprüfung: …` | `problems` nennt, was abweicht: IBS5 oder Sdui verhalten sich anders (Layout, Login, CORS) oder `ferien.json` reicht keine 180 Tage mehr (siehe [Ferientermine](#ferientermine)). |
| viele `Push abgelehnt: HTTP 403` (oder 401) im Log, `auth_rejected > 0` in `/api/health` | Push-Dienste lehnen den VAPID-Absender ab: Schlüssel gewechselt oder Uhrzeit/`VAPID_SUBJECT` falsch, siehe [VAPID-Schlüssel](#vapid-schlüssel). |
| andere `Push fehlgeschlagen: HTTP …` | Störung beim Push-Dienst (Google, Apple, Mozilla); das Abo bleibt bestehen. Häuft es sich, Erreichbarkeit nach außen prüfen. |
| Nutzer melden „keine Antwort“ bzw. Pause, auch die IBS5-Webseite geht nicht | IP-Sperre durch IBS5 beim jeweiligen Nutzer, nicht am Server; vergeht von selbst. Der Server fragt IBS5 nur bei der Selbstprüfung an. |

## Container-Images

Nicht Teil dieses Repos: `/etc/cron.d/docker-images` startet sonntags um 05:00
`/usr/local/sbin/update-docker-images.sh` für alle Stacks auf dem Server (Caddy, sunshine, wechselmodell):
`caddy:2` neu holen, eigene Images mit frischem `python:3.13-slim` neu bauen, Container neu starten,
danach müssen Seiten und Health-Checks antworten. Caddy ist dabei für alle Sites einige Sekunden weg.
Von Hand: `ssh privat update-docker-images.sh`.

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

## Server neu aufsetzen

Aus dem Repo kommt per `server/deploy.sh` alles unter `/srv/sunshine` außer Daten und `.env`. Nur auf dem
Server liegt und muss bei einem Neuaufbau von Hand (oder aus dem Hetzner-Backup) zurück:

- [ ] Debian 13, Pakete `docker-ce` mit Compose-Plugin, `sqlite3`, `rsync`, `curl`, `python3`,
      `unattended-upgrades`; Docker-CE-Quelle in den unattended-upgrades eintragen
- [ ] SSH nur per Schlüssel, Hetzner-Firewall (eingehend TCP 22, 80, 443, ICMP), Hetzner-Backup einschalten
- [ ] DNS bei Variomedia: A und AAAA von `sunshine.thomschke.info` auf die neue Adresse
- [ ] `/srv/caddy/compose.yaml` (`caddy:2`, `network_mode: host`, `restart: unless-stopped`, Volume
      `./sites:/etc/caddy/sites:ro`; den Mount von `/srv/sunshine/web` ergänzt `deploy.sh`) und
      `/srv/caddy/Caddyfile` mit `log default { exclude http.log.error }` und dem Import von `sites/*`
- [ ] `/usr/local/sbin/update-docker-images.sh` und `/etc/cron.d/docker-images` (sonntags 05:00)
- [ ] `/srv/sunshine/.env` mit `ADMIN_KEY` — **wird nicht gesichert**; neu setzen, Betreiber-Geräte neu markieren
- [ ] `server/deploy.sh`, dann `data/` aus dem jüngsten Backup zurückspielen (siehe
      [Datensicherung](#datensicherung)) und prüfen, dass `/api/vapid` den alten Schlüssel zeigt

**Restore-Probe** (gelegentlich, ohne den laufenden Dienst anzufassen):

```sh
ssh privat 'd=$(mktemp -d); f=$(ls -t /srv/sunshine/backup/sunshine-data-*.tar.gz | head -1); echo "$f"
  tar -xzf "$f" -C "$d" && sqlite3 "$d/push.sqlite" "PRAGMA integrity_check; SELECT COUNT(*) FROM subs"
  cmp "$d/vapid_private.pem" /srv/sunshine/data/vapid_private.pem && echo "VAPID-Schlüssel gleich"; rm -rf "$d"'
```

Erwartet: `ok`, eine plausible Zahl Abos, „VAPID-Schlüssel gleich“. Nach einem echten Wiederherstellen
zusätzlich `/api/vapid` mit dem vorher bekannten öffentlichen Schlüssel vergleichen.

## VAPID-Schlüssel

`data/vapid_private.pem` ist der Absenderschlüssel aller Push-Abos. **Nie neu erzeugen, nie löschen.**
Fehlt die Datei beim Start, erzeugt der Dienst still einen neuen Schlüssel und warnt im Log, wenn schon Abos
bestehen (`docker compose logs push | grep VAPID`). Die Push-Dienste lehnen dann alle alten Abos ab
(`auth_rejected` in `/api/health`); nach 7 Tagen durchgehender Ablehnung löscht der Dienst sie.

Vorgehen: `docker compose stop push`, Schlüssel aus dem jüngsten Backup zurückholen (siehe oben), starten,
prüfen, dass `/api/vapid` den alten Schlüssel zeigt. Ohne Backup müssen alle Geräte die Erinnerung neu
einschalten; die App gleicht dabei den Schlüssel ab und abonniert neu. `auth_rejected > 0` ohne
Schlüsselwechsel deutet auf ein eigenes VAPID-/JWT-Problem hin (Uhrzeit, `VAPID_SUBJECT`).

## Python-Abhängigkeiten

`server/push/requirements.txt` ist mit Hashes gepinnt und wird aus `server/push/requirements.in` erzeugt
(Befehl steht dort, mit `--upgrade` für neue Versionen); danach Tests und `server/deploy.sh`. Das
wöchentliche Image-Update erneuert nur das Python-Basis-Image, nicht diese Pakete.

## Ferientermine

`web/ferien.json` (Berliner Schulferien) erzeugt `python3 tools/ferien.py` aus der OpenHolidaysAPI, bis
zum Ende der letzten bekannten Sommerferien. Reicht die Datei keine 180 Tage mehr, meldet die Selbstprüfung
das; dann das Skript laufen lassen, Diff ansehen, committen und `server/deploy.sh`.

## Tests

| | |
|---|---|
| Server | `ssh privat 'cd /srv/sunshine && docker compose run --rm -T -v /srv/sunshine/push:/app push python -m unittest test_app'` oder lokal in einem venv mit Python 3.13 und `pip install --require-hashes -r server/push/requirements.txt`: `cd server/push && python -m unittest test_app` |
| Web | `python3 -m http.server` im Repo, dann `web/tests/test.html`, `web/tests/guard.html`, `web/tests/xss.html`, `web/tests/kinder.html`, `web/tests/ferien.html`, `web/tests/anmelden.html?mode=granted|denied|off`, `web/tests/ui.html` und `web/tests/crypto.html` im Browser |
