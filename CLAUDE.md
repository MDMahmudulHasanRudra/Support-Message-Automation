# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Rule-based WhatsApp support automation: a Next.js dashboard (`apps/web`), a dedicated OpenWA
worker (`apps/worker`), and a PostgreSQL/Prisma backend (`packages/db`), run via Docker Compose.
`README.md` says "Status: Phase 1 — Project Foundation" — that line is stale; the codebase has
since shipped multi-account routing, the rule engine, the outbound queue, Priority-Based Support
Escalation, Conversation Learning (pattern detection + AI-assisted analysis), and a consolidated
dashboard. `ARCHITECTURE.md` is the durable, still-accurate design reference (component
boundaries, DB-mediated web⇄worker coordination, provider abstraction); treat its phase numbering
as historical, not current status.

Four root-level `*.md` files (`RULE-BASED SUPPORT MESSAGE AUTOMATION.md`,
`WHATSAPP ACCOUNT SAFETY AND ANTI-SPAM REQUIREMENTS.md`,
`Priority-Based Support Monitoring & Escalation — Implementation Command.md`,
`AI Learning & Knowledge System — Full Development Prompt.md`) are the original build specs for
each major feature area — useful for rationale/intent, but `ENGINEERING_STANDARDS.md` (below) is
the living rulebook for ongoing work, not these.

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
active-team-member check → resolve `WhatsAppGroup` → fetch the previous message in the chat
**before** inserting the current one (so it can't match itself) → insert the `Message` row (a
Prisma `P2002` unique-constraint violation here *is* the dedup/idempotency check) → fire-and-forget
escalation side-effect (own try/catch, never gates the rule outcome) → `evaluate()` from
`packages/engine` against active `AutomationRule`s (single priority-sorted pass) → execute the
resulting action(s) — actions only **enqueue** (`enqueueOutboundMessage`/`enqueueNotification`),
never send directly → persist `AutomationExecution` + update message status → upsert
`ProcessingCheckpoint`.

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
  (optional, separately gated). All three are entirely off by default.

### apps/web

Server-rendered (App Router), no client-side data layer — pages fetch via `prisma.*` directly in
server components (`(dashboard)/*/page.tsx`), mutations go through `src/server/actions/*.ts`
(`"use server"`). Read-only, multi-query dashboard summaries (e.g. `dashboardSummary.ts`) are plain
async helpers in the same `server/actions/` directory *without* `"use server"`, since they're never
invoked from a client event handler. UI is a small custom component kit under
`src/components/ui/` (`Card`, `StatTile`, `Badge`, `Table`, `DashboardModuleCard`, etc.) on Tailwind
CSS v4 with CSS-custom-property design tokens (`globals.css`) — **no shadcn/Radix, no charting
library**; trend visuals are hand-rolled inline SVG (see `Sparkline.tsx`) by deliberate choice.
Multi-account routing for WhatsApp-sending features goes through
`resolveWhatsAppAccount(serviceKey)` (`packages/db`) — the single centralized resolver every
sending feature must call, never re-derive the Primary/pinned/fallback decision at the call site.

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
