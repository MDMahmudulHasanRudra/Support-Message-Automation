# Multi-Project Softify Assist: Audit and Plan

Status: **plan for review. No implementation has started.** This is the Phase 1–2 deliverable the spec
asks for before any code: the Global vs Project-Scoped Entity Map, the Existing Data Migration Plan
and the Project Context Plan. It also covers the access model, feature flags, phasing, and the
decisions that need Rudra's answer before Phase 3 begins.

Audited on 28 Sep 2026 against branch `rudra` at `1306b90`.

---

## 1. What the audit found

The size of the job, measured rather than guessed:

| Surface | Count | What it means |
|---|---:|---|
| Prisma models | 80 | 9 stay global, 70 become project-scoped, `SystemLog` gets an optional project (§3) |
| Settings singletons (`id = "global"`) | 12 | each becomes one row per project |
| Reads/writes of a singleton by `id: "global"` | ~150 | each needs the project |
| Unique constraints that are install-wide today | 19 | each must become unique *per project* |
| Prisma call sites in `apps/web` | ~740 | pages, actions, reports, API routes |
| Prisma call sites in `apps/worker` | ~335 | pipeline, loops, queues |
| Files with raw SQL | 8 | `$queryRaw` bypasses any Prisma-level scoping, so these are fixed by hand |
| Dashboard pages / server-action files / API routes | 90 / 47 / 10 | |
| Absolute URLs in the web app (`href="/…"`, `redirect("/…")`, `revalidatePath("/…")`) | ~405 | affected by the routing change |

Four structural facts shape the plan.

1. **Almost all operational data already hangs off `WhatsAppAccount`.** Messages, groups, the
   outbound queue, AI decisions, escalation cases, support activity, sessions and attendance all
   carry an `accountId` or a `groupId`. Making the account belong to a project gives most of the
   data a project for free. The rest has no owner at all today: rules, knowledge, team members,
   teams, AI providers, settings, templates, policies and shifts.
2. **Authorization already has three entry points** (`checkPermission`, `requireAccess`,
   `pageAccess` in `server/authorize.ts`), and almost every page and action calls one of them
   first. That is where the project context attaches. There is no need to thread a `projectId`
   through 740 call sites by hand; each one gets a scoped database handle from the check it
   already makes.
3. **The worker is already per-account.** Every incoming message arrives with its `accountId`, and
   every queue row carries one. Project context in the worker becomes "look up the account's
   project", plus project-aware versions of the six background scanners that today read the whole
   database.
4. **Many things assume there is one of them**: one Primary account, one AI model per job, one
   escalation admin, one communication-style profile, one set of shift templates, one holiday
   calendar. Each of these becomes "one per project", not something deleted.

---

## 2. The recommendation, in one paragraph

Add a `Project` table and a `projectId` column on every project-scoped table. Backfill every
existing row to a first project (the current installation, e.g. "SP Digital"). Put the project in
the URL (`/p/sp-digital/rules`) so that two browser tabs on two projects can never write into each
other. Resolve and **authorize** the project server-side in the three existing permission helpers,
and have them hand back a Prisma client that **injects `projectId` into every query and fails
closed** if a scoped model is queried without one. The worker takes the project from the account,
never from anywhere else. Feature flags are a `ProjectFeature` table checked in the same helpers
and in the worker. With one project, everything behaves exactly as it does today. That is the
property that lets each phase ship on its own.

---

## 3. Global vs Project-Scoped Entity Map

**Rule for "own column":** every project-scoped table gets its own `projectId`, including tables
whose parent already implies it. Two reasons:

- the scoping layer (§5) can then inject one predicate uniformly and refuse any query that lacks
  it;
- the heavy tables (`Message`, `OutboundMessage`) need `projectId` in their indexes. Joining
  through `account.projectId` on every inbox poll and report would be the slow path.

Consistency with the parent is then enforced by the database (§6.5), not by hope.

Risk: **H** = large table or hot path; **M** = unique/semantic change; **L** = additive column only.

