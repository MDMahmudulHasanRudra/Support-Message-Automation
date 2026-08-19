# Architecture

This is the condensed, durable design reference. It was locked in Phase 0 with a small,
deliberately narrow scope; the system has since grown substantially (multi-account routing, the
rule engine, Priority-Based Support Escalation, Conversation Learning, AI Learning foundations,
Support Activity Tracking, and a floating AI Admin Assistant). The component boundaries and
web⇄worker coordination model described here are still exactly how the system works — only the
model list and provider interface have grown. For an exhaustive, page-by-page functional
reference, see **`PROJECT_REFERENCE.md`**. Treat any phase numbering below as historical, not
current status — see `README.md` for current status.

## Components

- **apps/web** — Next.js (App Router) dashboard. Server-rendered; reads/writes Postgres directly
  via Prisma (`packages/db`) in server components, mutations go through `"use server"` Server
  Actions. Runs the rule engine (`packages/engine`) in-process for the dry Rule Tester — no worker
  call, so a dry test cannot send anything. No client-side data layer, no REST API beyond two
  narrow exceptions: `/api/health` and `/api/support-activity/export` (a file download can't be
  triggered from a Server Action). Also hosts a floating **AI Admin Assistant** chat widget
  (`apps/web/src/server/aiAdmin/`) — a read-only, tool-calling admin chatbot, separate from the
  worker's AI-assisted Conversation Learning path.
- **apps/worker** — dedicated Node/TS process. The **only** process that owns the OpenWA browser
  session(s). Runs the incoming message pipeline, the outbound queue processor, the notification
  dispatcher, a `WorkerCommand` poller, Priority Support Escalation's tick loop, and Conversation
  Learning's three background jobs.
- **packages/db** — Prisma schema, migrations, seed, and a `PrismaClient` singleton, imported by
  both apps. Ships as raw TypeScript with no build step; `packages/db/src/` has a hard rule of zero
  relative imports between its own files (Node and Turbopack have resolved one differently before,
  causing a real outage).
- **packages/engine** — pure, side-effect-free rule evaluation (matchers, priority resolution,
  explainable decision trace, deterministic pattern-detection scoring). One implementation,
  imported by both apps, so the dashboard's dry tester and the worker's live pipeline can never
  drift apart. Regex matching is safety-bounded: patterns are validated and rejected at save-time,
  and evaluated only under a runtime timeout, so no administrator-authored pattern can hang the
  worker.
- **packages/ai-client** — a thin, deliberately text-only Claude (Anthropic) completion wrapper.
  Its `AiClient.complete()` has no tool-use/function-calling and no Prisma/WhatsApp access — that
  absence is a structural safety guarantee for its only caller, the worker's optional AI-assisted
  Conversation Learning analysis job. The unrelated AI Admin Assistant (real tool-calling) is
  intentionally **not** built on this package — see below.
- **packages/shared** — enums/types shared by all of the above (message direction, rule status,
  automation mode, etc.) — the source of truth since `packages/engine` can't depend on
  `@prisma/client`; Prisma schema enums are kept in sync by convention, not tooling.

## Web ⇄ Worker: no direct HTTP

The dashboard and worker never call each other. All coordination goes through Postgres:

- **Worker → Dashboard**: the worker writes `WhatsAppAccount.status`, `qrCode`, `lastHeartbeatAt`
  on every state change; the dashboard polls these columns.
