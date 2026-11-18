# Betrieb der Web-Version

Wer was wo hostet und wie es auf den Server kommt. Was die Seite für Nutzer tut,
steht im README unter „Architektur“.

```
  Arbeitskopie                          GitHub                       Hetzner Cloud: Server „privat“
                                   thmschk/sunshine-reminder         Debian 13, CPX12
  lokaler Klon     ── git push ──▶ (öffentlich, main)
        │                                 │ Tarball des Commits      /srv/caddy     Caddy (Docker)
        │                                 └────────────────────────▶ /srv/sunshine  Web-Dateien + Push-Dienst (Docker)
        └──────── server/deploy.sh (ssh: Commit von main) ─────────▶ (lädt und spielt auf)

  Browser/Handy ──HTTPS──▶ sunshine-order.de / sunshine.thomschke.info ──▶ Caddy
       │                                                                      ├─ statische Seite  /srv/sunshine/web
       │                                                                      └─ /api/*  ──▶  Push-Dienst 127.0.0.1:18080
       └──direkt──▶ IBS5 (Speiseplan, Bestellen)
```

## Hosting

| | |
|---|---|
| Server | Hetzner Cloud CPX12 „privat“, eigenes privates Hetzner-Projekt, Debian 13 |
| Firewall | Hetzner-Firewall: eingehend nur TCP 22, 80, 443 und ICMP |
| Domain | `sunshine-order.de` (Hauptadresse, `www.` leitet dorthin um) und `sunshine.thomschke.info` (frühere Adresse, bei Variomedia), beide gleichwertig in Betrieb, je A- und AAAA-Eintrag auf den Server |
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
| Geheimnisse | `ADMIN_KEY`, optional `HEARTBEAT_URL`, `BACKUP_PING_URL` | `/srv/sunshine/.env` | nur auf dem Server, siehe [Überwachung](#überwachung) |

Der Push-Dienst nimmt Push-Abos an, verschickt jede Minute die fälligen Weckrufe, reicht Sdui durch,
prüft bei jedem Container-Start und täglich um 06:30 (in eigenem Thread, hält den Versand nicht auf), ob
IBS5 und Sdui sich noch wie erwartet verhalten und `ferien.json` noch reicht, räumt stündlich tote Abos
ab (siehe [Abos aufräumen](#abos-aufräumen)) und meldet seinen Zustand unter `/api/health`.

Caddy schreibt keine Zugriffs- und keine Fehlerprotokolle einzelner Anfragen
(`log default { exclude http.log.error }` im `Caddyfile`).

Der Push-Dienst schreibt ins Journal des Servers (`logging: driver: journald` in `server/compose.yaml`,
`journalctl -t sunshine-push`), je Weckruf eine Zeile mit gekürzter Abo-id, Art, HTTP-Status, Dauer und
Kennung beim Push-Dienst (nie Endpoint oder IP). Der journald-Treiber von Docker rotiert nicht selbst;
es gilt die Grenze von journald (Standard: Größe, keine Frist).

**To-do (Server):**

- [ ] Aufbewahrung festlegen: `journalctl --disk-usage` und `/etc/systemd/journald.conf` ansehen; Vorschlag
      `/etc/systemd/journald.conf.d/retention.conf` mit `[Journal]`, `MaxRetentionSec=30day` (und z. B.
      `SystemMaxUse=500M`), dann `systemctl restart systemd-journald`. Gilt für das ganze Journal des Servers.
      Danach in `web/datenschutz.html` und im README („Was der Server sieht“) „keine feste Frist“ durch die
      Frist ersetzen.
- [ ] Caddy-Fristen gegen langsame Clients prüfen: steht der globale Block `servers { timeouts { … } }`
      (siehe [Server neu aufsetzen](#server-neu-aufsetzen)) wirklich im `/srv/caddy/Caddyfile`?
      `ssh privat 'grep -A6 timeouts /srv/caddy/Caddyfile'`.

## Aufspielen

```sh
server/deploy.sh            # Stand von main auf GitHub
server/deploy.sh feature/x  # anderer gepushter Branch oder ein voller Commit-Hash
```

Deployt wird nur, wenn der lokal ausgecheckte HEAD genau dem Stand auf GitHub entspricht (also erst
pushen bzw. pullen); `server/deploy.sh --abweichend <ref>` übergeht das ausdrücklich.

Ablauf auf dem Server (ein `ssh`, gesperrt per `flock` auf `/srv/sunshine/.deploy.lock`, damit nie zwei
Deploys zugleich laufen):

1. Commit als Tarball von GitHub in ein Temp-Verzeichnis laden.
2. Fehlt in `/srv/caddy/compose.yaml` der Mount von `/srv/sunshine/web`, ihn hinter der Zeile
   `      - ./sites:/etc/caddy/sites:ro` eintragen; gibt es die Zeile nicht, mit Fehler abbrechen (noch nichts
   geändert). Caddy wird nur dann neu angelegt.
3. Caddy-Site mit `caddy validate` prüfen; besteht sie nicht, bleibt alles beim alten Stand.
4. Image `sunshine-push:<commit>` im Temp-Verzeichnis bauen, **samt Tests** (Test-Stage im Dockerfile).
   Scheitert das, bleibt `/srv/sunshine/push` unverändert — sonst nähme das sonntägliche Image-Update
   ungeprüften Code live.
5. `push/` und `compose.yaml` nach `/srv/sunshine`, Image als `sunshine-push:latest` markieren,
   `docker compose up -d --no-build`. Scheitert das, zurück wie in Schritt 6.
6. Bis zu 20 s warten, bis der Container mit dem eben gebauten Image läuft (Image-ID verglichen),
   `127.0.0.1:18080/api/health` 200 liefert und `/api/vapid` denselben öffentlichen Schlüssel zeigt wie
   vorher. Sonst: alter Stand von `push/`, `compose.yaml` und Image zurück, Container neu, Abbruch mit den
   letzten Logzeilen. Web-Dateien und Caddy sind bis hierher unangetastet.
7. Erst jetzt Web-Dateien, `version.txt`, Caddy-Site, `backup-data.sh` und `/etc/cron.d/sunshine`
   übernehmen; Images älterer Commits löschen (der vorige bleibt), dazu unbenannte Reste früherer Bauten,
   aber nur solche mit dem Label `de.sunshine-order.app=push` (Dockerfile).
8. Caddy neu laden, bis die geladene Konfiguration (Admin-API `localhost:2019/config/`) der übersetzten
   Datei (`caddy adapt`) entspricht — höchstens dreimal, der erste Reload griff wiederholt nicht.

Zum Schluss prüft das Skript lokal, dass `https://sunshine-order.de/version.txt` den Commit zeigt und
`/api/health` mit 200 antwortet (auf dem Server steht der Commit zusätzlich in `/srv/sunshine/DEPLOYED`).
Beide Docker-Stacks haben `restart: unless-stopped`.

Auf dem Handy erscheint eine neue Fassung, sobald die App einmal ganz geschlossen und neu geöffnet wird.

## Nachsehen

```sh
curl -s https://sunshine-order.de/api/health                # Zustand, Selbstprüfung (siehe Überwachung)
curl -s https://sunshine-order.de/version.txt               # laufender Commit
ssh privat 'journalctl -t docker-images -n 30'             # letzte Image-Aktualisierung
ssh privat 'ls -l /srv/sunshine/backup'                    # nächtliche Datenkopien
ssh privat 'journalctl -t sunshine-push -n 50'                # Push-Dienst, auch über Deploys hinweg
ssh privat "sqlite3 -readonly -header -column /srv/sunshine/data/push.sqlite \
  'SELECT id, time, offset_min, weekdays, created, last_sent, last_ok, fail_since, is_admin FROM subs'"
```

Ändern an der Datenbank nur bei gestopptem Dienst (`docker compose stop push`).

## Betreiber-Alarme

Abos mit `is_admin = 1` bekommen die Alarme der Selbstprüfung und den Alarm „Sdui-Relay: mehr als 100
Logins in einer Stunde“ (höchstens einmal je Stunde). Ein Gerät markiert sich über `…/#betreiber` → ⚙ →
Erinnerung mit dem Schlüssel aus `ADMIN_KEY`; der Betreiber-Bereich erscheint dort nur bei eingeschalteter
Erinnerung. Höchstens 5 Versuche je Stunde und Netz (IPv4-/24 bzw. IPv6-/64).

Die Markierung hängt am Abo, nicht am Gerät: Meldet sich dasselbe Gerät neu an (neues Abo per `POST`,
etwa nach „Abmelden“ oder wenn der Browser das Push-Abo erneuert hat und die App es neu anlegt), ist es
**kein** Betreiber-Gerät mehr und muss sich neu markieren — der Endpoint ist kein Geheimnis und darf die
Markierung nicht vererben. Ein `PUT` mit neuem Endpoint auf das bestehende Abo behält sie. Die Antworten
auf `POST`/`PUT` zu einem Abo enthalten `"is_admin": true|false`, daraus zeigt die App den Stand an.
`/api/health` meldet unter `admins` die Zahl der Betreiber-Abos und warnt bei 0.

`ADMIN_KEY` mit mindestens 128 Bit erzeugen (der Dienst warnt beim Start, wenn er kürzer ist):

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(24))'
```

Austauschen: neuen Wert in `.env`, dann `docker compose up -d`. Das verhindert nur neue
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
| `/api/health` 503 mit `Zeitplan steht` | Der Versand-Thread läuft nicht mehr oder hängt (letzter Durchlauf `scheduler_at` älter als 5 min). `docker compose restart push`, dann Log ansehen. |
| `/api/health` 503 mit `heute nur Fehlschläge` | Heute bei mindestens 5 verschiedenen Abos (bzw. allen, wenn es weniger gibt) ein Weckruf aufgegeben und keine einzige Zustellung geglückt: Netz nach außen, VAPID-Schlüssel, Uhrzeit prüfen; Log `Weckruf … fehlgeschlagen`, `… aufgegeben`, `… abgelehnt`. |
| `warn: ["keine Betreiber-Abos"]` | Niemand bekommt Alarme der Selbstprüfung; ein Gerät neu markieren (siehe [Betreiber-Alarme](#betreiber-alarme)). |
| Alarm „Selbstprüfung: Abweichung“, `selfcheck.ok: false` in `/api/health`, im Log `Selbstprüfung: …` | `problems` nennt, was abweicht: IBS5 oder Sdui verhalten sich anders (Layout, Login, CORS) oder `ferien.json` reicht keine 180 Tage mehr (siehe [Ferientermine](#ferientermine)). |
| viele `Weckruf … abgelehnt: HTTP 403` (oder 401) im Log, `auth_rejected > 0` in `/api/health` | Push-Dienste lehnen den VAPID-Absender ab: Schlüssel gewechselt oder Uhrzeit/`VAPID_SUBJECT` falsch, siehe [VAPID-Schlüssel](#vapid-schlüssel). Ein abgelehnter Weckruf wird am selben Tag nicht wiederholt (zählt gleich als aufgegeben). Einzelne abgelehnte Abos sind normal (Gerät mit altem Schlüssel), sie verschwinden nach 7 Tagen. |
| andere `Weckruf … fehlgeschlagen: HTTP …` | Störung beim Push-Dienst (Google, Apple, Mozilla, Microsoft). Der Versand versucht es nach 1, 2, 4, 8 min erneut (bei 429/5xx mit `Retry-After` so spät wie verlangt), nach 5 Versuchen `… aufgegeben` (Zähler `gave_up`: Abos, nicht Weckrufe). Häuft es sich, Erreichbarkeit nach außen prüfen. |
| `Sdui-Login abgelehnt (401), heute N` | Nur ein Zähler falscher Sdui-Anmeldungen; steigt er sprunghaft, probiert jemand Passwörter durch (Begrenzung: 5 je Netz und Stunde, 100 insgesamt). |
| `Aufräumen ausgesetzt: seit … keine Zustellung` | Seit über 4 Tagen keine einzige Zustellung: der Dienst löscht dann nichts, siehe [Abos aufräumen](#abos-aufräumen). |
| Nutzer melden „keine Antwort“ bzw. Pause, auch die IBS5-Webseite geht nicht | IP-Sperre durch IBS5 beim jeweiligen Nutzer, nicht am Server; vergeht von selbst. Der Server fragt IBS5 nur bei der Selbstprüfung an. |

## Überwachung

Der Server meldet Probleme per Web-Push an die Betreiber-Geräte — fällt der Versand selbst aus, kommt
genau diese Meldung nicht an. Dafür gibt es zwei Signale nach außen, die ein fremder Dienst prüft:

**`/api/health`** (öffentlich, JSON): `ok`, `problems` (führen zu **HTTP 503**), `warn` (nur Hinweis,
weiter 200), `scheduler_at` (letzter Durchlauf des Zeitplans), Tageszähler `sent_ok`, `sent_fail`
(gescheiterte Versuche), `gave_up` (Abos, bei denen heute ein Weckruf nach 5 Versuchen oder nach
401/403 aufgegeben wurde, je Abo einmal), `auth_rejected`, `admins` (Zahl der Betreiber-Abos) und
`selfcheck`. 503 heißt: letzter Durchlauf älter als 5 min, oder heute bei mindestens 5 verschiedenen
Abos (bzw. bei allen, wenn es weniger gibt) aufgegeben und kein einziger Weckruf zugestellt. Wenige
tote oder abgelehnte Abos unter vielen lösen das nicht aus. Keine Betreiber-Abos sind bewusst nur
eine Warnung: der Versand läuft, ein 503 würde Neuinstallationen und den Docker-Healthcheck dauerhaft
rot färben, und ein Neustart behöbe es nicht. Docker prüft `/api/health` jede Minute
(`docker ps` zeigt `healthy`/`unhealthy`), startet bei `unhealthy` aber nicht neu.

**Totmannschalter `HEARTBEAT_URL`** (optional): Ist sie gesetzt, ruft der Zeitplan sie höchstens alle
5 min per GET auf, solange `/api/health` gesund ist. Bleibt der Ping aus (Container weg, Server weg,
Zeitplan hängt, Versand scheitert), alarmiert der fremde Dienst.

**Einrichten** (einmalig, z. B. mit healthchecks.io, das per Mail, Signal, Telegram, ntfy meldet;
Uptime Kuma im Push-Modus geht genauso):

1. Check „sunshine-push“ anlegen: Period **5 min**, Grace **10 min**. Die Ping-URL ist ein Geheimnis.
2. Check „sunshine-backup“ anlegen: Period **1 Tag**, Grace **2 h** (Sicherung läuft 03:40).
3. Auf dem Server in `/srv/sunshine/.env` eintragen (ohne Anführungszeichen) und den Dienst neu anlegen:
   ```sh
   ssh privat 'cd /srv/sunshine && nano .env'   # HEARTBEAT_URL=https://hc-ping.com/<uuid-1>
                                                # BACKUP_PING_URL=https://hc-ping.com/<uuid-2>
   ssh privat 'cd /srv/sunshine && docker compose up -d'
   ```
   `backup-data.sh` liest nur die Zeile `BACKUP_PING_URL` aus `.env`; der Dienst bekommt alle Zeilen.
4. Zusätzlich einen HTTP-Monitor auf `https://sunshine-order.de/api/health` (alle 5 min, Alarm bei
   Status ≠ 200), z. B. UptimeRobot oder Uptime Kuma; er fängt auch Caddy-, Zertifikats- und
   DNS-Ausfälle, die der Ping vom Server aus nicht sieht. Wer auch Warnungen will: Schlüsselwort-Monitor,
   der `"warn": []` erwartet.
5. Prüfen: nach höchstens 5 min zeigt der Check „up“; `docker compose stop push` → nach ~15 min Alarm;
   wieder `docker compose start push`.

Die URLs nie ins Repo; der Dienst schreibt sie nicht ins Log (nur den Fehlertyp, falls der Ping scheitert).

## Abos aufräumen

Abos werden gelöscht, wenn der Push-Dienst sie mit 404/410 als abgelaufen meldet, nach 7 Tagen
durchgehender Ablehnung mit 401/403 (siehe [VAPID-Schlüssel](#vapid-schlüssel)) und stündlich von
`cleanup_subs`. Grundlage ist `fail_since`: der Tag des ersten gescheiterten Versands seit der letzten
Zustellung (jede Zustellung leert es, ebenso ein neuer Endpoint per `PUT`). Ohne gescheiterten Versand
wird nichts gelöscht, auch wenn `last_ok` alt oder leer ist (Dienst stand, Rollback auf einen Stand ohne
`fail_since`).

- **nie zugestellt** (`last_ok` leer): 2 Tage nach dem Anlegen, frühestens einen Tag nach dem ersten
  fälligen Weckruf (Wochentag nur Samstag: erst am Montag danach) und einen Tag nach dem ersten
  gescheiterten Versand. Ein geglückter Test-Weckruf zählt als Zustellung.
- **seit 14 Tagen scheitert jeder Versand** (`fail_since` älter als 14 Tage), gleich welcher Fehler
  (400, 5xx, Zeitüberschreitung …).
- Beide Fristen laufen frühestens ab dem Start des Dienstes (nach einem Ausfall oder Deploy bekommt jedes
  Abo erst wieder Weckrufe), bei „nie zugestellt“ also frühestens 2 Tage nach dem Start.
- Gab es seit über 4 Tagen gar keine Zustellung mehr, löscht der Dienst nichts (eigene Störung soll nicht
  alle Abos kosten) und schreibt `Aufräumen ausgesetzt` ins Log.

Neue Abos: höchstens 10 je Stunde und Netz (IPv4-/24, IPv6-/64; die Client-IP kommt aus dem letzten
`X-Forwarded-For`-Eintrag von Caddy), höchstens 1000 noch nie zugestellte zugleich (sonst 503 „voll“).
Ein Prüf-Push beim Anlegen wäre die direktere Kontrolle, zeigte aber jedem Nutzer eine Meldung.
Bestehende Abos galten beim Einführen von `last_ok` (Schema-Version 2) als zugestellt; `fail_since`
(Schema-Version 3) beginnt leer.

## Container-Images

Nicht Teil dieses Repos: `/etc/cron.d/docker-images` startet sonntags um 05:00
`/usr/local/sbin/update-docker-images.sh` für alle Stacks auf dem Server (Caddy, sunshine, wechselmodell):
`caddy:2` neu holen, eigene Images mit frischem `python:3.13-slim` neu bauen, Container neu starten,
danach müssen Seiten und Health-Checks antworten. Caddy ist dabei für alle Sites einige Sekunden weg.
Der Neubau des Push-Dienstes führt die Tests aus (Test-Stage im Dockerfile); scheitern sie mit dem neuen
Basis-Image, scheitert der Bau und der alte Container läuft weiter.
Von Hand: `ssh privat update-docker-images.sh`.

**To-do (Skript liegt nicht im Repo):** `update-docker-images.sh` soll für den sunshine-Stack dieselbe
Sperre nehmen wie `deploy.sh`, damit Image-Update und Deploy nie gleichzeitig `/srv/sunshine` anfassen,
etwa `exec 9>/srv/sunshine/.deploy.lock; flock -w 600 9` vor dem Neubau (warten statt abbrechen).

## Datensicherung

Jede Nacht um 03:40 legt `/srv/sunshine/backup-data.sh` (aus `/etc/cron.d/sunshine`) eine konsistente
Kopie von `push.sqlite` (per `sqlite3 .backup`) und `vapid_private.pem` als
`/srv/sunshine/backup/sunshine-data-<datum>.tar.gz` ab und behält 14 Stände. Schreibt der Dienst gerade,
wartet `sqlite3` bis zu 5 s (`.timeout 5000`). Vom Server weg bringt sie das Hetzner-Backup des Servers
(eingeschaltet, tägliches Abbild mit dessen eigener Aufbewahrung). Fehler: `journalctl -t sunshine-backup`;
nach Erfolg ein Ping an `BACKUP_PING_URL`, falls gesetzt (siehe [Überwachung](#überwachung)).

Wiederherstellen (bei verlorenem Server zuerst das Hetzner-Backup einspielen oder die Datei daraus holen).
Ein liegengebliebenes Journal (`push.sqlite-journal`, `-wal`, `-shm`) gehört zur alten Datei und würde
beim Start auf die zurückgeholte angewendet; es muss vorher weg:

```sh
ssh privat 'cd /srv/sunshine && docker compose stop push \
  && rm -f data/push.sqlite-journal data/push.sqlite-wal data/push.sqlite-shm \
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
- [ ] DNS: A und AAAA von `sunshine-order.de`, `www.sunshine-order.de` und `sunshine.thomschke.info` (Variomedia) auf die neue Adresse
- [ ] `/srv/caddy/compose.yaml` (`caddy:2`, `network_mode: host`, `restart: unless-stopped`, Volume
      genau als Zeile `      - ./sites:/etc/caddy/sites:ro`; den Mount von `/srv/sunshine/web` ergänzt
      `deploy.sh` dahinter) und `/srv/caddy/Caddyfile` mit `log default { exclude http.log.error }`, dem
      Import von `sites/*` und Fristen gegen langsame Clients im globalen Block (gilt für alle Sites):
      ```
      {
          servers {
              timeouts {
                  read_header 10s
                  read_body 30s
                  idle 2m
              }
          }
      }
      ```
- [ ] `/usr/local/sbin/update-docker-images.sh` (mit der Sperre `/srv/sunshine/.deploy.lock`, siehe
      [Container-Images](#container-images)) und `/etc/cron.d/docker-images` (sonntags 05:00)
- [ ] `/srv/sunshine/.env` mit `ADMIN_KEY` (siehe [Betreiber-Alarme](#betreiber-alarme)), `HEARTBEAT_URL`,
      `BACKUP_PING_URL` — **wird nicht gesichert**; neu setzen, Betreiber-Geräte neu markieren
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
bestehen (`journalctl -t sunshine-push | grep VAPID`). Die Push-Dienste lehnen dann alle alten Abos ab
(`auth_rejected` in `/api/health`); nach 7 Tagen durchgehender Ablehnung löscht der Dienst sie.

Vorgehen: `docker compose stop push`, Schlüssel aus dem jüngsten Backup zurückholen (siehe oben), starten,
prüfen, dass `/api/vapid` den alten Schlüssel zeigt. Ohne Backup müssen alle Geräte die Erinnerung neu
einschalten; die App gleicht dabei den Schlüssel ab und abonniert neu. `auth_rejected > 0` ohne
Schlüsselwechsel deutet auf ein eigenes VAPID-/JWT-Problem hin (Uhrzeit, `VAPID_SUBJECT`).

## Python-Abhängigkeiten

`server/push/requirements.txt` ist mit Hashes gepinnt und wird aus `server/push/requirements.in` erzeugt
(alle direkt importierten Pakete: `pywebpush`, `py-vapid`, `cryptography`, `requests`; Befehl steht dort,
mit `--upgrade` für neue Versionen); danach Tests und `server/deploy.sh`. Das
wöchentliche Image-Update erneuert nur das Python-Basis-Image, nicht diese Pakete.

## Ferientermine

`web/ferien.json` (Berliner Schulferien) erzeugt `python3 tools/ferien.py` aus der OpenHolidaysAPI, bis
zum Ende der letzten bekannten Sommerferien. Reicht die Datei keine 180 Tage mehr, meldet die Selbstprüfung
das; dann das Skript laufen lassen, Diff ansehen, committen und `server/deploy.sh`.

## Tests

| | |
|---|---|
| Server | `ssh privat 'cd /srv/sunshine && docker compose run --rm -T -v /srv/sunshine/push:/app push python -m unittest test_app'` oder lokal in einem venv mit Python 3.13 und `pip install --require-hashes -r server/push/requirements.txt`: `cd server/push && python -m unittest test_app` |
| Web | headless in einem venv mit `pip install playwright`: `python -I tools/webtests.py` (findet alle Testseiten mit Summenzeile „ALLE OK“ selbst; lokal `--channel chrome`, Standard). Einzeln: `python3 -m http.server` im Repo, dann `web/tests/<seite>.html` im Browser |
| CI | `.github/workflows/tests.yml` lässt beides bei jedem Push auf `main` laufen |
