# 07 — Security and permissions

## 1. Secrets
- Platform secrets (`META_APP_SECRET`, verify token, `META_*` config ids) live only in server env; never in a
  response, log line, System Log metadata or the browser.
- Customer tokens (Page, BISU, user) are stored only as `encryptSecret` envelopes and decrypted only in the
  provider modules. Views never carry a token.
- Customers never paste platform secrets or shared tokens. Manual mode (their own app) stays for compatibility.

## 2. OAuth
Signed/hashed single-use state, browser binding cookie (HttpOnly, Lax, Secure), one-time claim, fixed return
origin taken from the start request (never from Meta's redirect), same user on start/claim, rate limit 20/h,
10-minute TTL, user tokens wiped when the attempt ends. Embedded Signup uses a server-issued nonce bound the same way.

## 3. Product permissions (Get Assist side)
| Feature flag (project) | Approval | Keys |
|---|---|---|
| `OMNICHANNEL` (exists) | plan | `channels.view`, `channels.manage`, `conversations.reply` |
| `WHATSAPP_OFFICIAL` (new) | **manualOnly → platform ModuleApproval** (billable) | reuses `channels.*`; new `channels.send_template` |
| `SOCIAL_STUDIO` (exists, manualOnly) | platform approval | `social.*` (+ new `social.engage`) |
| `META_ADS` (new, manualOnly) | platform approval | `meta_ads.view`, `meta_ads.manage` |
| `META_LEADS` (new) | plan | reuses `sales.*` |
| `META_CONVERSIONS` (new, manualOnly) | platform approval | `meta_conversions.manage` |

Every new action calls `checkPermission` with its feature; new pages go in `SECTION_RULES`; the highest-risk
actions (template send, ad changes) name their own page (`sections`).

## 4. Tenant isolation
Project-scoped Prisma client, `$queryRaw` naming `"projectId"`, Phase-7 same-project triggers on every new
relation, installation-wide partial unique per asset per capability, routing only from authorised rows.

## 5. Reliability
Bounded retries with backoff, UNKNOWN never auto-retried for anything customer-visible or billable, overlap-guarded
loops, health checks, Notification Center event on NEEDS_RECONNECT, per-loop liveness.

## 6. Billable safety
No billable request (template send, ad change) without an explicit person action and a confirmation that names
the cost owner. No billable feature is on by default; module approval by a platform operator is required.
