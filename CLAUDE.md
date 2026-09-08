# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**Softify Assist** (production: `https://assist.softifybd.com`). Rule-based WhatsApp support
automation: a Next.js dashboard (`apps/web`), a dedicated OpenWA worker (`apps/worker`), and a
PostgreSQL/Prisma backend (`packages/db`), run via Docker Compose. The npm scope
(`@support-automation/*`), the git repo name (`support-crm`) and the Docker volume names predate
the product name and are deliberately unchanged — renaming them touches every import and every
stateful volume, so treat "Softify Assist" as the user-facing name only.
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

PORT=8668 pnpm dev:web                           # apps/web (NEXTAUTH_URL must match the port)
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
docker compose ps    # postgres, app (:8668 on the host), worker (no published port) should all be healthy
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

`test:isolated` also sets a throwaway `AI_CREDENTIALS_ENCRYPTION_KEY`. Without it the four suites
that encrypt a credential fixture (`resolveAiClient`, `teamsTokenRefresh`, and the two that seed an
AI provider) fail or self-skip, which silently hid ~80 tests — so the isolated path looked green
while covering far less than the shared-DB path. The key is test-only and encrypts nothing but
fixtures in a database that gets dropped.

Three harness details worth knowing before you chase an intermittent red:
- **The isolated `DATABASE_URL` bounds the Prisma pool on purpose**
  (`connection_limit=5&pool_timeout=30&connect_timeout=30`). Each vitest worker holds its own pool,
  and the default churned enough connections through Docker Desktop's port forward that a request
  occasionally failed with "Can't reach database server" while Postgres itself sat healthy and
  idle — surfacing as *unrelated* suites failing at random. Note the URL is quoted in the script:
  `cmd.exe` reads `&` in a query string as a command separator and silently splits the line.
- **Fixtures that will be claimed by a queue processor must set `scheduledAt` explicitly.** The DB
  container's clock runs a few milliseconds ahead of the host's, so a row relying on the schema's
  `@default(now())` can read as not-yet-due to the very next line's host-clock `new Date()`.
  Production is unaffected — every production write sets `scheduledAt` from the app's own clock.
- **A "unique" test phone number must be digits only.** Team-member matching normalizes a number to
  its digits, so a UUID slice like `+8809a3f2b1c4` collapsed to `88093214` — and roughly one in
  seven fell under the 8-digit minimum, making the seeded member unresolvable.

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
packages/ai-client   text-only, no-tools completion client (Anthropic + one OpenAI-compatible client covering OpenAI/OpenRouter/Ollama/Google) — used by every worker-side AI job: the AI fallback, deep answers, both Forge jobs, all three knowledge builders, and Conversation Learning analysis. The text-only-no-tools contract is a safety invariant; the AI Admin Assistant needs tool-calling and therefore does NOT use this package
packages/forge-client   thin Softify Forge REST wrapper (plain fetch) + the disclosure gate that decides what a customer may be told — used by apps/worker's Forge jobs and apps/web's Forge settings page
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
| `startKnowledgeImportProcessor` | 15s | drains manual Knowledge Center imports (pasted text, uploaded file, URL, spreadsheet), one chunk at a time |
| `startAiAnalysisProcessor` | 6h | optional AI-assisted rescoring via `packages/ai-client` (gated on `AiSettings.aiEngineEnabled` + `.learningEnabled`; also triggerable on-demand via an `AI_ANALYSIS_BATCH` WorkerCommand) |
| `startGroupKnowledgeProcessor` | 1h | distils one monitored group's stored conversation into knowledge entries (gated on `aiEngineEnabled` + `knowledgeFromChatEnabled`) |
| `startCommunicationStyleProcessor` | 12h | rebuilds `CommunicationStyleProfile` from the team's own replies — manner, never fact (gated on `aiEngineEnabled` + `communicationStyleLearningEnabled`) |
| `startTeamsSyncProcessor` | 3min (admin-configurable) | polls Microsoft Graph for joined teams/channels/messages, scoped to channels linked to an open `SupportIssue`; runs resolution-keyword matching on each new message (no-ops until Microsoft OAuth env vars are set **and** an admin completes the connect flow; also triggerable on-demand via a `TEAMS_SYNC_NOW` WorkerCommand) |
| `startForgeKnowledgeProcessor` | 6h | reads ISPDIGITAL's own docs + module source through Softify Forge into the knowledge base (no-op until `FORGE_API_KEY`/`FORGE_API_URL` are set **and** an admin enables it; on-demand via a `FORGE_SYNC_NOW` WorkerCommand) |
| `startForgeResearchProcessor` | 2min | works through customer questions verified knowledge could not answer, researching each against the product's source (same gate, plus `ForgeSettings.researchUnanswered`, off by default) |
| heartbeat | 15s | health state + DB connectivity log |

On boot: health server → DB connectivity check (fatal if unreachable) → crash recovery (resets
stuck outbound messages / notifications / group-participant-add items) → ensures the legacy
pre-multi-account session and a Primary account both exist → connects every connectable account
**sequentially, never concurrently** (`ProviderRegistry.connectAccount()` — OpenWA's `connect()`
does a process-global `process.chdir()`, so concurrent connects race).

### WhatsApp Accounts page (`(dashboard)/accounts/`)

Linking is a modal (`QrConnectDialog`), not an inline 224px image: scanning is a two-device task
and the QR needs to be big enough to read across a desk. The code is always rendered **on white
with quiet-zone padding regardless of theme** — a dark-on-dark QR is unscannable and the failure
looks like a broken camera rather than a contrast problem. The dialog opens on the *transition
into* `AUTHENTICATION_REQUIRED`, never on every render where a code exists: the page polls while
a QR is live and the code rotates every few seconds, so the latter would reopen the dialog
seconds after the operator closed it.

**Polling is gated on work actually being in flight** (`AUTHENTICATION_REQUIRED`/`RECONNECTING`,
or a pending `WorkerCommand`) — not on `status !== CONNECTED`, which kept the page re-querying
every 4s forever for a permanently disconnected spare number whose status cannot change on its
own.

