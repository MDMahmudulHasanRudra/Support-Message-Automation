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

**A new test must be confirmed to FAIL against the code it is protecting, before it is kept.** Not
a formality: `collectionWatchdog.integration.test.ts` initially passed 16 of 17 against the exact
pre-incident selection it exists to prevent, because the fixture set the provider's status without
setting the account's DATABASE status — and the old watchdog selected on the column. Setting only
one of two things that production always sets together is how a suite ends up guarding nothing. The
same check is why `queryRewrites.integration.test.ts` spells the OLD query out inline: it no longer
exists in the codebase, and comparing a rewrite against itself proves nothing.

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
packages/shared   canonical enum/type definitions (engine can't depend on @prisma/client, so these are the source of truth; Prisma schema enums are kept in sync by convention, not tooling)
```

pnpm workspace (`pnpm-workspace.yaml`); Node >= 22.13. `packages/db`/`packages/shared` are consumed
as raw TypeScript by both apps via Next's `transpilePackages` (web) / `tsx` (worker dev) — `engine`
and `shared` do have a `build` step to `dist/`, but web still transpiles their source directly; only
worker's production `start` (compiled) actually depends on `dist/`.

**Every process gets a BOUNDED Prisma pool** (`withPoolBounds` in `packages/db/src/index.ts`).
Prisma defaults to `num_cpus * 2 + 1` PER PROCESS and nothing ever set one, so `app` and `worker`
each sized themselves off the host's core count against a stock `postgres:16-alpine` whose
`max_connections` is 100 — now stated explicitly in `docker-compose.yml` so both sides are sized
against one number. A URL that already names `connection_limit`/`pool_timeout`/`connect_timeout`
keeps its own value, which is what leaves `test:isolated`'s deliberately tighter pool untouched and
lets a deployment override any of the three without a code change. The test harness has carried
exactly these three parameters since an unbounded pool started failing suites at random; this is
that lesson applied to production.

**`packages/db/src/` has zero relative imports between its own files, by hard rule** — Node's
runtime (worker) and Turbopack (web) have resolved a relative import differently between two files
in this package before, and it caused a real production outage. Any new function that needs to live
alongside `resolveWhatsAppAccount()`/`encryptSecret()`/etc. goes in the same file, not a sibling
module reached by `./`.

### Multi-project (in progress — `MULTI_PROJECT_PLAN.md` is the reference)

The platform is becoming multi-project: the original installation is the project **ISP Digital**
(`proj_isp_digital`, slug `isp-digital`). **Phase 1 (database foundation)**: `Project`,
`ProjectAccess`, `ProjectFeature`, a `projectId` on the 70 project-scoped tables plus a nullable one
on `SystemLog`, and composite `(projectId, …)` uniques. Its temporary ISP Digital default and the old
install-wide uniques were removed in Phase 3 (below).

Two rules that hold from here on:
- **Project access ≠ permission.** `ProjectAccess` says which projects a user may enter, nothing
  more. What they may do inside is the EXISTING permission system, unchanged, the same in every
  project. Never add a role or permission column to `ProjectAccess`.
- **`projectId` means the platform project, everywhere.** ForgeSettings' own Forge-repository
  project is `forgeProjectId`/`forgeProjectName` (renamed in the Phase 1 migration) so the two
  cannot be confused.

**Phase 2 (web isolation) has landed too.** In apps/web the project comes from the URL
(`/p/<slug>/…`; `proxy.ts` sets `x-softify-project` from the path and strips any client copy), and
`import { prisma } from "@/server/db"` is a PROJECT-SCOPED client: every query on a project-owned
table is confined to that project, fails closed with no project, and refuses one naming another.
Never import `prisma` from `@support-automation/db` in web code; only `server/auth.ts` and
`server/projectContext.ts` use the platform client. `$queryRaw` is NOT covered: every raw query must
add `"projectId" = ${await activeProjectId()}`. Write links project-relative ("/rules") through
`@/components/ProjectLink` / `ButtonLink` / `useProjectRouter`, and pass server paths through
`await projectPath("/rules")` before `redirect`/`revalidatePath`. Work in `after()` must be wrapped in
`runWithProject(project, …)`, because it has no request headers.

**Phase 3 (worker isolation) has landed too.** Worker code imports `prisma` from `src/db.ts`: the
same scoped client, resolving the project from `project/context.ts`'s `AsyncLocalStorage`, and
throwing outside a project. Work enters a project in exactly three ways: `withAccountProject(accountId)`
(the account row is the authority: the message path, group sync, connection state), a shared queue
row's own `projectId` after a global claim through `platformPrisma` (outbound, notifications,
commands, group adds, escalation, stranded messages), or `forEachProject` for the per-project
scanners. Never take a project from a message or payload, never default one, and never call a
self-entering function (`processOne`, `processOneCase`, `processIncomingMessage`…) from inside a
DIFFERENT project — a nested switch throws. Every send checks that the sending account belongs to
the row's project. The database has no default project any more: `projectId` defaults to
`project_id_required()`, which raises, and the old install-wide uniques are gone — use `findFirst`
(scoped) or the compound `projectId_*` key (`await activeProjectId()` in the web,
`currentProjectId()` in the worker). Worker tests write fixtures through
`__tests__/helpers/projectFixtures.ts` (ISP Digital outside a context) and wrap project-wide jobs in
`inIsp(...)`. See `MULTI_PROJECT_PLAN.md` §10.3.

**Phase 4 (Main Admin Portal) has landed.** `/admin` (outside every project) lists projects, creates
them and manages who may enter each one; the sidebar header is the project switcher, and the
breadcrumb starts with the project name. Gated by two new keys, `projects.view` / `projects.manage`
(a Main Admin, who may also enter every project); `READ_ONLY_PERMISSION_KEYS` deliberately excludes
them, so Read Only did not change. A project is created only through `createProjectWithDefaults()`
(packages/db) — one transaction, its own default rows, automation off, nothing copied. SUSPENDED and
ARCHIVED projects are read-only in the web (checkPermission words it, `server/db.ts` enforces it) and
held in the worker (queues skip them, scanners skip them, incoming messages stored without
automation; archived accounts are not connected). See `MULTI_PROJECT_PLAN.md` §10.4.

**Phase 5 (project feature flags) has landed.** `packages/shared/src/projectFeatures.ts` is the
catalogue: each feature's routes, the permission keys only it uses, and what switching it off stops.
A feature is an ENTITLEMENT set by a Main Admin; the module's own settings stay the project's choice
within it, and both must be on. Enforced in four places — nav (`navGroupsFor(granted, disabled)`),
pages (`requireProjectPage` via the proxy's `x-softify-project-path`), actions (`checkPermission`,
by page path, exclusive key, or an explicit `checkPermission(key, "FEATURE")` for shared-key
modules), and the worker (`projectHasFeature` beside each setting check). A new page belongs in a
feature's `routes` if it is that module's; a new action in a shared-key module passes its feature.
Never compare a project's name or slug in code. See `MULTI_PROJECT_PLAN.md` §10.5.

The migration's `projectId` foreign keys were added `NOT VALID` and validated in a separate
migration (`…_projects_foundation_validate`): a plain FK add scans `Message` under a write-blocking
lock inside Prisma's per-migration transaction; `VALIDATE CONSTRAINT` does not block inserts.

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

**An attempt that does not connect must not leave its Chromium running** (`orphanBrowsers.ts`).
OpenWA returns a client only when `create()` resolves, so an attempt that ends any other way — the
five-minute window expiring unscanned, an operator switching to a phone code — left its browser
parked on a rotating QR, unreachable (the library keeps it in a module variable the next launch
overwrites). Once the window became five minutes that was the normal case, not an edge: observed
24 Sep 2026, every retry launched a second browser on the same profile and died early as "App
Offline", and the orphan kept writing codes to the dashboard after the last retry gave up. Browsers
are now killed by process, matched on the exact `--user-data-dir` argument (one profile per
account), before every launch and when an attempt unwinds; a code arriving with no attempt in
flight is never published; and an attempt ending clears its stored QR.

### Replacing the number that serves customers (`accounts.ts`, `GroupSetupTransfer.tsx`)

**A customer reply always goes out on the account that received the message** — `runAiFallback` is
handed `accountId: raw.accountId` and never calls `resolveWhatsAppAccount()`. Primary and Account
Routing govern only the *notification* service keys (`NOTIFY_WHATSAPP`, `PRIORITY_SUPPORT`,
`CONVERSATION_LEARNING`; `TEAMS_RESOLUTION_NOTIFY` is retired); none of them is "reply to a customer", and
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

### Collecting every message (`OpenWAProvider`, `catchUpMissedMessages.ts`, `accountRegistrySync.ts`)

Message collection is a **push**, and that is the whole difficulty: anything that arrives while
this process is not listening is not delayed, it is gone. Three separate holes let that happen, and
all three are closed here. Read this before touching the connect/subscribe path.

**The listener lives on the provider instance, never on a client object.** `connect()` builds a
brand-new OpenWA `Client` every time, and `onAnyMessage` attached to the previous one dies with it.
`subscribeToMessages()` therefore only *records* the handler; `connect()` re-attaches it at the end
of every successful connection, and `attachMessageListener()` compares client identity so a second
call cannot double-wire the same client and process every message twice. The gate is inside
`connect()` rather than at the call site precisely so no reconnect path — the RECONNECT command,
automatic recovery, anything added later — can forget it.

This was a real, silent, total failure. The listener used to be attached exactly once, by
`ProviderRegistry.connectAccount()`, to whatever client existed then. The dashboard's RECONNECT
(`provider.disconnect()` + `provider.connect()`) left the account **CONNECTED, green, sends still
working, and collecting nothing at all, permanently** — until the worker process was restarted.
Nothing reported it, because "no messages arriving" and "a quiet afternoon" are the same thing from
the outside.

**`catchUpMissedMessages()` fills the gap after every connect** — the registry's initial connect (
chained after the group sync, so a recovered message can resolve to a `WhatsAppGroup` row), the
RECONNECT command, and automatic recovery. `ProcessingCheckpoint` is what makes a gap knowable: it
has been written on every message since the pipeline was built and read by **nothing**, and this is
the reader it was always for. The provider answers with `fetchMessagesSince()`, bounded by chat
activity rather than by roster size — `getAllGroups()` reports each chat's last interaction, so a
fifteen-minute gap reads the handful of groups that actually received something, not all 1,848.
Groups only; that is where this product's conversations live.

**Replay is safe because `Message @@unique([accountId, whatsappMessageId])` already is the dedup
guard** — `persistIncomingMessage()` returns null on `P2002` and both paths share it, so a message
recovered after a gap lands byte-identically to one seen live. Sharing that write is not tidiness:
`storeNonAutomatedMessage` is the older second copy of it and has already drifted, still storing
`isFromTeamMember: false` with no quote and no mentions.

**Two numbers decide what a replay actually does, and `catchUpWindow.test.ts` pins both.**
`CATCHUP_AUTOMATION_WINDOW_MINUTES` (15) is the consequential one: inside it a recovered message
goes through the ordinary pipeline, replies and all, because a restart must not cost a customer
their answer. Outside it `storeMissedMessage()` records the message and the support activity in it
but evaluates **no rules** — a reply to this morning's question arriving at lunchtime is worse than
silence (a colleague has very likely answered in the group already), and a burst of them on every
restart is the unprompted bulk sending this product refuses to do. Nothing is lost either way: the
message is stored, so it shows in the inbox, counts in Team Performance, and appears under "waiting
for a reply" if it really was never answered. Escalation is deliberately **not opened** for an old
message — a backdated case is instantly overdue and fires its whole alert ladder — but
`markHumanReplied` still runs, because that only ever closes one. `CATCHUP_MAX_LOOKBACK_HOURS` (12)
stops a worker that was off for a week dragging a week back in.

**A dropped session now reconnects itself.** `accountRegistrySync` skipped any account already in
the registry (`has()` was true forever, since the provider outlives the session), so a number whose
session died sat collecting nothing until a human happened to press Reconnect. `recoverIfDropped()`
retries `DISCONNECTED`/`ERROR` only — never `AUTHENTICATION_REQUIRED`/`SESSION_ERROR`, which need a
person with the phone and would otherwise spin forever — behind a 5-minute cooldown, skipped
entirely while an operator's own RECONNECT/LOGOUT command is pending. It requires
`lastConnectedAt` **and** `phoneNumber`: LOGOUT clears the number, and without that check this would
relaunch Chromium every few minutes for a retired spare, forever. `connect()` is also re-entrant now
(it joins an attempt in flight rather than starting a second), because two callers can ask at once
and it does a process-global `process.chdir()` first.

**The group list is completed from evidence, not trusted from one read** (24 Sep 2026, production).
A number linked at 3:11 PM was synced two minutes later, while the phone was still pushing its chats
to the new device: 498 of 1,952 groups. Nothing read the list again, so 1,454 groups stayed
inactive and the inbox (active groups only) hid their conversations; later the page lost WhatsApp
Web's chat store while the account kept reading CONNECTED, and the collection watchdog never looked
because it only checks accounts with *monitored* groups — this one had none. Four fixes:
`resolveGroup` treats a message from a group as proof of membership (reactivates an inactive group,
registers an unknown one with every automation flag off — it never deactivates or enables anything);
the deactivation sweep holds when a read would switch off more than a tenth of the active roster
(`groupSyncGuard.ts`, logged as `GROUP_SYNC_SWEEP_HELD`); two follow-up syncs run 5 and 15 minutes
after every connect; and `checkSessionHealth()` asks each CONNECTED page every two minutes whether
`Store.Chat` exists — two misses record the account DISCONNECTED so `recoverIfDropped` restarts it.
A sync on a page with no chat store fails once with `SessionNotReadyError`, never three times with
"reading 'map'". The watchdog now selects accounts with any ACTIVE group, not only monitored ones.

### Staying up, and noticing when nothing is arriving (`lifecycle.ts`, `recovery.ts`, `pipeline/messageRecovery.ts`, `health/collectionWatchdog.ts`)

**Accounts connect in the BACKGROUND, and nothing may put that back on the startup path.**
`main()` used to `await registry.connectAccount()` in a loop before a single interval existed.
`connect()` waits up to ten minutes for a QR scan and gets three attempts with backoff, so ONE
unscanned account held the entire worker for about half an hour — no heartbeat (the dashboard said
"the worker is not responding"), no command processor (Show QR / Reconnect / Logout wrote
`WorkerCommand` rows nothing would read, so the buttons appeared to work and did nothing), no
outbound queue, and with several accounts each wait added to the next. The loop that recovers a
dropped session was itself stuck behind the account that was stuck. Observed live.
`startAccountRegistrySync(registry, undefined, { immediate: true })` owns the initial connect now —
it already connected every account the registry did not hold, one at a time, and being a single
overlap-guarded loop it is also the one place the never-two-concurrent-connects rule is enforced.

**One missed `.catch()` used to kill the whole worker.** There were no `unhandledRejection` /
`uncaughtException` handlers, and Node throws on an unhandled rejection — so a forgotten catch in
any of the eighteen loops stopped WhatsApp collection, the outbound queue and the escalation timers
together, with a restarted container as the only symptom. This codebase is deliberately full of
fire-and-forget promises (the escalation hook, the support-activity hook, the AI fallback stage all
intentionally do not gate message processing), which is exactly what produces one.
`installProcessGuards()` splits the two cases: a **rejection** is one failed operation, so it is
logged loudly and the worker keeps running; an **exception** unwound a stack and left unknown state,
so it is logged and the process exits non-zero for the restart policy, where boot recovery requeues
whatever was mid-flight.

**Shutdown waits, and only runs once.** `clearInterval` cancels the next tick, never the one already
awaiting `sendText` — so SIGTERM mid-send killed the process, left the row PROCESSING, and the next
boot requeued and sent it again. `beginShutdown()` stops new claims (a tick scheduled before its
interval was cleared still fires; `trackTick` makes it a no-op), then shutdown waits up to 8s for
in-flight work — bounded, because a tick blocked on a hung provider call would otherwise hold the
container open until SIGKILL. `trackTick` wraps only the four loops that act outward or claim a
queue row (outbound, notifications, participant adds, commands); the learning/knowledge/Forge loops
write their own records and their next tick starts over.

**Stuck-work recovery runs every five minutes, not only at boot.** Boot-only assumed a dead process
is the only way to strand a claimed row — a hung send on a live worker does it too, and that row
then waits for the next restart. All four `recoverStuck*` functions only touch rows past their own
`updatedAt` threshold, so repeating them can never reclaim live work.

**`reconcileAccountStatusesOnBoot()` runs before the connect loop.** Nothing clears status on the
way down, so a worker four seconds old holding no session reported its accounts CONNECTED for as
long as the sequential connect loop took — minutes, during which the dashboard and the outbound
queue's own checks both believed it. CONNECTED/RECONNECTING/OUTBOUND_PAUSED/RATE_LIMITED are claims
about a live session and become DISCONNECTED; AUTHENTICATION_REQUIRED/SESSION_ERROR/ERROR describe
stored credentials and survive a restart, so they are left alone. **Every QR is cleared regardless**
— it belongs to a pairing attempt that died with the last process, so it is not stale data but a
code that cannot work, and somebody will stand there scanning it.

**`recoverStrandedMessages()` closes the pipeline's own window.** The `Message` row is written first
on purpose (it is the dedup guard), which leaves a gap between the insert and the status settle
where a crash strands the row `PENDING` — and because the row exists, WhatsApp's redelivery then
hits P2002 and returns "already processed". The question sat in the database, visible in the inbox,
with no rule ever evaluated and nothing reporting a problem. `runAutomationStage()` is split out of
`processIncomingMessage` so exactly that row can be re-run. Re-running is safe by construction:
`OutboundMessage.idempotencyKey` stops a second send, `createAiFallbackDecision` already answers
P2002 with a message rather than a throw, `SupportActivity.messageId` is insert-and-catch, and
`AutomationExecution` is **upserted rather than inserted** — a plain create made every retry fail at
the last step, which is worse than not retrying. Picked up only between 5 minutes and 6 hours old:
younger may still be in flight (the AI call has a retry budget), older is history rather than an
outstanding question. A retry that throws lands FAILED, which is not picked up again — so one retry,
then visibly failed, never a loop.

**Counters live in memory, and the health code does not depend on them** (`health/metrics.ts`,
`health/server.ts`). Everything durable is already derivable from rows that exist —
`Message.processingStatus`, `OutboundMessage.status`, `AiFallbackDecision.outcome` — and the
dashboard reads exactly those, so a metrics table would be a second, drifting answer to a question
already answered correctly. What a table cannot tell you is what this PROCESS has seen, which is the
question when the suspicion is that it has stopped seeing anything: `received` counts the provider
handoff itself, so `received` flat while the groups are busy names the listener rather than the
pipeline. A message never received leaves no row anywhere. `/metrics` serves them; `/health`
includes them but **the 200/503 decision stays on database connectivity alone** — restarting the
container cannot fix an unscanned QR or a session waiting on a human, and letting session state
decide the exit code would cycle Chromium against a problem only a person with the phone can solve,
losing every healthy session with it.

**`checkCollectionHealth()` is the answer to "we look healthy, so why is nothing arriving?"** It
never infers anything from silence, because silence is not evidence — a group can be quiet all
night. When an account that ought to be collecting has stored nothing for 45 minutes, it asks the
browser what IT has seen. Messages there and not here is a **disagreement**, which is proof rather
than suspicion — and it is the exact signature of the listener bug, which was total and had no
other symptom. Having proved it, it runs the catch-up sweep: an alarm that only tells somebody to
go and look leaves the customers unanswered until they do.

**It selects on OBLIGATION, never on status, and that distinction is what the 18 Sep 2026 outage
cost three hours to establish.** Messages stopped being stored at 07:06 and nobody noticed until
10:22. Every health mechanism here was pull-based and status-gated — each asked the database which
accounts were `CONNECTED` — so an account that was neither CONNECTED nor DISCONNECTED fell through
all of them. `RECONNECTING` is that state: excluded from `recoverIfDropped`, excluded from the
watchdog, and printed on the Accounts page as "the worker is bringing this session back up" while
nothing was. The selection is now "has connected before, is in active groups" (monitored or not — 24 Sep 2026), and the
status is something this *reads and reacts to* rather than something it trusts. Five findings, five
different things to do: `NOT_COLLECTING`, `UNREADABLE`, `STUCK_RECONNECTING`, `NEEDS_HUMAN`, `DOWN`.
The status checks run every tick — they are claims about state, not inferences from silence — and
only the probe waits for the quiet threshold. `collectionWatchdog.integration.test.ts` pins this:
re-narrowing the selection back to `where: { status: "CONNECTED" }` fails six of its tests.

**`probeCollection()` exists because `fetchMessagesSince()` cannot fail.** It catches its own
enumeration error and returns `[]`, which is right for catch-up (a sweep that read nothing has
recovered nothing, and must not take down the connection it just established) and exactly wrong for
a watchdog, which read the same empty array as "WhatsApp holds nothing newer". A dead browser
logged *"quiet for 195m and WhatsApp agrees"*; the watchdog's own try/catch could never fire,
because nothing ever threw. The probe returns `{ ok: false, reason }`, treats a **zero-chat roster
as unknown too** (an account already known to be in monitored groups cannot truly be in none — an
empty roster is a fact about the page, not the account), and bounds its own enumeration, because
`getAllGroups()` on this deployment's ~1,848 groups has been exceeding the 150s group-sync ceiling
in production. A timeout is worded apart from a hard failure: "the session is dead" and "this
roster is enormous" need opposite responses.

**`NotificationEvent.COLLECTION_BROKEN` was missing vocabulary, not a missing call site.** Every
other member describes something a customer said, so nothing could express "nothing a customer says
is arriving". It raises through `enqueueNotification` like every other alert, so Notification Center
routing, muting and per-member DM opt-in apply unchanged — and it goes out over Teams and WhatsApp
**independently**, because the obvious flaw in alerting about WhatsApp over WhatsApp is that the
alert travels through the registry being reported on. `pickSendingAccount()` prefers any account
that is not the broken one, and falls back to the affected number **only while it is still
CONNECTED** — a dead listener does not stop `sendText`, and on a single-account deployment a
possible alert beats a guaranteed silence. When no channel is reachable at all, that is itself
recorded, because the absence of an alert otherwise reads as the absence of a problem.

**`MessageDropCounter` makes a dropped message leave a trace.** The empty-body return stored
nothing, logged nothing and counted nothing durable, so the incident's own first question — did
messages arrive and get discarded, or never arrive? — had no answer anywhere, and `metrics.received`
lives in memory, which the restart that is always tried first erases. A counter per account per day
per reason, not a row per message: the failure worth catching is a change in SHAPE (a WhatsApp
update that starts delivering ordinary text in a form this code reads as empty), which shows as a
spike. It also makes `received` derivable at last — stored plus dropped.

**Per-loop liveness (`health/loopLiveness.ts`).** The heartbeat proves that ONE `setInterval` fires
and shares nothing with the other twenty, so a wedged outbound queue or command processor leaves
every health field looking perfect. Each loop stamps when its tick **finishes** — the only moment
that proves it is not wedged, since a guard that never clears is exactly how one dies silently —
served on `/health` and `/metrics`, and published to the singleton `WorkerHealthSnapshot` so
Overview can name the stalest one. Written once per heartbeat, never once per tick: the command
processor runs every 1.5s. Reported, never acted on: a stalled loop is usually stuck on a call into
a browser, and restarting the container to clear it would destroy every healthy session with it.

**`recoverStuckCommands` needs `atBoot`, and its absence was a live bug.** It had no age cutoff,
justified in its own comment by "this runs once at boot" — true until it was also wired into the
five-minute sweep, at which point it began marking commands FAILED *while they were still running*:
a RECONNECT waiting up to ten minutes for a QR scan, an eight-minute RESYNC_GROUPS, each telling the
operator to run it again so they ran a second on top of the first. `WorkerCommand.startedAt` is
stamped in the same write that claims the row. At boot no cutoff is still correct, because nothing
can be running yet. Relatedly, `STUCK_PROCESSING_TIMEOUT_MS` is 5 minutes rather than 2: two was
shorter than Puppeteer's 180s `protocolTimeout`, so a send still in flight could be requeued
underneath itself and sent twice.

**Chromium calls are bounded by two different mechanisms, and the difference matters** (`util/withTimeout.ts`). Most are bounded by Puppeteer's own 180s `protocolTimeout`; only four carry an explicit application-level `withTimeout` — `kill()`, `logout()`, the watchdog's probe enumeration and the group sync. Do not assume all 21 `client.*` call sites share one timeout, and do not assume 180s is short: every caller is an overlap-guarded loop holding a boolean across the call, so three minutes on a hung send is three minutes of no outbound queue. The four that are wrapped are the ones `protocolTimeout` cannot help with. `client.kill()` had no timeout at
all, against a browser that may itself be what has gone wrong, and every caller is an
overlap-guarded loop holding a boolean across the call — so one unanswering `kill()` silenced the
registry sync or the command processor for the process lifetime, green heartbeat, no log line.
`logout()` had the same shape plus OpenWA's own warning that it "can exit the whole process".

**`accountRegistrySync` connects ONE account per pass and returns.** `connectWithRetry`'s worst case
is about 31 minutes, and it previously blocked discovery, connection *and* drop recovery for every
other account — `recoverIfDropped` runs in the same loop, so the one thing that could rescue a
healthy number that had dropped was queued behind the number that was never coming back. `index.ts`
documents this hazard as fixed; it had been relocated out of `main()`, not removed.
`recoverIfDropped` now also logs its OUTCOME, not just the attempt: a recovery can move an account
from DISCONNECTED (retried) to AUTHENTICATION_REQUIRED (never retried), so trying to fix it is one
of the ways it stops being fixable.

**`OUTBOUND_PAUSED` and `RATE_LIMITED` are gone from `WhatsAppAccountStatus`.** Nothing ever wrote
either, yet both were rendered on the Accounts page with their own colours and hints describing a
per-account throttling mechanism that does not exist. Throttling here is per outbound MESSAGE —
`OutboundMessageStatus.RATE_LIMITED`, which is real and untouched.

`INCIDENT_RUNBOOK.md` is the operator-facing version of all of this: what to read, in what order,
and what to capture before restarting anything.

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
genuinely deleted. Rules and Keywords are not nav entries: they are the same job as Settings
(deciding what counts), so **Setup** hosts them with their routes unchanged. Team Performance and
the Activity Feed now sit in the sidebar's **Team** module beside Team Management's pages.

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

### Team Report (`packages/shared/src/teamReport.ts`, `apps/web/src/server/teamReport.ts`, `(dashboard)/team-report/`)

Per-member and per-group WhatsApp support report — groups supported, replies, customer messages,
customer waits, **Missed**, **Recall** and support duration — for a day, week, month or custom range
(capped at 92 days), for the whole team or one member, broken down by day/week/month, with a group
drill-down listing every wait and CSV (groups) / Excel (full: Summary, Team Members, Groups, period,
Missed & Recall) exports. Sidebar: Reports → Team Report; also the first card on All Reports.

**All counting is ONE pure function, `computeTeamReport`, unit-tested in packages/shared.** The page,
the drill-down and both exports call `loadTeamReport`, which only fetches and classifies rows, so the
screen and the file cannot disagree. Its doc comment is the rulebook; the page's Help repeats it.
Reads `Message` (not `SupportActivity`, which is off by default), one row per real message —
`DISTINCT ON (whatsappGroupId, whatsappMessageId)` collapses the copies two accounts in one group
store. Senders are matched to `InternalTeamMember` exactly as Duty History does (whatsappId, raw and
digits-only phone), including deactivated members so history keeps its owner.

The definitions are existing ones wherever one existed: a **wait** is First Response's (a customer
message after a reply or none; a run of lines is one wait; closed by the next MEMBER or BUSINESS
message), and duration uses Team Performance's idle gap (`offlineAfterMinutes`) over one timeline per
member across all groups, split at Dhaka midnight. **No "missed" rule existed**, so: a group with a
priority uses its escalation policy's `firstAlertMinutes`; every other group uses the new
`SupportActivitySettings.missedReplyAfterMinutes` (default 30, on Support Activity Setup). Answered
after the threshold = Recall (a subset of Missed, never counted twice); never answered past it =
Missed and unrecovered; still inside it = neither. Missed is charged to the group's
`assignedTeamMemberId` ("Unassigned" otherwise); Recall to whoever sent the late reply. Business-number
replies count as replies but carry no person and no duration. Replies are looked for up to 24 h
past the period end, and only waits starting inside the period count.

**Team filter (28 Sep 2026): a Team is "who was in it AT THAT MOMENT", not "who is in it now".**
`Team` rows are created on `/teams` (WhatsApp module); `InternalTeamMember.teamId` is the person's
current Team, and `TeamMembership` (member, team, `startedAt`, `endedAt`) is the history the report
actually reads. Changing a member's Team closes the open membership and opens a new one dated now,
in the same transaction as `teamId` (`applyTeamChange` in `server/actions/teamMembers.ts`); a
member's FIRST Team has a null `startedAt`, meaning "since before Teams were recorded", so assigning
Teams makes past reports filterable immediately instead of empty. Filtering on the current `teamId`
instead would move somebody's whole history into their new Team the day they transfer.

`computeTeamReport` takes a `scope(memberId, ts)` predicate (overriding `memberId`); the loader
composes Team + member into it with `inTeamAt`. In scope: that member's messages, groups and
duration while in scope; Missed when the group's assigned member was in scope when the customer
asked; Recall when the late replier was in scope when they answered; customer messages and waits of
the in-scope groups counted once per group. **With no Team chosen nothing changes** — the unscoped
path is untouched, and `teamReportTeams.test.ts` proves a one-member `scope` equals the old
`memberId` report byte-for-byte. The member dropdown cascades from `membersOfTeamDuring` (anyone in
the Team at any moment of the period); a member not in the chosen Team is reset to the whole Team
with a note, never an empty report. `team=none` is "members in no Team". Exports carry the Team in
the file name and Summary sheet, and the Missed & Recall sheet lists `countedMissedWaits` — exactly
the waits behind the scoped figures. A Team is never deleted once any membership points at it.

**The Team members, By day and Groups tables are selectable and exportable** (`ReportDataTable.tsx`,
`server/teamReportTables.ts`, `POST /api/team-report/table-export`). Row checkboxes (header = this
page), search on the first column, sortable headers, 50–1,000 rows per page, sticky header and footer
inside the table's own scroll box, and Export → Selected / Current page / All filtered × Excel / CSV.
Paging is client-side ON PURPOSE: the report must read every message in the period to compute any
figure, so these rows are already-computed aggregates (one per member, at most 92 days, one per
group — a couple of thousand at most; Groups used to page on the server by re-running the whole
report per page) and paging on
the server would re-run the whole report per page. The export posts the row KEYS in on-screen order;
the server recomputes the report and builds the rows with the same `buildMembersTable`/
`buildBucketsTable` the page rendered, so the file has the table's columns, names, order and values
(durations as the displayed text, counts as numbers) and never the checkbox column. Text shown UNDER
a cell (a group's WhatsApp id, "+3 business") is `ReportTableRow.sub` — presentation, not a column,
so it is not exported; search matches the group id through it.

The dashboard's content column carries `min-w-0` (`DashboardShell.tsx`). Without it a wide table
inside `overflow-x-auto` still widened the whole column — `main` measured 882–995px at a 390px
viewport on Team Members, Teams and Team Report — because a flex child cannot shrink below its
content's minimum width unless told to.

### Team Management (`apps/web/src/server/teamManagementReports.ts`, `server/actions/teamManagement.ts`, `apps/worker/src/teamManagement/attendance.ts`)

Shifts, roster, leave and coverage, built on `InternalTeamMember` — **there is no second identity
model**. The spec this was built from named a `TeamMemberIdentity` and a `TEAM_MESSAGE`; neither
exists in this codebase and neither was created, because `InternalTeamMember` and
`Message.isFromTeamMember` already are those things.

**Three records, and the reading of them is DERIVED at read time, never stored.** `DutyAssignment`
is the plan, `TeamAttendanceDay` is the evidence, `LeaveRequest` is the approval; `deriveDutyState`
in `teamManagementReports.ts` joins them. Nothing writes a fourth "actual status" row — a stored
derivation drifts from its own inputs the moment one is corrected, and then two screens disagree
with nothing to say which is right. It also means no daily reconciliation job, which this worker
has no cron to run anyway (every scheduled thing here is a `setInterval`).

**`NO_ACTIVITY` is not `ABSENT`, and must never be renamed to it.** No message is evidence of no
message and nothing more: somebody on the phone, out at a customer site, or working in a group this
account cannot see produces the same silence as somebody who did not come in. `ABSENT` is reachable
only from `AttendanceOverride`, a manager's explicit verdict, which is stored in its own columns
**beside** the evidence rather than over it — so "marked absent, and there were forty messages"
stays readable as exactly that. The counts are recomputed on every later message and deliberately
do not clear the override.

**Attendance reads `Message`, not `SupportActivity`.** `SupportActivitySettings.enabled` defaults to
false and its detector returns early when off, so anything built on that table is empty on a fresh
install and would silently empty if tracking were ever switched off — which for an attendance record
is a lie. `getGroupsAwaitingReply` reads `Message` directly for the same reason.

**`recordTeamAttendance()` recomputes a member-day rather than incrementing, under a Postgres
advisory lock, and both halves are load-bearing.** Incrementing double-counts on a replayed message,
a worker retry or a reconnect. Recomputing converges — but only SEQUENTIALLY: two messages arriving
at once give two recomputes, and A reading nine while B reads ten and writes ten, then A writing its
stale nine, is a lost update that leaves the count quietly wrong.
`pg_advisory_xact_lock(hashtext(key)::bigint)` on `(teamMemberId, activityDate)` serialises the read
and the write. It is held in POSTGRES, not worker memory — two worker processes share no memory to
lock in, and the whole point is that this holds across them.

This is **measured, not assumed**. `teamAttendance.integration.test.ts`'s concurrency test was
written twice before it could detect a deliberately removed lock: writing all ten messages up front
and then racing the recomputes proves nothing (every racer reads the same settled ten), and so does
an unstaggered `Promise.all` (the ten creates all finish before the first SELECT). Staggered
arrivals over fourteen rounds is what works — with the lock deleted, probe rounds returned 10, 8, 9,
9, 10, 10, 10, 10, 10, 8. Do not simplify that test; each simplification was tried and each passed
against broken code.

The recompute is deliberately **not** filtered on `Message.isFromTeamMember`. That column is stamped
at insert time, so it is false for everything somebody sent before they joined the roster — filtering
on it would mean adding a colleague at noon silently discarded their morning. `senderPhone` is the
identity, and `resolveActiveTeamMember` (the existing resolver, not a second detector) has already
established it. `senderIdentifiers()` looks for every form that resolver matches — exact
`whatsappId`, then digits-normalised `phoneNumber` — or the recompute would count a different pile
of messages than the one that triggered it.

**Coverage is EFFECTIVE, never a raw count of assignment rows.** Two people on Morning with one on
approved leave is one person available, and reporting that as covered is how a shift silently runs a
man short. `effective = assigned - unavailable`, `gap = max(0, required - effective)`. Approving
leave therefore **updates the `DutyAssignment` to LEAVE and keeps its shift snapshot** rather than
deleting it: delete the row and the shift just looks understaffed with no explanation, and the audit
trail loses the fact that somebody was supposed to be there.

**`DutyAssignment` snapshots the shift's name and times** alongside the template FK, so editing
"Late" from 13:00–22:00 changes what Late means from now on and never what somebody worked last
Tuesday. Same reasoning as `SupportPriorityPolicy` snapshotting SLA minutes onto each case. Nothing
hardcodes 10–19 / 12–21 / 13–22 anywhere in business logic; those three exist only as seed rows.

**One assignment per member per date is a database constraint, and the coverage path CREATES rather
than upserts on purpose.** A manager editing somebody's Tuesday means to replace it, so
`setDutyAssignment` upserts. A manager filling a vacancy means to *add* somebody, so
`applyShiftChange` lets the unique violation surface as "they are already on Late that day" — never
silently overwriting the candidate's existing shift, and never silently moving a third person to make
room. `previewShiftChange` shows what the vacated shift would be left with **before** anything is
written; leaving a gap is a legitimate decision that must not be an invisible one. Both halves of a
change share a `changeGroupId`, because moving Rakib and putting Bipul on the shift he vacated is one
decision and two unrelated rows would not say so.

**`WeeklyScheduleEntry` has three states, not two.** No row = nobody has decided; a row with a null
template = decided, they are off. Collapsing those makes an unfilled rota look fully scheduled, which
is the single most dangerous thing a rota can do. `materialiseRosterForDate` skips every date that
already has an assignment (so it is safe to press twice) and leaves a member with no pattern entirely
alone rather than writing them OFF.

`LeaveType` and `Holiday` ship **empty**, deliberately — entitlement and public holidays differ by
country and company, and a seeded guess quietly becomes policy because nobody checked it.
`LeaveRequest.dayCount` is counted once at creation so a holiday declared later cannot resize a
decided request. Cancelling approved leave does **not** restore the duty rows: cover was very likely
arranged, and silently un-cancelling would double-staff the day.

Its pages (Today, Roster, Leave) sit in the sidebar's **Team** module. `/team-members` stays under WhatsApp and
is linked to, never duplicated. This module does **not** duplicate `/support-activity/team`, which
owns who is online, engaged time and first-response stats; this one owns **schedule versus reality**.

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

**Telling the customer when AI could not answer** (`aiFallback/unableToUnderstandReply.ts`,
`packages/shared/src/unableToUnderstand.ts`, `AiSettings.unableToUnderstandReply*`, off by default).
On a handover, send the customer an admin-editable holding reply ("we could not understand this, the
support team will follow up"). Four decisions worth not undoing:

- **Only handovers where the AI had no reliable answer qualify, listed explicitly**
  (`UNABLE_TO_UNDERSTAND_REASONS`: MEDIA_ONLY_MESSAGE, NO_KNOWLEDGE*, NO_BUSINESS_KNOWLEDGE,
  AI_DECLINED, EMPTY_RESPONSE, LOW_CONFIDENCE*, INVENTED_PROCEDURE). A handover the SYSTEM caused —
  SAFETY_BLOCKED (the throttles protecting the number; another message there defeats them),
  AI_UNAVAILABLE, AI_ERROR, TRUNCATED/MALFORMED — never sends, and neither does any reason added
  later until somebody puts it on the list.
- **A plain acknowledgement never gets it** (`isAcknowledgementOnly`: "ok vai", "thanks",
  "ধন্যবাদ", emoji). Under the default strict mode every one of those is a NO_KNOWLEDGE handover, and
  answering "sorry, I did not understand" to a thank-you is the false trigger the feature must not have.
- **It is not an answer, so the AI reply cooldown ignores it** (`queue/cooldown.ts` excludes its
  idempotency variant, exactly as it excludes the handover mention). Counting it would block the
  customer's next, clearer message and cancel the mention queued right after it at send time.
- **Idempotent three ways**: it runs only on the pass that claimed the `AiFallbackDecision` row; its
  own `idempotencyVariant` ("unable-to-understand") allows one row per customer message; and
  `unableToUnderstandRepeatMinutes` stops a burst of unclear messages getting one each. It re-runs
  `checkAutoReplySafety` without the AI cooldown (kill switch, MANUAL_ONLY, monitored group, rate
  limits all still decide) and goes through `enqueueOutboundMessage` — no second send path.
  `AiFallbackDecision.holdingReplyOutboundMessageId` records it for the AI Activity log.

Wording: `unableToUnderstandReplyText` null = the built-in Bangla default, so Restore is "forget my
edit" and saving the default text stores null too — same shape as Notification Templates.

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

### Microsoft Teams Integration — REMOVED (27 Sep 2026)

The Graph/OAuth integration (Issues, Connection, Teams & Channels, Resolution Rules/Keywords, its
settings, the worker's Teams sync loop and `packages/teams-client`) was removed at Rudra's request;
its Manage page showed no Teams discovered when it went. Do not confuse it with the **Teams webhook** alert channel
(`TEAMS_WEBHOOK_URL`, `NotificationType.TEAMS`, `RULE_NOTIFY_TEAMS`), which is separate and stays.

Deliberately **non-destructive**: the Prisma models were removed but **no migration drops their
tables** (`SupportIssue`, `Teams*`, `IssueResolutionEvent`, `TeamsIntegrationSettings`), so any rows
that existed remain in the database. Every FK from those tables cascades or sets null, so deleting
an account or group still works with them present. A later `prisma migrate dev` will propose
dropping them — that is the intended cleanup, once Rudra confirms nothing is needed from them.
`WorkerCommandType.TEAMS_SYNC_NOW` and `WhatsAppServiceKey.TEAMS_RESOLUTION_NOTIFY` stay in the
schema, marked retired, because Prisma throws on reading a row whose enum value it no longer lists;
a leftover queued `TEAMS_SYNC_NOW` is closed as FAILED with a "removed" message. The seed deletes
the two `teams_integration.*` permission keys by name. `InternalTeamMember.microsoftEmail` is an
unused column now, left in place for the same reason as the tables.

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
one `OutboundMessage` with `actionType: MANUAL_REPLY` and stops there (the same DB-mediated hand-off
every sender uses); the worker sends it. `MANUAL_REPLY` is the one action type the
queue treats differently: **the automation kill switch does not cancel it** (the switch stops the
robot, not the operator) and an account rate limit **defers** it rather than discarding it, since
silently dropping something a person typed is not acceptable. It still gets the same live
group-membership check the broadcast path does. **Which groups make the list is decided by recent activity, not by name.** It used to take the
first 300 groups alphabetically and then sort those by recency — which reads as an ordering choice
and is really a selection one: with 1,848 groups a conversation that arrived five minutes ago was
invisible if its name sorted past the 300th. A `LATERAL` join picks the newest message per group so
the cap falls on the quietest rows rather than the alphabetically unlucky ones.

**Inbox organisation is `chatCategoryId` / `chatPinnedAt` / `chatArchivedAt` on `WhatsAppGroup`,
plus `ChatCategory`** (`server/actions/chatOrganisation.ts`). All three govern what an operator
SEES and nothing else — that file never writes `isMonitored` or `aiAutomationEnabled`. Archiving is
explicitly not unmonitoring: a group can be out of somebody's inbox while AI keeps answering in it,
and conflating them would stop automation in a live customer conversation as a side effect of
tidying up. The archived view says so on screen, and shows each row's "AI on" badge as the proof.

Categories are **shared, not per-user**: a support team looks at one inbox together, and
per-operator folders would mean everyone curating 1,848 groups alone and nobody able to say "it's
in Billing" and be understood. `name` is unique so two people cannot create "Billing" twice and
split the same groups across both; the FK is `SetNull` so deleting a category empties it rather
than deleting conversations. `chatPinnedAt` is a timestamp rather than a boolean so pin order is
expressible, and one `new Date()` covers a whole bulk pin so forty groups keep their relative order.

Selection is a **mode**, not always-on checkboxes — the list is read far more often than it is
reorganised, and a checkbox per row turns a reading surface into a form. In that mode a row is a
`button`, not a `Link` with an intercepted click: leaving a real `href` under the cursor means
middle-click and ctrl-click navigate away and lose the selection. Bulk results report
"8 moved, 3 already there" rather than "Done", matching `bulkSetMonitoring`.

**Opening a conversation clears it from "waiting"** (`chatReviewedAt`, `markChatReviewed`). The
inbox's "waiting" filter is a TRIAGE signal — what still needs somebody's attention — not a claim
that the customer was answered, so reading a conversation is a legitimate way to resolve it.

`chatReviewedAt` is a timestamp, never a boolean, and that is the whole safety property: the filter
compares it against the newest message, so a NEW customer message lands after the mark and puts the
conversation straight back in the list. Nothing can be dismissed permanently, only until they speak
again — a boolean would let one glance bury a customer for good, turning the feature that finds
unanswered people into the one that hides them.

A queued reply already counts as an answer. A reply — yours from this inbox, or the AI fallback'''s —
only becomes a `Message` when WhatsApp echoes it back, which is seconds later and much longer when
the queue defers for a rate limit; for that whole window the newest stored message was still the
customer'''s question, so an answered conversation kept showing as waiting. Both paths write an
`OutboundMessage`, so one lookup covers both. `ANSWERING_OUTBOUND` is pointedly NOT
`UNSETTLED_OUTBOUND`: that set exists to render queued bubbles and includes FAILED, CANCELLED and
SKIPPED, which mean the customer received nothing — reading those as an answer would hide the
conversations that most need somebody. It is floored at the oldest message the page is asking about,
because SENT rows accumulate forever and `OutboundMessage.chatId` carries no index of its own.

`setChatReviewed(ids, reviewed)` is the bulk form, in the selection bar beside pin/categorise/
archive, plus a one-click "Mark all N read" that appears ONLY while the waiting filter is active —
that gesture from the All tab would silence the whole inbox in a click, and the one list where it
is genuinely wanted is the things you have just read. Marking read deliberately does NOT narrow the
write by `chatReviewedAt: null`: a row already carrying a mark can still be waiting (its customer
wrote since), so skipping those would leave behind exactly the conversations being cleared.

Two dots, because one would hide exactly that case. **Solid** = nobody has looked. **Hollow ring** =
somebody opened it and the customer still has no reply, with its own "seen, unanswered" filter
chip, because those conversations leave the waiting count by design and must not simply vanish.
`ConversationSummary.isUnanswered` is the raw fact; `awaitingReply` is unanswered-and-unreviewed.
`MarkWaitingButton` puts one back (by NULLing the mark, so the ordinary rule resumes) and renders
only while the customer is genuinely unanswered, rather than sitting there doing nothing.

The stamp goes through Next's `after()` in the thread page, below the `notFound()` guard — `after`
still runs when a render throws, and a group that does not exist must not be stamped. It
deliberately does **not** `revalidatePath`: the conversation list is layout-level, so revalidating
on every thread open would re-render the whole inbox and discard the unsent draft Composer.tsx
works to protect. The badge clears on the list's own 4s refresh.

**`getGroupsAwaitingReply()` in the Support Activity reports does NOT read this, deliberately.**
That number answers "which customers has nobody answered" and feeds Team Performance; letting a
review mark clear it would let a lead empty the backlog by scrolling through it.

**The 300-group list cap bounds what is RENDERED, never what is reachable.**
`getChatConversations` has always accepted a search term and, until `searchConversations`
(`server/actions/chatSearch.ts`) existed, nothing passed one — so the browser could only filter the
loaded 300. On an account in 1,856 groups that made a quiet group literally unfindable by name, and
the cap read as a wall rather than a window. The inbox now runs both: the instant local filter over
what is on screen, plus a debounced server query across every group, whose extra matches appear
under "Elsewhere in your groups". Results are stored WITH the query they answered, so staleness is
derived rather than tracked and a slow response cannot land under a newer query.

Do NOT fix this by raising the cap. The layout re-queries the whole list every four seconds and
each row costs a LATERAL lookup for its last message, so rendering the full roster would multiply
that cost for a list nobody scrolls.

**The inbox is a tool somebody drives all day, and the UI is built for that rather than for a
screenshot.** Four rules worth not undoing:

*The filter rail scrolls sideways, never wraps.* Wrapping was harmless at two categories and pushed
the first conversation below the fold at six: the header grew downward without limit while the list
it filters shrank. A rail is a fixed height whatever the team files their work into. The
300-group cap notice moved to the FOOT of the list for the same reason, cut to one line.

*`ThreadScroller` opens a conversation at its newest message.* The thread rendered oldest-first in
a plain scroll container, so opening a busy group landed you on a message from days ago. It jumps
instantly rather than smoothly (this is where the content starts, not a transition), and new
messages only pull you down **if you were already near the bottom** — the layout refreshes every
four seconds, so following the reader down while they read history would make old messages
unreadable. The parent keys it by group id, which is what resets its state; setting that state in
an effect instead is the cascading render the lint rule exists to catch.

*Density is `useSyncExternalStore`, not state seeded from an effect.* `localStorage` cannot be read
while rendering on the server, and the obvious default-then-correct version renders every row at
the wrong height for a frame and costs a second pass on every mount.

*Motion is capped by frequency, not by taste.* This inbox is opened hundreds of times a day, so
there are no entrance animations on rows, chips or panes — only feedback (a 1px `active` settle, a
hover shadow on a bubble) and state. The one movement, "Jump to latest", is smooth precisely
because it is rare and because you asked for it. Reduced motion needs no per-component handling
here: `globals.css` already kills every transition globally.

Keyboard: `/` focuses search from anywhere (never while typing in a field), arrows walk the list,
Enter opens, Escape clears. The hint is printed in the field because a shortcut nobody knows about
is the same as no shortcut.

**Saved replies** (`SavedReply`, `server/actions/savedReplies.ts`, `SavedReplyPicker.tsx`) are the
sentences operators retype all day. Deliberately **not** `AiKnowledgeItem`: that table is what the
assistant answers customers from and carries a human-verification gate for exactly that reason,
while this is shorthand a person picks and sends themselves. Feeding one into the other would put
unreviewed operator shorthand into the assistant's mouth, and customer-facing claims into a list
people edit casually.

The picker **inserts, never sends** — at the cursor, not replacing the box, since somebody who
typed a greeting first means to keep it. A picker that sent on click is a one-tap path to putting
the wrong canned message in front of a customer. It is a panel anchored above the composer rather
than a modal, so the conversation stays visible while you choose. Ordered by `usageCount` so the
few everybody sends float up on their own; `recordSavedReplyUse` deliberately does **not**
revalidate, because re-rendering the chat layout to reorder a picker would discard a half-typed
draft.

**Drafts survive leaving a conversation**, keyed per group in `localStorage`. Triage means moving
between conversations constantly, and losing a half-written reply teaches people not to trust the
box. Not the database: a draft is one person's unfinished thought on one machine, and a shared
table would show a colleague words nobody chose to send. Every access is wrapped — private mode
throwing must not stop the composer rendering.

**`Input` and `Textarea` declare `ref` explicitly.** React 19 already passed it through the spread
as an ordinary prop, but `InputHTMLAttributes` does not include it, so a caller needing one failed
to compile against a component that would have worked. `forwardRef` is the React 18 answer to a
problem React 19 does not have.

**There is no mute**, deliberately. WhatsApp's mute silences notifications; this app has no
per-group notification concept to silence, so the control would be a switch that does nothing —
the dead-setting problem this project keeps removing. Archive is the real version of what people
reach for mute to do here.

Not-yet-confirmed sends render as dashed "queued"
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

**`AiKnowledgeItem.procedure` reaches the prompt, and did not for a long time.** The column
existed, the knowledge form let people type steps into it, and nothing ever read it — a stored
"Billing list → Payment → Pay → Submit" reached no customer. It is now selected, truncated on the
same budget as the answer, and rendered as a `Steps:` line *after* the answer, since the model reads
the end of an entry more reliably than the middle. No AI job writes it yet; only hand-written
entries carry one.

**The prompt asks for steps, and forbids inventing them in the same breath.** `HOW TO WRITE THE
ANSWER` tells the model to give a procedure in the order it is done, naming what the person opens
or clicks, warm and plain. That instruction creates its own risk — asked for confident navigation a
model will happily invent a screen, which the Forge work already caught it doing from zero bytes of
source — so `NEVER INVENT A STEP` sits directly under it, with "cover the part you can and hand over
for the rest". The block sits **after** the language rules and **before** the scope rules, and the
ordering is asserted: style is subordinate to both, exactly as the house-style guidance is.

This is deliberately **not** mode-dependent. `aiResponseMode` governs which sources may be used;
how the answer is written is a separate axis. Making the formatting depend on the mode would mean
the same question got a worse-written answer under a stricter setting, which is incoherent — though
the effect is most visible in the two Forge modes, since those are the ones that can produce a
procedure from the product's own source.

**Ranking is BM25F (`aiFallback/bm25.ts`), not a count of matching keywords.** What it replaced
is worth knowing, because the failure was invisible: the score was the NUMBER of matched keywords,
and `derivePatternSignature` yields at most five, so up to three hundred candidates were sorted
into at most five buckets. Ties were the normal case, and they fell through `hasProcedure`, then
`fromSameGroup`, then `id.localeCompare` — a cuid. Which three entries grounded an answer came
down to alphabetical order over a random identifier. Counting also made every term equally
valuable (matching "bill", in nearly every billing entry, counted as much as "prorated", in one),
let repetition accumulate without limit, and rewarded long entries for containing more words by
accident.

**BM25F rather than plain BM25, and the procedure-retrieval test is what forced it.** Flattening
title/question/answer/procedure into one haystack fixes the length problem and creates a worse one:
an entry carrying a real step list is LONGER, so length normalisation demotes it for holding
exactly the content that makes it the best answer to a "how do I" question. That test went red the
moment flat BM25 landed. BM25F normalises each field against the average length of its own kind and
weights them — question 3.0, title 2.5, procedure 2.0, answer 1.0 — so a match in the
customer-phrased question outweighs one buried in a paragraph. Saturation is applied AFTER summing
the fields, which is what makes it BM25F rather than four BM25 scores added together.

The `1 +` inside the IDF logarithm is load-bearing: Robertson's original form goes NEGATIVE once a
term appears in more than half the corpus, so a common word would actively subtract from a score —
pushing an entry below one that never mentions the subject, for mentioning it too popularly.

**The change is confined to ORDERING, and the seam is two vocabularies.** `matchVocabulary` (the
pattern signature) still decides which entries are relevant and still produces `bestOverlap`,
because both feed decisions *outside* the function: the relevance filter is recall, and
`bestOverlap` is the integer `isStrongEnough` compares against 2 to decide whether to spend a
completion on query expansion. `bestOverlap` is now the MAXIMUM matched count rather than the
top-ranked entry's — identical to the old value in every case, where reading it off the new first
entry would have moved that threshold as a side effect of reordering. Only `rankVocabulary` is
wider.

**`derivePatternSignature` is a cluster KEY and must not be repurposed as a query.** It is stored
as `patternKey` on every `PatternCandidate`, so changing it re-buckets the entire Conversation
Learning history — which is why `deriveQueryTerms` exists alongside it instead. A key wants to be
short, stable and order-independent; a query wants every content word. Conflating them is what
capped the ranker at six possible scores, and "longest token first" is a corpus-free guess at
specificity that prefers "internet" to "otp".

Same-group and has-steps remain **tiebreaks**, as their original comment insisted, via relevance
bands (`bandByRelevance`): a continuous score makes exact ties vanish, which would have quietly
retired both signals. Banding rather than a fuzzy comparator because "within 2%" is not transitive,
and a non-transitive comparator handed to `Array.sort` gives an implementation-defined order — the
opposite of what a reproducible ranking needs.

`countWholeWord` shares one scan with `containsWholeWord`, and `tokenizeWords` lives in
`normalize.ts`, so pattern signatures, query extraction and BM25's length measure cannot disagree
about what a word is. That has mattered once already — the `\p{M}` fix, without which Bengali words
shattered into fragments.

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

### AI Sandbox — edit, verify, make knowledge (`(dashboard)/conversation-learning/sandbox/`, `server/actions/sandbox.ts`)

An isolated place to ask the AI a customer-style question, correct its answer, verify it and turn the
final Question + Answer into knowledge. Isolation is structural: its actions write only
`SandboxSession`/`SandboxTurn` (plus an `AiKnowledgeItem` through Make Knowledge) — never a Message,
OutboundMessage, Notification or WorkerCommand.

**The review rules are pure and tested** (`packages/shared/src/sandboxWorkflow.ts`), and the server
actions call them rather than restating them: the FINAL answer is `editedResponseText ?? responseText`
and is the only text Verify, Make Knowledge and Export use; `responseText` (the original AI answer) is
never overwritten, which is the audit trail; only an APPROVED turn becomes knowledge, once; a REJECTED
turn must be reopened before it can be edited; editing a verified answer returns it to WAITING; once
saved, the knowledge entry is what gets edited. An admin can also write the answer to a turn the AI
handed over without drafting one.

**Verified or Pending Review is a permission, not a checkbox.** Make Knowledge saves straight as
`humanVerified: true` only for a role with `ai_learning.manage` — the same right that creates a
verified entry on the knowledge form or verifies one in Pending Review. Everyone else's entry lands
unverified in Pending Review, as sandbox answers always did; a testing tool cannot grant a trust
level the user does not otherwise have. Before creating, `findSimilarKnowledge` shows entries whose
question scores ≥ `DUPLICATE_QUESTION_THRESHOLD` on `questionSimilarity` (packages/engine — the
overlap of `deriveQueryTerms`, the words retrieval itself reads); nothing existing is changed and
"Create anyway" is the admin's explicit second press. The knowledge row records `source: SANDBOX`,
`aiGenerated: false` when the admin rewrote it, the verifier, and a version-1 change summary naming
the test conversation. Export (`/api/sandbox/export`, one turn or the whole conversation, CSV/Excel/
JSON) writes the Knowledge Base import columns (`KNOWLEDGE_ROW_COLUMN_LABELS`) so a file re-imports
unchanged. Follow-up questions in the same conversation still see the ORIGINAL AI answers in their
transcript — the worker was deliberately left untouched.

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

**Every Overview figure that has somewhere honest to go is a link** — `StatTile` and `ChartCard`
both take an optional `href`, and it stays optional on purpose. A tile that lands on a page where
the reader rebuilds the dashboard's own query by hand is worse than one that does not move: it
promises the eighteen rows and delivers a search box. So the outbound-queue tile and the outbound
delivery chart are deliberately **inert** — that count includes auto-replies, manual sends and
broadcast rows, and no page lists the queue in full; `/messages?autoReplyStatus=PENDING` is only
the auto-reply subset and would show a smaller number under the same label.

`/messages` gained a **`within`** param (`24h` / `7d` / `14d`) for this, and that is not
decoration: the tiles count a ROLLING window while `dateFrom`/`dateTo` name Dhaka calendar days, so
a tile linking with `dateFrom=today` would land on a different set than the number it displayed —
wrong before lunch and wronger at midnight. Explicit dates still win when both are present; a
shorthand must not override something somebody typed. The value is whitelisted rather than parsed,
because a pasted `within=9999` should fall through to no window rather than scan the table.

A tile is a real `<a>`, never a div with `onClick` — middle-click, ctrl-click and open-in-new-tab
are how somebody triages a dashboard. `ChartCard` puts its link in the header instead of wrapping
the card, because a chart is content you read and hover, and one anchor over the whole surface
turns every one of those into a navigation.

`getResponseTimeSeries` is the heaviest query on the landing page — a window function over fourteen
days of messages partitioned by group, leaning on `Message`'s `[groupId, timestampWa]` and
`[timestampWa]` indexes. If volume ever makes it the bottleneck the answer is a nightly rollup, not
a narrower window: the "wait" definition must stay identical to Team Performance's.

Nav lives in one place — `(dashboard)/navigation.ts`. A pinned "Overview" link, then ten
**collapsible modules** (27 Sep 2026): Support (WhatsApp Chat, Messages, Escalations), Team (Today,
Roster, Leave, Team Performance, Activity Feed), Reports, WhatsApp (Accounts, Groups, Team Members,
Teams, Broadcast, Add Number to Groups), Automation, AI Learning, Conversation Learning, System, Users &
Permissions, Release Notes. It used to be thirteen always-expanded groups under four department
headings — about fifty rows. **Navigation only: no route, page or permission changed**, and the
check that proved it compared the old and new `navGroupsFor()` across 323 role sets (every single
key, all, none, 300 random) and found every role reaching exactly the same pages.

Only the module holding the current page opens by itself, and it cannot be closed (that would hide
the page you are on). Others toggle, and which ones somebody keeps open persists in `localStorage`
(`sidebar-open-groups`, a `useSyncExternalStore` store like the collapse preference). A module with
one link renders as that link. `isGroupActive` decides which module opens; a settings page or a
report that sits under another module's path (`/support-activity/settings`,
`/team-management/attendance`) opens System or Reports, not the module whose path it shares.

**`NavLink.tabs` groups sibling pages behind ONE sidebar entry**, drawn as a tab strip
(`SubNavTabs.tsx`, rendered by `DashboardShell` from `tabsForLocation`): Messages (All / Needs
attention / Ignored), Broadcast (New / History), Automation Rules (Rules / Rule Tester), Knowledge
Base (Entries / Pending review / Import), Patterns (candidates / unknown), Release Notes (read /
manage). Each tab keeps its own route and its own permission gate; `navGroupsFor` filters tabs per
role, hides an entry with none left and points it at the first tab the role can open.
`ALL_NAV_LINKS` expands tabs into their own entries, so ⌘K and the breadcrumb still find "Rule
Tester" by name. The active tab is the LONGEST match (`activeTabHref`), so the import page lights
"Import", not "Entries". See `PROJECT_REFERENCE.md` for every page.

**Configuration lives in one Settings module** (`SETTINGS_SECTIONS` in `navigation.ts`, 27 Sep 2026).
The configuration pages that used to sit at the end of their own groups (AI Settings, Providers,
Models, Product Knowledge, Conversation Learning settings, Notification Center/Templates, Account
Routing, the two bulk limits pages, Escalation Policies, Support Activity Setup, Shifts, Team
Settings, Security, and `/settings` itself, now titled "Automation & Safety") are offered through a
single sidebar **Settings** link. **Their routes did not move** — every page, form, save action and
permission gate is untouched, so bookmarks and in-page links keep working. `DashboardShell` draws
`SettingsNav` beside any path `isSettingsPath()` claims (exact or child), because the pages live under
different route segments and no Next layout could wrap them. The rail and the sidebar link are
permission-filtered (`settingsSectionsFor`); the link opens the first settings page the role can
reach. ⌘K and the breadcrumb still resolve every settings page via `ALL_NAV_LINKS`. Left out on
purpose: Automation Control (operational kill switch), WhatsApp Accounts, Groups, Team Members,
Users, Permission Modules and the notification delivery log — places you work in, not
preferences. A new configuration page belongs in `SETTINGS_SECTIONS`, not at the end of its group.

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

**`{ not: value }` on a NULLABLE column silently skips every NULL row, and it has already shipped
a broken feature.** Prisma compiles it to `column <> value`, and in SQL `NULL <> 'abc'` is NULL
rather than TRUE. `setChatCategory` used `chatCategoryId: { not: categoryId }` to avoid rewriting
rows already in the target category — which meant assigning a category to uncategorised
conversations matched **zero** rows and reported "0 moved". That is every conversation on a fresh
install, so the category feature appeared completely dead while removing a category worked fine
(`{ not: null }` compiles to `IS NOT NULL`, and NULL-safety only bites when comparing to a value).

**`AT TIME ZONE` means opposite things depending on the column's type, and Prisma gives you the
one that bites.** `DateTime` maps to `timestamp WITHOUT time zone` here, holding UTC. Applied to a
`timestamptz`, `AT TIME ZONE 'Asia/Dhaka'` CONVERTS to that zone; applied to a plain `timestamp` it
INTERPRETS the value as already being in it — so the single-argument form shifts a UTC instant six
hours the wrong way, moving every message sent before noon Dhaka onto the previous day. Verified
against the database: `2026-09-18 02:00` (08:00 Dhaka, plainly the 18th) buckets as the 17th. The
correct form is `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'`, pinned by a test in
`queryRewrites.integration.test.ts`. `getActivityTrend` uses it, and so now do the two Overview
charts in `dashboardMetrics.ts` (`getAiOutcomeSeries`, `getResponseTimeSeries`) that were left on
the single-argument form for a while because fixing them changed numbers already on screen. That
decision was taken on 23 Sep 2026: re-verified on Postgres 16 that the old form filed everything
from Dhaka midnight to 11:59 on the PREVIOUS day, so those two charts shifted by a day for half of
all activity until then. There should now be no single-argument `AT TIME ZONE` on a `DateTime`
column anywhere; a new one is a bug.

**Postgres has no index skip-scan, so `DISTINCT ON` is a sort, not a walk.** A comment in
`chatInbox.ts` claimed the opposite for years. `DISTINCT ON (x) … ORDER BY x ASC, y DESC` is also
mixed-direction, which an all-ascending compound index cannot serve from either end. Where the
driving set is small and known — the monitored groups, the 300 listed conversations — a
`CROSS JOIN LATERAL (… ORDER BY … LIMIT 1)` expresses what was meant: one index probe per row.
`getGroupsAwaitingReply` and the chat inbox both use it now, and both are pinned against their old
form in `queryRewrites.integration.test.ts`. Note `CROSS JOIN` rather than `LEFT JOIN`: it drops a
group with no messages, which is what the old inner JOIN did.

Spell the null case out — `OR: [{ col: null }, { col: { not: value } }]`. The intuitive rewrites do
not work: Prisma 5.22 compiles the `NOT: { col: value }` block form to the same NULL-excluding
comparison, verified against a real database (0 rows vs the 2 expected). Every other `not:` filter
in this repo is on a required column and is therefore safe; check nullability before adding one.

**Bulk actions read current state before writing**, so they report "8 enabled, 1 already on, 1 not
found" rather than "Done", and converge on a re-run instead of writing twice. `bulkSetAiAutomation`
mirrors `bulkSetMonitoring` with one deliberate difference: it **never clears
`aiAutomationExcluded`**. That flag is a hard "never let AI answer here", and a broad gesture must
not quietly override a specific one — those rows are reported as "left alone — excluded from AI",
because an operator who selected a group and saw nothing happen needs to know why. The confirmation
dialog describes the action it is actually confirming; a confirmation that misdescribes what it is
about to do is worse than no confirmation.

### Permissions are enforced on every page and every action (`apps/web/src/server/authorize.ts`)

**Every Server Action is a public HTTP endpoint** — anyone with a session can call it directly, whether
or not the page that shows its button is one they can open. Hiding a page is therefore not a check;
each action makes its own. Until 23 Sep 2026 the roles assigned on Permission Modules governed five
modules and nothing else: the seeded "Read Only" role, described as "View-only access across every
module", could toggle the kill switch, delete rules and broadcast to every group. `rulesBulk.ts` even
said so in writing — "this app has no role/permission system" — a sentence that outlived the fact.

Three shapes, and the choice between them is not taste:
- `checkPermission(key)` for an action that returns form state — return `{ error: granted.denied }`.
- `requireAccess(key)` for an action that returns NOTHING, and for pages. A void action has nowhere to
  put a refusal: throwing replaces the page with the error boundary, and returning silently lets the
  caller show a success toast for something that did not happen. It redirects to
  `/overview?denied=<key>`, and the Overview names what was refused.
- `pageAccess(view, manage)` for a module page, which renders `ViewOnlyNotice` when `canManage` is false.

**Polled readers refuse as "nothing to show", never a redirect** — `readLinkState` is polled about once
a second and a redirect would pull somebody off the page mid-scan. `markChatReviewed` (runs from
`after()`) and `recordSavedReplyUse` (a counter) are silent rather than refused.

Each module uses its own `.view` / `.manage` pair (Automation Rules has finer keys: create, edit,
delete, activate, bulk_import, bulk_export). `messages.reply` exists because Messages had only `.view`
and replying is the most consequential thing a support role does; its migration granted it to every
custom role that could already see Messages, so nobody lost the ability on deploy. Pages whose only
purpose is editing (new/edit forms, the two broadcast composers) need the manage key to open.

**The sidebar and ⌘K palette only offer pages the role can open** (`navPermissionFor` in
`navigation.ts`), and the AI assistant only renders with `ai_learning.view`. That is presentation, not a
check. The map must match each page's own gate; it was verified against all 62 nav links when written,
and a mismatch in the safe direction (a link that then refuses) costs only a bounce.

**A new action or page must gate itself.** The Administrator module is re-synced to every key by the
seed on each deploy, so the admin login cannot be locked out by a key added later.

### Release Notes (`apps/web/src/server/actions/releaseNotes.ts`, `server/releaseNotesReports.ts`, `apps/web/src/lib/releaseNotes.ts`)

A permanent changelog, entirely apps/web-only — nothing in the worker ever reads or writes a
`ReleaseNote`. Its small catalogs (module tags, type/status labels, bullet-line parsing) live in
`apps/web/src/lib/releaseNotes.ts`, not `packages/shared`: unlike `aiResponseModes`/`replyLanguage`,
which the worker's own prompts must render identically, nothing here crosses the app boundary,
so putting it in the shared package would couple two packages for no reason — matches
`lib/aiResponseModes.ts`'s own reasoning, applied to a feature with the same one-app shape.

**DRAFT is hidden from everyone without `release_notes.manage`; PUBLISHED and ARCHIVED are both
public.** Archiving retires a release from being the *current* one, it does not erase that it
happened — "every release should remain available historically" is a stated requirement, not a
suggestion. `getPublishedReleaseNotes()` and `getReleaseNoteForViewer()` hard-code that status
filter with no parameter that can widen it; the admin list is a separate function reached only from
a page already gated on `.manage`.

**The detail page (`/release-notes/[id]`) doubles as the admin's publish preview**, on purpose.
`getReleaseNoteForViewer(id, canManage)` only returns a DRAFT when `canManage` is true — so an admin
previewing an unpublished release sees the exact render a reader will eventually get, with a banner
on top saying it isn't public yet, rather than a second preview implementation that could drift
from the real one.

**Content is seven plain `String[]` sections, one bullet per array element — never a markdown or
rich-text body.** This app has no markdown renderer or rich-text editor anywhere (checked before
adding one), and `String[] @default([])` is already this schema's established way to store a short
list of lines. `affectedModules` is likewise a plain `String[]`, not an enum: the set of modules
this product ships grows continuously, and an enum would need a migration every time a new one
existed just to tag a release with it — the editor offers a suggested list, the column accepts
anything.

**Editing already-public content, or publishing, writes an after-image revision and bumps
`ReleaseNote.currentVersion`** — mirrors `AiKnowledgeItem.currentVersion` /
`AiKnowledgeVersion` exactly: version 1 is what was true the moment it was first published, version
2 is after the first post-publish correction, and so on, so "what did v1.8.0 actually say the day
it shipped" stays answerable. A pure status flip with no content change (archive/unpublish/
re-publish) never writes one — a revision exists exactly when public-facing content changes, not
when its visibility does. Nothing is snapshotted for a DRAFT edit either: it was never public, so
there is no prior public state to lose.

