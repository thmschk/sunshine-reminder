#!/usr/bin/env bash
# Läuft nachts per /etc/cron.d/sunshine auf dem Server (#1): legt eine konsistente Kopie
# von /srv/sunshine/data (Abos, VAPID-Schlüssel) nach /srv/sunshine/backup und behält 14.
# Aus dem Server heraus bringt sie erst das Hetzner-Backup; ein Abbild der laufenden
# push.sqlite könnte mitten in einem Schreibvorgang entstehen, diese Kopie nicht.
# Fehler landen im Journal: journalctl -t sunshine-backup. Ist in /srv/sunshine/.env
# BACKUP_PING_URL gesetzt, geht nach Erfolg ein GET dorthin (fehlt er, meldet die Überwachung).
set -euo pipefail
exec > >(logger -t sunshine-backup) 2>&1
DEST=/srv/sunshine/backup
KEEP=14
install -d -m 700 "$DEST"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# .timeout: schreibt der Dienst gerade, bis zu 5 s warten statt sofort mit „database is locked“ abzubrechen.
sqlite3 -cmd ".timeout 5000" /srv/sunshine/data/push.sqlite ".backup '$tmp/push.sqlite'"
[[ $(sqlite3 "$tmp/push.sqlite" 'PRAGMA integrity_check') == ok ]] || { echo "FEHLER: Kopie von push.sqlite beschädigt"; exit 1; }
cp -p /srv/sunshine/data/vapid_private.pem "$tmp/"
out="$DEST/sunshine-data-$(date +%F).tar.gz"
(umask 077 && tar -czf "$out.part" -C "$tmp" push.sqlite vapid_private.pem)
mv "$out.part" "$out"
ls -1t "$DEST"/sunshine-data-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
# Nur diese eine Zeile aus .env lesen (dort steht auch ADMIN_KEY); die URL nie ausgeben.
ping_url=$(sed -n 's/^BACKUP_PING_URL=//p' /srv/sunshine/.env 2>/dev/null | tail -1 | tr -d '"'"'" || true)
if [[ -n $ping_url ]]; then
  curl -fs -m 10 --retry 3 -o /dev/null "$ping_url" || echo "Erfolgs-Ping fehlgeschlagen (curl $?)"
fi
echo "Sicherung $out geschrieben"
