#!/usr/bin/env bash
# Rollback: back to Caddy exactly as it was before the move. sudo bash ~/chithii-migration/rollback.sh
# Leaves nginx installed but stopped and disabled; certificates in /etc/letsencrypt are kept.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
# The FIRST backup holds the Caddyfile from before the move (a re-run of 01-prepare backs up the modified one).
BACKUP="$(ls -d /root/caddy-backup-2* 2>/dev/null | sort | head -1)"
systemctl disable --now chithii-domain-certs.timer 2>/dev/null || true
systemctl stop nginx 2>/dev/null || true
systemctl disable nginx 2>/dev/null || true
if [ -n "$BACKUP" ] && [ -f "$BACKUP/etc-caddy/Caddyfile" ]; then
  cp "$BACKUP/etc-caddy/Caddyfile" /etc/caddy/Caddyfile
  echo "Caddyfile restored from $BACKUP"
fi
systemctl enable caddy
systemctl start caddy
sleep 2
echo "caddy: $(systemctl is-active caddy)   nginx: $(systemctl is-active nginx)"
curl -s -o /dev/null -m 15 -w 'https://demo.getassist.pro/login -> %{http_code}\n' https://demo.getassist.pro/login
