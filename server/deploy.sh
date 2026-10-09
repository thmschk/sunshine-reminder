#!/usr/bin/env bash
# Spielt einen gepushten Stand von GitHub auf den Server (SSH-Alias "privat") und lädt Caddy neu.
# ./server/deploy.sh [branch|commit], Standard main. Der Server lädt den Commit selbst als
# Tarball von GitHub; was nur lokal liegt (uncommittet, ungepusht), geht so nicht live.
# Caddy läuft als gemeinsamer Proxy in /srv/caddy; diese App liefert nur ihre
# statischen Dateien nach /srv/sunshine/web und ihre Site-Datei.
set -euo pipefail
HOST="${HOST:-privat}"
REF="${1:-main}"
REPO="https://github.com/thmschk/sunshine-reminder"

if [[ $REF =~ ^[0-9a-f]{40}$ ]]; then
  SHA=$REF
else
  SHA=$(git ls-remote "$REPO" "refs/heads/$REF" | cut -f1)
  [[ -n $SHA ]] || { echo "FEHLER: Branch $REF gibt es auf GitHub nicht" >&2; exit 1; }
fi
LOCAL=$(git -C "$(dirname "$0")" rev-parse HEAD 2>/dev/null || true)
[[ $LOCAL == "$SHA" ]] || echo "Hinweis: lokal ist ${LOCAL:0:7} ausgecheckt, live geht ${SHA:0:7} ($REF)."

# Die Server-Blöcke kommen per stdin (bash -s): jeder docker-Aufruf bekommt
# </dev/null, sonst liest er womöglich den Rest des Skripts weg und bash endet still mit 0.
ssh "$HOST" "SHA=$SHA REPO=$REPO bash -s" <<'EOF'
set -euo pipefail
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT
curl -sfL "$REPO/archive/$SHA.tar.gz" | tar -xz --no-same-owner -C "$src" --strip-components=1
[[ -f $src/web/index.html && -f $src/server/compose.yaml ]] || { echo "FEHLER: Tarball von $SHA unvollständig" >&2; exit 1; }

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

# Dann den Push-Dienst bauen; scheitert der Build, bleiben Web-Dateien und Caddy beim alten Stand.
rsync -a --delete "$src/server/push/" /srv/sunshine/push/
cp "$src/server/compose.yaml" /srv/sunshine/compose.yaml
# data/ (VAPID-Schlüssel, Abos) bleibt auf dem Server und gehört dem Container-User.
mkdir -p /srv/sunshine/data && chown 1000:1000 /srv/sunshine/data && chmod 700 /srv/sunshine/data
cd /srv/sunshine
docker compose build --quiet </dev/null
rsync -a --delete --exclude tests/ "$src/web/" /srv/sunshine/web/
# Welcher Commit läuft, ist so auch unter /version.txt zu sehen (#3).
echo "$SHA" > /srv/sunshine/web/version.txt
cp "$src/server/sunshine.caddy" "$site"
docker compose up -d --quiet-pull </dev/null 2>&1 | grep -vE "^ *(#|=>)" | tail -3
install -m 755 "$src/server/update-images.sh" /srv/sunshine/update-images.sh
install -m 755 "$src/server/backup-data.sh" /srv/sunshine/backup-data.sh
install -m 644 "$src/server/sunshine.cron" /etc/cron.d/sunshine
echo "$SHA" > /srv/sunshine/DEPLOYED
EOF

ssh "$HOST" bash -s <<'EOF'
set -euo pipefail
cd /srv/caddy
# Caddy muss das Web-Verzeichnis sehen; einmalig in compose.yaml eintragen.
if ! grep -q "/srv/sunshine/web" compose.yaml; then
  sed -i 's#      - ./sites:/etc/caddy/sites:ro#      - ./sites:/etc/caddy/sites:ro\n      - /srv/sunshine/web:/srv/sunshine/web:ro#' compose.yaml
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
live=$(curl -sf https://sunshine.thomschke.info/version.txt) || { echo "FEHLER: Seite antwortet nicht" >&2; exit 1; }
[[ $live == "$SHA" ]] || { echo "FEHLER: /version.txt zeigt ${live:0:7} statt ${SHA:0:7}" >&2; exit 1; }
echo "deployt: ${SHA:0:7} ($REF) auf https://sunshine.thomschke.info/"
