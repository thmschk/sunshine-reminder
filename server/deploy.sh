#!/usr/bin/env bash
# Spielt einen gepushten Stand von GitHub auf den Server (SSH-Alias "privat") und lädt Caddy neu.
# ./server/deploy.sh [--abweichend] [branch|commit], Standard main. Der Server lädt den Commit
# selbst als Tarball von GitHub; was nur lokal liegt (uncommittet, ungepusht), geht so nicht live.
# Live geht nur, was auch lokal als HEAD ausgecheckt ist; --abweichend erlaubt einen anderen Stand.
# Caddy läuft als gemeinsamer Proxy in /srv/caddy; diese App liefert nur ihre
# statischen Dateien nach /srv/sunshine/web und ihre Site-Datei.
set -euo pipefail
HOST="${HOST:-privat}"
ABWEICHEND=
if [[ ${1:-} == --abweichend ]]; then ABWEICHEND=1; shift; fi
REF="${1:-main}"
REPO="https://github.com/thmschk/sunshine-reminder"

if [[ $REF =~ ^[0-9a-f]{40}$ ]]; then
  SHA=$REF
else
  SHA=$(git ls-remote "$REPO" "refs/heads/$REF" | cut -f1)
  [[ -n $SHA ]] || { echo "FEHLER: Branch $REF gibt es auf GitHub nicht" >&2; exit 1; }
fi
# Der SHA landet ungeprüft in URLs und Befehlen auf dem Server.
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo "FEHLER: $REF ergibt keinen eindeutigen Commit: ${SHA:-leer}" >&2; exit 1; }
LOCAL=$(git -C "$(dirname "$0")" rev-parse HEAD 2>/dev/null || true)
if [[ $LOCAL != "$SHA" ]]; then
  if [[ -z $ABWEICHEND ]]; then
    echo "FEHLER: lokal ist ${LOCAL:0:7} ausgecheckt, $REF auf GitHub ist ${SHA:0:7}. Erst pushen/pullen oder --abweichend." >&2
    exit 1
  fi
  echo "Hinweis: lokal ist ${LOCAL:0:7} ausgecheckt, live geht ${SHA:0:7} ($REF)."
fi

# Der Server-Block kommt per stdin (bash -s): jeder docker-Aufruf bekommt
# </dev/null, sonst liest er womöglich den Rest des Skripts weg und bash endet still mit 0.
ssh "$HOST" "SHA=$SHA REPO=$REPO bash -s" <<'EOF'
set -euo pipefail
mkdir -p /srv/sunshine
# Nie zwei Deploys zugleich (zweites Terminal, zweiter Rechner).
exec 9>/srv/sunshine/.deploy.lock
flock -n 9 || { echo "FEHLER: es läuft schon ein Deploy" >&2; exit 1; }
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
curl -sfL "$REPO/archive/$SHA.tar.gz" | tar -xz --no-same-owner -C "$src" --strip-components=1
[[ -f $src/web/index.html && -f $src/server/compose.yaml ]] || { echo "FEHLER: Tarball von $SHA unvollständig" >&2; exit 1; }

# Caddy muss das Web-Verzeichnis sehen; einmalig in die fremde /srv/caddy/compose.yaml eintragen.
# Vor allem anderen: scheitert es, ist noch nichts umgestellt.
caddy_changed=
if ! grep -q "/srv/sunshine/web" /srv/caddy/compose.yaml; then
  sed -i 's#^      - ./sites:/etc/caddy/sites:ro$#&\n      - /srv/sunshine/web:/srv/sunshine/web:ro#' /srv/caddy/compose.yaml
  if ! grep -q "/srv/sunshine/web" /srv/caddy/compose.yaml; then
    echo "FEHLER: /srv/caddy/compose.yaml hat keine Zeile '      - ./sites:/etc/caddy/sites:ro';" \
      "Volume /srv/sunshine/web:/srv/sunshine/web:ro von Hand eintragen" >&2
    exit 1
  fi
  caddy_changed=1
fi

