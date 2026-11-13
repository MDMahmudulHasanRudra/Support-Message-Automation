#!/usr/bin/env bash
# Step 2: the cutover. Run as root ONLY after the go-ahead: sudo bash ~/chithii-migration/02-cutover.sh
# Stops Caddy and starts nginx back to back (a few seconds without a listener on :80/:443), then checks
# every site. If nginx does not start or app.chithii.com does not answer, it puts Caddy back by itself.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

nginx -t || { echo "nginx -t failed — nothing changed."; exit 1; }

echo "== Cutover $(date -u +%H:%M:%S) UTC"
systemctl stop caddy && systemctl start nginx
started=$?
echo "== nginx start exit $started at $(date -u +%H:%M:%S) UTC"

ok=1
[ "$started" = 0 ] || ok=0
if [ "$ok" = 1 ]; then
  sleep 2
  code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' https://app.chithii.com/login)"
  echo "   https://app.chithii.com/login -> $code"
  [ "$code" = 200 ] || ok=0
fi

if [ "$ok" != 1 ]; then
  echo "!! Check failed — rolling back to Caddy"
  bash "$HERE/rollback.sh"
  exit 1
fi

systemctl disable caddy
systemctl enable nginx
systemctl enable --now chithii-domain-certs.timer
systemctl enable --now certbot.timer 2>/dev/null || true

echo "== Checks"
for u in https://app.chithii.com/login https://admin.chithii.com/ https://noorvip.chithii.com/login \
         https://zoventio.udboy.com/login https://admin.udboy.com/ \
         https://demo.getassist.pro/login https://admin.getassist.pro/ https://noorvip.getassist.pro/login \
         http://app.chithii.com/login; do
  printf '   %-42s %s\n' "$u" "$(curl -s -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "$u")"
done
echo "   caddy: $(systemctl is-active caddy) / $(systemctl is-enabled caddy)   nginx: $(systemctl is-active nginx) / $(systemctl is-enabled nginx)"
echo
echo "== certbot renew --dry-run"
certbot renew --dry-run 2>&1 | tail -15
echo
echo "DONE. Rollback any time: sudo bash $HERE/rollback.sh"
