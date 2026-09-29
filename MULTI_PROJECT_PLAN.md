# Multi-Project Softify Assist: Audit and Plan

Status: **Phases 1–5 implemented and verified locally, 28–29 Sep 2026: not pushed, not
deployed.** Phase 6 has not started. See §10.2–§10.5 for what each delivered.

> **The existing permission system and existing portal functionality remain unchanged and are
> reused inside every project. Project access determines which projects a user can enter; existing
> permissions determine what they can do within each accessible project.**
>
> The current installation becomes the project **ISP Digital** (slug `isp-digital`), with all of
> its data and behaviour intact.

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
existing row to the first project, **ISP Digital** (the current installation). Put the project in
the URL (`/p/isp-digital/rules`) so that two browser tabs on two projects can never write into each
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
| `User` | One login across projects, keeping its existing role (`permissionModuleId`). Which projects it may enter is a new `ProjectAccess` row per project (§7). |
| `UserSession` | Sessions belong to people, not projects. |
| `Permission` | The catalogue of permission keys is code, identical everywhere. |
| `PermissionModule` | **Unchanged.** A user's existing role applies, as it is today, inside every project they can access (§7). |
| `PermissionModulePermission` | Child of the role definition. |
| `SecuritySettings` | Login and session policy is a platform concern. |
| `WorkerHealthSnapshot` | There is one worker process. Per-loop liveness is about the process, not a project. |
| `ReleaseNote`, `ReleaseNoteRevision` | The product changelog describes the platform, not a customer project. |

`SystemLog` is **mixed**: a nullable `projectId` is set for operational events (a group sync, an AI
handover) and left null for platform events (worker boot, a login). The System Logs page filters to
the current project, plus platform events for Main Admins only.

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

- **3 new tables:** `Project`, `ProjectAccess` (which projects a user may enter, nothing else),
  `ProjectFeature`.
- **No change to `User`, `PermissionModule`, `Permission` or `PermissionModulePermission`.**

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
With ISP Digital open in one tab and Bizify in another, switching project in the second tab would
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
  3. **project access:** confirm the user has `ProjectAccess` to it (or is a Main Admin, §7);
  4. confirm the project is not Suspended or Archived (read-only when Suspended, §8);
  5. **existing permission:** run the permission check exactly as today, against the user's
     existing role. It is unchanged and the same in every project;
  6. check the feature flag if the page or action names one.

  They return `{ session, project, db }`, where `db` is the scoped client (§5).
- **Changing the slug proves nothing.** Every request is re-authorized against `ProjectAccess`,
  so a hand-edited URL (`/p/bizify/...`) from an ISP-Digital-only user is refused server-side. The
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
- **"Only the Primary account replies" becomes per project.** `processIncomingMessage` suppresses
  automation on any account that is not THE Primary (`findFirst({ isPrimary: true })`). Left global,
  every Bizify message would be silenced because ISP Digital's Primary is not Bizify's account. This
  was found while verifying Phase 1: a stray Primary account in the test database silenced the whole
  AI suite.
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

1. **Create the tables.** `Project`, `ProjectAccess`, `ProjectFeature`. Insert the first project
   with a **fixed id** (`proj_isp_digital`) so every later step can reference it in plain SQL:
   - name: **ISP Digital**;
   - slug: `isp-digital`;
   - status: `ACTIVE`.
2. **Grant access.**
   - Every existing user gets `ProjectAccess` to ISP Digital.
   - Their role, permissions and permission assignments are untouched: nothing in the permission
     tables is written.
   - Nobody loses or gains a single ability on deploy.
3. **Add `projectId` to the 70 scoped tables** (and a nullable one to `SystemLog`):
   `ADD COLUMN "projectId" TEXT NOT NULL DEFAULT 'proj_isp_digital'`. The default stays in place
   until Phase 2 (§10), so every existing write keeps landing in ISP Digital with no code change.
4. **Add indexes and foreign keys.**
   - Add the FK to `Project`, `NOT VALID` first and validated in a separate migration (§6.2).
   - Add a `projectId`-leading index where a table is filtered by it. These arrive with the
     queries that use them (Phase 2), not before. On `Message` and
     `OutboundMessage` these are built `CONCURRENTLY` using the escape-hatch pattern already
     documented in `20260902091844_knowledge_sources_and_query_indexes`, because a plain
     `CREATE INDEX` there blocks writes.
