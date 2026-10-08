# Support Intelligence — Implementation Audit

**Date:** 4 Oct 2026
**Branch:** `rudra`
**Stage:** 0 (audit). It precedes every implementation stage.
**Progress:** stages 1–14 are built locally, on `rudra` only. Nothing is pushed or deployed.
Stage 1 (reporting data health) is in REPORTS.md §8. Stages 2–14 (the Support Intelligence reports)
are in §9. Real-data validation is still open: see §9.6.

This audit covers the Support Intelligence request: three layers of reporting.
- **Level 1** — what happened. These are the existing reports, which stay unchanged.
- **Level 2** — how support was handled.
- **Level 3** — how effective each employee and the team were.

REPORTS.md remains the reference for the existing reports. This file describes what is built on top
of them and why.

**Decisions already taken** (from the request):
- **Scores and rankings** are approved, on condition that they are explainable.
- **Database changes** are limited to three: a collection-gap table, a per-project verified-from
  date, and a safely created outgoing-message index. They are applied to local and test databases
  only.
- **Resolution, ownership and hand-off** are inferred with a confidence level. Explicit inbox actions
  are an optional later step.
- **Defaults:**
  - a case closes after 4 hours of inactivity;
  - a customer returning within 24 hours reopens the case only when context supports it;
  - ranking needs at least 20 waits handled and 3 verified active days;
  - customer preference needs at least 5 interactions and 2 explicit signals.

**Still open:**
- the verified-from date for ISP Digital. It ships empty, which means nothing is verified until an
  admin sets it;
- how real-data validation is run (§J).

---

## A. What already exists

### Pipeline

| Step | Code | Notes |
|---|---|---|
| Ingestion | `apps/worker/src/pipeline/processIncomingMessage.ts`, `persistIncomingMessage` | One `Message` row per account per WhatsApp message (`@@unique[accountId, whatsappMessageId]`). Columns: `direction` INCOMING / OUTGOING / SYSTEM, `senderPhone` (a phone number or a LID), `isFromTeamMember` stamped at insert, `quotedMessageId`, `mentionedPhones`, `body`, `timestampWa`, `receivedAt`. |
| Recovery | `catchUpMissedMessages.ts` | After every connect it sweeps from `ProcessingCheckpoint` up to 12 hours back and at most 2,000 messages. Messages within 15 minutes go through automation; older ones are stored only. |
| Collection health | `health/collectionWatchdog.ts` | Every tick it reports NOT_COLLECTING / UNREADABLE / STUCK_RECONNECTING / NEEDS_HUMAN / DOWN. Nothing about this is persisted except `SystemLog` rows. |
| Connection state | `provider/openwa/connectionState.ts` `recordConnectionState` | Updates `WhatsAppAccount.status` (current state only) and writes a `SystemLog` "WhatsApp connection: \<state\>" row. |
| Boot reconcile | `recovery.ts` `reconcileAccountStatusesOnBoot` | Turns CONNECTED / RECONNECTING into DISCONNECTED when the worker starts. |
| Classification | `apps/web/src/server/teamReport.ts` `loadTeamReport` | SYSTEM is dropped. OUTGOING becomes **BUSINESS**. INCOMING becomes **MEMBER** when the roster matches (exact `whatsappId`, raw phone, digits-only phone) or `isFromTeamMember` was stamped; otherwise **CUSTOMER**. |
| Counting | `packages/shared/src/teamReport.ts` `computeTeamReport` | Waits (first-response definition); ON_TIME / RECALLED / MISSED / PENDING against the group's threshold; support time as one timeline per member across all groups (idle gap, Dhaka midnight); Team scope from `TeamMembership` at the moment of each message. |
| Report builders | `apps/web/src/server/reports/*.ts` | 12 generic reports (`/reports/<id>`) built on `loadReportContext`. Team Report, Support Activity and Duty History keep their own pages. |
| Exports | `server/reports/exportFile.ts`, `app/p/[project]/api/reports/[report]/{export,table-export}` | The same builder as the page. CSV is the detailed table. Excel has Summary / Detailed / Breakdown sheets. |