### 3.1 Global: stays platform-wide (9 models)

| Entity | Why global |
|---|---|
| `User` | One login across projects. Access to a project is granted by a new `ProjectMember` row (§7). |
| `UserSession` | Sessions belong to people, not projects. |
| `Permission` | The catalogue of permission keys is code, identical everywhere. |
| `PermissionModule` | Role *definitions* ("Support Agent", "Read Only") are reused across projects and assigned per project via `ProjectMember`. See decision D4. |
| `PermissionModulePermission` | Child of the role definition. |
| `SecuritySettings` | Login and session policy is a platform concern. |
| `WorkerHealthSnapshot` | There is one worker process. Per-loop liveness is about the process, not a project. |
| `ReleaseNote`, `ReleaseNoteRevision` | The product changelog describes the platform, not a customer project. |

`SystemLog` is **mixed**: a nullable `projectId` is set for operational events (a group sync, an AI
handover) and left null for platform events (worker boot, a login). The System Logs page filters to
the current project, plus platform events for platform admins only.

### 3.2 Project-scoped roots: have no project today

| Entity | Current relations | Unique constraints that change | Risk |
|---|---|---|---|
| `WhatsAppAccount` | root of the WhatsApp tree | `isPrimary` partial unique → one Primary **per project** | M |
| `WhatsAppServiceRoute` | → account | `serviceKey` unique → `(projectId, serviceKey)` | M |
| `InternalTeamMember` | → Team, ShiftTemplate | `phoneNumber`, `whatsappId`, `microsoftEmail` unique → per project (D2) | M |
| `Team` | | `name`, `code` → per project | L |
| `TeamMembership` | → member, team | | L |
| `AutomationRule` | → User | | L |
| `AiProvider` | | | M (D3) |
| `AiModelConfig` | → provider | `job` unique → `(projectId, job)` | M |
| `AiKnowledgeItem` | → group, import, user | | M (retrieval must scope) |
| `AiKnowledgeVersion` | → item | | L |
| `KnowledgeImport` | → user | | L |
| `SupportPriorityPolicy` | | `priority` → `(projectId, priority)` | M |
| `SupportKeyword`, `SupportRule` (+ `SupportRuleKeyword`, `SupportRuleGroup`, `SupportRuleTeamMember`) | | | L |
| `ShiftTemplate`, `LeaveType`, `Holiday` | | `name`, `name`, `date` → per project | M |
| `WeeklyScheduleEntry`, `DutyAssignment`, `DutyAssignmentChange`, `LeaveRequest` | → member | already keyed on member, so safe once the member is scoped | L |
| `ChatCategory`, `SavedGroupSet`, `SavedReply` | | `name` → per project | L |
| `NotificationTemplate`, `NotificationEventSetting` | `key`/`event` is the id | id → composite `(projectId, key)` | M |
| `TeamMemberNotificationPreference` | → member | | L |
| `PatternCandidate` | → provider | `patternKey` → `(projectId, patternKey)` | M |
| `PatternCandidateEvidence` | → candidate, session, message | | L |
| `RuleProposal` | → candidate, rule | `sourceSignature` → per project | M |
| `LearningBatchJob`, `ConversationAnalysisRun`, `ConversationCandidate` | | | L |
| `ForgeResearchTask` | → decision | `signature` → per project | M |
| `SandboxSession`, `SandboxTurn` | → group | | L |

### 3.3 Settings singletons: one row per project

`AutomationSettings`, `AiSettings`, `GroupBroadcastSettings`, `GroupParticipantAddSettings`,
`SupportEscalationSettings`, `LearningSettings`, `SupportActivitySettings`, `ForgeSettings`,
`TeamManagementSettings`, `CommunicationStyleProfile`.

- **Shape:** each gains `projectId @unique`. The existing row keeps its id `"global"` and gets the
  first project's id, so nothing moves. New projects get their row from a defaults function at
  creation (§8).