5. **Make the unique constraints per project** (the 19 in §3.2). Phase 1 adds the composite
   `(projectId, …)` unique **next to** the old single-column one; Phase 2 drops the old one once no
   code looks rows up by it. With one project the data is identical, so no row can conflict.
6. **Singletons.** Add `projectId @unique` and set it to `proj_isp_digital` on the existing `"global"`
   rows.
7. **Composite consistency FKs** (§6.5). Added last, once the data is verifiably consistent.

### 6.2 Why the big tables are safe

On Postgres 11 and later, `ADD COLUMN … NOT NULL DEFAULT <constant>` is **metadata-only**: it does
not rewrite `Message`, however many rows it has, and completes in milliseconds. When the default is
later dropped (Phase 2), existing rows keep reading the value.

A foreign key is the one part that reads the whole table. `ADD CONSTRAINT … FOREIGN KEY` checks
every row while holding a lock that blocks writes, and Prisma runs each migration in a transaction.
So every new FK is added **`NOT VALID`** (instant, no scan), and validated in a **second,
separate migration** with `VALIDATE CONSTRAINT`. That takes a lock that does not block inserts, so
the worker keeps storing messages while `Message` is checked. The `projectId` indexes (Phase 2) are
the only other slow part, and those are built concurrently.

### 6.3 Verification after the migration (run before any code uses it)

```sql
-- Every scoped row belongs to a project, and it is the first one
SELECT '<table>', count(*) FROM "<table>" WHERE "projectId" <> 'proj_isp_digital';   -- expect 0 each
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

## 7. Users, project access and the existing permission system

**Two separate checks, in this order, and neither replaces the other:**

```text
User → Project access check (new: which projects may they enter?)
     → Existing permission check (unchanged: what may they do in there?)
     → Existing functionality