The page reports **worker liveness** from the newest `WhatsAppAccount.lastHeartbeatAt`, which
the worker's 15s heartbeat now stamps on every account. It previously moved only when
`recordConnectionState()` fired, so it meant "when this session last changed state" — a healthy
worker with a stable account looked silent for hours, and the dashboard could not tell "the
worker is down" from "the worker is up but this account will not connect". Every control here writes
a `WorkerCommand` and waits; with the worker down they all still "succeed" and then do nothing,
and the heartbeat is the only thing that distinguishes that from a slow reconnect.

### Replacing the number that serves customers (`accounts.ts`, `GroupSetupTransfer.tsx`)

**A customer reply always goes out on the account that received the message** — `runAiFallback` is
handed `accountId: raw.accountId` and never calls `resolveWhatsAppAccount()`. Primary and Account
Routing govern only the four *notification* service keys (`NOTIFY_WHATSAPP`, `PRIORITY_SUPPORT`,
`CONVERSATION_LEARNING`, `TEAMS_RESOLUTION_NOTIFY`); none of them is "reply to a customer", and
none could be — the send would fail `verifyGroupMembership` from an account that is not in the
group. Setting an account Primary does not move existing conversations onto it.

**Logout deactivates that account's groups** (the `LOGOUT` command handler). This is the one case
`syncGroups`' own deactivation sweep can never cover: that sweep compares against a live provider
result, and a logged-out account never produces one again. Left active, the rows keep filling the
chat inbox (which filters `isActive: true`) with conversations the number can no longer reach, and
every send fails membership verification at the queue. It sets `isActive: false` **only** —
`isMonitored`, `aiAutomationEnabled` and the rest are untouched, so reconnecting the same number
restores the setup via `syncGroups`' upsert. Deleting the rows is never an option: `Message`,
`SupportActivity`, `SupportSession`, escalation cases, AI decisions and issues all hang off them.

**`adoptGroupSetupFromAccount()` carries the setup across.** Because `WhatsAppGroup` is
`@@unique([accountId, whatsappGroupId])`, one WhatsApp group is a separate row per account, so a
new number's groups arrive with every flag at its default — unusable at roster scale. This copies
`isMonitored`, `aiAutomationEnabled`, `aiAutomationExcluded`, `testModeEnabled`,
`escalationMonitoringEnabled`, `priority` and `assignedTeamMemberId` for every **shared** group.
Not copied, deliberately: the knowledge-build watermarks (they mark a position in *that* account's
own stored messages) and `aiSuppressedUntil` (a live takeover timer, not a setting).

It is an **explicit action, not something that fires on connect**. Two accounts running side by
side is a supported arrangement, so "a new account appeared" cannot be read as "it is replacing
that one" — and guessing wrong turns monitoring on for hundreds of groups under a second number,
which means **every customer gets answered twice**. `getGroupSetupCandidates()` previews it, and
its `wouldCarry` figure is the load-bearing number: setup can only land on a group the new account
is also in, and a new number is in nothing until somebody adds it. "0 of 1,848 would carry" is the
answer, not an error — the groups must be joined first, and **`addGroupParticipant` also verifies
membership**, so bulk-adding the new number requires the old one still connected.

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

**Team-member recognition is digits-only on both sides** (`resolveActiveTeamMember` in
`pipeline/teamFilter.ts`, via `normalizePhoneNumber`). It was raw string equality, which could
never match: OpenWA delivers a sender as a JID (`8801XXXXXXXXX@c.us`) while people enter
colleagues as `+8801XXXXXXXXX`. Every team member was therefore processed as a customer — no
support activity recorded, human takeover never pausing the AI, and the loop-prevention filter
that stops the system answering its own staff never engaging. `toRawIncomingMessage` now also
strips the JID domain, so `Message.senderPhone` holds a phone number rather than a JID.

**WhatsApp now identifies group participants by a LID, not a phone number** — an opaque 14–15
digit id that is deliberately not their number. Digits-only matching alone therefore stopped
recognising anybody: `resolveActiveTeamMember` matches `InternalTeamMember.whatsappId` **exactly**
first, then falls back to the digits-normalized phone. Adding someone from message history is the
only way to map most of a roster, and that history carries nothing but the LID — so it lands in
`whatsappId` and, because `phoneNumber` is required and unique, in `phoneNumber` too.

That is fine for **recognising** them and useless for **messaging** them: a direct send to a LID
goes nowhere. `hasReachablePhoneNumber()` (`packages/shared/src/groupParticipantAdd.ts`) names the
distinction — a stored number equal to the stored WhatsApp id means no human ever typed one — and
**every send addressed to a person rather than a group must call it first**: the escalation member
tier, the Notification Center's direct recipients, and the AI handover mention all skip an
unreachable member with a log instead of enqueueing into nothing. It is surfaced where it can be
fixed (a "Needs phone number" badge on Team Members, disabled notification checkboxes with the
reason on their edit page), not as a per-alert delivery failure, which would be noise about a
problem that can only be fixed somewhere else.

