# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Rule-based WhatsApp support automation: a Next.js dashboard (`apps/web`), a dedicated OpenWA
worker (`apps/worker`), and a PostgreSQL/Prisma backend (`packages/db`), run via Docker Compose.
`README.md`'s status line is kept current — check it first for what's actually shipped.
`ARCHITECTURE.md` is the durable, still-accurate design reference (component boundaries,
DB-mediated web⇄worker coordination, provider abstraction, full data model by feature area); treat
its phase numbering as historical, not current status. **`PROJECT_REFERENCE.md` is the exhaustive,
page-by-page functional reference** (every sidebar module, every field, every button, every
behavior) — read it before touching a page you haven't worked on before, instead of re-deriving
its behavior from scratch.

Five root-level `*.md` files (`RULE-BASED SUPPORT MESSAGE AUTOMATION.md`,
`WHATSAPP ACCOUNT SAFETY AND ANTI-SPAM REQUIREMENTS.md`,
`Priority-Based Support Monitoring & Escalation — Implementation Command.md`,
`AI Learning & Knowledge System — Full Development Prompt.md`,
`Support Activity Tracking + AI Admin Assistant — Safe Integration Master Prompt.md`) are the
original build specs for each major feature area — useful for rationale/intent, but
`ENGINEERING_STANDARDS.md` (below) is the living rulebook for ongoing work, not these.

