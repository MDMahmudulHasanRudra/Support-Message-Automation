#!/usr/bin/env bash
# Puts the platform Meta app's credentials into the server's .env for the gate B test
# (docs/meta-integration/10-gate-b-runbook.md). Run it ON THE SERVER, in the repository folder:
#
#   bash scripts/meta-gate-b-credentials.sh <internal-test-project-id>
#
# The App Secret is typed hidden and goes only into .env: it is never printed, logged or sent anywhere.
# It does NOT switch the integration on (META_INTEGRATION_ENABLED stays empty) and restarts nothing.
# Activation is a separate, deliberate step in the runbook.
set -euo pipefail

ENV_FILE=".env"
PROJECT_ID="${1:-}"
if [[ ! -f "$ENV_FILE" ]]; then echo "Run this in the repository folder (no $ENV_FILE here)." >&2; exit 1; fi
if [[ ! "$PROJECT_ID" =~ ^[a-z0-9_]{10,40}$ ]]; then echo "Give the internal test workspace's project id as the first argument." >&2; exit 1; fi

read -rp "Meta App ID: " APP_ID
read -rsp "Meta App Secret (hidden): " APP_SECRET; echo
read -rp "Facebook Login for Business configuration ID (Enter to skip): " CONFIG_ID

[[ "$APP_ID" =~ ^[0-9]{5,20}$ ]] || { echo "The App ID must be the app's numeric id. Nothing was changed." >&2; exit 1; }
[[ "$APP_SECRET" =~ ^[A-Fa-f0-9]{32}$ ]] || { echo "The App Secret must be the 32-character secret. Nothing was changed." >&2; exit 1; }
[[ -z "$CONFIG_ID" || "$CONFIG_ID" =~ ^[0-9]{5,25}$ ]] || { echo "The configuration ID must be numeric. Nothing was changed." >&2; exit 1; }

mkdir -p ~/backups
BACKUP=~/backups/env-before-meta-$(date -u +%Y%m%d-%H%M%S)
cp "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"

set_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# Keep an existing verify token, so a webhook already saved at Meta keeps matching.
TOKEN=$(grep -E '^META_WEBHOOK_VERIFY_TOKEN=.+' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
[[ -n "$TOKEN" ]] || TOKEN=$(openssl rand -hex 24)

set_var META_INTEGRATION_ENABLED ""
set_var META_APP_ID "$APP_ID"
set_var META_APP_SECRET "$APP_SECRET"
set_var META_WEBHOOK_VERIFY_TOKEN "$TOKEN"
set_var META_OAUTH_REDIRECT_URI "https://admin.getassist.pro/api/meta/oauth/callback"
set_var META_LOGIN_CONFIG_ID "$CONFIG_ID"
set_var META_ALLOWED_PROJECT_IDS "$PROJECT_ID"
chmod 600 "$ENV_FILE"

echo
echo "Saved. The previous .env is at $BACKUP"
echo "Still OFF: META_INTEGRATION_ENABLED is empty, and nothing was restarted."
echo
echo "For Meta's webhook form (Page and Instagram), once the integration is switched on:"
echo "  Callback URL: https://admin.getassist.pro/api/meta/webhook"
echo "  Verify token: $TOKEN"
