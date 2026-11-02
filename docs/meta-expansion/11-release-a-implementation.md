# 11 — Release A and B1: what was built

Written for whoever reviews, deploys or continues this work. Branch `feature/meta-expansion`, starting at `rudra`
6cbbaab. Each work package is its own commit. Nothing here has been tried against real Meta (that is Gate B).

## A1 — "WhatsApp (Legacy)"
- **What changed:** words on screen only. `LEGACY_WHATSAPP_LABEL` in `packages/shared/src/channels.ts` names the
  OpenWA channel in these places:
  - the sidebar module and the Settings section;
  - the All Conversations tab, channel mark and account filter;
  - the Messaging Channels card;
  - the module setup step.
- **What did not change:**
  - inbox scope `whatsapp`, routes, feature keys, permission keys, report keys, tables, enums and worker code;
  - page titles such as "WhatsApp Chat";
  - "WhatsApp" as a client's contact channel (Clients, Commerce).
- **One subtlety:** project-role module ids were slugged from the sidebar label. The group now carries
  `id: "whatsapp"`, so saved page access means what it did.
- **Tests:** `legacyWhatsAppLabel.test.ts` pins every identifier. It failed 5 of 6 before the change. The existing
  suites (inbox, Team Report parity snapshot, worker pipeline) are the evidence that behaviour is unchanged.

## A2 — Social Studio connects from any customer address
The Social Studio flow now goes through the same handover as messaging:

| Step | Where | Guard |
|---|---|---|
| Start | `/p/<slug>/api/social/meta/connect` on the customer address | OPEN/CUSTOMER host, `social.manage` + SOCIAL_STUDIO, allowlist, rate limit, state hashed, cookie `softify-meta-social-oauth` |
| Meta returns | `/api/meta/oauth/callback` (the ONE registered URI) | single-use state, 10 min TTL, code redeemed server-side, token encrypted |
| Back | the address the attempt started from (stored on the row) | never taken from the request, so not an open redirect |
| Claim | `/p/<slug>/api/social/meta/claim` | same user, same browser cookie, same address, same project, once, purpose SOCIAL_CONNECT only |

How the two grants stay separate:
- Messaging and publishing use different scopes and configurations (`META_SOCIAL_LOGIN_CONFIG_ID`).
- Each claim route refuses the other flow's attempt.
- A publishing attempt cannot open the messaging choice screen.
- The messaging claim now also checks the arrival address.

Compatibility:
- Existing `SocialConnection` rows are untouched, and the next connect updates them in place.
- `/api/social/meta/callback` is retired to a start-again stub. Remove it from the Meta app's redirect URIs after
  deploying.

Migration: `20261101140000_meta_oauth_social_purpose` (one enum value).

## A3 — hygiene
- **Reconnect notifications.**
  - New Notification Center event `CHANNEL_NEEDS_RECONNECT`, with its own template, Notification Center card and
    team-member opt-in.
  - The worker's `sweepReconnectAlerts` (inside the 5-minute `meta-connection-health` loop, per OMNICHANNEL project)
    announces each NEEDS_RECONNECT connection once, whatever marked it, and works with or without a platform app.
  - The new column `ChannelConnection.reconnectAlertedAt` is claimed conditionally. It is cleared when the connection
    recovers, so the next breakage is announced again.
  - Migrations: `20261101150000_notification_event_channel_reconnect`, `20261101150100_channel_reconnect_alerted_at`.
- **Explicit channel types.** `isMetaChannelType` is an allow-list for every Meta route, the webhook verify, and the
  Facebook reconnect. The old checks excluded only Telegram, so a website-chat connection was treated as Meta.
- **Webhook payloads.** Bodies are read with a streaming cap (`readWebhookBody`). Before, a chunked body without
  Content-Length was buffered whole first. Limits are unchanged: 1 MB manual, 8 MB platform.
  - A signed body that is not `{ object, entry[] }` → 400, nothing recorded.
  - An object we do not handle (e.g. `whatsapp_business_account`) → 200, nothing recorded, one warning per process.