**Before assuming a live error is a new bug, check whether it's actually an undeployed migration.**
A schema migration can be committed (and even verified against the isolated test DB) in one session
without being deployed to the live database — by design, per the live-DB safety convention below.
This has already caused one real incident: a later session's routine work hit a live `P2022`
"column does not exist" error that was actually just a pending `pnpm db:migrate:deploy`. If a
query that touches a recently-changed model starts failing, check `_prisma_migrations` (or
`pnpm db:migrate:deploy`'s own status output) before treating it as a new problem — and don't run
that deploy against the live DB without the user's explicit go-ahead.

## Commands

```bash
pnpm install
pnpm --filter @support-automation/db generate   # generate Prisma client (run after install / schema changes)

pnpm dev:web                                     # apps/web on :3000
pnpm dev:worker                                  # apps/worker

pnpm build                                       # build all packages/apps
pnpm lint                                        # apps/web only — no other package has a lint script
pnpm typecheck                                   # all packages

pnpm db:generate / db:migrate / db:migrate:deploy / db:seed
```

Docker (full stack, matches production topology):

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps    # postgres, app (:3000), worker (no published port) should all be healthy
```

### Testing

Vitest is used in `packages/engine`, `packages/shared`, `packages/ai-client`, and `apps/worker`.
**`apps/web` and `packages/db` have no test suite.** `apps/web` has `lint`/`typecheck` only.

```bash
pnpm --filter @support-automation/engine test                 # unit tests, no DB needed
pnpm --filter @support-automation/engine exec vitest run src/__tests__/evaluate.test.ts -t "test name"

pnpm --filter @support-automation/worker test                 # ⚠️ see live-DB warning below
pnpm --filter @support-automation/worker exec vitest run src/__tests__/pipeline.integration.test.ts
```

**`apps/worker`'s integration tests (`src/__tests__/*.integration.test.ts`) run real Prisma queries
against whatever `DATABASE_URL` currently points at.** If that's the live `docker compose` database,
do not run `pnpm --filter @support-automation/worker test` directly — `sessionSegmentation.ts` and
`patternDetectionJob.ts` scan **globally** by design (no per-account/test filter), so running them
processes real production message rows as a side effect. This has actually happened. Use the
isolated throwaway DB instead:

```bash
docker compose -f docker-compose.test.yml up -d --wait      # postgres-test on :5433, separate Compose project
pnpm --filter @support-automation/worker test:isolated       # points DATABASE_URL at postgres-test
docker compose -f docker-compose.test.yml down -v            # tear down + drop all test data
```

The files most sensitive to this (`sessionSegmentation.integration.test.ts`,
`patternDetectionJob.integration.test.ts`, `unknownPatternDetection.integration.test.ts`,
`aiAnalysisJob.integration.test.ts`) must never be run against the live/shared DB. `vitest.config.ts`
in `apps/worker` sets `fileParallelism: false` — integration tests share one Postgres outbound
queue and must run sequentially.

## Architecture

### Monorepo layout

```
apps/web       Next.js dashboard — reads/writes Postgres directly via Prisma; never talks to the worker over HTTP
apps/worker    dedicated Node/TS process — the ONLY process that owns the OpenWA/Chromium session
packages/db    Prisma schema, migrations, seed, PrismaClient singleton — raw TS source, no build step
packages/engine   pure rule-evaluation engine (matchers, priority, regex safety) — one implementation, imported by both apps
packages/ai-client   thin Claude (Anthropic) completion client — used only by apps/worker's AI-assisted Conversation Learning analysis job
packages/teams-client   thin Microsoft OAuth + Graph API wrapper (plain fetch, no SDK) — used by apps/web's Teams connect/callback routes and apps/worker's sync job
packages/shared   canonical enum/type definitions (engine can't depend on @prisma/client, so these are the source of truth; Prisma schema enums are kept in sync by convention, not tooling)
```

pnpm workspace (`pnpm-workspace.yaml`); Node >= 22.13. `packages/db`/`packages/shared` are consumed
as raw TypeScript by both apps via Next's `transpilePackages` (web) / `tsx` (worker dev) — `engine`
and `shared` do have a `build` step to `dist/`, but web still transpiles their source directly; only
worker's production `start` (compiled) actually depends on `dist/`.

**`packages/db/src/` has zero relative imports between its own files, by hard rule** — Node's
runtime (worker) and Turbopack (web) have resolved a relative import differently between two files
in this package before, and it caused a real production outage. Any new function that needs to live
alongside `resolveWhatsAppAccount()`/`encryptSecret()`/etc. goes in the same file, not a sibling
module reached by `./`.

### Web ⇄ Worker: no direct HTTP

All coordination goes through Postgres:
- **Worker → Web**: worker writes `WhatsAppAccount.status`/`qrCode`/`lastHeartbeatAt` on every state
  change; the dashboard polls these columns.
- **Web → Worker**: actions needing the live browser session (reconnect, fetch QR, live test send,
  group resync) are inserted as `WorkerCommand` rows; the worker polls (`startCommandProcessor`,
  1.5s, strictly serial) and executes them.
- **Kill switch**: `AutomationSettings.automationEnabled`, re-read by the worker every processing tick.

### apps/worker — background loops (all `setInterval`, each with a manual overlap-guard boolean
since `setInterval` doesn't await its callback)

| Loop | Interval | Purpose |
|---|---|---|
| `startOutboundQueueProcessor` | 2s | drains the outbound send queue, one message/tick |
| `startGroupParticipantAddProcessor` | 2s | drains "Add to Groups" queue |
| `startCommandProcessor` | 1.5s | polls `WorkerCommand` (dashboard-issued actions), strictly serial |
| `startNotificationDispatcher` | 3s | sends queued Teams/WhatsApp notifications |
| `startAccountRegistrySync` | 20s | discovers new accounts, provisions + connects them one at a time |
| `startEscalationProcessor` | 15s | advances at most one due `SupportEscalationCase` per tick |
| `startSessionSegmentationProcessor` | 5min | Conversation Learning: buckets messages into `ConversationSession` (no-ops unless `LearningSettings.conversationLearningEnabled`) |
| `startPatternDetectionProcessor` | 15min | deterministic, AI-free recurring-pattern scoring → `PatternCandidate` (same enable-flag gate) |
| `startAiAnalysisProcessor` | 6h | optional AI-assisted rescoring via `packages/ai-client` (gated on `AiSettings.aiEngineEnabled` + `.learningEnabled`; also triggerable on-demand via an `AI_ANALYSIS_BATCH` WorkerCommand) |
| `startTeamsSyncProcessor` | 3min (admin-configurable) | polls Microsoft Graph for joined teams/channels/messages, scoped to channels linked to an open `SupportIssue`; runs resolution-keyword matching on each new message (no-ops until Microsoft OAuth env vars are set **and** an admin completes the connect flow; also triggerable on-demand via a `TEAMS_SYNC_NOW` WorkerCommand) |
| heartbeat | 15s | health state + DB connectivity log |

On boot: health server → DB connectivity check (fatal if unreachable) → crash recovery (resets
stuck outbound messages / notifications / group-participant-add items) → ensures the legacy
pre-multi-account session and a Primary account both exist → connects every connectable account
**sequentially, never concurrently** (`ProviderRegistry.connectAccount()` — OpenWA's `connect()`
does a process-global `process.chdir()`, so concurrent connects race).

### WhatsApp provider abstraction

`apps/worker/src/provider/WhatsAppProvider.ts` defines the interface (connect/disconnect/
getConnectionStatus/getGroups/subscribeToMessages/sendMessage/getAccountInfo/
verifyGroupMembership/getGroupParticipantCount/addGroupParticipant/logout). `OpenWAProvider`
(`provider/openwa/OpenWAProvider.ts`) is the only module allowed to import `@open-wa/wa-automate`;
the pipeline, engine, and queue depend only on the interface. `ProviderRegistry` owns one
`OpenWAProvider` (one Chromium) per `accountId`.

### Incoming message pipeline (`apps/worker/src/pipeline/processIncomingMessage.ts`)

Empty-body drop → non-`INCOMING` messages are stored but never automated (loop-prevention) →
active-team-member check (a team-member message also calls `recordHumanTakeover(groupId)` when the
group has AI fallback enabled — see below) → resolve `WhatsAppGroup` → fetch the previous message
in the chat **before** inserting the current one (so it can't match itself) → insert the `Message`
row (a Prisma `P2002` unique-constraint violation here *is* the dedup/idempotency check) →
fire-and-forget escalation side-effect (own try/catch, never gates the rule outcome) → `evaluate()`
from `packages/engine` against active `AutomationRule`s (single priority-sorted pass) → on a genuine
`NO_MATCH`, the Hybrid AI Automation fallback layer gets a chance (own try/catch, see below) →
execute the resulting action(s) — actions only **enqueue** (`enqueueOutboundMessage`/
`enqueueNotification`), never send directly → persist `AutomationExecution` + update message status
→ upsert `ProcessingCheckpoint`.

### Rule engine (`packages/engine`)

`evaluate()` sorts rules by `priority` descending, runs conditions + text matchers per rule, returns
the first (highest-priority) match, and builds a full `DecisionTraceEntry[]` for every rule
considered — this trace is what the Rule Tester UI's "rules evaluated" view reads directly. Falls
back to a `system:team-member-filter` IGNORE or `system:no-match` decision. **Regex safety is
two-layered**: `regexSafety.ts`'s `validateRegexSafety()` is a save-time gate (max 200 chars, max 10
quantifiers, rejects nested-quantifier shapes like `(a+)+`) required before a regex rule can go
ACTIVE; `safeRegexTest()` is a runtime net using `vm.runInNewContext` with a 50ms timeout (timeout
→ treated as no-match, not thrown), protecting rules saved before the validator existed.

### Escalation and Conversation Learning phases

- **Priority Support Escalation** (`apps/worker/src/escalation/`): SLA-timer-driven (not a settings
  flag), advances one case per tick through
  `NEW → MONITORING → WAITING_FOR_HUMAN → SECOND_ALERT → MEMBER_ESCALATED → ADMIN_ESCALATED → FOLLOW_UP`
  to a terminal `HUMAN_REPLIED`/`RESOLVED`/`CANCELLED`.
- **Conversation Learning** (`apps/worker/src/learning/`): three independently-gated phases —
  segmentation (deterministic) → pattern detection (deterministic, AI-free) → AI-assisted analysis
  (optional, separately gated). All three are entirely off by default. A `RuleProposal` is a
  fully-formed `AutomationRule` draft copied from a `PatternCandidate`'s suggested fields
  (`createRuleProposalFromCandidate()` in `packages/db/src/index.ts` — shared by the dashboard's
  manual "Create Proposal" button and the worker's optional auto-approval path, so both stay
  byte-for-byte identical); approving one always creates a **DRAFT** `AutomationRule`, never an
  active one — a human still separately activates it on the Rules page.

### Support Activity Tracking (`apps/worker/src/supportActivity/`, `apps/web/src/app/(dashboard)/support-activity/`)

Detects a configured `InternalTeamMember`'s message inside a WhatsApp group satisfying a
`SupportRule`'s trigger — `KEYWORD_MATCH`, `REPLY_TO_CUSTOMER` (quotes a non-team-member message),
or `MENTION` (`@`-mentions a non-team-member) — and records one `SupportActivity` row per message.
The detector hooks into `processIncomingMessage.ts` as a fire-and-forget side effect (own
try/catch, same philosophy as the escalation hook right above it in that file) and is a true no-op
when `SupportActivitySettings.enabled` is false (default). Idempotency is `SupportActivity.messageId
@unique`, insert-and-catch-`P2002`. Reporting supports 3 counting modes (`UNIQUE_GROUP`,
`EVERY_ACTIVITY`, `PER_TEAM_MEMBER`) and 3 periods (`DAILY`, `WEEKLY`, `MONTHLY`), always computed
live via `groupBy` against the raw activity table (`apps/web/src/server/supportActivityReports.ts`)
— never pre-aggregated, so changing the setting retroactively reinterprets history. CSV/Excel
export lives at `apps/web/src/app/api/support-activity/export/route.ts` — this app's second-ever
Route Handler (after `/api/health`), justified because a file download can't be triggered from a
Server Action; reuses the already-installed `xlsx` package (previously read-only, now also used to
write). `ANY_MESSAGE` is a fourth trigger: any message a team member sends in an in-scope group counts,
with no keyword, reply or mention needed — the simplest definition of "this person worked in this
group today". It is evaluated **after** every other trigger (`TRIGGER_PRECEDENCE` in
`detector.ts`), because it matches everything and would otherwise shadow a KEYWORD_MATCH rule —
and only a keyword rule carries `marksCompletion`, so an "any message" rule would quietly stop
SupportSessions ever completing.

`SupportActivity.actor` (`TEAM_MEMBER` | `AI`) records who delivered the support.
`recordAiSupportActivity()` writes an AI row when the fallback answers a customer unaided, keyed
on the **customer's** message (the reply is an OutboundMessage that only becomes a `Message` on
echo, and keying on the incoming message reuses `messageId @unique` as the idempotency guard). AI
rows carry no rule and **never open or close a SupportSession** — a session models a person
handling a conversation over time and feeds "hours worked", which an AI answer has no span for.
Every person-measuring report (`getPerTeamMemberBreakdown`, `getTeamAvailability`) filters
`actor: TEAM_MEMBER` explicitly so AI work can never inflate someone's numbers;
`getActorBreakdown()` reports the split, including `aiOnlyGroups` — groups no human touched.

Team members can be added by picking real senders out of a group
(`getGroupParticipantCandidates`) rather than typing numbers: the phone number is the exact match
key, and a typo silently classifies a colleague as a customer.

`REACTION` as a fifth trigger type is a documented, deliberately deferred future phase —
WhatsApp reactions need a separate `client.onReaction()` subscription and a new table, not just a
new enum value.

### Hybrid AI Automation / AI Fallback (`apps/worker/src/aiFallback/`)

Fires only when `packages/engine`'s `evaluate()` genuinely misses on a real customer message
(`finalDecision === "NO_MATCH"`) **and** the message's group has opted in
(`WhatsAppGroup.aiAutomationEnabled`, default false). `checkAiFallbackEligibility()` gates on the
kill switch, automation mode, group opt-in, and `AiSettings.aiEngineEnabled` before
`runAiFallback()` ever calls `resolveAiClient("RESPONSE")` — reuses `checkAutoReplySafety()`,
`enqueueOutboundMessage`, and `enqueueNotification` exactly as the deterministic pipeline does,
never a second send path. Records a single `AiFallbackDecision` row per `Message` (outcome
`AI_REPLIED` or `HUMAN_FALLBACK`) as its audit trail. `recordHumanTakeover(groupId)` — called from
`processIncomingMessage.ts` whenever a team member sends a message in an `aiAutomationEnabled`
group — sets `WhatsAppGroup.aiSuppressedUntil` to now + `AiSettings.humanTakeoverCooldownMinutes`,
so the AI fallback layer stays silently ineligible for that group while a human is actively
handling it. This is a distinct system from the AI Admin Assistant below and from
`packages/ai-client`'s Conversation Learning caller — do not conflate the three.

### Microsoft Teams Integration (`apps/worker/src/teams/`, `apps/web/src/server/teamsAuth/`,
`apps/web/src/app/(dashboard)/integrations/teams/`, `apps/web/src/app/(dashboard)/issues/`)

Links a developer's Microsoft Teams conversation to an open customer WhatsApp conversation via a
manually-created `SupportIssue` (admin picks the WhatsApp group + customer phone + a Teams
channel/optional exact thread — **not** auto-detected from message content, unlike Support Activity
Tracking's rule-based detection, to avoid a second heuristic-detection system in this slice).
`packages/teams-client` wraps the Microsoft identity platform's OAuth 2.0 endpoints and the Graph
REST API directly via `fetch` (no `@azure/msal-node`/`@microsoft/microsoft-graph-client`
dependency — see that package's own doc comments for why). OAuth tokens are encrypted at rest via
the **existing** `encryptSecret`/`decryptSecret` (`AI_CREDENTIALS_ENCRYPTION_KEY`) on the singleton
`TeamsAccount` row — no second encryption mechanism, and the customer's Microsoft password never
touches this application at all (real OAuth redirect only — see `TEAMS_SETUP.md`'s "Customer
setup"). `TeamsAccountStatus` is `DISCONNECTED`/`CONNECTED`/`SYNCING`/`ERROR`/`REAUTH_REQUIRED` —
`packages/teams-client`'s pure, unit-tested `classifyTokenError()` decides which of the latter two a
refresh failure gets (`invalid_grant`/`interaction_required`/`consent_required` →
`REAUTH_REQUIRED`, only fixable by the customer reconnecting; anything else → `ERROR`, retried
automatically). A successful OAuth callback immediately enqueues a `TEAMS_SYNC_NOW`
`WorkerCommand` (never blocking the callback itself) so Teams/channels appear within moments.
`graphSync.ts` polls (default every 3 minutes, `TeamsIntegrationSettings.pollingIntervalMinutes`),
always discovering every joined team/channel (cheap, powers the "Manage Teams & Channels" page) but
only pulling message bodies when `isChannelInAutomationScope()` says so — both
`TeamsTeam`/`TeamsChannel.isEnabledForAutomation` (default true) enabled, OR an open `SupportIssue`
explicitly linked to that exact channel (an Issue link always wins over the coarser toggle) — and
stores `TeamsTeam`/`TeamsChannel`/`TeamsMessage` idempotently (insert-and-catch-`P2002`, same
pattern as `Message`). `resolutionEngine.ts` matches each newly
stored message against active `TeamsResolutionRule`s using `packages/engine`'s
`matchSupportKeyword()` **as-is** (reused, not reimplemented) — a match inserts an
`IssueResolutionEvent` (idempotency + audit trail via `@@unique([issueId, teamsMessageId])`,
exact same pattern as `SupportEscalationEvent`), and — only if
`TeamsIntegrationSettings.enableCustomerNotification` is explicitly on (default **off**) — queues a
WhatsApp message to the customer via a direct `OutboundMessage` insert (not
`pipeline/enqueueOutbound.ts`'s `enqueueOutboundMessage()`, which is shaped for the incoming-message
pipeline's non-null-`incomingMessageId` + rule-cooldown contract that doesn't apply here), routed
through `resolveWhatsAppAccount("TEAMS_RESOLUTION_NOTIFY")`. `TEAMS_SETUP.md` has the exact Azure
App Registration steps — real OAuth credentials cannot be fabricated and must come from the user.
Full session/duration analytics, real-time webhooks, and Teams-data CSV export are documented,
deliberately deferred future phases.

### AI Admin Assistant (`apps/web/src/server/aiAdmin/`)

A read-only, tool-calling admin chatbot, floating on every dashboard page
(`(dashboard)/FloatingAiChat.tsx`, wired into `DashboardShell.tsx`). Deliberately **not** built on
`packages/ai-client` — that package's text-only-no-tools contract is a safety invariant for the
Conversation Learning job and must not be loosened for this. Talks to the Anthropic SDK directly
via its own `AiModelJob.ADMIN_ASSISTANT` config slot (`resolveAiAdminClient.ts`, gated only on
`AiSettings.aiEngineEnabled` — deliberately not `learningEnabled`, which is specific to the
Conversation Learning job). A fixed registry of read-only tools (`tools.ts`) lets it answer real
questions (support stats, accounts, groups, priority cases, AI settings, broadcast jobs); it cannot
change anything yet — no write-tool/confirmation-flow/audit-log layer exists in this version,
by deliberate scope decision, so adding write capability later is additive, not a rewrite.
Conversation history is held in client-side React state only (every tool is read-only, so a
client-trusted history carries no real risk); each turn still re-runs live tool queries, so answers
are always fresh regardless of what the client claims happened earlier.

### WhatsApp Chat inbox (`apps/web/src/app/(dashboard)/chat/`, `src/server/chatInbox.ts`)

A WhatsApp-Web-style two-pane inbox: conversation list (layout-level, so it keeps scroll/search
across navigations) plus thread and composer. Reads only what the app already stores — it never
asks the worker for history, so a thread goes back to whenever monitoring began. Sending writes
one `OutboundMessage` with `actionType: MANUAL_REPLY` and stops there (same DB-mediated hand-off
as the Teams resolution notifier); the worker sends it. `MANUAL_REPLY` is the one action type the
queue treats differently: **the automation kill switch does not cancel it** (the switch stops the
robot, not the operator) and an account rate limit **defers** it rather than discarding it, since
silently dropping something a person typed is not acceptable. It still gets the same live
group-membership check the broadcast path does. Not-yet-confirmed sends render as dashed "queued"
bubbles; a `SENT` row whose `providerMessageId` already exists as a stored `Message` is skipped as
a duplicate, because WhatsApp echoes our own sends back through `onAnyMessage`. Polls via
`AutoRefresh` (4s) — there is no websocket.

### Automation by AI (`AiSettings.aiAutomationScope`, `aiRuleGenerationEnabled`)

`AiAutomationScope` decides **which groups** the fallback may answer in — `PER_GROUP` (the
original per-group opt-in) or `ALL_MONITORED_GROUPS`. It never changes **when** AI runs: the
fallback is still only reached on a genuine `NO_MATCH`, so a rule that matched always wins.
`WhatsAppGroup.aiAutomationExcluded` is a hard opt-out honoured under every scope and checked
before the scope rules. `recordHumanTakeover()` now takes the group's flags and decides
eligibility itself, because under `ALL_MONITORED_GROUPS` the per-group opt-in flag is usually
false and the old caller-side check would have stopped pausing AI when a human replied.

With `aiRuleGenerationEnabled`, a confident AI answer also drafts a rule:
`createRuleProposalFromAiReply()` (`packages/db`) writes a `RuleProposal` with
`source: AI_REPLY`, deduplicated on `sourceSignature` (packages/engine's
`derivePatternSignature`), so a question asked fifty times yields one draft. `patternCandidateId`
is nullable for exactly this reason — approve/reject guard on it. Approval still produces a
**DRAFT** rule a human separately activates; nothing AI writes reaches a customer automatically.

Human-fallback alerts route to `AiSettings.takeoverNotifyGroupIds`, falling back to
`AutomationSettings.whatsappNotificationGroupIds` so existing deployments alert where they always did.

### Knowledge Center — manual imports (`apps/worker/src/knowledge/knowledgeImportJob.ts`)

The knowledge base has **two** sources that converge on one review queue. The conversation
builder learns from customer chats; the importer takes your own documentation. A fresh install
has an empty knowledge base, so the importer is the only way the AI can know anything about the
product on day one.

`KnowledgeImport` is a job row, not an inline server action: a manual is chunked
(`chunkDocument` splits on the document's own paragraph/sentence structure, never a fixed
offset), each chunk is a separate API call, and the whole thing has to survive a restart and
report progress. `startKnowledgeImportProcessor` (15s) drains it. A failing chunk marks the
import `PARTIAL` and **keeps every entry the other chunks produced** — a 40-page manual failing
at page 30 still leaves 29 pages of knowledge. `rawText` is retained so Retry needs no re-upload.

Only plain text today (.txt/.md); PDF/DOCX would need a parsing dependency this repo does not
carry. `buildImportPrompt` is deliberately separate from the conversation prompt: a chat log must
be *interpreted*, documentation must be *preserved*. They share only the record format and
`parseKnowledgeRecords`.

`/ai-learning/knowledge-base/review` is the trust boundary — everything from both sources lands
`humanVerified: false` and only verified entries are ever retrieved. Discarding archives rather
than deletes.

`AiSettings.requireKnowledgeForAiReply` closes the loop: with it on, AI hands off
(`NO_KNOWLEDGE`) rather than answering from the model's general knowledge when nothing verified
covers the question. Checked before the API call, so an ungroundable question costs nothing.

### Knowledge-grounded AI answers (`apps/worker/src/aiFallback/knowledgeContext.ts`)

Closes the loop the knowledge builder opens. Before this the knowledge base was **write-only** —
conversations were distilled into it and reviewed, but nothing read it back, so the AI answered
from the model's general knowledge alone. `findRelevantKnowledge()` now runs before every AI
completion, narrowing by `derivePatternSignature` keywords in SQL and ranking by keyword overlap
(same-group provenance breaks ties). `selectRelevantKnowledge()` is the pure ranking half, split
out so it is unit-testable without a DB.

**Only `humanVerified: true` + `ACTIVE` entries are ever retrieved, and that is load-bearing.**
Knowledge-builder output is unverified by design; feeding an unverified model-distilled claim
back into a customer-facing answer would launder a hallucination into a citation and re-cite it
with growing apparent authority. Human verification is what breaks that cycle. When grounding is
present the prompt also instructs the model to decline (`SHOULD_REPLY: NO`) rather than fill a gap
the reference material does not cover.

### AI Activity log (`(dashboard)/ai-learning/activity/`)

The read view over `AiFallbackDecision` — one row per message the rule engine missed in an
AI-eligible group, with what the AI drafted, whether it was sent, and the diagnostic reason for
every handoff (translated into plain language beside the raw code, which is what appears in logs).
Filters by outcome/group/time window; stat tiles are scoped to the window and group but
deliberately **not** to the outcome filter, so filtering to handoffs cannot report "100% handed
off". Before this existed, AI decisions could only be read one message at a time, which made the
first week of running AI automation effectively unobservable.

### Knowledge from group conversations (`apps/worker/src/knowledge/`)

`startGroupKnowledgeProcessor` (hourly, one group per tick, oldest-first) reads a monitored
group's stored messages and distils them into `AiKnowledgeItem` rows. Gated on `aiEngineEnabled`
+ `knowledgeFromChatEnabled`, both off by default. Incremental via
`WhatsAppGroup.knowledgeBuiltAt`/`knowledgeBuiltThroughAt`. The transcript is reduced to
`[CUSTOMER]`/`[SUPPORT]` roles before it reaches the model, so no name or number can be copied
into an entry. Entries land `humanVerified: false` with `sourceGroupId` set — a model's reading
of a chat log is evidence, not fact. `setKnowledgeVerified()` is the way out of that queue
(a button on the knowledge detail page); verification is deliberately independent of
`status`, since an entry can be ACTIVE-but-unchecked or verified-but-deliberately-inactive. On-demand via a `BUILD_GROUP_KNOWLEDGE` WorkerCommand
(the Groups page's "Learn" button). Parsing is a record-separated text format, unit-tested in
`apps/worker/src/__tests__/groupKnowledgePrompt.test.ts` (pure, safe to run against any DB).

### AI providers

`AiProviderKind` now covers ANTHROPIC, OPENAI, **OPENROUTER**, **OLLAMA** (GOOGLE/CUSTOM remain
reserved and unimplemented). The last three all share `OpenAiCompatibleClient`; only the default
endpoint, whether an `Authorization` header is sent, and the timeout differ.
`AiProvider.apiKeyCiphertext` is nullable **only** for the keyless local runtime — the requirement
is enforced in `aiProviders.ts`, not by the column. `packages/shared/src/aiProviders.ts` is the
one catalog of kinds/endpoints/key-requirements, read by both the provider form and
`resolveAiClient`, so what the UI suggests is what the request uses. The **AI Admin Assistant
remains Anthropic-only** by design — it needs real tool-calling, which is a different wire format,
not a base-URL swap.

### apps/web

Server-rendered (App Router), no client-side data layer — pages fetch via `prisma.*` directly in
server components (`(dashboard)/*/page.tsx`), mutations go through `src/server/actions/*.ts`
(`"use server"`). Read-only, multi-query dashboard summaries (e.g. `dashboardSummary.ts`) are plain
async helpers in the same `server/actions/` directory *without* `"use server"`, since they're never
invoked from a client event handler. UI is a small custom component kit under
`src/components/ui/` (`Card`, `StatTile`, `Badge`, `Table`, `DashboardModuleCard`, `Switch`/
`SwitchField`, `ButtonLink`, etc.) on Tailwind CSS v4 with CSS-custom-property design tokens
(`globals.css`) — **no shadcn/Radix, no charting library**; trend visuals are hand-rolled inline SVG
(see `Sparkline.tsx`) by deliberate choice. `Switch`/`SwitchField` (a standalone boolean/master
toggle) is distinct from `Checkbox` (an item inside a multi-select list) — don't use them
interchangeably. `ButtonLink` renders a real `<a href>` styled like `Button`, for cases (like a file
download) that must stay real navigation, not a client `onClick`. `(dashboard)/DashboardShell.tsx`
is a Client Component wrapping `Sidebar` + page content + the floating AI chat — it owns the mobile
nav drawer and a pathname-keyed page-entrance animation; `layout.tsx` itself stays an async Server
Component doing only data-fetching. Multi-account routing for WhatsApp-sending features goes
through `resolveWhatsAppAccount(serviceKey)` (`packages/db`) — the single centralized resolver
every sending feature must call, never re-derive the Primary/pinned/fallback decision at the call
site.

Sidebar nav groups, top to bottom (a pinned "Overview" link sits above all of them; Messages
leads with the WhatsApp Chat inbox): Messages,
Escalations, Support Activity, Teams Integration, WhatsApp, Automation, Bulk Messaging, AI Learning,
Conversation Learning, System — ordered by day-to-day check frequency, not by when each feature
shipped. See `PROJECT_REFERENCE.md` for every link in every group.

## Engineering standards (condensed from `ENGINEERING_STANDARDS.md` — read the full file for
anything safety/UI/DB related; this is the subset most likely to bite an unfamiliar change)

- **No unnecessary features.** No decorative dashboards, no charts without an operational reason, no
  unused config/fields/endpoints. Simple → Reliable → Maintainable beats Complex → Feature-heavy.
- **Idempotency is mandatory** wherever an operation could fire twice: message processing,
  auto-replies, broadcasts, queue processing, reconnects, group sync, retries. The same WhatsApp
  message must never create duplicate processing records; the same broadcast job/group pair must
  never send twice.
- **One outbound mechanism.** All outbound WhatsApp sends go through the DB-backed outbound queue
  (`OutboundMessage`) — never add a second independent send path.
- **No concurrent duplicate workers.** Every worker polling loop needs an overlap guard; commands
  for the same account must not run conflicting operations back-to-back (e.g. two concurrent
  reconnects).
- **"Active" ≠ "Monitored"** for WhatsApp groups — active means the account is still a member;
  monitored means an admin opted it into automation. Never conflate them in queries or UI.
- **Anti-spam philosophy is load-bearing, not incidental**: automation is conservative and
  reply-triggered-by-incoming-message only; no unrestricted bulk mode; every auto-reply path
  respects per-client/global rate limits and rule-level cooldowns (`AutomationSettings`,
  `AutomationRule.cooldownSeconds`). Don't loosen these defaults without being asked.
- **Soft-delete over hard-delete** for records with historical value (e.g. deactivate a
  `WhatsAppGroup` the account left, don't delete it).
- **Errors must be actionable** ("Group membership verification failed. The message was not sent.
  [Retry]"), never a bare "Error occurred"; no internal stack traces surfaced to the dashboard UI.
- **Production safety checklist** before touching live-connected functionality: check current
  state, migration status, worker health, WhatsApp connection state, and pending
  commands/jobs first; make the smallest change possible; verify after.
- Do not refactor unrelated code while implementing a feature unless required for correctness.
