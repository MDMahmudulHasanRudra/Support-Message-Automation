# Omnichannel inbox — Facebook Messenger, Instagram DM, Telegram

All Conversations puts every channel's conversations in one inbox beside WhatsApp, and adds a
dedicated inbox for each new channel. This file is the reference: the audit it started from, the
decisions and why, how each flow works, what each provider needs, what is tested, and what is not
built.

Status (11 Oct 2026): implemented and tested against mocked Meta and Telegram APIs on the isolated test
database. **Not yet tested with live credentials.** The feature is off by default in every project.

---

## 1. Audit — what existed (Phase 1)

| Area | Finding |
|---|---|
| Stack | pnpm monorepo. Next.js 16 App Router dashboard (`apps/web`), a Node worker (`apps/worker`), Prisma 5.22 / PostgreSQL 16 (`packages/db`), pure rules in `packages/shared`, Vitest. |
| Tenancy | Multi-project. `/p/<slug>/…`, a project-scoped Prisma client that refuses cross-project queries, worker work entered with `withProject` / `forEachProject`, and Phase 7 triggers (`enforce_same_project`, `enforce_project_immutable`) in PostgreSQL. |
| Auth | Session cookie → `User` → `PermissionModule` keys. Every server action checks for itself (`checkPermission` / `requireAccess` / `pageAccess`). Project features (`ProjectFeature`) gate modules. |
| WhatsApp | OpenWA (a WhatsApp Web automation library, i.e. an **unofficial** browser session) inside the worker, one Chromium per account. Incoming: a push listener → `processIncomingMessage` → `Message` → rules → AI fallback. Outgoing: `OutboundMessage` rows drained by the worker (`outboundQueueProcessor`). |
| Data model | WhatsApp-specific end to end: `Message` (required `accountId`, `whatsappMessageId`), `WhatsAppGroup`, `OutboundMessage`. About 40 readers assume every `Message` is WhatsApp: Team Report, attendance, support response tracking, Support Assignment, escalation, mood detection, conversation learning, Support Intelligence and more. There is no generic customer, contact or conversation table. |
| Real time | None: pages poll (`AutoRefresh`, every 4 s, paused while the tab is hidden). |
| Queues | Database rows claimed by `setInterval` loops in the worker, each with an overlap guard, plus per-loop liveness. No Redis or other broker. |
| AI | `runAiFallback` (worker): knowledge retrieval (BM25F over human-verified entries), query expansion, optional Forge research, an answer plan, the prompt, the response parser, and gates (response mode, a business-question guard no setting relaxes, confidence floors, an invented-procedure check, safety). Text-only `packages/ai-client`. Decisions are recorded in `AiFallbackDecision`, which references a WhatsApp `Message`. |
| Webhooks | None existed. The web app is the only process with a public port; the worker has none. |
| Secrets | `encryptSecret` / `decryptSecret` (AES-GCM, `AI_CREDENTIALS_ENCRYPTION_KEY`), already used for AI keys, Google tokens and Google OAuth clients. |
| Baseline before changes | `pnpm typecheck`: clean. `pnpm lint`: 0 errors, 8 warnings. `packages/shared` tests: 573 passed. The worker and web isolated suites passed in the previous session. |

**A conflict the brief asked to be written down.** The brief forbids "unofficial … browser-session"
APIs. The existing WhatsApp integration is exactly that, and the brief also requires it to be kept
working and not replaced without approval. It is kept unchanged. The prohibition is applied to the
**new** channels, which use only official APIs (Meta Graph API, Telegram Bot API).

## 2. Decisions

1. **New channels get their own four tables; WhatsApp is read from where it already is.** The brief
   prefers extending existing tables. Here that would mean making `Message.accountId` optional and
   adding Messenger rows to `Message`, and every one of its ~40 readers would then count them as
   WhatsApp messages: Team Report waits, attendance, "unanswered groups", Support Intelligence. That is
   the "silently changed feature" the brief rules out. The smallest change that changes nothing is
   four additive tables (`ChannelConnection`, `ChannelConversation`, `ChannelMessage`,
   `ChannelInboundEvent`) and a unified reader over both.
2. **No duplicate records.** The unified inbox reads WhatsApp through WhatsApp Chat's own functions
   (`getChatInbox` / `getChatConversations`). "Waiting", "seen" and the 300-row window mean the same
   thing in both places, and nothing is copied. A WhatsApp row opens the WhatsApp Chat thread, so
   WhatsApp replies keep their single existing path (`sendChatMessage` → `OutboundMessage`).
