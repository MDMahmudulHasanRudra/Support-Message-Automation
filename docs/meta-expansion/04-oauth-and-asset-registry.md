# 04 — OAuth gateway and asset registry

Status: **proposal.** Builds on the messaging OAuth that already works (`server/channels/metaOAuth.ts`).

## 1. One gateway, separate consents

The platform Meta app is one app, but each capability asks for its own consent, through its own Facebook Login
for Business configuration (`config_id`), never one combined request:

| Capability | Configuration | Permissions | Token |
|---|---|---|---|
| Messaging (Messenger, Instagram DM) | `META_LOGIN_CONFIG_ID` (exists) | `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages` (+ `business_management` per App Review) | Page token |
| Publishing (Social Studio) | `META_SOCIAL_LOGIN_CONFIG_ID` (exists, undocumented in env) | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` | Page token / IG via Page |
| Comments & insights (Release C) | new `META_ENGAGEMENT_LOGIN_CONFIG_ID` | `pages_manage_engagement`, `pages_read_user_content`, `read_insights`, `instagram_manage_comments`, `instagram_manage_insights` (names to confirm in App Review) | Page token |
| WhatsApp Official (Release B) | Embedded Signup `config_id` | `whatsapp_business_management`, `whatsapp_business_messaging` | BISU business token |
| Ads read / Lead Ads (Release D) | new configs | `ads_read`; `leads_retrieval`, `pages_manage_ads`, … | BISU or user→system user |

## 2. Fixing Social Studio on customer addresses (G1)

Adopt the messaging pattern, which already works across hosts:
1. Start on the customer host: `visitorOrigin`, host scope OPEN/CUSTOMER, DB session row with hashed state +
   hashed browser binding, HttpOnly binding cookie on the customer host.
2. Callback on the platform host (`https://admin.getassist.pro/api/meta/oauth/callback` — the SAME redirect URI
   as messaging, so no new URI is registered): no session needed; single-use state; code exchange; one-time
   hashed claim; redirect to `returnOrigin`.
3. Claim on the customer host: same user + claim + binding cookie, single use; then Social Studio's existing
   discovery (`saveMetaDiscovery`) runs inside the project.

Changes: `MetaOAuthPurpose` gains `SOCIAL_CONNECT` (migration); `completeMetaCallback` chooses claim path and
landing page by purpose; Social Studio's start route switches to the session row; `/api/social/meta/callback`
is kept for one release as a fail-closed redirect ("start again") so old in-flight attempts end cleanly, then
removed. Existing `SocialConnection`/`SocialAccount` rows and history are untouched. The Meta dashboard keeps
only the one redirect URI (document the removal of the Social callback URI after the release).

## 3. Asset registry — reuse, don't duplicate

Decision: **no new generic registry table yet.** The capability grants already live where they are used:
- messaging → `ChannelConnection` (`grantedScopes`, `pageTasks`),
- publishing → `SocialConnection` / `SocialAccount`,
- WhatsApp Official → `ChannelConnection` (`WHATSAPP_CLOUD`, `wabaId`),
- ads/leads (Release D) → new `MetaAdAccount` / `MetaLeadForm` tables.

A read-only view (`server/meta/assets.ts`) lists one workspace's Meta assets across these tables for the
Integration Center. The same Page may have a messaging grant and a publishing grant in the same workspace; the
installation-wide partial unique stays **per capability** (one live messaging row per Page, one live publishing
row per Page), so two workspaces can never both hold the same Page for the same capability.

A dedicated `MetaIntegrationAudit` is not needed: every grant/revoke/reconnect writes the System Log.

## 4. Token lifecycle
- Encrypted with `encryptSecret`; decrypted only in the provider modules.
- Page tokens (from long-lived user tokens) do not expire; BISU tokens default to non-expiring. The health loop
  detects revocation (`/me`, `subscribed_apps`) and marks NEEDS_RECONNECT; add a Notification Center event for it (G8).
- Deauthorize / data-deletion callbacks extend to WhatsApp Official and ads connections.