### Other relevant records

| Record | What it means here |
|---|---|
| `SupportActivity` / `SupportSession` | One activity per qualifying team-member message. A session opens on activity and **completes only on a `marksCompletion` keyword** or an admin close. Off by default (`SupportActivitySettings.enabled`). |
| `SupportResponseEpisode` | One record per wait, answered only by a member of the configured Support Team. Business number, AI and rules never answer. |
| `SupportEscalationCase` / `SupportEscalationEvent` | The **SLA alert ladder** for priority groups (NEW → … → ADMIN_ESCALATED). Ends HUMAN_REPLIED (a member replied) or RESOLVED (an admin pressed Resolve). |
| `DutyAssignment`, `TeamAttendanceDay`, `TeamAttendanceGroup`, `LeaveRequest` | Plan, evidence and approval. Duty state is derived at read time. `dutyWorkload()` splits time into in-shift, beyond-shift and off-day. |
| `OutboundMessage` | Every send this system made. `actionType` (MANUAL_REPLY / AUTO_REPLY / GROUP_BROADCAST …), `ruleId`, `createdById`, `providerMessageId` (the WhatsApp id of the echo). |
| `AiFallbackDecision` | One row per AI decision. `outboundMessageId` is the AI's reply. |

### Access and isolation
- **Access chain:** Project access → existing permission (`support_activity.view`, or
  `team_management.view` for the duty report) → project feature (TEAM_REPORTS) → page and export.
- **Scoped client:** confines all Prisma queries to the active project.
- **Raw SQL:** must name `"projectId"`. `rawSqlProjectFilter.test.ts` enforces this in both apps.
- **Database triggers:** reject cross-project parent rows and any change of `projectId`.
- **Catalogue tests:** `projectIntegrity.integration.test.ts` and
  `projectFoundation.integration.test.ts` check the trigger and table catalogue.

### Indexes the new layer leans on
- `Message`: `[groupId, timestampWa]`, `[accountId, timestampWa]`, `[timestampWa]`,
  `[senderPhone, timestampWa]`, `[quotedMessageId]`.
- `OutboundMessage`: **none on `providerMessageId`.**

---

## B. What can be reused

| Need | Reuse |
|---|---|
| The message dataset for a period | `loadTeamReport`'s query and classification — called as-is, never edited |
| Waits, thresholds, Missed/Recall | `computeTeamReport` waits (`ReportWait`) |
| Person timeline, concurrency-safe time | `memberTimelines`, `splitIntoStretches` (one timeline across all groups) |
| Duty baseline | `dutyWorkload` plus `DutyAssignment` loading in `buildDutyWorkload` |
| Team scope at a moment | `inTeamAt`, `membersOfTeamDuring`, `ReportContext.scope` |
| Group scope, names, filters | `ReportContext` (`groupInScope`, `groupName`, `memberName`, `options`) |
| Previous-period comparison | `changeRatio` (null when the previous value is 0 — no "∞%") from `executiveHealth.ts` |
| Phrase detection with an SQL pre-filter | The Call Activity pattern (`CALL_SQL_PREFILTER` + `detectCallMention`) |
| Rendering, presets, filters, exports | `BuiltReport`, `/reports/[report]`, `reportWorkbook`, `toCsv`, `ReportDataTable` |
| Attention lists | `attentionItems` (one row per group, most urgent issue first) |
| Outgoing-message attribution | `OutboundMessage.providerMessageId` = `Message.whatsappMessageId`; `AiFallbackDecision.outboundMessageId`; `actionType` / `ruleId` / `createdById` |

---

## C. What must be added