3. **One send queue for the new channels.** An outbound `ChannelMessage` row *is* the queue entry
   (QUEUED → SENDING → SENT → DELIVERED / READ, or FAILED / UNKNOWN). The thread and the queue
   therefore cannot disagree, and nothing sends except the worker.
4. **The web app receives webhooks, the worker processes them.** A webhook is verified, cut into
   events and recorded (`ChannelInboundEvent`, unique per provider event) on the request, so the
   provider is acknowledged in milliseconds and a worker restart loses nothing. Everything else runs
   in worker loops.
5. **Credentials per connection, per project**, entered by an admin on Settings → Messaging Channels,
   checked with the provider before saving, and stored encrypted. This is the same model as Google
   Sheets' per-project OAuth client. No platform OAuth app is needed, which also means no Meta App
   Review for the platform as a whole.
6. **AI reuses the WhatsApp answering logic.** It calls the same functions in the same order with the
   same thresholds. `runAiFallback` is untouched. One function in it, `sendHumanFallbackAlert`, was
   exported and made to accept a null WhatsApp message id, so channel handovers raise the same alert.
7. **Feature `OMNICHANNEL`, off by default.** New keys: `channels.view`, `channels.manage` and
   `conversations.reply`. Reading the inbox uses the existing `messages.view`. A migration grants
   `conversations.reply` to every custom role that already has `messages.reply`. A separate key is
   needed because `messages.reply` belongs to the WhatsApp Chat feature, and gating channel replies on
   it would make them depend on that feature.

## 3. How it works

### Inbound

```
Meta / Telegram ──POST──▶ /api/channels/<meta|telegram>/<webhookKey>          (apps/web, no session)
                           verify signature (Meta: X-Hub-Signature-256 HMAC with the app secret)
                                     or secret (Telegram: X-Telegram-Bot-Api-Secret-Token)
                           split the body into events (packages/shared splitMetaWebhook / telegramDedupKey)
                           route each event to the connection, IN THE KEY'S PROJECT, whose account it names
                           INSERT ChannelInboundEvent … ON CONFLICT DO NOTHING      → 200
worker  channel-inbound (2 s, per project with the feature on)
                           normalize (normalizeMetaEvent / normalizeTelegramUpdate)
                           message  → find/open ChannelConversation, INSERT ChannelMessage (unique provider id)
                           echo     → our own send (metadata / provider id / in-flight text) or a person
                                      in Meta Business Suite (stored as BUSINESS; AI paused)
                           receipt  → move our messages SENT → DELIVERED → READ, never back
                           other    → IGNORED, with the reason
worker  channel-ai (3 s)  → new customer messages ≤ 15 min old on connections with AI on (§4)
```

A Meta app has **one** callback URL for all its Pages and Instagram accounts. A body arriving at one
connection's URL is therefore routed to whichever connection in the same project (and the same app)
owns the account named in `entry.id`. An account no connection owns is dropped, never stored.

### Outbound

```
person presses Send ─▶ sendChannelReplyAction (conversations.reply) ─▶ queueChannelReply
                         connection on and connected? text valid for the channel? reply window open?
                         INSERT ChannelMessage QUEUED, idempotencyKey manual:<conversation>:<nonce>
                         conversation: preview, read, AI paused for the takeover period
worker  channel-outbound (2 s) ─ claim QUEUED→SENDING (conditional) ─ re-check connection, window,
                         and for AI the kill switch ─ send ─▶ SENT + provider id
                         temporary refusal → QUEUED + backoff (15 s, 1 m, 5 m, 15 m; 5 attempts)
                         dead credential  → FAILED, connection NEEDS_RECONNECT
                         other refusal    → FAILED with the reason
                         timeout after the request left → UNKNOWN (never retried by itself)
                         SENDING for > 5 min (worker died) → UNKNOWN
```

"Send again" re-queues a FAILED reply. An UNKNOWN reply is re-queued only after the person confirms
they checked the provider's app, because it may already have arrived.

### Reply windows (packages/shared `decideReplyWindow`)

| Channel | Rule |
|---|---|
| Messenger, Instagram | Within 24 h of the customer's last message: any reply (`RESPONSE`). From 24 h to 7 days: a **person** only, tagged `HUMAN_AGENT`, and only when the connection's "Human Agent permission approved" switch is on. After 7 days: nothing can be sent. AI never uses the tag. |
| Telegram | No window. A bot can only answer people who wrote to it, which is how every conversation here starts. |