**The roster can be populated from WhatsApp's own membership list, not just message history.**
`getGroupParticipantCandidates()` reads who has spoken in a group, which is nobody at all for a
quiet group or one being set up before any traffic exists — exactly when you most want to fill the
roster. `requestGroupParticipants()`/`readGroupParticipants()` (`server/actions/teamMembers.ts`)
instead queue a `GET_GROUP_PARTICIPANTS` `WorkerCommand`, which the worker answers via
`WhatsAppProvider.getGroupParticipants()` (OpenWA's `getGroupMembers`), and the dialog polls for
the result. Both paths compare numbers **normalized to digits** before offering or inserting
anyone: `phoneNumber @unique` only catches a byte-identical duplicate, so without that check the
same colleague could be added twice as `+8801…` and `8801…`, splitting their activity across two
identities and making per-member counts quietly wrong.

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

**`getExecutiveWorkload()` is the headline report, and `getDailyHoursWorked()` is the trap it
replaced.** Hours-worked sums `SupportSession.durationSeconds`, which is only written when a
session COMPLETES, which needs a rule whose keyword carries `marksCompletion` — a deployment
running the `ANY_MESSAGE` rule (the configuration this module is most often used in, and the one
running here) has no such keyword, so its sessions never complete and its hours report is
permanently empty **while looking perfectly healthy**. `getExecutiveWorkload()` instead reads the
activity rows directly: one raw-SQL query spanning each person's first→last message **per group
per Dhaka calendar day**, summed. Per group *and* per day deliberately — one span across a week
would count the nights in between, one span across every group at once would count the time they
were busy elsewhere. A day with one message is zero seconds, which is honest rather than
flattering; the message count beside it is what says they were working. `date_trunc('day', … AT
TIME ZONE 'Asia/Dhaka')` bounds the shift the way the person lived it: UTC midnight falls at 06:00
local and would split every morning in two.

**A team member with recorded activity is deactivated, never deleted.** `SupportActivity.teamMemberId`
is `SetNull`, so hard-deleting someone silently orphaned every activity they ever recorded — this
had already happened in the live database. Someone added by mistake with no activity is still
genuinely deleted. Sidebar nav for this module is four entries, not six: Rules and Keywords were
two more lines for the same job as Settings (deciding what counts), so **Setup** hosts them with
their routes unchanged, and **Team Performance** leads because it is the question the module gets
opened to answer.

**Presence is one timeline per person, split on an idle gap** (`SupportActivitySettings.offlineAfterMinutes`,
default 120). Somebody is online from the moment they message any group; go that long without
messaging and they are offline; message again and a new stretch begins. `getExecutiveWorkload()`
sums those stretches, first message to last.

Across **all** groups rather than per group, which is the correction that matters: measuring each
group separately and adding them up double-counts anyone working two conversations at once — an
executive in group A 10:00–11:00 who also answers group B at 10:30 was credited 60 minutes plus 15
for one hour of work. Handling several groups at once is the normal shape of this job, so that
inflated the busiest people most. The idle gap is what keeps a single timeline honest; without it
one message at 09:00 and one at 18:00 would read as nine hours.

**One threshold drives both readings.** "Is she online now?" and "how long was she working?" are the
same question at different moments, and they previously had different answers — availability used a
hardcoded 30 minutes while work time was per group per day — so somebody could show offline inside a
stretch the same page was counting. `getPresenceTimeoutSeconds()` is the single reader, clamped to
5 minutes–24 hours because a zero would make every message its own stretch and show everybody
permanently offline, which reads as broken rather than misconfigured.

**The module measures what the team DID, so it was blind to the absence of it.** A customer
nobody answered produces no `SupportActivity` row, opens no `SupportSession`, and therefore
appeared nowhere — a busy week and a week with six people ignored read identically.
`getGroupsAwaitingReply()` closes that: monitored, active groups whose newest `Message` is inbound
and not from a team member, longest wait first. It reads `Message` rather than `SupportActivity`
deliberately, so it depends on no rule being configured, no session completing and no counting
setting being right. A reply is `direction = OUTGOING` (ours, including AI) **or**
`isFromTeamMember` — an executive on the business phone produces the first, one present in the
group as themselves produces the second.

`getFirstResponseStats()` is the metric a support lead is judged on, and the module had nothing
like it. Only messages that **start** a wait are measured — a customer sending four lines in a row
is one person waiting once, and counting each would flatter the figure by dividing one real wait
across three near-instant ones. **The median is the headline, not the average**: one conversation
answered the next morning drags an average past every honest reading of the day. Average and worst
case sit beside it, because the worst case is usually the one being complained about.

**Two dead reports were deleted rather than left to be picked up.** `getDailyHoursWorked()` (0
callers) summed `SupportSession.durationSeconds` and is the trap described above.
`computeSupportActivityCount()` (0 callers) was the only consumer of
`SupportActivitySettings.countingMode` — so that **setting did nothing at all**: it was saved,
validated, offered in the form and reported by the AI assistant, while every number on every page
stayed identical whichever value was chosen. It was dropped rather than wired up, because it is
also redundant: the Activity Feed shows unique groups and total activities as separate tiles, and
per-member totals are their own table, so wiring it in would have meant hiding one of two numbers
already on screen.

Team members can be added by picking real senders out of a group
(`getGroupParticipantCandidates`) rather than typing numbers: the phone number is the exact match
key, and a typo silently classifies a colleague as a customer.

`REACTION` as a fifth trigger type stays unbuilt, and should: beyond needing a separate
subscription and a new table, OpenWA's `onReaction()` is gated behind an **Insiders licence this
deployment does not have**, so the trigger would appear configured in the UI and never fire once.
(`sendTextWithMentions`, used by the handover mention, is *not* licence-gated — the two are often
assumed to go together.)

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

**Asking a person by name, inside the customer's own group** (`aiFallback/mentionTeam.ts`,
`AiSettings.mentionTeamOnHandover`, off by default). The ordinary handover alert goes to a separate
notifications group: it tells the team, but not *where*, and the customer sees nothing happen at
all. `mentionTeamForHandover()` posts in the conversation itself and tags the group's
`assignedTeamMember`, or whoever opted into `AI_HUMAN_FALLBACK` alerts if there is none, **capped
at three** — tagging everybody turns a request for help into a broadcast nobody feels responsible
for. Anyone failing `hasReachablePhoneNumber()` is skipped: a mention addresses a real contact, and
tagging a LID resolves to nobody, producing a message that *looks* like help was summoned when it
was not. Off by default because it puts an extra message in front of a customer, which is a
decision about tone rather than plumbing. It goes through `enqueueOutboundMessage` like everything
else — `OutboundMessage.mentions` carries the contact ids and the provider uses
`sendTextWithMentions` only when that array is non-empty, so no ordinary reply changes send path to
serve this.

### Outbound rate limits are shaped for conversation, not for one acknowledgement