- **Code change:** the ~150 `where: { id: "global" }` reads become one helper per model,
  `getProjectSettings(db, model)`, which reads by `projectId` and creates the row if it is absent.
  That is the same shape `pipeline/settings.ts` already uses.
- **Excluded:** `SecuritySettings` and `WorkerHealthSnapshot` stay global (§3.1).

### 3.4 Project-scoped descendants: project already implied, column added for indexing and enforcement

| Entity | Parent | Risk |
|---|---|---|
| `Message` | account, group | **H**: the largest table. Metadata-only column add (§6.2); indexes built `CONCURRENTLY`. |
| `OutboundMessage` | account, message, group | **H**: the hot queue. `idempotencyKey` is globally unique and stays so, because it already embeds the account id. |
| `WhatsAppGroup` | account | M: `@@unique([accountId, whatsappGroupId])` stays; the account pins the project. |
| `AutomationExecution`, `Notification`, `WorkerCommand`, `ProcessingCheckpoint`, `MessageDropCounter` | account / message | L |
| `GroupBroadcastJob`, `GroupParticipantAddJob`, `GroupParticipantAddItem` | account | L |
| `AiFallbackDecision`, `AiEvidenceSnapshot`, `AiEvidenceItem` | message | L |
| `SupportEscalationCase`, `SupportEscalationEvent` | account, group | L |
| `ConversationSession` | account, group | L |
| `SupportActivity`, `SupportSession` | account, group, member | M: `SupportSession.openGroupId` unique stays, since the group pins the project. |
| `TeamAttendanceDay`, `TeamAttendanceGroup` | member | L |

**Total: 9 global, 70 project-scoped (39 roots, 10 singletons, 21 descendants), plus `SystemLog` with an optional project.** Also needed:

- **3 new tables:** `Project`, `ProjectMember`, `ProjectFeature`.
- **1 new column on `User`:** `isPlatformAdmin`.

---

## 4. Project Context Plan

### 4.1 Web: the project lives in the URL

```
/admin                      Main Admin Portal: projects dashboard
/admin/projects/new         create a project
/admin/projects/[id]        project settings, lifecycle, features, members
/p/[project]/overview       the existing app, inside a project
/p/[project]/rules          …every existing page, same structure
/p/[project]/api/…          the existing export routes
```

**Why the URL and not a cookie.** A cookie holding the "current project" is shared by every tab.
With SP Digital open in one tab and Bizify in another, switching project in the second tab would
silently send the first tab's next form submit into Bizify: an isolation failure that no permission
check catches, because the user is allowed in both. The URL is per tab. Server Actions POST to the
page's own URL, so the project travels with every write automatically.

**Mechanics:**

- **Move the pages.** `app/(dashboard)/*` moves under `app/p/[project]/(dashboard)/*`. It is a
  mechanical `git mv` that keeps every page file intact, and `params.project` is then native.
- **Prefix the links.** A small `projectPath("/rules")` helper (server) and `useProjectPath()`
  (client) prefix the current project. A codemod updates the ~405 absolute URLs.
  `navigation.ts` keeps its unprefixed hrefs as *identifiers*; only the rendered link is prefixed,
  so every nav, tab, breadcrumb and palette behaviour from 27 Sep keeps working.
