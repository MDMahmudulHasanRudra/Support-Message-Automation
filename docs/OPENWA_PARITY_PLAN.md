# Bringing OpenWA's functionality into Softify Assist — what it would take

Written 16 Oct 2026 against rmyndharis/OpenWA@`078b8aa` (MIT) and our worker's engine,
`@open-wa/wa-automate` 4.76. This is the plan and the decisions it needs.

**Built since (16 Oct 2026, behind `CHAT_UI_V2`, not yet verified on a live number):** delivery and
read receipts, deleted-message events, live history on demand ("Load earlier from WhatsApp"), polls,
locations, stickers (stored WebPs only), forward, star, and pin/archive on the phone —
`CHAT_RICH_MESSAGING.md`. The rows below still describe the state before that.

## 1. The short answer

"All of OpenWA" is not one feature. OpenWA is a **WhatsApp API gateway**: a public REST API, API keys,
webhooks, an AI-agent (MCP) endpoint, plugins and two WhatsApp engines, with a small dashboard on top.
Softify Assist is a **support product**: rules, AI answers, escalation, Team Report, roles, projects.
Roughly a third of OpenWA we already have (often in a stronger form), a third we can add on our current
engine, and a third depends on two decisions only you can make:

1. **Which WhatsApp engine** — stay on wa-automate (optionally buying its Insiders licence), or add
   whatsapp-web.js, the engine OpenWA uses by default. This decides received reactions, edit events,
   LID → phone mapping and on-demand history.
2. **Whether Softify Assist should also become a gateway** — a public API, webhooks and MCP for other
   systems. That is a product decision, not a missing feature.

Every item below follows the rules that already protect the business number: one outbound queue,
no cold messaging, rate limits, project isolation, permissions, idempotency, tests that fail first,
new behaviour off by default, and **live verification on a dedicated lab number** before production.

## 2. Feature-by-feature

Status: ✅ we have it · 🟡 partly · ❌ not built.
Engine: what our current engine (wa-automate 4.76) allows — *public*, *Insiders* (paid licence),
*experimental*, or *not available*.
Effort: rough working days for one experienced developer, including tests; lab verification extra.

### 2.1 Gateway core

| OpenWA | Ours | What to build | Engine | Effort |
|---|---|---|---|---|
| REST API for everything | ❌ (the dashboard uses Server Actions; no public API) | `/api/v1/…` routes for sessions, chats, messages, groups, contacts — every send still writes `OutboundMessage`; OpenAPI/Swagger document | — | 15–25 |
| API keys (admin / operator / viewer) | ❌ (users + roles only) | `ApiKey` table (hashed, project-scoped, role, expiry, last used), create/revoke page, audit | — | 5–7 |
| Session-scoped and chat-scoped keys | ❌ (we scope by project, role and page) | `allowedAccounts` / `allowedChats` on a key, enforced in one guard, refusal by default | — | 4–6 |
| IP allow-list (CIDR), per-key rate limits | ❌ | On the API key; reuse the app's rate limiting | — | 2–3 |
| Webhooks with HMAC signature and filters | ❌ (we only send alerts to Teams / WhatsApp groups) | `Webhook` + `WebhookDelivery` tables, signed POSTs from the worker, retry with backoff, delivery log page, event filters | — | 8–12 |
| MCP server for AI agents | ❌ (we have the in-app AI Admin Assistant instead) | `/mcp` endpoint over the same API keys, read-only tools first, write tools behind the queue | — | 5–8 |
| Plugins (Chatwoot, Typebot), n8n nodes | ❌ | Only after the API + webhooks exist; most integrations are then configuration | — | 10+ each |
| Multi-session | ✅ multi-account, per project | — | — | — |
| Dashboard | ✅ (far broader) | — | — | — |
| Audit log | ✅ System Logs | — | — | — |
| Health checks | ✅ `/health`, `/metrics`, watchdog | — | — | — |

### 2.2 Messaging