## 4. AI on the new channels

The same answering functions as WhatsApp (`findRelevantKnowledge`, `expandQueryTerms`,
`researchForCustomerQuestion`, `buildAnswerPlan`, `buildFallbackPrompt`, `parseFallbackResponse`,
`validateGrounding`), applied in the same order with the same settings. AI answers only when **all**
of these hold; otherwise the message is recorded SKIPPED with the reason:

- the Omnichannel and AI-reply features are on;
- the kill switch is off and the mode is not MANUAL_ONLY;
- the AI engine and auto-responses are on;
- the connection is on and its own "AI may answer" switch is on;
- the conversation is 1:1. Never a Telegram group: the WhatsApp equivalent is an opted-in monitored
  group, and a bot answering every line of a group chat is the spam this product refuses to send;
- no person is handling it (`aiSuppressedUntil`, set when anyone replies from here or from Meta
  Business Suite);
- the provider allows an automated reply now;
- the message is at most 15 minutes old. A backlog processed after an outage never becomes a burst of
  replies;
- no newer customer message is waiting. A burst of lines gets one answer, to the last line, with the
  earlier lines as context.

On top of these, the per-customer AI cooldown and the hourly per-customer ceiling apply as on
WhatsApp. A handover raises the usual "AI assistance required" alert through `enqueueNotification`.
Each customer message is claimed exactly once (`aiClaimedAt`, set by a conditional update), and the
reply carries the idempotency key `ai:<message id>`.

## 5. Data model (migration `20261011091600_messaging_channels`)

| Table | Holds | Key constraints |
|---|---|---|
| `ChannelConnection` | one Page / Instagram account / bot: name, status, enabled, account ids, encrypted token, app secret, Meta verify token, Telegram webhook secret, AI and Human Agent switches, health fields | `webhookKey` unique (installation-wide); `(projectId, type, externalAccountId)` unique |
| `ChannelConversation` | one customer thread (or Telegram chat): customer identity, status OPEN/CLOSED, assignee (a user), last message, `lastInboundAt` (window), `reviewedAt` (read), `aiSuppressedUntil` | `(projectId, connectionId, externalThreadId)` unique |
| `ChannelMessage` | every message both ways; outbound rows carry the send-queue fields; inbound rows carry the AI decision | `(projectId, connectionId, externalMessageId)` unique (dedup); `(projectId, idempotencyKey)` unique |
| `ChannelInboundEvent` | each webhook event as received | `(projectId, connectionId, dedupKey)` unique; processed rows are deleted after 14 days |

The migration is additive only: no existing table is touched. Every relation has its Phase 7
`_same_project` trigger and every table has `_projectId_immutable`.
`20261011091700_permission_conversations_reply` inserts the three permission keys and the grant.
Identities are never merged across channels: a person writing on Messenger and on Telegram is two
conversations. Linking them would be a separate, explicit feature.

## 6. What each provider needs

### Facebook Messenger

- A Meta **Business** app with the Messenger product.
- The **App ID** and **App Secret** (App settings → Basic).
- A **Page access token** for the Page. A system user's token in Business Settings does not expire.
- Permissions: `pages_messaging` and `pages_manage_metadata` (for the subscription). Serving Pages the app's business does not own needs Meta **App
  Review** (Advanced Access). The **Human Agent** permission (7-day replies) needs its own App Review.
- Connecting checks the pair with Meta, reads the Page, and calls `POST /{page-id}/subscribed_apps`
  for `messages, message_echoes, message_deliveries, message_reads`.
- Manual step in the Meta app dashboard: Webhooks → Callback URL and Verify token (both shown on the
  connection page), subscribed to the same fields.
- Graph API version: `v25.0`, overridable with `META_GRAPH_API_VERSION`.

### Instagram DM

- Implemented through **"Instagram Messaging via the Messenger Platform"** (Facebook Login): an
  Instagram **professional** account linked to a Facebook Page, reached with the Page's token
  (`POST /{page-id}/messages`, recipient = Instagram-scoped id). Personal accounts are not supported
  by Meta.
- Permissions: `instagram_basic`, `instagram_manage_messages` (plus `pages_manage_metadata` for the
  subscription).
- In the Instagram app: Settings → Messages and story replies → Message controls → Connected tools →
  Allow access to messages.
