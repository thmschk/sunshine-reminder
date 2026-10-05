#!/usr/bin/env bash
# Spielt die Web-App auf den Server (SSH-Alias "privat") und lädt Caddy neu.
# Caddy läuft als gemeinsamer Proxy in /srv/caddy; diese App liefert nur ihre
# statischen Dateien nach /srv/sunshine/web und ihre Site-Datei.
set -euo pipefail
HOST="${HOST:-privat}"
cd "$(dirname "$0")/.."

rsync -a --delete --exclude tests/ web/ "$HOST:/srv/sunshine/web/"
rsync -a --delete server/push/ "$HOST:/srv/sunshine/push/"
scp -q server/compose.yaml "$HOST:/srv/sunshine/compose.yaml"
# data/ (VAPID-Schlüssel, Abos) bleibt auf dem Server und gehört dem Container-User.
ssh "$HOST" 'mkdir -p /srv/sunshine/data && chown 1000:1000 /srv/sunshine/data && chmod 700 /srv/sunshine/data && cd /srv/sunshine && docker compose up -d --build --quiet-pull 2>&1 | grep -vE "^ *(#|=>)" | tail -3' 
scp -q server/sunshine.caddy "$HOST:/srv/caddy/sites/sunshine.caddy"

ssh "$HOST" bash -s <<'EOF'
set -euo pipefail
cd /srv/caddy
# Caddy muss das Web-Verzeichnis sehen; einmalig in compose.yaml eintragen.
if ! grep -q "/srv/sunshine/web" compose.yaml; then
  sed -i 's#      - ./sites:/etc/caddy/sites:ro#      - ./sites:/etc/caddy/sites:ro\n      - /srv/sunshine/web:/srv/sunshine/web:ro#' compose.yaml
  docker compose up -d
fi
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null
docker compose exec -T caddy caddy reload --force --config /etc/caddy/Caddyfile
EOF
# Das Neuladen griff schon gelegentlich nicht: ausgelieferte CSP gegen die Datei prüfen.
want=$(grep -o 'Content-Security-Policy "[^"]*"' server/sunshine.caddy | cut -d'"' -f2)
for try in 1 2 3; do
  got=$(curl -sI https://sunshine.thomschke.info/ | tr -d '\r' | sed -n 's/^content-security-policy: //Ip')
  [ "$got" = "$want" ] && break
  echo "Caddy hat die neue Konfiguration noch nicht, lade erneut ($try) …"
  sleep 2
  ssh "$HOST" 'cd /srv/caddy && docker compose exec -T caddy caddy reload --force --config /etc/caddy/Caddyfile >/dev/null 2>&1'
done
[ "$got" = "$want" ] || { echo "FEHLER: ausgelieferte CSP weicht von server/sunshine.caddy ab" >&2; exit 1; }
echo "deployt: https://sunshine.thomschke.info/"