**A PUBLISHED or ARCHIVED release can never be deleted, by any path** — only unpublished or
archived. There is no override and no confirmation-gated escape hatch; the safest version of
"must never accidentally disappear" is a design with no code path that can do it at all. Only a
DRAFT, which never had readers, can be deleted.

**Publishing requires at least one change recorded in any section** — a blank draft cannot go
live by accident. `publishedAt`/`publishedByUserId` are set once on the transition INTO published
from DRAFT and never cleared by a later unpublish/archive/re-publish, the same way
`AiFallbackDecision.aiProviderId` is a snapshot rather than a live link: they are a record of who
published it and when, and taking it down again must not erase that fact.

**No historical release/version scheme exists in this repository** — zero git tags, every
`package.json` still at the scaffolded `0.1.0`, no `CHANGELOG.md`, no commit anywhere in this
repo's history uses a version-like marker. `prisma/seedReleaseNotes.ts` is a one-time, hand-run
backfill (never wired into the routine `pnpm db:seed`) that reconstructs 14 historical releases
(v0.1.0 → v0.14.0, Aug 11 – Sep 13) from real, dated commits — every release date and every bullet
traces to an actual commit; only the version NUMBERS themselves are invented, since nothing real
to derive them from exists. Purely operational commits (merges, the GitLab history-join, deploy
status updates, planning-only commits describing no shipped change) are deliberately excluded.
Idempotent by `version` and safe to re-run — it only creates a release that doesn't already exist,
never overwrites one an admin has since edited.

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
