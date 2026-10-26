# 05 — OAuth and webhook security

## Threats, and what stops each one

| Threat | Defence | Test |
|---|---|---|
| Forged or replayed callback | The state is 32 random bytes, stored as SHA-256, valid for 10 minutes. It is consumed by a conditional update (`STARTED` → `AUTHORIZED` only while unexpired), so a second use finds nothing. | §2 "refuses an unknown state, a declined dialog, a replay and an expired state" |
| OAuth CSRF: attacker's state, victim signs in at Meta | The result is handed over only with **three** things together: the same signed-in user, the one-time claim code from the redirect, and the HTTP-only binding cookie set on the browser that started. The victim's browser has the claim but not the attacker's cookie. The attacker's browser has the cookie but never sees the claim. | §2 "…only to the same person in the same browser, once" |
| Another user or project using someone's attempt | Every step after the callback runs inside the project with the scoped client (another project's session is "not found") and checks `userId`. | §2 claim/choice tests |
| Code interception | The code is redeemed server-side with the app secret and the exact redirect URI. The secret never reaches a browser. | fake Meta refuses a mismatched redirect URI or secret |
| Open redirect | The callback redirects only to the `returnOrigin` + `returnPath` stored server-side when the person started. Those were derived from that request's own host, checked against a plain-host pattern and the SaaS host rules (OPEN or CUSTOMER only). Nothing in Meta's redirect chooses the destination. | §2 |
| Token leakage | User and Page tokens are `encryptSecret` envelopes. Page tokens are requested from Meta only at the moment of connecting. The user token lives at most 30 minutes, then is wiped. No view, action result, System Log entry or URL carries a token or the app secret (tested by searching them). Provider errors are redacted by `readMetaError`. | §3 "…connects Messenger and Instagram…" |
| Secret in the frontend or Git | `META_APP_SECRET` is read on the server only (`metaPlatformConfig`, `metaPlatformAppSecret`). `.env.example` carries empty keys. Diagnostics list variable **names**, never values, and only to a Main Admin. | shared `readMetaPlatformConfig` test |
| Forged webhook | HMAC-SHA256 of the raw body with `META_APP_SECRET`, compared in constant time; 401 otherwise. Bodies over 8 MB are refused. The GET handshake needs `META_WEBHOOK_VERIFY_TOKEN` (constant time) and echoes only `[A-Za-z0-9_-]{1,128}`. | §4 |
| Cross-tenant event injection | The project is never read from the payload. Each event is mapped by its account id to the single live PLATFORM row that holds it (database-unique), and recorded in **that row's** project. Unknown accounts, and accounts held only by a MANUAL connection, are dropped. | §4 "routes each account to its own project…" |
| The same Page in two workspaces | A partial unique index makes it impossible. The choice screen says "connected in another workspace" without naming it. A race between listing and saving surfaces as the same refusal (P2002). | §3, shared classification test |
| Duplicate webhook delivery | `ChannelInboundEvent` is unique on `(projectId, connectionId, dedupKey)` with `skipDuplicates`. | §4 (the same body twice) |
| Sending after revocation | Deauthorize → NEEDS_RECONNECT and the token is wiped. The send queue refuses NEEDS_RECONNECT or token-less connections at send time. The health check marks dead tokens. | §5 |
| Forged deauthorize or deletion | `signed_request` is HMAC-SHA256 with the app secret, constant time, and the algorithm must be HMAC-SHA256. 400 otherwise, and nothing changes. | §5, shared tests |
| Unauthorised person starting or finishing | `checkPermission("channels.manage")`, which also enforces the OMNICHANNEL feature, read-only projects and page-level project roles, at start, claim and connect. | §1, §3 |
| Abuse of the start endpoint | 20 attempts per person per hour. | — |
| A malicious page in a browser tab | Start is a top-level GET that only creates the person's own attempt. Choosing and connecting are Server Actions (origin-checked by Next). Cancel is a form post. | — |

## Least privilege

Requested: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`,
`instagram_manage_messages`. Nothing for posts, comments, ads, insights, leads or business
management. A Page is connectable only when the person's tasks allow both messaging and moderating
it (`hasPageRoleFor`).

## Cookies

| Cookie | Content | Flags |
|---|---|---|
| `softify-meta-oauth` | A random 32-byte binding value. The database stores only its hash. | HttpOnly, SameSite=Lax, Secure in production, path `/`, 40 min. Cleared at the claim. |

`SameSite=Lax` is needed: the claim is a top-level navigation arriving from Meta's domain via our
callback.

## Logging

The System Log records, in the connection's project:

- connected or refused (with the reason);
- cancelled;
- disconnected;
- health transitions;
- deauthorize and data-deletion effects.

No entry contains a token, a secret, a state, a claim or a code. The callback logs nothing of the
request itself.

## Not covered

- **mTLS on webhooks.** Meta documents mTLS for WhatsApp Business Account subscriptions only; the
  signature is the authentication here.
- **IP allow-listing of Meta's webhook senders.** Not done. The signature is required instead.
