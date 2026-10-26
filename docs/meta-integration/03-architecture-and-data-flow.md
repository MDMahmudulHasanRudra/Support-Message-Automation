# 03 — Architecture and data flow

"Connect with Facebook" adds one way to **create** a Messenger or Instagram connection. Everything after
that — webhook ingestion, the worker's event processing, the inbox, the send queue, AI replies — is the
existing Omnichannel module (`OMNICHANNEL.md`). A connection now has an `authMode`:

| | MANUAL (unchanged) | PLATFORM (new) |
|---|---|---|
| Meta app | The project's own | The platform's one app (environment) |
| Customer enters | App ID, App Secret, Page token | Nothing — signs in at Facebook |
| App secret stored | Encrypted on the row | Never stored; `META_APP_SECRET` |
| Webhook URL | `/api/channels/meta/<key>` per connection, pasted by the admin | `/api/meta/webhook`, set once by the operator |
| Routing | The URL key → connection → project (siblings by app id, MANUAL only) | The account id in the event → the one live PLATFORM row holding it |
| Same account in two projects | Allowed (two different apps) | Refused by a partial unique index |
| Reconnect | Paste new credentials | "Reconnect with Facebook" |

## Components

```
apps/web
  server/channels/metaOAuth.ts        the flow: start, callback, claim, choice, connect, cancel
  server/channels/metaRevocation.ts   deauthorize and data-deletion callbacks
  server/channels/providerApi.ts      + code exchange, long-lived token, /me, /me/permissions, /me/accounts
  server/channels/webhookIngest.ts    + ingestPlatformMetaWebhook (manual ingest now matches MANUAL siblings only)
  server/channels/connections.ts      PLATFORM-aware view, disconnect, health check, switch back to manual
  app/p/[project]/api/meta/connect    start (customer's address)
  app/api/meta/oauth/callback         Meta's redirect (the one registered URI)
  app/p/[project]/api/meta/claim      hand-back (customer's address)
  app/api/meta/webhook                platform webhook (GET handshake, POST events)
  app/api/meta/deauthorize            Meta's deauthorize callback
  app/api/meta/data-deletion          Meta's data-deletion callback + status
  settings/channels/OneClickPanel     the "Connect with Facebook" card
  settings/channels/meta/[sessionId]  the choice screen
apps/worker
  channels/metaHealth.ts              scheduled health check, abandoned-attempt expiry
  channels/providerApi.ts             + metaGraph helper, metaAppSecretFor
  channels/outboundProcessor.ts, inboundProcessor.ts   the app secret of a PLATFORM row comes from the environment
packages/shared
  metaPlatform.ts                     config reading, required scopes, asset classification, signed_request
packages/db
  ChannelConnection + authMode, metaOAuthSessionId, metaUserId, grantedScopes, pageTasks
  MetaOAuthSession, MetaDataDeletionRequest
```

## Connecting

```
customer address (signed in, channels.manage, OMNICHANNEL on)
  GET /p/<slug>/api/meta/connect?type=MESSENGER
    MetaOAuthSession STARTED {stateHash, browserBindingHash, returnOrigin, returnPath, expires +10 min}
    Set-Cookie softify-meta-oauth=<binding> (HttpOnly, Lax)
    303 → https://www.facebook.com/<v>/dialog/oauth?client_id&redirect_uri&state&(config_id|scope)
Meta dialog: the person signs in, picks Pages / Instagram accounts, grants permissions
  303 → META_OAUTH_REDIRECT_URI?code&state           (any address this installation serves)
GET /api/meta/oauth/callback        (no session needed)
    STARTED → AUTHORIZED, conditional on status + expiry (single use); expires +30 min
    code → short token → long-lived token; /me; /me/permissions
    store: metaUserId, name, token (encrypted), scopes, claimHash
    303 → <returnOrigin>/p/<slug>/api/meta/claim?c=<claim>
GET /p/<slug>/api/meta/claim        (customer address)
    same user + claim hash + binding cookie hash; claimedAt set once; cookie cleared
    303 → /p/<slug>/settings/channels/meta/<sessionId>
choice screen
    /me/accounts (no Page tokens) → classifyMetaAssets → AVAILABLE / CONNECTED_HERE / MANUAL_HERE /
    CONNECTED_ELSEWHERE / MISSING_PERMISSION / MISSING_PAGE_ROLE / NO_INSTAGRAM
Connect (server action, channels.manage)
    /me/accounts WITH Page tokens → re-classify → for each ticked, still-selectable account:
      /me with the Page token (must be that Page) → Instagram still linked → POST /{page}/subscribed_apps
      create or update the ChannelConnection: authMode PLATFORM, token encrypted, no app secret,
      new webhookKey (retires a manual URL); CONNECTED only if subscribed, else ERROR
      P2002 from the partial unique index → "connected in another workspace"
    session COMPLETED, user token wiped; one System Log entry per account
```

## Receiving

```
Meta → POST /api/meta/webhook  (X-Hub-Signature-256 with META_APP_SECRET over the raw body, ≤ 8 MB)
  splitMetaWebhook (shared, unchanged) → events with entry.id
  PLATFORM rows, status ≠ DISCONNECTED, (type, externalAccountId) — at most one per account
  ChannelInboundEvent in THAT row's project, createMany skipDuplicates  → 200 EVENT_RECEIVED
  anything else (unknown account, manual connection's account) → dropped, counted in the log
worker channel-inbound → channel-ai → channel-outbound   (unchanged)
```

The project is never taken from the payload. It is the project of the connection row the account
id maps to, and that row was created inside the project by a person with `channels.manage`.

## Sending

Unchanged: `ChannelMessage` QUEUED → the worker. The only difference is where the app secret for
`appsecret_proof` comes from (`metaAppSecretFor`). A PLATFORM row with NEEDS_RECONNECT or no token is
refused at send time exactly like a manual one, so nothing is sent after authorisation is revoked.

## Health

- **Scheduled** (worker `meta-connection-health`, every 5 min, at most 10 connections per project
  per tick, each at most every 6 h): Page token accepted → Instagram still linked → Page still
  subscribed to the platform app (resubscribed once if Meta dropped it). Dead token →
  NEEDS_RECONNECT. Network / Meta outage → nothing changes.
- **On demand:** "Test connection" on a connection's page, the same checks, without resubscribing.
- **Revocation:** Meta's deauthorize callback → every PLATFORM row that person authorised →
  NEEDS_RECONNECT, token wiped. Data deletion → the same, plus their Facebook id and name are erased.
- **No refresh job**, deliberately. Page tokens obtained from a long-lived user token have no
  expiry date; the user token itself is kept at most 30 minutes.

## AI

Untouched. `channels/aiReply.ts` runs the WhatsApp answering functions with the same gates. A
one-click connection's "AI may answer" switch is off when it is created, exactly like a manual one.
A Business Suite reply still arrives as an echo and pauses AI. The `HUMAN_AGENT` tag is never used by
AI.

## What does not change

- WhatsApp (OpenWA, `Message`, `OutboundMessage`, every report): no file touched.
- Telegram: no file touched.
- Manual Meta connections: same routes, same secrets, same behaviour. One deliberate tightening:
  manual sibling routing now ignores PLATFORM rows. Such a row has never existed before this change.