| Stage | Addition | Kind |
|---|---|---|
| 1 | Collection-gap recording (worker), verified-from setting, data-health calculation, confidence vocabulary, data-health strip on reports, Inactive Groups wording | 1 table + 1 column, pure functions, UI |
| 2 | Support Session 2.0 and Observed Support Session Time (concurrency peak/average) | Derived (pure functions) |
| 3 | Support Case (open / active / waiting / escalated / resolved / reopened / abandoned) | Derived |
| 4 | Ownership, internal hand-off (inferred), resolution confidence | Derived (phrase catalogues, confidence) |
| 5 | Human Response SLA and the actor classifier (human / operator / AI / rule / broadcast / business phone) | Derived + 1 index |
| 6 | Duty vs actual: before-shift / after-shift split, utilisation | Extends `dutyWorkload` additively |
| 7–9 | Customer appreciation, preference, complexity | Derived |
| 10–11 | Effectiveness metrics, explainable score, separate leaderboards | Derived |
| 12 | Executive Support Intelligence, period comparison | New report + additive blocks |
| 13 | Drill-downs (employee, group, customer) and exports | Pages on the existing builder |
| 14 | Read-only real-data validation script and results | Script + report |

**No new permission key.** The new reports use `support_activity.view` (duty parts use
`team_management.view`), exactly as the existing reports do. The verified-from date is edited on
Support Activity Setup under `support_activity.manage`.

---

## D. What must NOT change

- **Untouched code:** `loadTeamReport`, `computeTeamReport` and every existing report builder's
  figures, routes, filters, presets, permissions and exports. New code calls them; it never edits
  them.
- **Support Time** keeps its definition. The new figure is a separate metric, **Observed Support
  Session Time**, and the UI names both.
- **Response SLA and Missed Support** keep counting any reply from our number (AI and rules
  included) as an answer. **Human Response SLA** is a separate report.
- **The SLA escalation ladder** is unchanged. Internal hand-off is a separate, inferred concept and
  is never merged with it.
- **The 92-day period cap** stays.
- **The permission model** and **project access levels** stay as they are.
- **Existing rows:** no migration rewrites one, and no backfill pretends history was verified.

---

## E. Data limitations

1. **Collection health has no history before this work.** `WhatsAppAccount.status`,
   `WorkerHealthSnapshot` and `ProcessingCheckpoint` describe the present only. Two partial sources
   exist:
   - `SystemLog` holds "WhatsApp connection: …" rows and, since September, the
     drop/recover/catch-up rows;
   - the 18 Sep 2026 outage (3 h 15 m lost) proves silent loss has happened.

   **Consequence:** no period before collection-gap recording starts can be called verified. The
   verified-from date ships empty.
2. **A disconnect is not automatically a data gap.** Catch-up recovers up to 12 hours (at most
   2,000 messages) after a reconnect. A gap is time that was not, or could not be, recovered:
   - longer than the look-back;
   - capped at 2,000;
   - the read failed;
   - or no checkpoint existed.
3. **Gaps are per account, not per group.** When two of our numbers sit in the same group and only
   one dropped, the group was still collected. The first version reports the gap anyway. That is
   conservative: it claims less certainty, never more.
4. **"Escalation" in this system is the SLA alert ladder.** An employee passing a problem to a
   developer is recorded nowhere; it is inferable only from the employee's words.
5. **Resolution is barely recorded.** It exists only as an admin Resolve on an escalation case, or
   a `SupportSession` closed by a completion keyword (needs keywords and tracking enabled).
   Everything else is inferred.
6. **Business-phone replies cannot be attributed.** An employee typing on the shared business phone
   produces OUTGOING messages with no `OutboundMessage` match. They are "business number, person
   unknown" and are never credited to anyone.
7. **Employees missing from the roster are counted as customers.** Their messages are attributed
   only once their WhatsApp id or number is on the roster.
8. **Customers are senders, often LIDs.** A LID is stable per person but is not a phone number, so
   one customer in two groups can appear as two. The group stays the primary client unit.
