#!/usr/bin/env bash
# Läuft monatlich per /etc/cron.d/sunshine (#2) auf dem Server: holt neue Basis-Images
# (caddy:2, python:3.13-slim) und startet die Container damit neu. Debian und Docker
# selbst aktualisieren sich über unattended-upgrades, die Images nicht.
# Caddy ist der gemeinsame Proxy, auch wechselmodell ist dabei kurz weg.
# Ausgabe und Fehler landen im Journal: journalctl -t sunshine-update
set -euo pipefail
exec > >(logger -t sunshine-update) 2>&1

cd /srv/caddy
docker compose pull -q
docker compose up -d
cd /srv/sunshine
docker compose build -q --pull
docker compose up -d
docker image prune -f >/dev/null

for _ in $(seq 30); do
  if curl -sf -o /dev/null localhost:18080/api/health && curl -sf -o /dev/null https://sunshine.thomschke.info/; then
    echo "Images aktualisiert, Seite und /api/health antworten"
    exit 0
  fi
  sleep 2
done
echo "FEHLER: nach dem Aktualisieren antworten Seite oder /api/health nicht"
exit 1