```

| Concept | Where it lives | Answers |
|---|---|---|
| Project access | `ProjectAccess { userId, projectId }`: one row per project a user may enter; nothing else is stored on it | "Can this user enter ISP Digital? Bizify?" |
| Existing permissions | `User.permissionModuleId` → `PermissionModule` → `Permission`, **exactly as today** | "Can this user manage rules, broadcast, edit AI settings…?" |

- **The existing permission system is not redesigned, simplified or restructured.** `hasPermission`,
  `checkPermission`, `requireAccess`, `pageAccess`, every permission key, every module, every page
  gate and every action gate keep their current logic.
- **The user's existing role applies in every project they can access.** Someone who can manage
  WhatsApp, Automation, AI and Settings today can do exactly that inside ISP Digital, and inside
  Bizify too if given access. The project layer only adds the question in front of it.
- **Not being a Main Admin removes nothing.** A user with access only to ISP Digital, and the
  existing Administrator role, keeps full Administrator control inside ISP Digital.
- **One user, several projects.** A user can have access to one project or several. With several,
  the project switcher lists exactly those; with one, they go straight into it after login, as today.
- **Without access, a project does not exist for that user.** It is absent from the switcher and
  the project list, and every URL, action, export and API call for it is refused server-side,
  including a hand-edited slug.

**Main Admin.** Managing projects needs a permission that does not exist yet, so it is **added to
the existing catalogue**, not built as a parallel system:

- **`projects.view` / `projects.manage`:** two new keys in `packages/shared/src/permissions.ts`,
  alongside the existing ones. The seed already re-syncs the Administrator module to every key on
  each deploy, so current Administrators get them automatically and nobody else does.
- **What they allow:** a user whose role holds `projects.manage` is a Main Admin. They can:
  - use the Main Admin Portal;
  - create, suspend and archive projects;
  - set each project's features;
  - grant and revoke users' project access;
  - enter any project.

  Inside a project they are still governed by the same existing permissions as everyone else.

This lands with the portal (Phase 4). In Phase 1 nothing reads it.

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
- `ProjectAccess` for the creator.

It deliberately does **not** create a WhatsApp account, AI provider, rules or knowledge. Those are
set up inside the project, through the pages that already exist for them.

**Main Admin Portal (`/admin`)** — project management only:

- one card per project: name, status, WhatsApp connection state, monitored groups, team members,
  messages today, open escalations, and whether anything needs attention (a disconnected account,
  collection broken);
- totals: projects by status;
- **Create New Project**.

Each card links into the project's existing Overview, which becomes that project's Overview. The
**project switcher** (`ISP Digital ▾` at the top of the sidebar) lists exactly the projects the user
has access to, with "All projects" and "Create project" for Main Admins. The project name is shown
in the sidebar header and prefixed to the breadcrumb (`ISP Digital › WhatsApp › Accounts`).

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
  project *cannot* use AI replies (a Main Admin's decision). `AiSettings.aiEngineEnabled` is the
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
| **1 Database foundation** | `Project`, `ProjectAccess`, `ProjectFeature`; ISP Digital created; every user given access to it; `projectId` on the 70 scoped tables (default = ISP Digital); per-project composite uniques **alongside** the existing ones; singleton `projectId`; FKs added `NOT VALID` then validated. **No application code changes.** | L | Migration on large tables: metadata-only columns, `NOT VALID` FKs, verification in §6.3 |
| **2 Scoped data layer** | `scopedPrisma`, fail-closed guard, `getProjectSettings`, the project-access step in the permission helpers; web server code converted page by page to `db`; the `projectId` defaults dropped; the old install-wide uniques dropped once code uses the composite ones; `projectId` indexes | XL | 740 call sites. The guard makes a missed one loud rather than leaky. |
| **3 Worker context** | Account → project in the pipeline, project settings per queue row, scanners iterate projects | L | The hot path; covered by the existing 791-test isolated suite plus new two-project tests |
| **4 Routing and portal** | `/p/[project]` move, link codemod, `proxy.ts` redirects, Main Admin Portal, `projects.*` keys, create project, access assignment, switcher, lifecycle | L | Broken links. The codemod plus a crawl of every nav link, like the 27 Sep nav check. |
| **5 Feature flags** | Catalogue, `ProjectFeature` checks in the four places, a Features tab per project | M | |
| **6 Isolation test suite** | Two-project fixtures (ISP Digital / Bizify) asserting §11 end to end | M | Each test must fail against an unscoped query first, per CLAUDE.md |
| **7 DB hardening** | Composite consistency FKs (§6.5) | M | |

**Order is not negotiable in one place:** Phases 2 and 3 (enforcement) finish before Phase 4
exposes a way to create a second project. Until then a second project cannot exist, so there is
nothing to leak.

**Phase 2 must also grant access on user creation.** A user created after Phase 1 has no
`ProjectAccess` row; nothing reads it yet, but the moment Phase 2 enforces access they would be
locked out. The Users page must grant ISP Digital access on create until the Main Admin Portal
assigns it explicitly, and Phase 2 re-runs the Phase 1 backfill for anyone created in between. The
seed already grants its admin access, idempotently.

### 10.2 Phase 2 as delivered (28 Sep 2026)

- **Project from the URL.** Every page lives under `/p/<slug>/…` (`app/p/[project]/`), including
  the 9 export and import-template routes (`/p/<slug>/api/…`); `/api/health` stays global.
  - `proxy.ts` forwards the URL's slug in `x-softify-project` and always discards a
    client-supplied copy.
  - Project-less URLs go to `/open`, which continues into the last project opened (cookie, used
    for nothing else) or the first accessible one.
  - Routing moved forward from Phase 4 because Rudra required the URL in Phase 2. The portal and
    the switcher stay in Phase 4.
- **Authorization order.** `checkPermission`, `requireAccess` and `pageAccess` now run session →
  project access (`ProjectAccess`) → the existing permission check, unchanged. The dashboard
  layout makes the project check too.
  - A project the user cannot enter is a 404, disclosing nothing.
  - An action refuses with "You do not have access to this project."
- **Scoped client.** `apps/web/src/server/db.ts` exports `prisma` as
  `createProjectScopedPrisma(...)` (packages/db). It scopes every query on the 70 tables (where,
  data, nested writes, connects, list includes, `_count`), fails closed with no project, and
  refuses a query naming another project.
  - All 132 web modules that used Prisma now import it; only `auth.ts` and the project resolver
    keep the platform client.
  - Settings singletons keep their `id: "global"` call sites: the scope reads that as "this
    project's row".
- **Raw SQL.** The 14 `$queryRaw` queries each add `"projectId" = ${await activeProjectId()}`.
- **Links and redirects.** Rendered links go through `@/components/ProjectLink` (and
  `ButtonLink`), `useRouter` through `useProjectRouter`, and redirects/revalidations through
  `projectPath()`. All of these resolve "/rules" inside the current project.
- **Deferred to Phase 3, deliberately.** Both are needed while the worker is still unscoped.
  - The `projectId` DB defaults stay: the worker writes without a project.
  - The old install-wide uniques and the two key-as-primary-key tables stay: the worker looks
    rows up by them.

  The consequence: until then, a second project cannot save a value that collides with ISP
  Digital's under those constraints (a team or shift with the same name, a notification template
  key, a notification event setting, an AI model job slot). Such a write fails loudly; it never
  lands in or reads from the wrong project. No second project can be created from the UI before
  Phase 4.

### 10.5 Phase 5 as delivered (29 Sep 2026): project feature flags

- **Catalogue** (`packages/shared/src/projectFeatures.ts`). Each of the 10 features declares:
  - its default (on);
  - `routes`: the project-relative path prefixes of its pages and export routes;
  - `permissionKeys`: keys ONLY it uses;
  - `workerEffect`: what switching it off stops, in plain words.

  `featureForPath` resolves by longest prefix, so `/support-activity/team` is Team reports rather
  than Support Activity. Unit tests pin that no route or key belongs to two features, and that the
  core product always stays reachable: Overview, Messages, Accounts, Groups, Rules, Settings and AI
  Settings belong to no feature.
- **Storage.** `ProjectFeature` rows; an absent row means the default. ISP Digital has no rows,
  so it keeps every feature exactly as before.
- **An entitlement, not a setting.** Off means the project cannot use the module at all. The module's
  own settings (for example `LearningSettings.conversationLearningEnabled`) are kept untouched, so
  switching it back on resumes where it stopped. Both must be on.
- **One check, four places:**
  1. **Nav.** `navGroupsFor`, `settingsSectionsFor`, `reportPagesFor` and the ⌘K list take the
     project's disabled set. A link shows only when the role holds its key AND the project is
     entitled to its feature.
  2. **Pages.** `proxy.ts` now also forwards the in-project path (`x-softify-project-path`, client
     copy stripped). `requireProjectPage` runs in the project layout for every page and route, and
     sends a page of a disabled feature to `/overview?unavailable=<KEY>`, which names the feature.
     `requireAccess` does the same, which covers the export routes.
  3. **Actions.** `checkPermission` refuses with "<Feature> is not enabled for this project…" when:
     - the page the action was posted from belongs to a disabled feature; or
     - the key checked belongs only to a disabled feature; or
     - the action names its feature. Support Activity, AI Learning and Forge actions pass their
       feature explicitly, because their keys are shared with other modules.

     Three places that did their own permission lookup now go through the same steps: Team
     Management's actions, its export route, and the group-add actions. This also closed a gap:
     those three had skipped the Phase 2 project-access step and the Phase 4 read-only wording.
  4. **Worker** (`project/features.ts`, cached 30 s). The check sits beside each module's own
     setting check:
     - the AI fallback eligibility gate (AI_REPLY);
     - opening and advancing escalation cases;
     - support activity detection;
     - attendance;
     - segmentation, pattern detection, AI analysis, the knowledge builder and sandbox turns
       (CONVERSATION_LEARNING);
     - knowledge import, group knowledge and style (AI_LEARNING);
     - the Forge sync, research and live deep answers.

     Queued work of a switched-off feature waits, untouched.
- **Main Admin Portal.** A switch per feature on the project page (`projects.manage`; read-only for
  `projects.view`). Each off switch says what stops. Every change is logged, and it clears the web
  process's feature cache at once; the worker picks it up within 30 s.
- **Tests.**
  - `packages/shared` `projects.test.ts`: +5 on routing and keys.
  - `apps/worker` `projectFeatures.integration.test.ts` (7). Each worker gate runs with the
    module's own settings ON, first entitled and then not. Mutation-checked: removing each gate
    fails its test.
  - Browser, 19 checks. Bizify with WhatsApp Chat and Team Management off:
    - both are gone from the nav, the Settings rail and the Reports hub;
    - their pages redirect to the Overview with the reason;
    - the export route returns 403;
    - a Team Management action replayed against Bizify is refused with the feature reason;
    - ISP Digital is unchanged;
    - switching a feature back on restores it;
    - `projects.view` sees the features read-only.
- **Still open.**
  - Three features have no worker work to stop: WhatsApp Chat, Team reports and Bulk messaging.
    Bulk messaging's already-queued rows still send; only starting new jobs is refused.
  - A Server Action posted from a page OTHER than its own was refused in testing before any of this
    code ran: Next forwards it to the page that owns the action, and that forwarded request carries
    no project. Refusal is still the outcome, but it depends on Next's forwarding.
  - Forge credentials are still install-wide.
  - No migration was needed.

### 10.4 Phase 4 as delivered (29 Sep 2026): Main Admin Portal and project management

- **Routes** (all outside any project; `/admin` is in `lib/projectPaths.ts`'s outside-project list,
  so links to it are never prefixed):
  - `/admin`: Overview. Totals by status, a "needs attention" line per project, and one row per
    project with its status, WhatsApp state, monitored groups, messages today, open escalations
    and users with access.
  - `/admin/projects`: one card per project, with **Open project** and **Manage**. A dashed card
    offers **Create new project**; "Show archived" includes archived projects.
  - `/admin/projects/new`: the create form (name, slug, description, status).
  - `/admin/projects/[id]`: status and lifecycle, the project's ten settings rows, its features
    and its members (project access).

  The portal uses the project portal's own components and sidebar style, with two nav entries.
  Everything operational stays inside the project: the portal only counts rows
  (`server/mainAdmin.ts`, platform client) and never shows a message, group or customer.
- **Permissions: two new keys, nothing else changed.**
  - `projects.view` opens the portal read-only; `projects.manage` makes a Main Admin, who can
    create projects, change their status, grant or revoke access, and enter any project.
  - The seed re-syncs Administrator to every key, so Administrators get both.
  - `READ_ONLY_PERMISSION_KEYS` now excludes the Main Admin category. It is otherwise "every
    `.view` key", and the seed re-syncs it on each deploy, so without this every Read Only user
    would have been shown every project. Support Manager and Support Agent are unchanged, and a
    unit test pins all of this.
  - Without `projects.view` the portal is a 404. Every portal action checks `projects.manage`
    itself.
  - Inside a project, a Main Admin is governed by their existing role exactly like anyone else.
- **Creating a project** (`createProjectWithDefaults`, packages/db) runs one transaction. It creates:
  - the Project row;
  - its ten settings rows, with the schema defaults except automation OFF;
  - a feature row per catalogue entry;
  - a notification event row per event;
  - the three default shifts, now shared with the seed through `DEFAULT_SHIFT_TEMPLATES`;
  - the creator's access.

  Nothing is copied from another project, and no WhatsApp account, AI provider, rule, team or
  knowledge is created.
  - Name and slug use the shared validators in `packages/shared/src/projects.ts`: lower-case
    letters, digits and single hyphens, 2–48 characters, and not a reserved word.
  - Names are unique case-insensitively; the slug is unique in the database.
  - ISP Digital is displayed and never re-created.
- **Project access.** A yes/no switch per user on the project's page (`setProjectAccess`). Each user's
  existing role is shown beside it and never changed. A Main Admin is marked "enters every project".
  Every access or status change clears this process's access cache at once. Another web process
  may honour a cached decision for up to 5 s.
- **Switcher and context.**
  - The sidebar header is the project switcher (`components/ProjectSwitcher.tsx`). It lists exactly
    `accessibleProjects(userId)`: the user's `ProjectAccess` rows, or every non-archived project
    for a Main Admin.
  - Main Admin and Create project appear only for `projects.view` / `projects.manage`.
  - Switching goes to the other project's Overview.
  - The breadcrumb now starts with the project name on every page.
- **Lifecycle** (§8), with transitions in the shared `canTransitionProject`:
  SETUP → ACTIVE | ARCHIVED, ACTIVE ⇄ SUSPENDED, → ARCHIVED (final from the portal).
  - **Web:** a SUSPENDED or ARCHIVED project is read-only.
    - `checkPermission` refuses non-view keys with a sentence.
    - The web client refuses every write on a project-owned table as a backstop, except the
      empty-update upsert pages use to read a settings row.
    - A banner on every page says so.
  - **Worker:** outbound messages, alerts, group adds and escalation cases of a non-operating
    project are HELD (left pending, not cancelled), and the scanners skip it. Incoming messages are
    still stored, without automation. An ARCHIVED project's accounts are not connected, and a held
    session is released (disconnected, never logged out).
- **Tests.**
  - `packages/shared` `projects.test.ts` (12): slugs, names, lifecycle, the Main Admin keys and the
    default roles, and features.
  - `apps/worker` `projectLifecycle.integration.test.ts` (7): clean creation (every project-owned
    table counted, ISP Digital unchanged), all-or-nothing creation, held queues, storing without
    automation while suspended, scanners, and archived accounts. Mutation-checked: removing each
    guard fails its test. The two incoming-message guards (live path and recovery path) fail only
    when both are removed; that is defence in depth.
  - Browser, 55 checks: Main Admin, User A (ISP Digital only), User B (both), Read Only, a
    `projects.view`-only role, creation, clean project, validation, switching, URL and
    server-action replay attacks, suspend/read-only, and access revocation.
- **Still open.**
  - Feature flags are displayed but not enforced or editable: that is Phase 5.
  - Held outbound rows and escalation timers resume when a project is reactivated, so a long
    suspension can release late replies. The plan's "held, not cancelled" was followed literally;
    cancelling stale rows on reactivation would be a small follow-up.
  - Archived is final from the portal, by design.
  - Forge credentials are still install-wide (§10.3).
  - A role change takes up to 5 s to change Main Admin entry in another process.
  - No migration was needed: permission keys are seeded, and `Project`/`ProjectFeature` came from
    Phase 1.

### 10.3 Phase 3 as delivered (29 Sep 2026): worker and background processing

- **Where the project comes from.** `apps/worker/src/project/context.ts` holds it in an
  `AsyncLocalStorage`.
  - `withAccountProject(accountId, …)` takes it from the `WhatsAppAccount` row, the authoritative
    link (cached 60 s).
  - Rows the web app queued (outbound, notifications, commands, group adds, escalation cases) use
    their own `projectId`.
  - Nothing reads it from a message body or a payload.
  - An unknown account, an empty or unknown project, and a nested switch to a different project all
    throw `ProjectScopeError`.
  - `withProject` awaits inside the context. A Prisma query is a lazy thenable, so returning it bare
    ran the query outside the project. The new tests caught this before it shipped.
- **One scoped client.** `apps/worker/src/db.ts` exports `prisma`: the Phase 2 extension, with the
  worker's context as its resolver. All 56 worker modules use it, and it throws outside a context.
  - `platformPrisma` (unscoped) is used only to claim the next row of a shared queue, list accounts
    to connect, watch or heartbeat, release stranded claims, and reconcile status at boot. Each of
    these then enters the row's or account's own project.
  - The worker's two raw SQL queries (rate limiter, attendance) state `"projectId"` explicitly.
- **Entry points and loops.**
  - Message path: these run as the receiving account's project: `processIncomingMessage`,
    `runAutomationStage`, `storeMissedMessage`, `resolveGroup`, `catchUpMissedMessages`, the drop
    counter, group sync and every connection-state write. The connection-state wrappers keep their
    never-throw contract when an account has been deleted.
  - Shared queues (outbound, notifications, commands, group adds, participant checks, escalation,
    stranded-message recovery) keep ONE global claim order and one item per tick. Each row is then
    worked inside its own project.
  - Per-project scanners use `forEachProject`: segmentation, pattern detection, AI analysis, group
    knowledge, style, knowledge imports, conversation analysis, sandbox and both Forge loops.
    - Each project runs in turn, with its own settings and kill switch.
    - One project's failure is logged, and the next project still runs.
    - The 6 h and 12 h catch-ups decide per project whether they are overdue.
  - Boot: the legacy session account, the env AI provider (`OPENROUTER_*`) and the Forge auto-link
    belong to ISP Digital only, because the environment predates projects. Nothing is provisioned
    for another project that it did not configure itself.
- **Primary per project.**
  - The install-wide `WhatsAppAccount_isPrimary_unique` is dropped; Phase 1's per-project partial
    unique remains.
  - `resolveWhatsAppAccount` reads through the scoped client.
  - `ensurePrimaryAccountExists` heals each project from its own accounts.
- **Outbound safety.** Before any send, the outbound queue checks that the sending account belongs
  to the row's project.
  - A mismatch or a missing account is marked FAILED with a plain reason, logged to SystemLog, and
    never sent.
  - The notification dispatcher, the command processor and the group-add and participant-check
    processors apply the same check.
- **Migration `20260928170000_projects_worker_isolation`** (local only, not deployed):
  - The 70 `DEFAULT 'proj_isp_digital'` become `DEFAULT project_id_required()`. That function
    raises, so a write naming no project fails at the database instead of joining ISP Digital. A
    plain `DROP DEFAULT` would have made `projectId` a required input in every generated Prisma type.
  - The 15 install-wide uniques that stood next to Phase 1's composites are dropped.
  - `NotificationTemplate`, `NotificationEventSetting` and `WhatsAppServiceRoute` are re-keyed on
    `(projectId, key)`.
  - The install-wide Primary partial unique is dropped.

  It is metadata-only on the large tables, and the removed Teams tables are still not dropped. Code
  that used the old keys now uses `findFirst` (scoped) or the compound `projectId_*` key. The seed
  names ISP Digital explicitly.
- **Tests.** `projectIsolation.integration.test.ts` has 19 tests across two projects. They cover:
  - messages and group registration;
  - a missing or unknown project, and project switching;
  - cross-project reads, updates and creates;
  - knowledge, and the AI provider and model;
  - rules, and the Primary account;
  - outbound, alert and command mismatches, and alert muting;
  - segmentation and `forEachProject`.

  Every guarded behaviour was mutation-checked: removing it, or restoring the old index, fails the
  matching test. Fixtures use a test client that acts as ISP Digital outside a context
  (`helpers/projectFixtures.ts`); production code has no such fallback.
- **Still open (not solved by Phase 3).**
  - `$queryRaw` stays outside the scoped client in both apps. Every raw query must name its
    project; all current ones do.
  - Forge credentials are install-wide env, so a second project that enables Forge would read
    through the same API key. Per-project Forge credentials are Phase 4/5 work.
  - `OutboundMessage.idempotencyKey` and `AutomationExecution.idempotencyKey` stay install-wide
    uniques. Both are derived from row ids, so they cannot collide across projects.
  - Global rate limits are counted per project per account. That is per number, since an account
    belongs to exactly one project.
  - Composite consistency FKs (a row's `projectId` matching its parent's) remain Phase 7. Today the
    scoped clients and the send-time account check enforce it.
  - Nothing in the UI can create a project yet (Phase 4).

### 10.1 Phase 1, reviewed after the 28 Sep correction

What Phase 1 does, precisely, and what it deliberately leaves alone.

**Does:**

- **Three new tables.** Create `Project`, `ProjectAccess` and `ProjectFeature`. Insert **ISP
  Digital** (`proj_isp_digital`, `isp-digital`, ACTIVE).
- **Access.** Insert one `ProjectAccess` row per existing user for ISP Digital.
- **`projectId` on the 70 scoped tables**, `NOT NULL DEFAULT 'proj_isp_digital'` with a foreign key
  to `Project`, and a nullable one on `SystemLog` (existing rows are left null = platform, and
  Phase 2 decides what is operational).
  - The FKs are added `NOT VALID`.
  - A separate migration validates them.
- **Per-project composite uniques.** Add `(projectId, …)` for the 19 constraints in §3.2, **next
  to** the existing single-column ones, which stay until Phase 2 moves the code onto the composite
  ones. The Primary account gets a per-project partial unique next to the existing one.
- **Singletons.** The 10 settings singletons get `projectId @unique` (existing `"global"` rows
  pointed at ISP Digital).
- **Verification.** Run the §6.3 checks on the isolated test database, plus the full worker suite
  and all builds, to prove behaviour is unchanged.

**Does not:**

- touch `User`, `PermissionModule`, `Permission`, `PermissionModulePermission` or any role
  assignment;
- change a single query, page, action, route or worker path, with one exception: Forge's own
  `projectId`/`projectName` on `ForgeSettings` (the Forge repository it learns from) are renamed
  to `forgeProjectId`/`forgeProjectName`, a column rename plus 19 field references. The name
  `projectId` must mean the platform project everywhere, and Prisma would otherwise have read the
  Forge column as the new tenant column and overwritten it;
- drop any column, constraint or default;
- add the `projects.*` permission keys (Phase 4, with the portal that uses them).

**Why the defaults and the old uniques stay for now.** With the default in place, every existing
`create()` still writes into ISP Digital without being edited. With the old uniques in place, every
existing `findUnique({ where: { job } })` or `upsert` by name still compiles and behaves the same.
Phase 1 therefore changes the database and nothing else, and can be deployed and verified on its
own. Phase 2 removes both deliberately, once no code depends on them.

## 11. Acceptance: the isolation tests Phase 6 must contain

Each test uses two projects, **ISP Digital** and **Bizify**, each with its own account, group, team,
rule and knowledge. Each test is confirmed to fail with its scope deliberately removed.

- **WhatsApp:** Bizify's accounts, groups and messages never appear in any ISP Digital list, count,
  search, inbox or export.
- **Knowledge:** an ISP Digital customer's question retrieves only ISP Digital's verified knowledge,
  even when Bizify has an exact-match entry.
- **AI:** each project's reply uses its own model assignment and credentials.
- **Rules:** a Bizify rule never matches an ISP Digital message.
- **Team:** an ISP Digital team member's message in an ISP Digital group is recognised as staff; a
  Bizify-only person in the same group is a customer.
- **Reports:** Team Report, Overview charts and Support Activity totals equal the sum of that
  project's own rows.
- **Learning:** segmentation and pattern detection in one project write no candidates in the other.
- **Notifications:** alerts go only to the project's own destinations and its own members' DMs.
- **Worker:** an event on Bizify's account is processed with Bizify's settings, and its reply goes
  out on Bizify's account.
- **Access:** a user with access only to ISP Digital gets a refusal (not an empty page) on every Bizify
  URL, action and export, including hand-edited slugs, and never sees Bizify in the switcher or list.
- **Existing permissions:** a user's existing role grants exactly the same pages and actions inside
  each project they can access as it does today. This compares the permission-filtered navigation
  and gates before and after, like the 323-role-set check done for the 27 Sep navigation change.
- **Lifecycle:** a Suspended project sends nothing and accepts no writes, and still stores incoming
  messages.

---

## 12. Decisions

Answered by Rudra on 28 Sep 2026:

| # | Decision | Answer |
|---|---|---|
| D1 | First project | **ISP Digital**, slug `isp-digital` (corrected 28 Sep; not "SP Digital") |
| D2 | Same person on two projects' rosters | **Yes**: phone-number uniqueness becomes per project; activity is counted separately per project |
| D3 | AI providers | **Each project has its own** providers, credentials and model assignments; a Main Admin can copy one across |
| D6 | Routing | **Project in the URL** (`/p/isp-digital/...`); legacy URLs redirect |

Taken as recommended unless Rudra says otherwise:

| # | Decision | Assumed |
|---|---|---|
| D4 | Permissions | **Decided by Rudra, 28 Sep: the existing permission system is unchanged.** A user's existing role applies inside every project they have access to; project access is a separate yes/no per project (§7). Supersedes the earlier "role per project membership" idea. |
| D5 | One WhatsApp number in two projects | No: an account belongs to exactly one project. Two projects each with their own number in the same group is supported. |