9. **AI and rule replies close waits in the existing reports.** That is correct for Level 1 and is
   why Human Response SLA must be separate.
10. **Text inference is language-dependent.** Bangla, Banglish and English phrasing varies, so
    phrase lists will miss some messages and misread some jokes. That is why confidence exists and
    why Low confidence never counts.

---

## F. Accuracy risks

| Risk | Mitigation |
|---|---|
| An inference presented as fact | Every derived figure carries FACT or INFERRED plus a confidence level. Low is shown but never counted. Evidence is always one click away. |
| A score used beyond what WhatsApp shows | Wording ("Support Effectiveness", never "best employee"); components shown with every score; an on-page scope note |
| Small samples dominating rankings | Eligibility thresholds; empirical-Bayes shrinkage toward the team rate; INSUFFICIENT SAMPLE instead of a low rank |
| Concurrency inflating time | Time stays the per-person single timeline. Per-group sessions are counted for coverage, never summed for time. |
| Unfair opportunity (more groups, harder groups) | Rates, not totals; each group's own response baseline; dimensions with no opportunity are left out, not scored 0 |
| Historical periods looking precise | Verified-from defaults to empty; UNVERIFIED and DATA_GAP labels on every affected report; scores use verified, gap-free days only |
| Case boundaries misjudged (merged or split issues) | The 4 h gap; reopen only with continuity evidence (a quote, the same customer, a "still not working" phrase); checked against real conversations before scoring |
| Phrase catalogues drifting | Unit-tested in both directions, as `parseStyleGuidance` is; sampled during real-data validation |

---

## G. Implementation order

The order follows the request's stages, with a hard stop for real-data validation before anything
is scored.

| Stage | Contents | Commit |
|---|---|---|
| 0 | This audit | `docs(reports): Support Intelligence implementation audit` |
| 1 | Data health: CollectionGap + recording in the worker, verified-from, `dataHealth.ts`, data-health strip and Summary rows, Inactive Groups "recorded" wording | `feat(reports): reporting data health` |
| 2 | Support Session 2.0 + Observed Support Session Time + concurrency | `feat(reports): support sessions` |
| 3 | Support Case | `feat(reports): support cases` |
| 4 | Ownership, internal hand-off, resolution confidence | `feat(reports): ownership and resolution` |
| — | **Stop:** run the read-only validation script on real ISP Digital groups and fix the logic until it matches | — |
| 5 | Human Response SLA (+ outgoing-message index) | `feat(reports): human response SLA` |
| 6 | Duty vs actual support | `feat(reports): duty and activity intelligence` |
| 7–9 | Appreciation, preference, complexity | `feat(reports): customer signals and complexity` |
| 10–11 | Effectiveness metrics, explainable score, leaderboards | `feat(reports): employee effectiveness` |
| 12 | Executive Support Intelligence + period comparison | `feat(reports): executive support intelligence` |
| 13 | Drill-downs and exports | (part of each stage) |
| 14 | Validation results, docs | `docs(reports): validation and definitions` |

**Each stage:**
- unit and integration tests, each confirmed to fail without the code it protects;
- existing suites;
- the project-isolation tests extended;
- a browser check on the throwaway database;
- REPORTS.md updated.

---

## H. Database changes

| # | Change | Why | Isolation / retention |
|---|---|---|---|
| M1 | `CollectionGap` table (stage 1) | Collection health is stored nowhere. Without a record no period can be called verified. | `projectId` (required, default raises); `accountId` with an `enforce_same_project` trigger; `projectId` immutable trigger; one open gap per account (partial unique index). Kept indefinitely: a row is one per outage, so the volume is tiny. |
| M2 | `SupportActivitySettings.reportingVerifiedFrom TIMESTAMP NULL` (stage 1) | An admin decision must be stored. Per project, since the settings row is. | Existing per-project row; null = nothing verified |
| M3 | Index on `OutboundMessage("providerMessageId")`, created CONCURRENTLY through the documented escape hatch (stage 5) | The actor join (Human Response SLA) scans `OutboundMessage` without it | Index only. Added in the stage that first queries it, not before. |