- Text is limited to 1,000 **bytes**, so Bangla text runs out at roughly 330 letters. The composer
  counts bytes.
- **Not built:** "Instagram API with Instagram Login" (graph.instagram.com, no Page, 60-day user
  tokens that must be refreshed). It would be a second token type and a refresh job.

### Telegram

- A bot from **@BotFather** and its token. Connecting calls `getMe` and then `setWebhook` with a random
  `secret_token`. **The server must be reachable over HTTPS.** A bot has one webhook, so connecting it
  here replaces any other service's webhook for the same bot.
- A bot sees every group message only with privacy mode off (`/setprivacy`). Telegram reports no
  delivery or read status to bots, so the inbox never shows more than "Sent".
- Polling mode (`getUpdates`) is not built. Webhook only.

### TikTok — feasibility (not built)

TikTok's Business Messaging API exists but is in limited beta. It needs approval from TikTok, is not
available in every region (several providers report the US, the EEA, Switzerland and the UK as
excluded), only lets the customer start a conversation, and has a 48-hour reply window. There is no TikTok
Business account with API access here, so nothing was built. Settings → Messaging Channels says so
plainly; it is not presented as a channel. A data-export or portability permission is **not** messaging
access. With access granted, it would be a fourth `ChannelType` plus its own webhook and send
functions; nothing else changes.

## 7. Security

- **Webhooks** carry no session. A Meta POST needs the HMAC-SHA256 of the raw body with the app secret,
  compared in constant time. A Telegram POST needs the secret set at registration. The Meta GET
  handshake needs the verify token and echoes only an alphanumeric challenge. The URL key is 24
  random bytes. Bodies over 1 MB are refused.
- **Credentials** are `encryptSecret` envelopes and are decrypted in exactly two places: the web app's
  `server/channels/connections.ts` and the worker's send path. No view, action result or log contains
  a token, app secret or webhook secret (tested). The Meta verify token is shown only to
  `channels.manage`, because the admin has to paste it into Meta. Provider error text is redacted
  before it is stored (`access_token=…`, `bot<token>`).
- **Isolation**: every read and write goes through the project-scoped client, or names `"projectId"`
  in raw SQL. An event is routed only within its key's project. Phase 7 triggers refuse cross-project
  rows in PostgreSQL itself (tested).
- **Message content is untrusted.** It reaches the AI only as the customer message inside the existing
  prompt, whose rules (business-question guard, knowledge-only grounding) are unchanged. The AI has no
  tools.
- **Attachments** are stored as references only. A provider link is rendered only when it is http(s),
  as `rel="noopener noreferrer nofollow"`.

## 8. Screens

- **Support → All Conversations** (`/conversations/all`): channel tabs (All, WhatsApp, Messenger,
  Instagram, Telegram), filters (Open, Unread, Needs reply, Assigned to me, Closed), a last-activity
  window, and a search across names and message text that runs on the server over every
  conversation.
- **Support → Facebook Messenger / Instagram DM / Telegram** (`/conversations/<channel>`): the same
  rows, filtered. A channel nobody has connected shows how to connect one.
- **Conversation** (`/conversations/<scope>/c/<id>`): the thread (delivery state, AI decisions,
  "Send again"), the composer (character or byte count, Human Agent notice, drafts), and Close /
  Reopen, Assign to me, Resume AI.
- **Settings → Messaging Channels** (`/settings/channels`): connections per channel, connect
  (`/settings/channels/new`), and per connection (`/settings/channels/<id>`): switches, rename,
  webhook URL and verify token, Test connection, replace credentials, disconnect. Disconnecting keeps
  history and cancels replies still waiting.

## 9. Not built, or limited (deliberately)

- Sending attachments. Customers' attachments are shown as links (Meta) or named (Telegram file ids
  are not public links).
- Importing history from before a connection was made.
- WhatsApp threads open in WhatsApp Chat rather than inside the unified layout.
- The AI Activity log lists WhatsApp decisions only. A channel's AI decision is shown on the message in
  its thread.
- The "unable to understand" holding reply and the in-conversation team mention are WhatsApp-only.
- Assignment is to oneself (Assign to me / Take over / Unassign), not to any user.
- A Messenger delivery receipt that arrives before the send's own response is not applied; a later
  read receipt still moves the message to Read.

## 10. Tests

