# Domain migration: getassist.pro → chithii.com, Caddy → nginx (Nov 2026)

getassist.pro is expiring. Every address on it moves to chithii.com, and the server's reverse proxy moves
from Caddy to nginx. This file is the record of what changed and the checklist of what only the owner
can change (provider dashboards).

## Status (13 Nov 2026, 17:40 UTC)

| Done | Item |
|---|---|
| ✅ | Certificates for all 8 hostnames (Let's Encrypt, valid to Feb 2027); `certbot renew --dry-run` passes for all 8 |
| ✅ | Cutover at 17:33:07 UTC: nginx active and enabled on boot, Caddy stopped and disabled |
| ✅ | `app.`, `admin.`, `noorvip.chithii.com` serve the app over HTTPS; HTTP → HTTPS (308) |
| ✅ | `demo.`, `admin.`, `noorvip.getassist.pro` pages → 301 to the new address; `/api/…` still reaches the app |
| ✅ | Meta webhook verify handshake answers on `admin.chithii.com` and `admin.getassist.pro` |
| ✅ | Database addresses switched; `.env` `NEXTAUTH_URL` and `VAPID_SUBJECT` switched, app recreated |
| ⬜ | Owner: the dashboard checklist below (Meta, Google, Telegram, website chat) |
| ⬜ | `META_OAUTH_REDIRECT_URI` → `admin.chithii.com` (after the Meta redirect URI is added) |
| ⬜ | Remove the getassist.pro addresses (last section) before the domain expires |

## Address map

| Old address | New address | What it is |
|---|---|---|
| `demo.getassist.pro` | `app.chithii.com` | Customer "MD Mahmudul Hasan Rudra" (projects `getassistadmindemo`, `get-assist-project-1`) — the marketing site's **Sign in** |
| `admin.getassist.pro` | `admin.chithii.com` | The Platform console, and the Meta app's OAuth / webhook / data-deletion callbacks |
| `noorvip.getassist.pro` | `noorvip.chithii.com` | Customer #1, Noor VIP (the founding customer: projects `noor-vip`, `isp-digital`); also `NEXTAUTH_URL` |
| `zoventio.udboy.com`, `admin.udboy.com` | unchanged | Older addresses, still served as before |

DNS (Cloudflare, zone chithii.com): `app`, `admin` and `noorvip` are A records → `201.18.218.251`, **DNS only
(grey cloud)**. Keep them grey: certificates are issued and renewed by certbot on the server over HTTP.

Project addresses (slugs such as `getassistadmindemo`) are deliberately unchanged: a slug is in every bookmark
and shared link and is never editable (BRANDING.md).

## What changed on the server

- **nginx** replaces Caddy on :80/:443. Config: `/etc/nginx/conf.d/00-chithii.conf` (gzip, upload limit 100 MB,
  upstream), `/etc/nginx/snippets/chithii-proxy.conf` (proxy headers, websockets/SSE, 1 h timeouts),
  `/etc/nginx/sites-available/chithii.conf` (every site). Security headers still come from the app
  (`apps/web/next.config.ts`); Caddy added none of its own.
- `X-Forwarded-For` is **overwritten** with the client address, never appended — the sign-in rate limit trusts
  its first entry (`server/authRateLimit.ts`), as it did behind Caddy.
- **Certificates:** Let's Encrypt via certbot (webroot `/var/www/certbot`), one per hostname, renewed by
  `certbot.timer`; `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` reloads nginx after a renewal.
- **Customer addresses added later** (Caddy's on-demand TLS has no nginx equivalent): `chithii-domain-certs.timer`
  runs `/usr/local/sbin/chithii-domain-certs` every 5 minutes. It reads the same list `/api/platform/tls-allowed`
  approves (VERIFIED/ACTIVE customer domains + admin hostnames), gets a certificate for any that points at the server
  and has none, and writes its nginx site in `/etc/nginx/chithii-customers/`. A new address is reachable over plain
  HTTP at once (so Platform → Check now can verify it) and over HTTPS within ~5 minutes of being VERIFIED; press
  Check now again to make it ACTIVE. Log: `journalctl -u chithii-domain-certs`.
- **The getassist.pro addresses** answer with a permanent redirect to the new address, except machine traffic —
  `/api/…` (webhooks, OAuth and payment callbacks), `/p/<project>/api/…` and the website-chat widget `/c/<key>` —
  which keeps reaching the app until every provider below is switched (a redirect drops a POST body).
- **Database:** `app.chithii.com` and `noorvip.chithii.com` added as ACTIVE customer domains; the two getassist.pro
  domains set to VERIFIED (still routed, never handed out in new links, because `pickCustomerOrigin` prefers ACTIVE);
  admin hostnames are now `admin.chithii.com, admin.getassist.pro, admin.udboy.com` (the first is the one shown in links).
- **.env:** `NEXTAUTH_URL=https://noorvip.chithii.com`, `VAPID_SUBJECT=mailto:support@chithii.com`, and — once the Meta
  dashboard has the new redirect URI — `META_OAUTH_REDIRECT_URI=https://admin.chithii.com/api/meta/oauth/callback`.
- Scripts used: `~/chithii-migration/` on the server, copied into this repository as `scripts/nginx/` (`01-prepare.sh`, `02-cutover.sh`, `rollback.sh`, the nginx files, the certificate timer and the SQL files).
  Caddy's config and data were backed up to `/root/caddy-backup-<UTC time>/` (path in `/root/caddy-backup-latest`).

### Rollback

```bash
sudo bash ~/chithii-migration/rollback.sh
```

Stops and disables nginx and the certificate timer, restores the original Caddyfile from the backup, and enables and
starts Caddy again. Certificates in `/etc/letsencrypt` are kept. The database and `.env` changes work under Caddy too.

## Checklist — dashboards only the owner can reach

Do these now. The old addresses keep forwarding webhooks only until getassist.pro expires.

### Meta App Dashboard (developers.facebook.com → the Chithii app, `META_APP_ID` in `.env`)

| Where | Old | New |
|---|---|---|
| App settings → Basic → App domains | `getassist.pro` (or its subdomains) | add `chithii.com`, `admin.chithii.com`, `app.chithii.com`, `noorvip.chithii.com`; remove getassist.pro entries after the switch |
| App settings → Basic → Privacy policy URL | getassist.pro privacy page | `https://chithii.com/privacy` |
| App settings → Basic → Terms of Service URL | getassist.pro terms page | `https://chithii.com/terms` |
| App settings → Basic → User data deletion | getassist.pro page or callback | callback `https://admin.chithii.com/api/meta/data-deletion` (or instructions URL `https://chithii.com/data-deletion`) |
| App settings → Basic → Website / Site URL | `https://getassist.pro` | `https://chithii.com` |
| Facebook Login for Business → Settings → Valid OAuth Redirect URIs | `https://admin.getassist.pro/api/meta/oauth/callback` | add `https://admin.chithii.com/api/meta/oauth/callback` (keep the old one until the `.env` switch is verified, then remove it) |
| Facebook Login for Business → Settings → Deauthorize callback URL | `https://admin.getassist.pro/api/meta/deauthorize` | `https://admin.chithii.com/api/meta/deauthorize` |
| Facebook Login for Business → Settings → Data Deletion Request URL | `https://admin.getassist.pro/api/meta/data-deletion` | `https://admin.chithii.com/api/meta/data-deletion` |
| Webhooks (Page, Instagram, WhatsApp Business Account) → Callback URL | `https://admin.getassist.pro/api/meta/webhook` | `https://admin.chithii.com/api/meta/webhook` — **Verify token unchanged** (`META_WEBHOOK_VERIFY_TOKEN`, do not paste it anywhere else) |
| Messenger / Instagram / WhatsApp product → Webhooks (if set per product) | same as above | same as above |
| App Review / Business Verification notes that mention getassist.pro | — | update the URLs to chithii.com |

After saving the redirect URI, tell the engineer: `META_OAUTH_REDIRECT_URI` is then switched in `.env` and the app
restarted, and one "Connect with Facebook" is tried from `admin.chithii.com`.

### Google Cloud console (APIs & Services → Credentials → each OAuth 2.0 Client used by a project)

Both Google configurations belong to the founding customer, so both now use `noorvip.chithii.com`:

| Project | Authorized redirect URI (old → new) | Authorized JavaScript origin (old → new) |
|---|---|---|
| `noor-vip` | `https://noorvip.getassist.pro/api/google/oauth/callback` → **add** `https://noorvip.chithii.com/api/google/oauth/callback` | `https://noorvip.getassist.pro` → add `https://noorvip.chithii.com` |
| `isp-digital` | same as above (its own client, if different) | same |

Then in each project: Settings → Google Sheets → the client shows the redirect URI it expects; it must match. Remove the
getassist.pro URIs once a Google connect works on the new address. OAuth consent screen: change the Application home
page, Privacy policy and Terms links to `https://chithii.com`, `/privacy`, `/terms`, and the authorized domain to
`chithii.com`.

### Telegram (bot of project `getassistadmindemo`)

Sign in at `https://app.chithii.com`, open the project → Settings → Channels → the Telegram connection → **Update token**,
leave the token empty and save. That re-registers the webhook (`setWebhook`) at
`https://app.chithii.com/api/channels/telegram/<key>` with the saved token. Until then it keeps arriving through the old
address.

### Website chat (the widget script on customers' websites points at the old address)

| Website | Project | Do |
|---|---|---|
| `noorvip.net` | `noor-vip` | Signed in at `noorvip.chithii.com`: Settings → Channels → Website chat → copy the install code again (or download the WordPress plugin again and update it) and replace it on the site |
| `mahmudulhasanrudra.online` (and `www.`) | `getassistadmindemo`, `get-assist-project-1` | Same, signed in at `app.chithii.com` |

The script tag's `src` is the only thing that changes. Pages that set `window.GetAssistChat` keep working; new code uses
`window.ChithiiChat`.

### Nothing to change (checked 13 Nov 2026)

- Payment gateways (SSLCOMMERZ, bKash): none configured. When one is added, its success/fail/cancel/IPN URLs are
  generated on the new address.
- Shopify / WooCommerce connections: none. Outbound API webhooks (Settings → API): none — their headers are now
  `X-Chithii-Event`, `X-Chithii-Event-Id`, `X-Chithii-Delivery`, `X-Chithii-Signature`.
- Microsoft Teams: outbound only.
- Cloudflare: nothing beyond the three DNS records.

## When every item above is done (before getassist.pro expires)

1. Platform → Customers → disable `demo.getassist.pro` and `noorvip.getassist.pro`; Platform → Settings → remove
   `admin.getassist.pro` from the admin addresses.
2. On the server: remove the three getassist.pro `server` blocks and names from `/etc/nginx/sites-available/chithii.conf`,
   `sudo nginx -t && sudo systemctl reload nginx`, then `sudo certbot delete --cert-name demo.getassist.pro` (and the
   `admin.` and `noorvip.` ones) so renewal stops trying them.
3. `grep -ri getassist ~/Support-Message-Automation/.env` must print nothing.

## Internal names that still say Get Assist / getassist (on purpose)

Never shown to anyone, and renaming them breaks something real:

- Project slugs `getassistadmindemo`, `get-assist-project-1` (bookmarks and links).
- Website-chat browser storage key `getassist-chat-<key>` (renaming loses every visitor's open conversation), the
  widget's DOM ids/attributes, internal events and the `getassist-preview` message type.
- WordPress plugin folder `getassist-chat/` and option names `getassist_chat_*` (renaming makes an update install a
  second plugin and loses its settings). Its visible name is "Chithii Chat"; the download is now `chithii-chat.zip`.
- Log-reference HMAC salt `get-assist/log-trace/v1` and the console-redaction symbol (renaming splits log history).
- Service-worker cache name `get-assist-offline-v1`, the backup folder `~/backups/get-assist`, and the
  `docs/get-assist-ultimate/` folder (referenced by applied migrations, which must never be edited).