**M1 columns:**

| Column | Type | Meaning |
|---|---|---|
| `projectId` | text | The project |
| `accountId` | text | The WhatsApp account |
| `cause` | text | e.g. `DISCONNECTED`, `WORKER_RESTART`, `NOT_COLLECTING`, `UNREADABLE` |
| `startedAt` | timestamp | When collection stopped (for a worker restart, the last heartbeat) |
| `endedAt` | timestamp, null | When it resumed; null while ongoing |
| `recoveryStatus` | enum, null | `RECOVERED`, `PARTIAL`, `FAILED`, `NOT_ATTEMPTED`; null until the sweep runs |
| `recoveryAttemptedAt` | timestamp, null | When the sweep ran |
| `recoveredFrom` | timestamp, null | Start of the window the sweep read |
| `recoveredCount` | int | Messages the sweep recovered |
| `recoveryNote` | text, null | Why recovery was partial or failed |
| `createdAt`, `updatedAt` | timestamp | |

Indexes are `(projectId, startedAt)` and `(accountId, endedAt)`.

**Proven unnecessary for now:** SupportCase, SupportIssueEvent, CustomerFeedbackSignal and
EmployeeSupportMetricSnapshot. Cases, signals and metrics can all be derived from `Message` for a
bounded period, and persisting a derived guess would freeze it. They will be added only if:
- stage 14 measurements show derivation is too slow;
- or you want explicit inbox actions ("Mark resolved", "Escalated to developer", "Reopen"). Those
  are facts a person records, and would need a small table.

The project-scoped table count in `projectFoundation.integration.test.ts` moves from 76 to 77. The
trigger catalogue test gains the new trigger.

---

## I. Performance risks

- **Session, case and score queries** read the same bounded dataset as `loadTeamReport` (one query,
  ≤ 92 days + 24 h, by the `timestampWa` index). Message body is **not** read into that query. Text
  inference (hand-off, resolution, appreciation, preference) reads only candidates matched by an
  SQL regex pre-filter, the way Call Activity does, with text truncated in SQL.
- **The actor join** needs M3. Without it, a 92-day Human Response SLA would scan
  `OutboundMessage`.
- **Data health** is two small indexed reads per report: gaps overlapping the period, and the
  newest message/checkpoint.
- **Effectiveness over 92 days** is pure computation over arrays already in memory. Benchmark it at
  stage 10 against a synthetic dataset of production scale (1,850 groups, about 40 members) before
  finalising. Only if that is too slow, consider a nightly per-day aggregate.
- **No N+1:** every per-group or per-member figure comes from the period's arrays, not per-row
  queries.

---

## J. Validation strategy

1. **Deterministic fixtures** (unit and integration) for every case in request §31. Each test is
   confirmed to fail against code with the rule removed.
2. **Project isolation:** ISP Digital, Bizify and a third project sharing WhatsApp group ids, for
   gaps, sessions, cases, signals, scores, exports and drill-downs.
3. **A read-only real-data script** (`packages/db/scripts/validate-support-intelligence.ts`, from
   stage 2).
   - It takes a project slug, group ids and a period. It runs the same pure functions as the
     reports and prints each step side by side:
     message → classification → session → case → ownership / hand-off / resolution → report row.
   - It contains no write statement and refuses a connection that is not read-only (it opens a
     `SET TRANSACTION READ ONLY` session).
   - It covers the 18 scenarios in request §29.
   - It must be run by you, or with read-only access you grant. This environment never touches the
     live database.
4. **Stop rule:** if a real conversation's derived case, owner or resolution does not match what
   happened, stages 5+ wait until the rule is fixed and re-validated.
5. **Regression:** the full shared, worker and web suites; lint (0 errors / 5 existing warnings);
   typecheck; production build; browser checks of every existing report touched.