| Suite | What | Result |
|---|---|---|
| `packages/shared` `channels.test.ts` | windows, text limits (bytes for Instagram), webhook splitting and dedup keys, normalising Meta and Telegram events, receipts only forward, error reading and redaction, backoff | 26 passed |
| `packages/shared` `projects.test.ts` | the feature catalogue with `OMNICHANNEL` | passed |
| `apps/web` `channels.integration.test.ts` | connect / refuse / encrypt (fake Meta and Telegram), webhook signature, secret and handshake, dedup, cross-project routing, the unified inbox (merge, scopes, filters, search, isolation, feature gate), reply idempotency, window, Human Agent tag, byte limit, retry, disconnect and reconnect | 22 passed |
| `apps/worker` `channels.integration.test.ts` | event → conversation, replay, out-of-order, ignored events, Telegram private and group, bots, feature off; echoes (metadata, in-flight, Business Suite); receipts; the send queue (backoff, dead credential, UNKNOWN, stuck, window at send time, Human Agent tag, kill switch); AI (once, handover, takeover, burst, group, kill switch, business guard) | 19 passed |

Regression, after the change (isolated database): `apps/worker` 96 files / 1,108 tests passed;
`apps/web` 40 files / 535 tests passed (these include every existing WhatsApp, AI fallback, isolation,
integrity and raw-SQL-guard suite); `packages/shared` 599 passed; `pnpm typecheck` clean; `pnpm lint`
0 errors and the same 8 warnings as before; `pnpm build` (web and worker) succeeded. The new screens
have been type-checked, linted and built, but not yet looked at in a browser.

Every new test was checked against deliberately broken code (one mutation at a time, see §10.1) and
failed as it should. All tests use mocked providers. **None of this proves live connectivity**; see
§12.

### 10.1 Mutation check

Each line is one deliberate defect, applied alone, with the suite that must catch it:

| Defect introduced | Caught |
|---|---|
| web: webhook signature not checked · provider retry not deduplicated · routing ignores the project · Telegram secret not checked · inbox SQL not scoped to the project · reply nonce ignored · reply window not checked · disconnect leaves queued replies · a user token accepted as a Page token | all 9 caught |
| worker: replayed message stored twice · older event overwrites a newer preview · echo metadata ignored · in-flight echo not matched · Business Suite reply does not pause AI · bot message given to AI · feature off still processed · unknown outcome retried · stuck sends not recovered · window not re-checked at send · AI reply sent after the kill switch · dead credential does not mark the connection · AI claim not exclusive · AI answers group chats · AI ignores human takeover · AI answers every line of a burst · AI kill switch ignored · business guard removed · strict mode answers ungrounded | all 19 caught |
| shared: AI may use the Human Agent tag · Instagram counted in characters · token not redacted in a Meta error · delivery dedup key order-dependent | all 4 caught |
| worker: receipt applied without `advanceDeliveryStatus` | not caught — an equivalent mutant: the query already excludes READ rows, so nothing can move backwards either way |

The user-token check was first NOT caught (the fake Meta errored before the check ran); a test with a
token Meta answers without `category` was added and now catches it.

## 11. Deploying

1. Back up the database.
2. Run the two migrations (`pnpm db:migrate:deploy`, or the compose `migrate` service). They are
   additive and lock nothing that exists. Then deploy `app` and `worker`.
3. Main Admin → Projects → a project → Features → **Omnichannel inbox** on.
4. Settings → Messaging Channels → connect. For Meta, then paste the Callback URL and Verify token into
   the app's Webhooks settings.
5. `NEXTAUTH_URL` must be the public **https** address: webhook URLs are built from it, and Telegram
   refuses anything else.

Optional environment variable: `META_GRAPH_API_VERSION` (default `v25.0`).

**Rollback.** Switching the feature off stops all processing and sending. Webhooks are still recorded,
so nothing is lost, and the backlog is processed when it is switched back on; AI answers nothing older
than 15 minutes. Before any channel has been connected, the migrations can be reverted by dropping the
four tables and nine types and deleting the three permission rows. After that, roll forward instead:
the tables hold customers' conversations.

## 12. Still needs live verification

- A real Meta app: credential check, Page subscription, the webhook handshake, a real message in, a
  reply out, echoes, delivery and read receipts, and the Human Agent tag once approved.
- A real Instagram professional account linked to a Page, including the 1,000-byte limit with Bangla
  text.
- A real Telegram bot behind the production HTTPS address.
- App Review status for `pages_messaging`, `instagram_manage_messages` and Human Agent, if Pages the
  business does not own are to be served.