- **Keep old URLs working.** A new `proxy.ts` (Next 16's middleware) redirects a legacy URL like
  `/rules` to `/p/<last project>/rules`. The last-opened project is a cookie used **only** for this
  redirect, never for authorization or for choosing where to write. Bookmarks keep working.
- **Resolve the project in the permission helpers.** `checkPermission`, `requireAccess` and
  `pageAccess` gain the project step:
  1. read the slug from the route;
  2. load the project;
  3. confirm the user is a `ProjectMember` (or a platform admin);
  4. confirm the project is not Suspended or Archived (read-only when Suspended, §8);
  5. check the permission key **against the user's role in that project**;
  6. check the feature flag if the page or action names one.

  They return `{ session, project, db }`, where `db` is the scoped client (§5).
- **Changing the slug proves nothing.** Every request is re-authorized against `ProjectMember`,
  so a hand-edited URL (`/p/bizify/...`) from an SP-Digital-only user is refused server-side. The
  sidebar never shows it either.

### 4.2 Worker: the project comes from the account, and only from there

```
Incoming message → accountId → account.projectId (cached, invalidated on change)
  → getProjectSettings(projectId) → project rules → project roster → project knowledge
  → project AI client → enqueueOutbound (row carries projectId) → project notifications
```

- **Pipeline.** `processIncomingMessage` resolves the project once and passes a
  `ProjectContext { projectId, db }` down. Every existing function keeps its logic and reads
  through `ctx.db`. The global reads become project reads:
  - `evaluate()` receives only this project's active rules;
  - `resolveActiveTeamMember` matches only this project's roster;
  - `findRelevantKnowledge` retrieves only this project's verified knowledge;
  - `resolveAiClient(job)` resolves this project's model assignment;
  - `resolveWhatsAppAccount(serviceKey)` finds this project's Primary.
- **Queue drainers** (outbound, participant adds, notifications, commands, escalations, knowledge
  imports, Forge research). They stay one global loop each, since one worker drains everything,
  and load the **row's** project settings per row. Per-account rate limits are already per
  account, so one project's traffic cannot consume another's allowance.
- **Scanners** (session segmentation, pattern detection, AI analysis, group knowledge,
  communication style, Forge sync). Today they read the whole database; that is the "scans
  globally" warning in CLAUDE.md. They become "for each Active project with the feature enabled,
  run with that project's context". Nothing learned in one project can reach another's knowledge
  or rules.
- **Account-level loops** (registry sync, watchdog, session health, heartbeat) stay global. Their
  alerts route through the affected account's project's notification settings.

One worker for all projects, not a worker per project: sessions are per account already, and a
second process would reintroduce the concurrent-connect race `ProviderRegistry` exists to prevent.

### 4.3 API routes and exports

The 10 route handlers move under `/p/[project]/api/…` and call the same helpers, so an export can
only ever contain the project in its own URL. `/api/health` stays global.

---

## 5. How isolation is enforced (defence in depth)

| Layer | Mechanism |
|---|---|
| UI | Only the current project's data is ever fetched; the sidebar shows only projects the user is a member of. Presentation, not security. |
| Route | Slug resolved per request; membership and project status checked in the permission helpers. |
| Action / API | Same helpers. Each Server Action already calls one; a lint rule flags an action or page that uses `prisma` directly instead of the helper's `db`. |
| Query | **`scopedPrisma(projectId)`**, a Prisma client extension on the 70 scoped models: <br>• adds `projectId` to every `where` (find/count/aggregate/groupBy/update/delete) and to every `data` (create/createMany/upsert); <br>• refuses a `data.projectId` that differs from its own. <br>The unscoped `prisma` export **throws** when used on a scoped model outside an explicit `platformPrisma` escape hatch reserved for the Main Admin Portal and migrations. It fails closed: a forgotten scope is an error in development, not a leak in production. |
| Raw SQL | `$queryRaw` bypasses the extension, so each of the 8 files (`dashboardMetrics`, `chatInbox`, `supportActivityReports`, `teamReport`, `escalationQueue`, `rateLimiter`, `attendance`, `packages/db/src/index.ts`) gets an explicit `projectId` predicate, pinned by a two-project test. |
| Database | Composite foreign keys, e.g. `Message(accountId, projectId) → WhatsAppAccount(id, projectId)`, so a row cannot point at a parent in another project even through a bug (§6.5). Postgres row-level security is an optional later layer and is not needed to meet the spec. |
| Worker | Context from the account only; scanners iterate projects; queue rows carry `projectId`. |

---

## 6. Existing Data Migration Plan

The current installation becomes the first project. **Nothing is deleted, renamed or moved.**
Every step is additive, and the app keeps working with one project after each step.

### 6.1 Order (one migration per step, each deployable alone)

1. **Create the tables.** `Project`, `ProjectMember`, `ProjectFeature`, and `User.isPlatformAdmin`.
   Insert the first project with a **fixed id** (`proj_default`) so every later step can reference
   it in plain SQL:
   - name: D1;
   - slug: e.g. `sp-digital`;
   - status: `ACTIVE`.
2. **Grant access.**
   - Every existing user becomes a `ProjectMember` of the first project, with the role they have
     today (`User.permissionModuleId` carried over).
   - The Administrator-role users become platform admins.
   - No one loses or gains access on deploy.
3. **Add `projectId` to the 70 scoped tables** (and a nullable one to `SystemLog`):
   `ADD COLUMN "projectId" TEXT NOT NULL DEFAULT 'proj_default'`, then `DROP DEFAULT`.
4. **Add indexes and foreign keys.**
   - Add the FK to `Project`.
   - Add a `projectId`-leading index where a table is filtered by it. On `Message` and
     `OutboundMessage` these are built `CONCURRENTLY` using the escape-hatch pattern already
     documented in `20260902091844_knowledge_sources_and_query_indexes`, because a plain
     `CREATE INDEX` there blocks writes.
5. **Make the unique constraints per project** (the 19 in §3.2). Create the new composite
   unique first, then drop the old single-column one. With one project the data is identical, so
   no row can conflict.
6. **Singletons.** Add `projectId @unique` and set it to `proj_default` on the existing `"global"`
   rows.
7. **Composite consistency FKs** (§6.5). Added last, once the data is verifiably consistent.

### 6.2 Why the big tables are safe

On Postgres 11 and later, `ADD COLUMN … NOT NULL DEFAULT <constant>` is **metadata-only**: it does
not rewrite `Message`, however many rows it has, and completes in milliseconds. The `DROP DEFAULT`
afterwards leaves existing rows reading the value. Only the indexes take time, and those are
concurrent. This is the same class of change as the `isPrimary` partial index, and it gets the same
care.

### 6.3 Verification after the migration (run before any code uses it)

```sql
-- Every scoped row belongs to a project, and it is the first one
SELECT '<table>', count(*) FROM "<table>" WHERE "projectId" <> 'proj_default';   -- expect 0 each
-- Children agree with their parents
SELECT count(*) FROM "Message" m JOIN "WhatsAppAccount" a ON a.id = m."accountId"
 WHERE m."projectId" <> a."projectId";                                              -- expect 0
-- Row counts are unchanged versus a snapshot taken before the deploy
```

### 6.4 Rollback

Steps 1–6 add columns and constraints only, so rolling back means dropping them. The data is never
rewritten, so there is no data rollback to perform. Take a `pg_dump` before step 3 anyway, as the
production safety checklist requires.

### 6.5 Database-level consistency

For each child → parent relation that implies the project (`Message → WhatsAppAccount`,
`WhatsAppGroup → WhatsAppAccount`, `OutboundMessage → WhatsAppAccount`, `AiFallbackDecision →
Message`, `InternalTeamMember → Team`, …):

- add a unique `(id, projectId)` on the parent;
- replace the child's FK with a composite `(parentId, projectId) → parent(id, projectId)`.

A row then physically cannot reference another project's parent. This is the guarantee against
the bug no test anticipated. It is added in step 7, once step 3's data is verified.

---

## 7. Users and access

| Role | Can |
|---|---|
| Platform admin (`User.isPlatformAdmin`) | Everything in the Main Admin Portal: create, suspend and archive projects, set features, add members. Can open any project, as that project's Administrator. |
| Project member (`ProjectMember { userId, projectId, permissionModuleId }`) | Opens only the projects they are a member of, with the permissions of *their role in that project*. The same person can be an Administrator in SP Digital and Read Only in Bizify. |

- **Permission checks change underneath.** `hasPermission(session, key)` becomes
  `hasPermission(session, project, key)`; the call sites do not change, because the helpers already
  wrap it.
- **Admin lock-out protection carries over.** The seed's existing guarantee that the Administrator
  role holds every key is unchanged, and it also ensures every platform admin can reach every
  project.
- **Where users land after login.** A user with one project goes straight into it, exactly as
  today. A platform admin, or a user with several projects, lands on the Main Admin Portal
  (platform admins) or a project picker (everyone else).

---

## 8. Project lifecycle, creation defaults and the Main Admin Portal

**Lifecycle:** `SETUP → ACTIVE ⇄ SUSPENDED → ARCHIVED`.

| Status | Operator UI | Worker |
|---|---|---|
| `SETUP` | usable, so the project can be configured | connects nothing until a WhatsApp account is linked |
| `ACTIVE` | normal | normal |
| `SUSPENDED` | read-only; every write action is refused by the helpers | stops sending (outbound rows for the project are held, not cancelled) and stops the scanners; keeps storing incoming messages, because collection is a push and anything missed is gone (CLAUDE.md, "Collecting every message") |
| `ARCHIVED` | read-only and hidden from the default list | disconnects the project's accounts |

**Nothing is ever physically deleted by a status change.**

**Creating a project** (`/admin/projects/new`: name, slug, description, status) runs one
transaction that creates:

- the `Project` row;
- the 10 settings rows, from the same defaults the schema declares today (automation OFF, AI OFF,
  strict knowledge mode, anti-spam limits at their current defaults);
- default `ProjectFeature` rows from the catalogue;
- the default notification event settings;
- the three default shift templates the seed already creates;
- a `ProjectMember` row for the creator.

It deliberately does **not** create a WhatsApp account, AI provider, rules or knowledge. Those are
set up inside the project, through the pages that already exist for them.

**Main Admin Portal (`/admin`)** — project management only:

- one card per project: name, status, WhatsApp connection state, monitored groups, team members,
  messages today, open escalations, and whether anything needs attention (a disconnected account,
  collection broken);
- totals: projects by status;
- **Create New Project**.

Each card links into the project's existing Overview, which becomes that project's Overview. The
**project switcher** (`SP Digital ▾` at the top of the sidebar) lists the user's projects, with
"All projects" for platform admins, plus "Create project". The project name is shown in the
sidebar header and prefixed to the breadcrumb (`SP Digital › WhatsApp › Accounts`).

---

## 9. Project feature flags

- **Catalogue in code** (`packages/shared/src/projectFeatures.ts`): a key, a label, a default and
  the permission modules it gates. For example `WHATSAPP_CHAT`, `AI_REPLY`, `AI_LEARNING`,
  `CONVERSATION_LEARNING`, `TEAM_MANAGEMENT`, `TEAM_REPORTS`, `BULK_MESSAGING`, `ESCALATIONS`,
  `SUPPORT_ACTIVITY`, `PRODUCT_KNOWLEDGE_FORGE`.
- **Storage:** `ProjectFeature { projectId, key, enabled }`. An absent row means the catalogue
  default, the same shape as `NotificationEventSetting`, so adding a feature needs no migration and
  no backfill. The first project gets every feature it uses today, so nothing disappears on deploy.
- **A feature is an entitlement; the existing settings are a choice.** `AI_REPLY` off means the
  project *cannot* use AI replies (a platform admin's decision). `AiSettings.aiEngineEnabled` is the
  project's own switch *within* that entitlement. Both must be on for AI to reply.
- **One check, four places:**
  - `navGroupsFor()` hides the module;
  - `pageAccess` / `requireAccess` refuse the page;
  - `checkPermission` refuses the action;
  - the worker checks the same flag at the same points it already checks the setting (e.g.
    `checkAiFallbackEligibility`).
- **No project names in code.** No code anywhere compares a project's name or slug.

"Feature X only for Project A" is then one row, set from the Main Admin Portal.

---

## 10. Phases (each ships alone; with one project each is invisible)

| Phase | Delivers | Size | Main risk |
|---|---|---|---|
| **P3 Schema foundation** | Tables, `projectId` on 70 tables, backfill, per-project uniques, singleton `projectId`. Code still reads the first project. | L | Migration on large tables: concurrent indexes and the verification queries in §6.3 |
| **P4 Scoped data layer** | `scopedPrisma`, fail-closed guard, `getProjectSettings`, project-aware permission helpers; web server code converted page by page to `db` | XL | 740 call sites. The guard makes a missed one loud rather than leaky. |
| **P5 Worker context** | Account → project in the pipeline, project settings per queue row, scanners iterate projects | L | The hot path; covered by the existing 791-test isolated suite plus new two-project tests |
| **P6 Routing and portal** | `/p/[project]` move, link codemod, `proxy.ts` redirects, Main Admin Portal, create project, switcher, lifecycle | L | Broken links. The codemod plus a crawl of every nav link, like the 27 Sep nav check. |
| **P7 Feature flags** | Catalogue, `ProjectFeature`, the four checks, a Features tab per project | M | |
| **P8 Isolation test suite** | Two-project fixtures (SP Digital / Bizify) asserting §11 end to end | M | Each test must fail against an unscoped query first, per CLAUDE.md |
| **P9 DB hardening** | Composite consistency FKs (§6.5) | M | |

**Order is not negotiable in one place:** P4 and P5 (enforcement) finish before P6 exposes a way to
create a second project. Until then a second project cannot exist, so there is nothing to leak.

---

## 11. Acceptance: the isolation tests P8 must contain

Each test uses two projects, **SP Digital** and **Bizify**, each with its own account, group, team,
rule and knowledge. Each test is confirmed to fail with its scope deliberately removed.

- **WhatsApp:** Bizify's accounts, groups and messages never appear in any SP Digital list, count,
  search, inbox or export.
- **Knowledge:** an SP Digital customer's question retrieves only SP Digital's verified knowledge,
  even when Bizify has an exact-match entry.
- **AI:** each project's reply uses its own model assignment and credentials.
- **Rules:** a Bizify rule never matches an SP Digital message.
- **Team:** an SP Digital team member's message in an SP Digital group is recognised as staff; a
  Bizify-only person in the same group is a customer.
- **Reports:** Team Report, Overview charts and Support Activity totals equal the sum of that
  project's own rows.
- **Learning:** segmentation and pattern detection in one project write no candidates in the other.
- **Notifications:** alerts go only to the project's own destinations and its own members' DMs.
- **Worker:** an event on Bizify's account is processed with Bizify's settings, and its reply goes
  out on Bizify's account.
- **Access:** a user who is only in SP Digital gets a refusal (not an empty page) on every Bizify
  URL, action and export, including hand-edited slugs.
- **Lifecycle:** a Suspended project sends nothing and accepts no writes, and still stores incoming
  messages.

---

## 12. Decisions needed from Rudra before P3

- **D1: first project's name and slug.** The spec's example is "SP Digital" / `sp-digital`, and
  the Forge integration reads ISPDIGITAL. Confirm the exact name.
- **D2: can one person be a team member in two projects?** Recommended: **yes**. The phone-number
  uniqueness becomes per project, and the same colleague can be on both rosters, with separate
  activity per project. The alternative, one person in one project only, breaks the moment
  somebody supports both.
- **D3: AI providers per project, or a shared provider list?** Recommended: **per project**, as the
  spec asks (§11). Each project owns its providers, credentials and model assignments. A platform
  admin can copy a provider into another project without retyping the key. The worker's
  `OPENROUTER_API_KEY` bootstrap provisions only the first project.
- **D4: roles.** Recommended: the existing Permission Modules stay **shared role definitions**,
  and each project membership picks one. The alternative is roles defined separately per project,
  which duplicates every role for every project.
- **D5: can one WhatsApp number serve two projects?** Recommended: **no**. An account belongs to
  exactly one project; this is the boundary everything else rests on. Two projects each having
  their own number in the *same* group is supported, and each sees only its own copy.
- **D6: routing.** Recommended: project in the URL (`/p/sp-digital/...`, §4.1), for the two-tab
  safety reason. A cookie-only design is smaller to build and is not safe.