- **Dashboard → Worker**: actions needing the live browser session (reconnect, fetch QR, resync
  groups, logout, fetch a single group's participant count, on-demand AI analysis batch) are
  inserted as rows into `WorkerCommand`; the worker polls (every 1.5s, strictly serial) and
  executes them.
- **Kill switch**: `AutomationSettings.automationEnabled`, re-read by the worker every processing
  tick. Pausing it also cancels any pending `GROUP_BROADCAST`-type outbound messages.

This removes an entire class of Docker networking problems, keeps the worker as the sole owner of
every OpenWA session, and means every cross-process interaction already has a DB row with a status
field (duplicate prevention/idempotency comes largely for free).

## Multi-account & service routing

The worker can own more than one WhatsApp session (`ProviderRegistry` holds one `OpenWAProvider`
per `accountId`, connected **sequentially at boot, never concurrently** — OpenWA's `connect()` does
a process-global `process.chdir()`, so concurrent connects race). Exactly one `WhatsAppAccount` may
be `isPrimary` at a time (enforced by a hand-written partial unique index, not expressible in the
Prisma DSL). Three real WhatsApp-sending call sites are individually routable to a specific account
via `WhatsAppServiceRoute` (keyed on a closed `WhatsAppServiceKey` enum: `NOTIFY_WHATSAPP`,
`PRIORITY_SUPPORT`, `CONVERSATION_LEARNING`), each with its own fallback policy
(`PRIMARY_FALLBACK` or `STRICT_NO_FALLBACK`). `resolveWhatsAppAccount(serviceKey)`
(`packages/db`) is the single centralized resolver every sending feature must call — never
re-derive the Primary/pinned/fallback decision at the call site.

## WhatsApp provider abstraction

```ts
interface WhatsAppProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): ConnectionStatus;
  getGroups(): Promise<GroupInfo[]>;
  subscribeToMessages(handler: (msg: RawIncomingMessage) => void): void;
  sendMessage(chatId: string, body: string): Promise<SendResult>;
  getAccountInfo(): Promise<AccountInfo>;
  verifyGroupMembership(chatId: string): Promise<boolean>;
  getGroupParticipantCount(chatId: string): Promise<number | null>;
  addGroupParticipant(chatId: string, phoneNumber: string): Promise<AddParticipantResult>;
  logout(): Promise<void>;
}
```

`OpenWAProvider` (`apps/worker/src/provider/openwa/OpenWAProvider.ts`) is the only module allowed
to import `@open-wa/wa-automate`. The pipeline, engine, and queue depend only on the interface.
`RawIncomingMessage` (the shape `subscribeToMessages` delivers) also carries an optional
`quotedWhatsappMessageId` (swipe-to-reply reference) and `mentionedPhones` (`@`-mentions) — both
read from the same `onAnyMessage` payload, feeding Support Activity Tracking's
`REPLY_TO_CUSTOMER`/`MENTION` trigger types without any extra subscription.

## Persistent session

OpenWA's session/user-data directory is mounted as a **named Docker volume**, so it survives
container recreation, not just process restart — verified at runtime (not assumed): connect →
restart worker → `docker compose down/up` → no QR re-scan required.

## Docker services

`postgres` (named volume, healthcheck), `app` (Next.js, standalone build, exposes 3000), `worker`
(Chromium-capable image, `shm_size: 1gb`, named `whatsapp_session` volume, **no published port** —
its health endpoint binds to `127.0.0.1` for its own `HEALTHCHECK` only). A fully separate compose
project, `docker-compose.test.yml`, spins up an isolated `postgres-test` (port 5433) for running
`apps/worker`'s integration tests without touching the live database — see `README.md`.

## Database

See `packages/db/prisma/schema.prisma` for the authoritative model list. Grouped by feature area:

- **Core messaging**: `User`, `WhatsAppAccount`, `WhatsAppServiceRoute`, `WhatsAppGroup`,
  `InternalTeamMember`, `Message` (incl. `quotedMessageId` self-relation, `mentionedPhones`),
  `ProcessingCheckpoint`.
- **Rule engine**: `AutomationRule` (one unified shape for ignore/escalation/auto-reply/
  last-sender/exception rules), `AutomationExecution`, `AutomationSettings` (singleton),
  `OutboundMessage` (the one DB-backed send queue every outbound path shares).
- **Bulk messaging**: `GroupBroadcastJob`, `GroupBroadcastSettings` (singleton),
  `GroupParticipantAddJob`, `GroupParticipantAddItem`, `GroupParticipantAddSettings` (singleton,
  more conservative defaults than broadcast).
- **Notifications & commands**: `Notification`, `WorkerCommand`, `SystemLog`.
- **AI Learning (Phase 1 foundation)**: `AiSettings` (singleton), `AiProvider`, `AiModelConfig`
  (job slots: `LEARNING`, `RESPONSE`, `VISION`, `DOCUMENT`, `EMBEDDING`, `ADMIN_ASSISTANT`),
  `AiKnowledgeItem` + `AiKnowledgeVersion` (full edit history, never overwritten).
- **Priority Support Escalation**: `SupportPriorityPolicy` (one row per P1/P2/P3 tier),
  `SupportEscalationSettings` (singleton), `SupportEscalationCase`, `SupportEscalationEvent`
  (audit trail **and** the idempotent duplicate-notification guard, via a unique constraint).
- **Conversation Learning**: `ConversationSession`, `LearningSettings` (singleton),
  `LearningBatchJob`, `PatternCandidate`, `PatternCandidateEvidence`, `RuleProposal`.
- **Support Activity Tracking**: `SupportActivitySettings` (singleton), `SupportKeyword`,
  `SupportRule`, `SupportRuleKeyword`/`SupportRuleGroup`/`SupportRuleTeamMember` (join tables, used
  only when a rule isn't scoped to "all"), `SupportActivity` (the raw event log — counts are always
  computed from this at query time, per 3 configurable modes and a configurable period, never
  pre-aggregated).
- **AI Admin Assistant**: no persistence layer yet in v1 (conversation history lives in client-side
  React state only, since every tool is currently read-only — see below).

Automation mode is locked to exactly three values (`AutomationSettings.mode`): `MANUAL_ONLY`,
`SAFE_AUTO_REPLY` (default), `FULL_RULE_AUTOMATION`.

## Support Activity Tracking

Detects when a configured `InternalTeamMember`'s message inside a WhatsApp group satisfies a
`SupportRule`'s trigger — `KEYWORD_MATCH` (via `packages/engine`'s `matchSupportKeyword`),
`REPLY_TO_CUSTOMER` (message quotes a non-team-member's message), or `MENTION` (message
`@`-mentions a non-team-member phone) — and records exactly one `SupportActivity` row per message
(idempotency is a `@unique` constraint on `SupportActivity.messageId`, insert-and-catch-`P2002`,
the same pattern `Message`'s own dedup uses). The detector
(`apps/worker/src/supportActivity/detector.ts`) hooks into `processIncomingMessage.ts` as a
fire-and-forget side effect, identical in philosophy to the pre-existing Priority Support
Escalation hook — never blocks or alters normal rule evaluation, and is a true no-op (not even a
DB read beyond the settings row) when the feature is disabled (default). Reporting supports 3
counting modes (`UNIQUE_GROUP`, `EVERY_ACTIVITY`, `PER_TEAM_MEMBER`) and 3 counting periods
(`DAILY`, `WEEKLY` Sunday-start, `MONTHLY`), all computed live via Prisma `groupBy` against the raw
`SupportActivity` table — changing the setting retroactively reinterprets history. `REACTION` as a
fourth trigger type is a known, deliberately deferred future phase — WhatsApp reactions arrive via
a wholly separate `client.onReaction()` event stream the worker doesn't subscribe to at all today,
and would need a new table and ingestion path, not just a new enum value.

## AI Admin Assistant (floating chat widget)

A read-only, tool-calling admin chatbot (`apps/web/src/server/aiAdmin/`), visible as a floating
bubble on every dashboard page. Deliberately **not** built on `packages/ai-client` — that package's
text-only contract is a safety invariant for the Conversation Learning job and must not be
loosened, and a real tool-calling loop's handlers need to call `apps/web`'s own server actions
directly (packages can't import from apps). Talks to the Anthropic SDK directly, using its own
`AiModelJob.ADMIN_ASSISTANT` config slot. A fixed registry of read-only tools (`get_support_stats`,
`get_top_support_members`, `get_whatsapp_accounts`, `get_groups`, `get_priority_cases`,
`get_ai_settings`, `get_broadcast_jobs`) lets it answer questions with real data; it cannot change
any setting yet (no write-tool/confirmation-flow/audit-log layer exists in v1 — a deliberately
scoped-down first version, designed so a future write-capable version is additive, not a rewrite).
Conversation history lives in client-side React state only, not persisted server-side.

## High-risk areas

1. OpenWA/Chromium stability inside Docker; one Chromium per connected account.
2. Session persistence across container recreation (verified path, not assumed).
3. Outbound queue race conditions — atomic claim + stuck-row recovery sweep required.
4. "Previous/last sender" ordering under non-guaranteed delivery order.
5. Admin-authored regex (ReDoS) — mandatory save-time validation + bounded runtime evaluation.
6. Notification/automation loops (support-group notifications must never re-enter the pipeline).
7. Rule engine correctness under multi-action + priority combinations.
8. Concurrent OpenWA connects (`process.chdir()` race) — connects are strictly sequential.
9. DB-mediated command polling latency (deliberate simplicity trade-off).
10. Conversation Learning's segmentation/pattern-detection jobs scan **globally** by design (no
    per-account filter) — safe in production, but means their integration tests must never run
    against the live/shared database (see `README.md`).
11. Schema migrations shipped in a session but not deployed to the live DB — a real incident has
    happened where a session added a column, deliberately deferred deploying it (per the live-DB
    safety convention), and a later session's routine work hit a live `P2022` "column does not
    exist" error before the migration was caught up. Before touching any `Message`-related (or
    otherwise recently-migrated) query, it's worth a quick `_prisma_migrations` check if anything
    seems newly broken.

## Status

See `README.md` for current shipped-feature status — this file's phase numbering is historical
(the project was scoped in phases 0–10 at inception; all of them have long since shipped along with
several features added afterward that weren't part of the original phase plan at all).