The original limits assumed automation sent a single acknowledgement per customer. Once AI answers
customers, "3 replies per client per hour" stopped being a spam ceiling and became **a cap on how
many of that customer's own questions get answered** — a fourth question in an hour got nothing
back, and the reply was *discarded*. Three things were fixed together, and the reasoning matters
more than the numbers:

- **Per-client limits bound a runaway loop, not a conversation.** Automation only ever replies, and
  loop prevention stops it answering its own or a colleague's messages, so these were raised
  (60/hour, 500/day) — still far below what a runaway rule or reply loop does, since those fire
  faster than a person types. **Global** limits are the ones genuinely protecting the WhatsApp
  number across all conversations (20/min, 600/hour, 5000/day) — ceilings, not targets.
- **`RATE_LIMITED` is no longer terminal for an auto-reply.** Every row this path produces is a
  reply to a message a customer actually sent, so discarding one means that customer is never
  answered at all. It now **defers** (as `MANUAL_REPLY` already did) up to 20 attempts across about
  ten minutes, then gives up for real so a permanently exhausted limit cannot cycle forever.
- **The test-group exemption resolves the group through `relatedMessage.groupId`.** It read
  `OutboundMessage.groupId`, which the schema is explicit is null for automation-generated rows —
  that column belongs to the broadcast path — so a group put in test mode was still rate limited at
  send time.

None of this touches the kill switch, MANUAL_ONLY, membership verification, idempotency or loop
prevention. See the anti-spam bullet under Engineering standards: these defaults were loosened
**on explicit request**, for this reason; do not loosen them further unasked.

### Notification Center (`apps/worker/src/notifications/eventSettings.ts`, `(dashboard)/notifications/events/`)

`NotificationType` was the *channel* (TEAMS | WHATSAPP) all along; nothing recorded **why** a
notification was raised, so every alert went wherever the two global destination settings pointed,
together. A team buried in unknown-pattern alerts had exactly one remedy: remove the notification
group, which also silenced escalations.

`NotificationEvent` is derived from the five places in the worker that actually raise one, not
invented: `SUPPORT_ESCALATION`, `AI_HUMAN_FALLBACK`, `RULE_NOTIFY_TEAMS`, `RULE_NOTIFY_WHATSAPP`,
`UNKNOWN_PATTERN`. Each gets its own `NotificationEventSetting` — enabled, per-channel switches,
and its own WhatsApp destination list.

**The gate lives inside `enqueueNotification()`**, which now *requires* an `event`, so a new caller
cannot forget it — and muting means **nothing is written**, not that a row is created and quietly
skipped later, which would leave the delivery log full of things that never went. The escalation
path checks separately because it writes its `Notification` inside the same transaction as the
`SupportEscalationEvent`; those two have to land together or a tier fires twice.

**It fails open throughout.** A missing row, an unmigrated database, a lookup that throws — all
deliver the notification. A suppressed alert is noise; a silently dropped escalation is a customer
nobody saw, and the two are indistinguishable from the console. Being additive is the other half:
no settings row means "behave exactly as before" (every event on, both channels, global
destinations), and an event with an **empty** group list *inherits* the global list rather than
sending nowhere — "not configured" and "configured to nobody" are different intentions, and
reading them the same way would break alerts for anyone who merely opened a card and saved it.
Notifications predating the column keep a null `event` and are reported as such; inferring what
each was for after the fact would be a guess presented as history.

`TeamMemberNotificationPreference` is the other half: who *additionally* receives an alert as a
direct message — the difference between "the escalations group was told" and "the person on call
was told". Opt-in **per member per event** (somebody wants escalations at 2am and never wants
pattern suggestions), stored as row *presence* rather than a row per event with a boolean, so
adding an event type later cannot silently start messaging everyone who happened to have a row.
Three deliberate properties: it is **additive** (the group copy is still sent — the group is the
record, the DM is the tap on the shoulder); **WhatsApp only and only alongside the WhatsApp copy**,
so a Teams webhook does not also fan out to everyone's phone; and per-recipient failures are
swallowed, with anyone already receiving the alert at that exact chat skipped rather than sent it
twice. `getDirectRecipients()` **fails closed**, unlike the rest of the module — a DM is an
addition, so if it throws the group has still been told.

### Notification Templates (`packages/shared/src/notificationTemplates.ts`, `(dashboard)/notifications/templates/`)

Every message this system sends that a person reads, in one editable catalogue: the AI handover
alert, the message posted in the customer's own group when AI tags somebody, rule alerts, the
unknown-pattern suggestion, and the five escalation tiers.

**Default wording lives in code; the table holds only overrides.** No rows are seeded — an absent
`NotificationTemplate` row means "use the built-in", the same shape as `NotificationEventSetting`.
Three things follow, and they are the reason for the shape: a fresh install works with nothing
configured; an unedited template keeps tracking wording improvements shipped later; and **Reset is
a DELETE**, not a copy of the current default, so a reset template goes back to tracking the app
rather than freezing at whatever it said that day.

`renderNotification()` (`apps/worker/src/notifications/templates.ts`) **never throws and never
returns empty**. A missing row, an unreadable database, a stored body that has since become invalid,
or an edit that renders to nothing once the variables are filled in — all fall through to the
built-in. Same fail-open reasoning as `getEventDelivery()`: a slightly wrong alert is noise, a
dropped escalation is a customer nobody saw. A stored body is **re-validated before use**, because a
template saved against an older catalogue can name a variable that no longer exists, and that would
reach a customer as a literal `{{oldName}}`.

`validateTemplateBody()` runs in the browser *and* in the server action — the client check is a
convenience a stale tab walks straight past. It refuses unknown placeholders (naming the valid ones),
empty bodies, anything over 4000 characters, and removal of `{{mentions}}` from
`AI_HANDOVER_MENTION`: without it the tags vanish and the customer reads that help was summoned
while nobody was actually tagged. At render time an unknown placeholder is left **visible** rather
than blanked, matching the Teams template this borrows from — a visible `{{typo}}` in an internal
alert is a bug report; a silent gap looks like missing data. A line whose only content was an empty
variable is dropped, so an unassigned case has no "Assigned to:" line rather than a dangling one.