| OpenWA | Ours | What to build | Engine | Effort |
|---|---|---|---|---|
| Text send / receive | ✅ | — | public | — |
| **Delivery and read receipts** | ❌ (SENT means "WhatsApp accepted it") | `onAck` listener → `OutboundMessage.deliveredAt / readAt` (+ the echo's `Message`), ✓✓ and blue ticks in Chat, a "read" figure in reports | public (`onAck`) | 4–6 |
| **Media sending** (image, video, document, voice note) | ❌ (text only by design) | Upload in the composer → media storage → `OutboundMessage.mediaId` → `sendImage` / `sendFile` / `sendPtt` in the worker; size/type limits; same rate limits | public (tagging inside a caption is Insiders) | 8–12 |
| Media receiving | ✅ (own decrypt, storage, gallery) | — | — | — |
| Reactions — send | 🟡 built in Chat v2 (needs lab verification) | Verify on a lab number | public | 1 |
| Reactions — **receive** | ❌ | `onReaction` → `MessageReaction` table → show everyone's reactions; optional REACTION support trigger | **Insiders** (or whatsapp-web.js) | 4–6 after the engine decision |
| Edit — send | 🟡 command exists, no UI | Edit action on own messages in Chat v2 | experimental — most accounts lack it | 2–3 |
| Edit — **receive** (`message.edited`) | ❌ | Store the edit beside the original (never overwrite), show "edited" | **not available** on wa-automate (whatsapp-web.js has it) | 3–5 after the engine decision |
| Delete — receive | ❌ | `onMessageDeleted` → mark "deleted for everyone", keep the original text for audit | public | 3–4 |
| Delete — send | ❌ (deliberately) | Only if wanted: "delete for everyone" on own recent messages, audited | public (`deleteMessage`) | 2–3 |
| Quoted replies, mentions | ✅ Chat v2 (lab verification pending) | Reply + mentions together needs Insiders or another engine | stub in wa-automate | — |
| Bulk messaging | ✅ Broadcast (with stricter safety) | — | — | — |
| Polls, location, contact cards, link previews | ❌ | Each is a composer option → queue → worker call | polls public; location public (address/url Insiders); link preview Insiders | 2–4 each |
| Forward, star, pin, archive on WhatsApp | ❌ (our archive/pin are inbox-only) | Optional mirror to WhatsApp | public (mute is Insiders) | 1–2 each |
| Send pacing / warm-up for new numbers | 🟡 rate limits, not age-based | Daily cap that grows with an account's age, separate cap on new conversations, failure breaker | — | 3–4 |

### 2.3 Groups, contacts, calls, channels

| OpenWA | Ours | What to build | Engine | Effort |
|---|---|---|---|---|
| Create / join / add / promote | ✅ | — | public | — |
| Remove, demote, set description, invite link get/revoke | ❌ | Admin actions with confirmation + audit, on the Groups page | public (setting the **title** is Insiders) | 4–6 |
| Group events (participants changed, settings changed) | ❌ | `onParticipantsChanged` / `onGroupChange` → keep the group's member list and history current | public (removed-from-group is Insiders) | 4–6 |
| Labels | ❌ | Sync WhatsApp Business labels into our categories (`getAllLabels`, `onLabel`, `addLabel`) | public | 4–6 |
| Contacts: block, profile, about | 🟡 read only | Block/unblock with audit | public | 2–3 |
| Calls: received events, reject, auto-reject | ❌ (calls not recorded at all) | `onIncomingCall` → a real call log (replaces the text-inferred Call Activity report) ; **reject is not available** on our engine | public (receive only) | 3–4 |
| Channels / newsletters | ❌ | Read channels the number follows; posting is a separate decision | partly public | 5–8 |
| Status / stories | ❌ | Not recommended | restricted | — |
| Catalog, products, orders | ❌ | Only for WhatsApp Business shops | **Insiders** | — |
| Per-account proxy | ❌ | Proxy URL on an account → Chromium launch args | public (launch option) | 2–3 |

### 2.4 Identity, history and real time

| OpenWA | Ours | What to build | Engine | Effort |
|---|---|---|---|---|
| LID ↔ phone mapping table | ❌ (deliberately — our engine gives no evidence) | `IdentityLink` table filled only from engine-supplied evidence, never guessed | **needs whatsapp-web.js** (or Baileys) | 5–8 after the engine decision |
| Live history on demand | ❌ (we show what was collected) | "Load older from WhatsApp" for one chat, stored once, never automated | whatsapp-web.js has a history call; wa-automate only `loadEarlierMessages` (public, unverified) | 4–6 |
| Real-time WebSocket events | ❌ (4 s polling) | Server-Sent Events from the web app, fed from the database (no Redis needed at our scale), project/account-scoped | — | 6–10 |
| Typing / recording indicators | ❌ | Show "typing…" in Chat | **Insiders** | 2–3 after the licence |

### 2.5 Infrastructure

| OpenWA | Ours | Plan |
|---|---|---|
| PostgreSQL | ✅ | — |
| SQLite | ❌ | Not needed |
| Redis cache | ❌ | Evaluated in PHASE2.md Stage 8 — no measured need |
| S3 / MinIO media | ❌ (local volume) | `S3MediaStorage` behind the existing `MediaStorage` interface: 4–6 days |
| Data migration between back-ends | ❌ | Not needed |
| Docker | ✅ | — |
| Two engines, chosen by setting | ❌ | See §3 |

## 3. The engine decision (the one that unlocks the rest)

| | A. Stay on wa-automate | B. Buy wa-automate Insiders | C. Add whatsapp-web.js | D. Add Baileys |
|---|---|---|---|---|
| What it unlocks | Everything marked *public* above | + received reactions, typing, removed-from-group, group title, caption tags, link previews | Received reactions, edits, receipts, LID mapping, history, labels — OpenWA's default engine | Same as C, low memory |
| Cost | none | Licence fee per number (open-wa.io pricing) | 6–10 weeks: a second `WhatsAppProvider`, its linking/QR flow, group sync, health checks, media; every number **re-linked by QR** | Like C |
| Risk to live numbers | none | none (same engine) | Re-linking risk; new failure modes; runs side by side per account during migration | **Higher ban risk** (OpenWA's own README says so) — not for the number serving customers |
| Our recommendation | Do all of §2 marked *public* first | Cheapest route to the remaining chat features | Only if a lab trial shows it is clearly more stable, or if a licence is not an option | No |

The provider abstraction (`WhatsAppProvider`) already isolates the engine, so C is a new class, not a
rewrite of the product — but it is still the largest item here, and it should start as a lab spike.

### 3.1 Option E: GOWA (aldinokemal/go-whatsapp-web-multidevice), reviewed 16 Oct 2026

- **What it is:** MIT-licensed, written in Go, about 4.9k stars, actively maintained (v9.6.0, pushed 15 Oct 2026).
- **Engine:** it runs on **whatsmeow**, which speaks WhatsApp's multi-device protocol directly with no browser. That puts it in the same class as Baileys (option D):
  - low memory and no Chromium;
  - it is not a web-client automation, so the ban-risk caveat in D applies.
- **What it offers:** a REST gateway with:
  - multi-device;
  - QR, pairing-code and passkey login;
  - signed webhooks (per device, filtered by event and JID);
  - MCP and Chatwoot;
  - scheduled sends;
  - media, polls, stickers;
  - edit, revoke, react, forward, star;
  - **call reject**;
  - group admin (remove, demote, name, photo, join requests, announce/lock);
  - newsletters;
  - **request older chat history**.
- **Webhook events:** message, reaction, revoked, edited, ack, deleted, presence, group participants, labels, newsletters, call offers. That covers almost every engine-dependent row in §2.4 and the Insiders-only rows in §2.2.
- **How it would fit:** as a separate container behind a new `GowaProvider`. Commands go over REST and events come in by webhook, then into the same pipeline. Its own auto-reply and auto-mark-read must stay **off**, and every send still comes from our `OutboundMessage` queue.
- **Storage:** sessions live in SQLite (or Postgres) inside GOWA, so it needs its own volume and backup.
- **Recommendation:** evaluate it in the Phase B lab spike alongside Insiders and whatsapp-web.js, on a lab number only. Do not run it on a customer number until it has run for weeks without a ban warning. Its README itself points production users to the official Business Platform.

## 4. Suggested order

**Phase A — current engine, no licence (≈ 5–7 weeks).** One lab-number check per item before it
ships, each behind a project feature switch, off by default.
1. Delivery and read receipts (✓✓ / blue ticks, read figures).
2. Deleted-message events (keep the original, mark it).
3. Media sending from the chat composer (images, documents, voice notes).
4. Call log from `onIncomingCall` (turns the inferred Call Activity report into a real one).
5. Group admin actions (remove, demote, description, invite link) and group membership events.
6. Labels sync into chat categories.
7. Real-time updates over Server-Sent Events in place of the 4 s poll.
8. Per-account proxy, send warm-up pacing, S3 media storage.

**Phase B — engine decision (1–2 weeks).** Lab spike: wa-automate Insiders vs a whatsapp-web.js
provider on the same lab number, measured on link time, stability over a week, memory, and the
features in §2.4.

**Phase C — engine-dependent (≈ 3–5 weeks).** Received reactions, edit events, typing, LID mapping,
on-demand history — on whichever engine B chooses.

**Phase D — only if Softify Assist should be a gateway (≈ 6–10 weeks).** Public API v1 + API keys
(account- and chat-scoped, IP allow-list, rate limits) + OpenAPI, signed webhooks with a delivery log,
MCP endpoint; then n8n / Chatwoot connectors.

**Not recommended:** Baileys on customer numbers, posting statuses, SQLite, back-end migration tools,
OpenWA's Docker-management page, copying OpenWA's code wholesale (MIT allows it with the notice, but
it is written for NestJS/TypeORM and would not fit our project isolation and permission model).

## 5. What we need from you

1. **A dedicated lab WhatsApp number** — every engine feature is verified there first, never on a
   customer number.
2. **Gateway or not?** Do you want a public API / webhooks / MCP (Phase D)?
3. **Licence or engine?** Are you open to buying the wa-automate Insiders licence, or should Phase B
   evaluate whatsapp-web.js?
4. **Order** — which Phase A items matter most to the support team.
