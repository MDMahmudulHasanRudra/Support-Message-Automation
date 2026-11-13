#!/usr/bin/env bash
# Step 1 of the Caddy -> nginx move. Run as root: sudo bash ~/chithii-migration/01-prepare.sh
# Changes NOTHING users can see: Caddy keeps serving. It backs up Caddy, installs nginx + certbot
# (nginx is NOT started), lets Caddy hand ACME challenges to certbot, gets one certificate per
# hostname, writes the nginx config and checks it with `nginx -t`. Safe to run again.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="/root/caddy-backup-$STAMP"
EMAIL="support@chithii.com"

# Every hostname Caddy serves today, plus the three new ones.
NEW_HOSTS="app.chithii.com admin.chithii.com noorvip.chithii.com"
OLD_HOSTS="demo.getassist.pro admin.getassist.pro noorvip.getassist.pro"
KEEP_HOSTS="zoventio.udboy.com admin.udboy.com"

FIRST="$(ls -d /root/caddy-backup-2* 2>/dev/null | sort | head -1)"
if [ -n "$FIRST" ]; then
  # Only the first run saw the original Caddyfile; later runs would back up the modified one.
  echo "== 1/6 Caddy already backed up before the move: $FIRST"
else
  echo "== 1/6 Back up Caddy (config, certificates, unit) to $BACKUP"
  mkdir -p "$BACKUP"
  cp -a /etc/caddy "$BACKUP/etc-caddy"
  [ -d /var/lib/caddy ] && tar -C /var/lib -czf "$BACKUP/var-lib-caddy.tgz" caddy
  systemctl cat caddy > "$BACKUP/caddy.service.txt" 2>/dev/null || true
  ls -la "$BACKUP"
fi

echo "== 2/6 Install nginx and certbot without starting nginx (Caddy holds :80/:443)"
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx certbot
rm -f /usr/sbin/policy-rc.d; trap - EXIT
systemctl disable nginx >/dev/null 2>&1 || true
nginx -v

echo "== 3/6 Let Caddy serve ACME challenges from /var/www/certbot (graceful reload, no downtime)"
mkdir -p /var/www/certbot/.well-known/acme-challenge
chmod -R 755 /var/www/certbot
cp "$HERE/Caddyfile.acme" /etc/caddy/Caddyfile
if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cp "$BACKUP/etc-caddy/Caddyfile" /etc/caddy/Caddyfile; echo "Caddyfile invalid, original restored."; exit 1
fi
systemctl reload caddy
echo ok > /var/www/certbot/.well-known/acme-challenge/chithii-probe
for h in $NEW_HOSTS $OLD_HOSTS $KEEP_HOSTS; do
  printf '   %-24s challenge path: ' "$h"
  curl -s -m 10 "http://$h/.well-known/acme-challenge/chithii-probe" || echo "NOT REACHABLE"
done
rm -f /var/www/certbot/.well-known/acme-challenge/chithii-probe

echo "== 4/6 Certificates (Let's Encrypt, HTTP-01 via webroot; you accept the LE subscriber agreement)"
for h in $NEW_HOSTS $OLD_HOSTS $KEEP_HOSTS; do
  certbot certonly --webroot -w /var/www/certbot -d "$h" --cert-name "$h" \
    --non-interactive --agree-tos --email "$EMAIL" --keep-until-expiring --quiet \
    && echo "   $h: certificate ok" || { echo "   $h: CERTIFICATE FAILED"; exit 1; }
done
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl is-active --quiet nginx && systemctl reload nginx || true\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "== 5/6 nginx config"
# Ubuntu sets server_tokens in nginx.conf; turn it off there (any uncommented server_tokens line, whatever precedes it).
sed -i -E 's/^[^#]*server_tokens[[:space:]]+[a-z]+;/	server_tokens off;/' /etc/nginx/nginx.conf
install -m 644 "$HERE/nginx/00-chithii.conf" /etc/nginx/conf.d/00-chithii.conf
install -m 644 "$HERE/nginx/chithii-proxy.conf" /etc/nginx/snippets/chithii-proxy.conf
install -m 644 "$HERE/nginx/chithii-acme.conf" /etc/nginx/snippets/chithii-acme.conf
install -m 644 "$HERE/nginx/chithii-sites.conf" /etc/nginx/sites-available/chithii.conf
ln -sfn /etc/nginx/sites-available/chithii.conf /etc/nginx/sites-enabled/chithii.conf
rm -f /etc/nginx/sites-enabled/default
mkdir -p /etc/nginx/chithii-customers
install -m 755 "$HERE/chithii-domain-certs" /usr/local/sbin/chithii-domain-certs
install -m 644 "$HERE/chithii-domain-certs.service" /etc/systemd/system/chithii-domain-certs.service
install -m 644 "$HERE/chithii-domain-certs.timer" /etc/systemd/system/chithii-domain-certs.timer
systemctl daemon-reload

echo "== 6/6 nginx -t"
nginx -t
echo
echo "PREPARED. Caddy is still serving. Next: sudo bash $HERE/02-cutover.sh (after the go-ahead)."