**There is deliberately no "add template" button.** The catalogue is the set of moments the worker
actually raises, not a settings list — a row nothing sends, configured on a page implying it will,
is the dead-setting problem this project keeps removing. A new alert is a code change; its entry
here is one line of that change. `key` is a plain `String @id` validated against the shared
catalogue rather than a Prisma enum, so adding one needs no migration.

Wording only. Whether an alert is raised, its channels, and its destination groups are the
Notification Center's job.

**Each card says whether it can currently send** (`server/notificationTemplateStatus.ts`). Without
it the page invites a precise waste: rewrite the escalation wording, save, and never learn that
escalation alerts are muted. It reports the actual blocker rather than a generic "off" — a muted
event, a switched-off feature, or nothing to trigger it at all (no active rule with a notify
action; no group carrying a priority tier, which is what escalation needs since it is SLA-timer
driven rather than flag driven) — and links to where each is fixed. An **absent**
`NotificationEventSetting` row counts as enabled, matching `getEventDelivery()`; reading it as off
would show every template dead on a deployment that has simply never opened that page. It never
disables the editor: preparing wording for something you are about to switch on is legitimate.

**Test send** (`sendTemplateTestMessage`) delivers the SAVED wording with sample values to a chosen
group, prefixed `🧪 TEST`. The prefix is not decoration — an escalation alert arriving with invented
customer details would be acted on. It goes through the outbound queue as `MANUAL_REPLY` (a person
pressed a button, so the kill switch correctly does not cancel it), and its idempotency key is
timestamped rather than content-hashed because re-sending the same template while comparing wording
is the normal way to use it. Only groups on a CONNECTED account that are still `isActive` are
offered, monitored ones marked — alerting into a monitored group feeds the alert back in as a
message.

The customer-facing template also flags a **language mismatch**: it ships in English, while
`defaultReplyLanguage` is usually Bengali here, so a customer mid-conversation would see the
language change. Auto is not treated as a mismatch — there is no single language for it to disagree
with.

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

Of that phase, **CSV/xlsx export shipped** (`apps/web/src/app/api/teams/export/route.ts`: Issues
with resolution timing, or the synced channel messages — mirroring the Support Activity export,
including why a Route Handler is the justified exception here). Issue rows carry **minutes**
to resolve, not seconds: these are conversations between people over hours or days, and
second-level precision would imply an accuracy that polling every few minutes cannot have. The
other two remain unbuilt for different reasons. **Real-time webhooks are blocked by topology, not
effort** — Graph change notifications need a publicly reachable HTTPS endpoint to deliver to, and
this runs behind Docker on a private port, so the subscription code would register and never
receive, which is worse than nothing because it looks finished. **Session/duration analytics have
nothing to compute from** (0 Teams messages, 0 channels, no connected account); numbers derived
from an empty table are a page of zeroes that implies a working integration.

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

`KnowledgeImportSourceType` covers `PASTED_TEXT`, `DOCUMENT`, `URL` (fetched once, never
crawled — re-import is a deliberate manual act), `PDF`, `DOCX`, `SPREADSHEET` and `FORGE_REPO`. A
spreadsheet of question/answer rows is parsed into entries **directly, with no AI call** — there is
nothing to interpret. `buildImportPrompt` is deliberately separate from the conversation prompt: a
chat log must be *interpreted*, documentation must be *preserved*. They share only the record
format and `parseKnowledgeRecords`.

`/ai-learning/knowledge-base/review` is the trust boundary — everything from both sources lands
`humanVerified: false` and only verified entries are ever retrieved. Discarding archives rather
than deletes.

### What AI may answer (`AiSettings.aiResponseMode`)

The distinction this encodes: a model *knowing* an answer is not the same as this software
having the *authority* to give it. A model can describe how billing software generally works; it
cannot know how THIS company's billing works, and a fluent guess about a refund window sounds
official, which makes it worse than silence.

Every AI reply is therefore classified `BUSINESS_SPECIFIC` or `GENERAL` by the same call that
drafts it (`SCOPE:` in the response format). Parsing **fails closed** — a missing, empty or
unrecognised value is read as `BUSINESS_SPECIFIC`, so a format slip can never be mistaken for
permission to speak for the business.

**There are exactly four modes because at answer time there are exactly three sources** — the
verified knowledge base, live research against the product's own source, and the model's general
knowledge. Conversation learning is **not** a fourth: it, manual imports and the scheduled Forge
sync all *write into* the knowledge base, so they are already present in every mode. A fifth mode
differing only by "conversation learning" would have behaved identically to the fourth, and a
setting that does nothing is worse than no setting.

| Mode | Sources |
|---|---|
| `STRICT_KNOWLEDGE_ONLY` (default) | verified knowledge |
| `KNOWLEDGE_PLUS_FORGE` | verified knowledge + live product-source research |
| `KNOWLEDGE_PLUS_GENERAL` | verified knowledge + the model's general knowledge |
| `KNOWLEDGE_FORGE_GENERAL` | all three |