# Erst prüfen, dann übernehmen: eine kaputte Site-Datei in sites/ legte beim nächsten
# Caddy-Neustart alle Sites des Servers lahm. Die alte Fassung liegt dabei außerhalb
# von sites/, weil Caddy dort jede Datei importiert.
site=/srv/caddy/sites/sunshine.caddy
prev=/srv/caddy/sunshine.caddy.prev
[[ -f $site ]] && cp "$site" "$prev"
cp "$src/server/sunshine.caddy" "$site"
if ! (cd /srv/caddy && docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile </dev/null >/dev/null 2>&1); then
  if [[ -f $prev ]]; then cp "$prev" "$site"; else rm -f "$site"; fi
  echo "FEHLER: sunshine.caddy von $SHA besteht caddy validate nicht, nichts geändert" >&2
  exit 1
fi
[[ -f $prev ]] && cp "$prev" "$site"

# Image im entpackten Tarball bauen, samt Tests (Dockerfile). /srv/sunshine/push bleibt bis
# zum Erfolg beim alten Stand, sonst nähme update-docker-images.sh am Sonntag ungeprüften Code
# live. Der Name ist der, den Compose vergibt (Projekt sunshine, Dienst push).
img=sunshine-push
docker build --quiet -t "$img:$SHA" "$src/server/push" </dev/null >/dev/null
new_image=$(docker image inspect -f '{{.Id}}' "$img:$SHA" </dev/null)
cd /srv/sunshine
# data/ (VAPID-Schlüssel, Abos) bleibt auf dem Server und gehört dem Container-User.
mkdir -p data && chown 1000:1000 data && chmod 700 data
vapid_before=$(curl -sf -m 5 http://127.0.0.1:18080/api/vapid || true)
running=$(docker compose ps -q push </dev/null 2>/dev/null || true)
old_image=
if [[ -n $running ]]; then old_image=$(docker inspect -f '{{.Image}}' "$running" </dev/null); fi
rm -rf push.prev
if [[ -d push ]]; then cp -a push push.prev; fi
if [[ -f compose.yaml ]]; then cp compose.yaml compose.yaml.prev; fi

# Zurück auf den alten Stand (push/, compose.yaml, Image hinter latest); Web-Dateien und Caddy
# sind bis dahin unangetastet. Ohne alten Container (erster Deploy) gibt es nichts zurückzuholen.
rollback() {
  if [[ -n $old_image && -d push.prev ]]; then
    rsync -a --delete push.prev/ push/
    if [[ -f compose.yaml.prev ]]; then cp compose.yaml.prev compose.yaml; fi
    docker tag "$old_image" "$img:latest" </dev/null || { echo "FEHLER: altes Image $old_image fehlt, kein Zurück" >&2; return; }
    docker compose up -d --no-build --force-recreate </dev/null >/dev/null 2>&1 || true
    echo "Alter Push-Dienst wieder gestartet; Web-Dateien und Caddy unverändert." >&2
  fi
}

rsync -a --delete "$src/server/push/" push/
cp "$src/server/compose.yaml" compose.yaml
docker tag "$img:$SHA" "$img:latest"
# Compose erkennt ein nur neu getaggtes latest nicht, solange compose.yaml gleich bleibt.
recreate=
[[ $old_image != "$new_image" ]] && recreate=--force-recreate
if ! docker compose up -d --no-build --quiet-pull $recreate </dev/null 2>&1 | { grep -vE "^ *(#|=>)" || true; } | tail -3; then
  echo "FEHLER: docker compose up mit ${SHA:0:7} gescheitert" >&2
  rollback
  exit 1
fi

# Läuft der neue Container mit dem eben gebauten Image, antwortet gesund und mit demselben
# VAPID-Schlüssel? Sonst zurück auf den alten Stand.
healthy() {
  local cid key
  cid=$(docker compose ps -q --status running push </dev/null) || return 1
  [[ -n $cid && $(docker inspect -f '{{.Image}}' "$cid" </dev/null) == "$new_image" ]] || return 1
  curl -sf -m 3 -o /dev/null http://127.0.0.1:18080/api/health || return 1
  key=$(curl -sf -m 3 http://127.0.0.1:18080/api/vapid) || return 1
  [[ -z $vapid_before || $key == "$vapid_before" ]]
}
ok=
for _ in $(seq 20); do
  sleep 1
  if healthy; then ok=1; break; fi
done
if [[ -z $ok ]]; then
  echo "FEHLER: Push-Dienst von ${SHA:0:7} läuft nicht mit dem neuen Image, nicht gesund oder mit anderem VAPID-Schlüssel; letzte Logzeilen:" >&2
  journalctl -t sunshine-push -n 15 --no-pager >&2 || true
  rollback
  exit 1
fi

# Caddy liefert direkt aus diesem Ordner: neue Dateien erst am Ende alle zusammen
# einsetzen und dann löschen, das hält den Mischstand kurz. version.txt bleibt bis zum Überschreiben.
rsync -a --delete-after --delay-updates --exclude tests/ --exclude /version.txt "$src/web/" /srv/sunshine/web/
# Welcher Commit läuft, ist so auch unter /version.txt zu sehen (#3).
echo "$SHA" > /srv/sunshine/web/version.txt
cp "$src/server/sunshine.caddy" "$site"
install -m 755 "$src/server/backup-data.sh" /srv/sunshine/backup-data.sh
install -m 644 "$src/server/sunshine.cron" /etc/cron.d/sunshine
prev_sha=$(cat /srv/sunshine/DEPLOYED 2>/dev/null || true)
echo "$SHA" > /srv/sunshine/DEPLOYED
# Images älterer Commits weg; der jetzige und der vorige bleiben für ein Zurück von Hand.
for tag in $(docker images "$img" --format '{{.Tag}}' </dev/null); do
  [[ $tag =~ ^[0-9a-f]{40}$ && $tag != "$SHA" && $tag != "$prev_sha" ]] || continue
  docker rmi "$img:$tag" </dev/null >/dev/null || true
done
# Unbenannte Reste früherer Bauten, nur die eigenen (LABEL im Dockerfile); fremde Images bleiben.
docker image prune -f --filter label=de.sunshine-order.app=push </dev/null >/dev/null || true

cd /srv/caddy
# Neuer Mount: nur dann den Caddy-Container neu anlegen, sonst reicht das Neuladen unten.
if [[ -n $caddy_changed ]]; then
  docker compose up -d </dev/null
fi
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile </dev/null >/dev/null
# Neu laden, bis die geladene Konfiguration (Admin-API, dank network_mode: host
# auf localhost:2019) der Datei entspricht. Das erste Reload nach dem Kopieren
# griff wiederholt nicht; verglichen wird die ganze Konfiguration, nicht nur ein Header.
for try in 1 2 3; do
  docker compose exec -T caddy caddy reload --force --config /etc/caddy/Caddyfile </dev/null >/dev/null 2>&1 || true
  sleep 1
  want=$(docker compose exec -T caddy caddy adapt --config /etc/caddy/Caddyfile </dev/null 2>/dev/null)
  got=$(curl -s localhost:2019/config/)
  if python3 -c 'import json, sys; sys.exit(json.loads(sys.argv[1]) != json.loads(sys.argv[2]))' "$want" "$got" 2>/dev/null; then
    exit 0
  fi
  echo "Caddy hat die neue Konfiguration noch nicht, lade erneut ($try) …"
done
echo "FEHLER: geladene Caddy-Konfiguration weicht von /etc/caddy/Caddyfile ab" >&2
exit 1
EOF
live=$(curl -sf https://sunshine-order.de/version.txt) || { echo "FEHLER: Seite antwortet nicht" >&2; exit 1; }
[[ $live == "$SHA" ]] || { echo "FEHLER: /version.txt zeigt ${live:0:7} statt ${SHA:0:7}" >&2; exit 1; }
health=$(curl -s -o /dev/null -w '%{http_code}' https://sunshine-order.de/api/health || true)
[[ $health == 200 ]] || { echo "FEHLER: /api/health antwortet mit ${health:-nichts} statt 200" >&2; exit 1; }
echo "deployt: ${SHA:0:7} ($REF) auf https://sunshine-order.de/"