- **Environment.** `META_SOCIAL_LOGIN_CONFIG_ID` is now passed to the app container and documented in
  `.env.example`. Before, it was read by the code but never passed by Compose.
- **Graph API version.**
  - One reader, `metaGraphVersion`. It was three raw copies; a malformed value is now ignored instead of being put
    into URLs.
  - One `META_PAGE_WEBHOOK_FIELDS` constant.
  - The default stays **v25.0**, deliberately.

### Graph API v26.0 review (1 Nov 2026)
**Source:** Meta's v26.0 changelog, released 29 Jul 2026.

**Areas checked.** No v26.0 breaking change targets anything Get Assist calls:
- the login dialog and `oauth/access_token`;
- `/me`, `/me/accounts` and `/me/permissions`;
- `subscribed_apps`;
- Messenger and Instagram send;
- Page and Instagram publishing;
- insights.

**Protocol-wide changes.** These apply to every version from 27 Oct 2026:
- `pretty`, `debug` and `If-None-Match` are ignored;
- `date_format` and root `?ids=` requests are errors.

A search of the Meta code found none of these in use.

**Recommendation.** Move to v26.0 by setting `META_GRAPH_API_VERSION=v26.0` on staging during Gate B, and re-run the
Gate B checks. Then change the default in code in its own commit.

## B1 — explicit provider dispatch (foundation only)
**What it is.** `packages/shared/src/channelProviders.ts` names every messaging provider: META_MESSENGER,
META_INSTAGRAM, TELEGRAM, WEBCHAT and WHATSAPP_CLOUD.
- WHATSAPP_CLOUD is listed, NOT implemented, and maps to no channel type.
- Each decision is an exhaustive `switch` with a `never` check. A new provider or channel type fails to compile
  until every place below has handled it.

**Where it decides:**
- **Webhook objects** (`classifyMetaWebhookObject`, used by both Meta webhooks):
  - `page` goes to Messenger and `instagram` to Instagram.
  - `whatsapp_business_account` is refused by name: acknowledged, recorded nowhere, logged once.
  - Anything else is unknown.
- **Recorded events** (`routeInboundEvent`, in the worker's inbound processor): an event is read only by its own
  connection's provider, and for Meta only with the same channel type.
  - A WhatsApp Cloud event, a missing provider or a mismatch is **FAILED** with the reason, never retried, never
    PROCESSED, and creates no conversation or message.
  - Before B1, anything that was not Telegram or website chat went to the Meta normaliser.
- **Sends** (`providerForChannelType`, in the worker's outbound processor): an unimplemented provider sends nothing
  and says so. Meta is a named case, no longer the `else`.
- **Connection test** (web): only Telegram and Meta connections reach a provider check.

**Not built here, by design:**
- no `WHATSAPP_CLOUD` channel type or migration (that is B2);
- no Embedded Signup;
- no sending;
- no billable action.

WhatsApp (Legacy) is not a provider in this file and never passes through it.

## Tests added
| File | Count | Confirmed to fail without the code |
|---|---|---|
| web `legacyWhatsAppLabel.test.ts` | 6 | yes (5 fail) |
| web `socialMetaOAuth.integration.test.ts` | 13 | yes (origin + flow checks removed → 3 fail) |
| web `metaWebhookHardening.integration.test.ts` | 7 | yes (Telegram-only check restored → 1 fails) |
| worker `channelReconnectAlert.integration.test.ts` | 5 | yes (stamp removed → 3 fail) |
| shared `metaPlatform.test.ts` (+2) | 19 | — |
| shared `channelProviders.test.ts` (B1) | 5 | — (pure; pins the mapping and the refusals) |
| worker `channelProviderDispatch.integration.test.ts` (B1) | 3 | yes (old inbound processor → 2 fail: the WhatsApp Cloud event was stored as a Messenger message) |