Under the two modes that do **not** allow general answers, no verified knowledge means no answer,
whatever the question turns out to be about — decided **before** the reply completion, since the
classification cannot change the outcome, so an ungroundable question costs nothing. The gate is
written as "may not answer generally" rather than a list of modes, so adding another source later
cannot silently start letting ungrounded answers through. General answers are held to
`generalAnswerMinConfidence` (normally higher than the main threshold, because nothing of the
team's stands behind them).

**The business-question guard is deliberately not configurable.** Under *every* mode,
`BUSINESS_SPECIFIC` + no verified knowledge → `NO_BUSINESS_KNOWLEDGE` handoff. Relaxing the mode
widens what counts as answerable general conversation; there is no setting that lets the model
invent this company's behaviour. For the same reason an ungrounded general answer never drafts a
rule — a rule is a standing answer the company gives, not the model talking about the world.

The web side must read `AI_RESPONSE_MODES` from `apps/web/src/lib/aiResponseModes.ts` — one
`satisfies readonly AiResponseMode[]` list plus an `isAiResponseMode()` guard, shared by the form
and the server action. It exists because the action previously carried its own hand-written
whitelist of the two modes that existed then, so both new modes were accepted by the form and
silently saved as `STRICT_KNOWLEDGE_ONLY`; a `satisfies`-checked list fails to compile when the
enum grows instead.

### Researching an answer while the customer waits (`apps/worker/src/aiFallback/deepAnswer.ts`)

What the two Forge modes above actually do. When `findRelevantKnowledge()` comes back empty,
`researchForCustomerQuestion()` reads the product's own source right then, works out the answer,
and stores what it learned so the next person gets it instantly.

**It returns GROUNDING, not a reply** — sanitised `AiKnowledgeItem` rows the normal prompt then
answers from, exactly as if a human had written them months ago. Three things follow, and they are
the whole reason for the shape:

- Raw source never reaches the prompt that drafts a customer reply. That arrangement is precisely
  what the disclosure rule exists to prevent.
- Every existing gate still applies afterwards — scope classification, confidence threshold,
  response mode, the send-time safety re-check. It is not a bypass; it is a way of having something
  to be grounded in.
- `checkKnowledgeEntrySafety()` runs here too. This is the one path where an entry can reach a
  customer in the same breath as being written, so it is the last place that should trust a prompt
  to have behaved.

Entries land `humanVerified: true` (`source: DEEP_ANSWER`) — recording one as unverified *while
sending it to a customer* would be incoherent, and would also mean it could never be reused, which
is the point. The mechanical gate stands in for that review, and the setting's own description says
plainly that this is the trade. It also **requires the Forge integration to be enabled and pointed
at a project**: turning on a mode should not quietly start reading a repository nobody connected.
Never throws — the caller is mid-conversation, and a research failure must leave the ordinary
handover intact. A handoff after a failed attempt records `NO_KNOWLEDGE: <reason>` so it is
distinguishable from one where nothing was tried.

### What language AI answers in (`AiSettings.defaultReplyLanguage`)

Default `"Bengali (Bangla)"`. Without a stated default the model infers a language from whatever it
was sent, and a one-word message carries almost no signal — "Hello" was answered in Portuguese and
a short transliterated-Hindi question in Bengali, to Bengali-speaking customers.

`buildFallbackPrompt` makes the model **decide the language first and report it** on a `LANGUAGE:`
line before drafting, then write `RESPONSE` in it. Deciding first is the mechanism: two earlier
attempts that only described the policy in prose produced replies that quietly defaulted to one
language regardless of the question.

`buildLanguageRules()` emits **two different checklists**, not one with a value substituted in,
because the modes disagree about what an ambiguous message means. With a language configured,
"unsure" resolves *to* that language — that is what setting one is for. Under automatic detection
there is no such answer, so the list is built around reading the customer instead, and the ordering
that makes each work differs.

**Fixed language** — order is load-bearing; the greeting rule must precede the English rule, or
"hello" is read as fluent English:

1. A greeting or single word (`hello`, `ok`, `thanks`, `yes`) → the default. These appear inside
   conversations in every language and settle nothing.
2. Only a number, link, invoice reference, product name or emoji → the default.
3. Non-Latin script **other than Bengali** (Devanagari, Arabic, Chinese, Tamil) → that language.
   The exclusion is load-bearing: Bengali *is* non-Latin, so without it this rule and rule 4 both
   claim a Bengali-script message and disagree whenever the default is not itself Bengali script —
   picking Banglish is exactly that case.
4. Bengali script → the default.
5. Bengali written in Latin letters ("bill kivabe generate korbo") → Bengali, not English.
6. A complete, fluent English sentence of several words → English.
7. Anything else — mixed, or not confidently placeable → the default.

**Automatic detection** (`AUTO_REPLY_LANGUAGE`) — mirror the customer's language *and script*:

1. Bengali script → Bengali script.
2. Another non-Latin script → that language. Script is checked first because it is an unambiguous
   signal; reading the greeting rule first would answer a Bengali-script "হ্যালো" in Latin letters.
3. *(everything below is Latin letters)* A greeting, single word, bare number, link, invoice
   reference or emoji → `AUTO_TIEBREAK_LANGUAGE`. Greeting still precedes English, for the same
   reason as above.
4. Bengali in Latin letters → Banglish back, explicitly **not** Bengali script and **not** English.
5. A complete, fluent English sentence → English.
6. Anything else → `AUTO_TIEBREAK_LANGUAGE`.

`AUTO_TIEBREAK_LANGUAGE` is Banglish: a message with no language signal has no correct answer, and
Banglish is the one form a Bengali and an English reader can both follow. Detection runs per
message and is never latched, so the customer's next message settles it properly.

**The sentinel lives in `packages/shared/src/replyLanguage.ts`**, not spelled out per file — the
`AI_RESPONSE_MODES` lesson. Four hand-written copies (form, server action, reply prompt, style
prompt) would drift silently, and the failure is invisible: the model is politely told to answer in
a language called `__auto__` and picks something. Any prompt that talks *about* the setting rather
than obeying it must render it through `describeReplyLanguage()` — the communication-style prompt
says "the assistant writes in X", which needs a phrase, not a sentinel.

The dashboard control is `ReplyLanguageField.tsx`: a real `Select` offering Auto / Bangla /
Banglish / English plus "Other language…", which reveals a text input, with the hint text changing
per choice because the two modes make opposite promises. It was a `datalist`-backed input — a text
box that happens to offer suggestions once you start typing — so nothing on screen said the options
existed. The field stays typeable because a deployment serving another language should not be
locked out of its own product; a language value is passed to the model **by name**, so anything it
recognises works. The server action deliberately keeps **no whitelist** here (unlike the response
mode) precisely because the field must accept a language this code has never heard of.

### Learning how the team writes (`apps/worker/src/knowledge/communicationStyle*.ts`)

`AiSettings.communicationStyleLearningEnabled`, off by default. Learns the **manner** executives
write in — greetings, formality, answer length, how a problem is acknowledged before it is solved
— and applies it to AI replies.

Deliberately separate from `knowledgeFromChatEnabled`, which learns **what** the team knows.
Conflating them would let "our team says refunds take 3 days" arrive dressed as a tone note and
skip the verification a product claim is supposed to get, so `parseStyleGuidance` drops any line
that reads like a fact — a duration, a price, a policy, a promise, a support-hours claim — and is
unit-tested in both directions (real style notes survive; product claims do not).

It reads outgoing messages this system did **not** send (executives typing from the business phone)
plus incoming messages from roster members, excluding anything the automation or AI sent — learning
tone from its own output would tighten a loop around whatever voice it started with — and excluding
the internal notification groups, whose contents are machine-written alerts.

`CommunicationStyleProfile.humanApproved` gates it: even switched on, the guidance reaches nothing
until a person approves it on `/ai-learning/communication-style`, and **every rebuild clears that
approval** so new wording never inherits the trust given to the old. A wrong knowledge entry
produces one wrong answer; wrong style guidance shapes every answer, with no per-reply review to
catch it. In the prompt, style is explicitly **subordinate**: it never overrides the language
rules, the business-question guard, or a fact.

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

### Product knowledge from the ISPDIGITAL repository (`apps/worker/src/forge/`, `packages/forge-client`)

The third knowledge source, after the conversation builder and manual imports: the product's **own
repository**, read through Softify Forge's REST API (`FORGE_API_KEY`/`FORGE_API_URL`). This is what
lets the assistant answer "how do I void an invoice" on a fresh install. **`FORGE_SETUP.md` is the
full reference** — read it before changing anything here.

Three tiers, differing only in how much authority the source has: hand-written user guides
(`docs/user-guides/**`, product overviews) → per-module guides the model writes by reading the
source behind each Forge module → on-demand research of one customer question that nothing covered.
Tier 1 may be auto-verified (`ForgeSettings.autoVerifyUserGuides`, the admin's recorded decision);
**tiers 2 and 3 are never auto-verified regardless of any setting** — a model's reading of source
code is evidence, not fact. Everything reuses `KnowledgeImport` rows and `parseKnowledgeRecords`
rather than a parallel pipeline.

**The customer-facing path is unchanged and has no repository access.** `findRelevantKnowledge()`
still retrieves only `humanVerified: true` + `ACTIVE`; Forge simply contributes more entries. Tier 3
runs *after* the human handoff, never in front of the customer — reading source takes seconds and
several round trips, and doing it inline would put raw code into the same prompt that drafts a
customer reply, which is the exact arrangement the disclosure rule exists to prevent.

**`checkKnowledgeSafety()` (`packages/forge-client/src/knowledgeSafety.ts`) is load-bearing, and the
prompt is not trusted to do its job.** Every generated entry is re-checked mechanically; anything
naming code, schema, tables, endpoints, infrastructure, servers or credentials is dropped and
logged, never stored — not even as a draft. This is not theoretical: the first live run stored and
auto-verified "this will create a `CustomerBillMaster` for each customer", produced by faithfully
summarising a manual written *for customers* that introduces those names itself. The
`internal-identifier` rule (compound capitalised words minus an allowlist of real product/vendor
names) exists because of that, and is tested against the exact strings that leaked. The gate must
also stay quiet on ordinary support English — a check that blocks real answers gets ignored, and an
ignored check protects nothing.

A module whose `sourcePaths` do not resolve produces **nothing**, deliberately: given a module name
and no source, the model invents a plausible guide (observed — "Support & Tickets" produced five
confident answers from zero bytes). `packages/forge-client` implements only read endpoints; Forge's
task/comment/daily-log writes are deliberately not wrapped.

`apps/worker/src/bootstrap/provisionAiProviderFromEnv.ts` turns `OPENROUTER_API_KEY`/
`OPENROUTER_MODEL` into a real `AiProvider` + `AiModelConfig` on boot — without it a key in `.env`
looks configured and does nothing, since every AI feature resolves its client from the table. It
never overwrites an existing provider or steals a job slot an admin already assigned.

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

`AiProviderKind` covers ANTHROPIC, OPENAI, **OPENROUTER**, **OLLAMA** and **GOOGLE** (only
`CUSTOM` remains reserved). All but Anthropic share `OpenAiCompatibleClient` via
`OPENAI_COMPATIBLE_KINDS`; only the default endpoint, whether an `Authorization` header is sent,
and the timeout differ. Gemini needs no client of its own — Google publishes an OpenAI-compatible
chat-completions endpoint, so enabling it was adding the kind and prefilling the URL. **`CUSTOM`
stays reserved deliberately**: every OpenAI-compatible endpoint is already reachable by choosing
OPENAI and setting the API URL, so implementing it would be a second way to do one thing, and the
way with no prefilled endpoint and no key rules to guide anyone.
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
download) that must stay real navigation, not a client `onClick`. `GroupPicker` is the shared,
searchable WhatsApp-group selector — **never ask anyone to type a raw group id**
(`1234567890-1234567890@g.us`): nobody knows those from memory, they get pasted from somewhere
else, and one wrong character is a destination that silently never receives anything. It also
carries the feedback-loop warning when a chosen group is one the system monitors, which a textarea
could not. `SearchField` is the shared list-search control; it is a plain **GET form**, not
debounced client state, matching every other filter in this app — which also means a searched list
can be bookmarked, shared and survives a refresh. It carries the page's other filters through as
hidden fields so searching narrows rather than silently resets them.
`(dashboard)/loading.tsx` and `(dashboard)/error.tsx` exist at the **group** level so all ~75
routes inherit them (two of seventy-five had a loading state and one had an error boundary before);
the two routes with layout-specific skeletons keep theirs, since Next prefers the nearest one, and
the group-level skeleton is deliberately generic because it stands in for pages with very different
layouts. Touch sizing is scoped to `pointer: coarse`, **not a screen width** — a narrow browser
window on a laptop is still a mouse and keeps the tight spacing; a large tablet is still a finger.
Growing the controls themselves was chosen over an invisible enlarged hit area, because two ghost
buttons in a table row would have ended up with overlapping invisible regions, and a tap landing on
the wrong action is worse than a row being a few pixels taller. `(dashboard)/DashboardShell.tsx`
is a Client Component wrapping `Sidebar` + page content + the floating AI chat — it owns the mobile
nav drawer and a pathname-keyed page-entrance animation; `layout.tsx` itself stays an async Server
Component doing only data-fetching. Multi-account routing for WhatsApp-sending features goes
through `resolveWhatsAppAccount(serviceKey)` (`packages/db`) — the single centralized resolver
every sending feature must call, never re-derive the Primary/pinned/fallback decision at the call
site.

**The Overview charts are hand-rolled inline SVG** (`components/charts/`: `AreaChart`,
`ColumnChart`, `DonutChart`, `StackedBar`, `BarList`, wrapped in `ChartCard`) — there is no
charting library and adding one is not the answer to wanting another chart. Colour comes from the
design system, and which set matters: `--chart-1..6` are **identity** slots for categorical series,
status tokens (`--color-success`/`warning`/`danger`) are for **state**. Painting AI green or amber
in the human-vs-AI split would editorialise a ratio the reader is meant to judge; painting a failed
send anything but danger would hide it.

Nine charts, and each has to answer a question somebody acts on — decorative dashboards are
explicitly against the standards. The four newest: **AI answers and handovers** (a handover is the
safety rule working, not a failure, and is not coloured as one), **how long customers wait** (median
per day, same wait definition as `getFirstResponseStats` — two response-time numbers computed
differently on two pages is worse than one), **support delivered** (people vs AI, with
`aiOnlyGroups` as the figure worth watching), and **busiest executives**.

`getResponseTimeSeries` is the heaviest query on the landing page — a window function over fourteen
days of messages partitioned by group, leaning on `Message`'s `[groupId, timestampWa]` and
`[timestampWa]` indexes. If volume ever makes it the bottleneck the answer is a nightly rollup, not
a narrower window: the "wait" definition must stay identical to Team Performance's.

Nav lives in one place — `(dashboard)/navigation.ts`. Groups, top to bottom (a pinned
"Overview" link sits above all of them; Messages leads with the WhatsApp Chat inbox): Messages,
Escalations, Support Activity, Teams Integration, WhatsApp, Automation, Bulk Messaging, AI Learning,
Conversation Learning, System, Users & Permissions — ordered by day-to-day check frequency, not by
when each feature shipped. See `PROJECT_REFERENCE.md` for every link in every group.

**Every settings column should have a control, and the audit that closed the last gaps is worth
not undoing.** `GroupBroadcastSettings` had six columns and no form anywhere — so the throttles
governing the riskiest thing this product does (sending the same message to hundreds of groups,
from the number that also serves every customer) were permanently whatever the schema defaulted to.
Bulk Messaging → **Sending Limits** now covers pace, size, retries and the repeat cooldown, and
`AutomationSettings.retryIntervalsMs` sits beside its own attempt count on Settings. Both **take
seconds and store milliseconds** — a backoff list typed in thousandths invites the one-digit slip
that turns a fifteen-second gap into a fifteen-millisecond one, and nobody notices until retries
are hammering a rate-limited number; convert once, at the boundary. Every value is **clamped
server-side** rather than trusted from the form, and an empty or unparseable backoff list keeps the
current schedule rather than quietly becoming "retry immediately". That leaves `automationEnabled`
as the only settings column with no form field, which is correct: it is the kill switch and has its
own confirmed control on Automation Control rather than sitting among ordinary inputs.

**Bulk actions read current state before writing**, so they report "8 enabled, 1 already on, 1 not
found" rather than "Done", and converge on a re-run instead of writing twice. `bulkSetAiAutomation`
mirrors `bulkSetMonitoring` with one deliberate difference: it **never clears
`aiAutomationExcluded`**. That flag is a hard "never let AI answer here", and a broad gesture must
not quietly override a specific one — those rows are reported as "left alone — excluded from AI",
because an operator who selected a group and saw nothing happen needs to know why. The confirmation
dialog describes the action it is actually confirming; a confirmation that misdescribes what it is
about to do is worse than no confirmation.

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
- **Test groups lift throttles, never safety.** `WhatsAppGroup.testModeEnabled` exempts one group
  from cooldowns, per-client and global rate limits, the randomised reply delay, and
  SAFE_AUTO_REPLY's rule-type restriction — so every message and rule type can be exercised
  back-to-back. It must never bypass the kill switch, MANUAL_ONLY, the monitored-group
  requirement, membership verification, the queue, idempotency, account isolation, loop
  prevention, or the AI's business-question guard. The number serving the test groups is the same
  one serving every customer, and rate limits are what stop it being banned.
- **Anti-spam philosophy is load-bearing, not incidental**: automation is conservative and
  reply-triggered-by-incoming-message only; no unrestricted bulk mode; every auto-reply path
  respects per-client/global rate limits and rule-level cooldowns (`AutomationSettings`,
  `AutomationRule.cooldownSeconds`). Don't loosen these defaults without being asked. The
  per-client limits *were* loosened once, on explicit request and for a stated reason — see
  "Outbound rate limits are shaped for conversation" above; the global limits protecting the number
  itself, and every safety gate, were untouched.
- **Soft-delete over hard-delete** for records with historical value (e.g. deactivate a
  `WhatsAppGroup` the account left, don't delete it) — this now includes an `InternalTeamMember`
  who has recorded support activity, since `SupportActivity.teamMemberId` is `SetNull` and deleting
  them orphans their whole history.
- **Errors must be actionable** ("Group membership verification failed. The message was not sent.
  [Retry]"), never a bare "Error occurred"; no internal stack traces surfaced to the dashboard UI.
- **Production safety checklist** before touching live-connected functionality: check current
  state, migration status, worker health, WhatsApp connection state, and pending
  commands/jobs first; make the smallest change possible; verify after.
- Do not refactor unrelated code while implementing a feature unless required for correctness.
