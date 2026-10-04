# Support Intelligence — Phase 0 Audit and Plan

**Date:** 4 Oct 2026
**Branch:** `rudra`
**Status:** audit only. No code, schema or data was changed to write this.

This is the "read before changing anything" step of the Support Intelligence & Employee Effectiveness
request. It records:
- what the reporting system does today;
- which signals are reliable, which are inferred and which do not exist;
- what that means for each question the request asks;
- the plan, the database changes it needs and the decisions needed before building.

REPORTS.md remains the reference for the existing reports. This document is about what comes next.

---

## 1. How a report is produced today

```
WhatsApp group message
  │  OpenWAProvider.onAnyMessage  →  persistIncomingMessage()            apps/worker/src/pipeline/
  ▼
Message row  (one per account per WhatsApp message; @@unique[accountId, whatsappMessageId])
  │  direction INCOMING | OUTGOING (our own number, including echoes of our sends) | SYSTEM
  │  senderPhone (a phone or a LID), isFromTeamMember (stamped at insert), quotedMessageId,
  │  mentionedPhones, body, timestampWa
  │
  ├─► SupportActivity / SupportSession   (only when Support Activity tracking is enabled)
  ├─► SupportEscalationCase              (only groups with a priority tier; SLA alert ladder)
  ├─► SupportResponseEpisode             (only when Support Team Teams are chosen)
  ├─► TeamAttendanceDay / …Group         (always; recomputed per member-day under a lock)
  └─► AiFallbackDecision / OutboundMessage (AI and rule replies)
  ▼
loadTeamReport()                                     apps/web/src/server/teamReport.ts
  • one raw query per period (≤ 92 days + 24 h look-ahead), project-filtered,
    DISTINCT ON (group, WhatsApp message id) so copies on two accounts count once
  • classify: SYSTEM dropped; OUTGOING → BUSINESS; INCOMING → MEMBER (roster match on
    whatsappId, raw phone, digits) or CUSTOMER
  ▼
computeTeamReport()                                  packages/shared/src/teamReport.ts
  • waits (first-response definition), ON_TIME / RECALLED / MISSED / PENDING
  • support time: one timeline per member across all groups, idle gap, Dhaka midnight
  • Team scope from TeamMembership AT THE MOMENT of each message
  ▼
report builders (BuiltReport)                        apps/web/src/server/reports/*.ts
  ▼
/reports/[report] page  ·  CSV / Excel export (same builder)   exportFile.ts, api/reports/[report]
```

Three report pages predate the generic page and read their own data:
- **Team Report** (`/team-report`) reads the same dataset.
- **Support Activity** (`/support-activity/reports`) reads `SupportActivity` and `SupportSession`.
- **Duty History** (`/team-management/attendance`) reads `DutyAssignment`, `TeamAttendanceDay` and
  `LeaveRequest`.

**Access.** Every report page and export checks:
- project access;
- the permission (`support_activity.view`, or `team_management.view` for duty reports);
- the project feature (TEAM_REPORTS).

Raw queries name `"projectId"`, and `rawSqlProjectFilter.test.ts` fails the build if one does not.

---

## 2. What is reliable, what is inferred, what is missing

| Signal | Source | Standing |
|---|---|---|
| A customer wrote in a group | `Message` INCOMING, sender not on roster | **Reliable**, for periods when collection was working (see §3.3) |
| A named employee wrote | `Message` INCOMING matched to `InternalTeamMember` | **Reliable** when the roster maps their WhatsApp id or number; otherwise they count as a customer |
| Our number replied | `Message` OUTGOING | **Reliable** that it happened. **Who** is a separate question, below. |
| Who sent an OUTGOING message | `OutboundMessage.providerMessageId` = `Message.whatsappMessageId` | **Derivable, not used today** (detail below) |
| Wait, first response, SLA, Missed, Recall | `computeTeamReport` | **Reliable as defined.** Note: an AI or rule reply closes a wait (§3.4). |
| Observed support time without concurrency inflation | one timeline per member | **Reliable.** Already counts parallel groups once (§3.6). |
| Scheduled duty | `DutyAssignment` (shift times copied onto the row) | **Reliable** where managers roster. Unrostered days have no baseline. |
| Inside vs outside duty | `dutyWorkload()` | **Reliable.** Splits in shift / beyond shift / off day. No before/after split yet. |
| Session opened / completed | `SupportSession` | **Weak here.** COMPLETED needs a `marksCompletion` keyword. A deployment on the ANY_MESSAGE rule may never complete one. Off by default. |
| SLA escalation of a priority group | `SupportEscalationCase` + events | **Reliable**, but it records **alerts to the team** for unanswered priority groups, not "an employee escalated to a developer" (§3.1) |
| An issue was resolved | — | **Not recorded** except an admin pressing Resolve on an escalation case. Otherwise inferred from text (§3.2). |
| Employee handed an issue to developers or another team | — | **Not recorded anywhere.** Inferable only from text, low to medium confidence. |
| Customer appreciation | `Message.body` | **Inferable** from text. Target is reliable only through a quote or @mention. |
| Collection was healthy for a period | — | **Not recorded historically.** Partial evidence in `SystemLog` (§3.3). |
| Issue category / complexity | — | **Not recorded.** Only signals exist: exchanges, duration, priority, SLA escalation level, reopen. |

**Who sent an OUTGOING message, in detail.** The join `OutboundMessage.providerMessageId` =
`Message.whatsappMessageId` separates:
- **AI:** `AiFallbackDecision.outboundMessageId`, plus the holding reply and the handover mention;
- **rule:** `AUTO_REPLY` with a `ruleId`;
- **dashboard operator:** `MANUAL_REPLY`, `createdById` = the user;
- **broadcast:** `GROUP_BROADCAST`;
- **typed on the business phone:** no match at all; a person, but unattributable.

The join has no index today (`OutboundMessage` has none on `providerMessageId`).

---

## 3. Findings that shape the plan

### 3.1 "Escalation" means two different things

In this codebase, escalation is the **SLA alert ladder**:
- a priority group's customer goes unanswered;
- the case moves NEW → MONITORING → … → ADMIN_ESCALATED;
- it ends HUMAN_REPLIED (a team member replied) or RESOLVED (an admin pressed Resolve).

The request's escalation is **an employee passing a customer's problem to developers or another
team** and coming back with the answer. Nothing records that.

The plan therefore keeps two separate, honestly named metrics:
- **SLA escalations:** factual, from `SupportEscalationCase`.
- **Internal hand-offs (inferred):** from the employee's own words ("developer ke janacchi",
  "check kore janacchi", "I'll check with the team"), with a confidence level and the message one
  click away.

If management wants hand-offs to be reliable rather than inferred, the honest fix is a one-click
"Escalated to …" / "Resolved" action in the chat inbox. That records a fact instead of guessing
one, and would need one small table.

### 3.2 "Resolved" is mostly not recorded

Resolution is either:
- an admin action on an escalation case (priority groups only);
- a `SupportSession` closed by a completion keyword (only if such keywords are configured and
  tracking is on);
- or inference.

Every resolution therefore carries a **confidence**, and the reports show it:

| Confidence | Evidence |
|---|---|
| **High** | The escalation case was resolved by an admin; or a session was completed by a configured completion keyword; or the customer explicitly confirms after an employee reply ("thank you, solved", "ঠিক হয়েছে", "kaj korche"). |
| **Medium** | The employee states completion ("done", "fixed", "হয়ে গেছে", "check korun") and the customer does not reopen within the reopen window. |
| **Low** | The conversation simply stopped after an employee reply. This is shown as "no further contact" and never counted as resolved. |

Resolution Rate, First-contact Resolution, Escalation Success and Reopened Rate are built on
High + Medium only. The page states that they are inferred from conversation text.

### 3.3 Data health cannot be proven for the past

Collection health is not stored as history:
- `WhatsAppAccount.status` is current state only;
- `WorkerHealthSnapshot` is current state only;
- `ProcessingCheckpoint` is one moving pointer.

`SystemLog` has partial evidence, written only since the September collection-reliability work:
- "Session dropped — reconnecting automatically", "Session recovered automatically";
- "A WhatsApp number has stopped collecting messages";
- "Recovered / Could not recover messages missed while disconnected".

Two consequences:
- **A disconnect is not automatically a data gap.** `catchUpMissedMessages` recovers up to 12 hours
  after every reconnect. A gap is time that was not, or could not be, recovered.
- **No historical period can be proven complete.** The 18 Sep 2026 outage (3 h 15 m lost) shows
  that silent loss happened.

Plan:
- **Record gaps from now on.** A `CollectionGap` row per account is opened by the worker when
  collection stops (status leaves CONNECTED, or the watchdog finds NOT_COLLECTING / UNREADABLE).
  It is closed on recovery, with the catch-up result: recovered count, or failed.
- **A per-project verified-from date.** It defaults to empty, meaning nothing is verified until an
  admin sets it. A period before it is labelled UNVERIFIED_HISTORY.
- **Health status per report period:**
  - **DATA_GAP:** an unrecovered gap overlaps the period;
  - **WARNING:** a recovered gap, or the period is still running;
  - **UNVERIFIED_HISTORY:** the period starts before the verified-from date;
  - **HEALTHY:** none of these.
- **Inactive Groups and Group Health** say "no communication recorded" rather than "no communication
  occurred" whenever the period is not HEALTHY. They never call a group inactive across a gap.

### 3.4 AI and rule replies already close waits in the existing reports

`loadTeamReport` turns every OUTGOING message into BUSINESS. A wait closed by an AI or rule reply is
ON_TIME. That is a defined behaviour and must not silently change (request Phase 36). It does not
inflate any person's figures, because BUSINESS belongs to nobody.

The new layer adds **Human Response SLA**, where only a named employee (or, shown separately, a
dashboard operator) closes a wait. It sits **beside** the existing SLA, with the difference
documented.

The Messages → Unanswered Groups feature already uses a third, stricter definition (Support Team
members only). All three are named and explained in REPORTS.md.

### 3.5 Employees on the business phone are invisible as individuals

An employee typing on the shared business phone produces OUTGOING messages with no outbound match.
These count as "business number, person unknown". They are never assigned to anybody. The
effectiveness report states how much of the period's replying was unattributable, because a team
that mostly uses the business phone cannot be compared fairly person by person.

### 3.6 Concurrency is already handled correctly. Keep it.

Support time is one timeline per person across every group, split on the idle gap and Dhaka midnight.
Group A 10:00–10:30, B 10:10–10:40 and C 10:20–10:50 already count as 50 minutes, not 90.

Session 2.0 keeps that **observed time** as the time figure. Per-group sessions are counted for
**coverage and outcomes, never summed for time**. Two further figures make multitasking visible:
- concurrent groups (peak and average);
- groups per observed hour.

### 3.7 Customers are identified by senderPhone, often a LID

A "customer" is a sender in a group. WhatsApp increasingly sends LIDs, which are stable per person
but not a phone number, so customer-level preference (Phase 8) works per group per sender. Two
consequences:
- one customer in two groups may appear as two;
- the same person may change identifier if WhatsApp migrates them.

The group stays the primary client unit.

### 3.8 This reverses an earlier decision

Earlier in this project, scores and employee rankings were explicitly ruled out ("no best/worst
employee, performance score or employee ranking reports"), and Executive Support Health was built
"not a ranking".

This request asks for an Effectiveness Score and ten leaderboards. The plan below is designed to
make that defensible:
- explainable components;
- shrinkage for small samples;
- opportunity normalisation;
- separate leaderboards;
- confidence labels.

**But this reversal needs your explicit confirmation before anything is built** (decision D1).

### 3.9 Real-world validation needs the live data

Phase 32 compares the WhatsApp timeline, the Message table, sessions and reports for real ISP
Digital groups. That needs the live database and WhatsApp itself, which this environment does not
touch by rule. It has to be either:
- run by you, with a script I prepare that reads only;
- or done through read-only access you grant explicitly.

---

## 4. The eighteen questions against the data

| # | Question | Answerable from |
|---|---|---|
| 1 | What happened | Existing reports. **Reliable.** |
| 2 | Support demand | Customer messages and waits. **Reliable** (subject to data health). |
| 3 | Groups that received support | Team Report, Group Coverage. **Reliable.** |
| 4 | Employees actually active | Member messages, attendance. **Reliable** for mapped members on their own phones. |
| 5 | Efficiency | Outcomes ÷ observed time. **Derived;** outcomes are partly inferred. |
| 6 | Customer issues handled | Waits → cases. **Derived;** case boundaries are a definition (§5.3). |
| 7 | Issues resolved | **Inferred** with confidence (§3.2). |
| 8 | Ownership of difficult issues | Derived from cases + complexity. **Medium confidence.** |
| 9 | Escalations handled well | SLA escalations: **reliable.** Internal hand-offs: **inferred** (§3.1). |
| 10 | Strong customer experience | Appreciation signals + response + resolution. **Inferred.** |
| 11 | Unhealthy groups | Group Health. **Reliable signals**, labelled with data health. |
| 12 | Overloaded employees | Observed time, concurrency, waits per scheduled hour. **Reliable.** |
| 13 | Highly efficient | Derived, with minimum samples. |
| 14 | Consistently effective | Per-week effectiveness, spread across weeks. Derived. |
| 15 | Improving | Current vs previous period, same definitions. Derived. |
| 16–17 | Outside duty / inside vs outside | `dutyWorkload`. **Reliable** where rostered. |
| 18 | Which metrics are trustworthy | Data health + confidence + verified-from (§3.3, §6). |

---

## 5. Proposed design

Derived first. Everything is computed live from existing rows by pure functions in
`packages/shared`, the way `computeTeamReport` is, so each rule is unit-tested. A table is added
only where the information cannot otherwise be known (§7). New reports use the existing
`BuiltReport` page and exports; no second export path.

### 5.1 Data health (Phase 1)
- **New:** `CollectionGap` (worker-written), `SupportActivitySettings.reportingVerifiedFrom` (per
  project, edited on Support Activity Setup by `support_activity.manage`), and
  `packages/shared/src/dataHealth.ts`.
- **Every report** gets a data-health strip: last message received, last processed, gaps
  overlapping the period, verified-from, and status. Effectiveness scores use only verified,
  gap-free days; other days are shown and flagged.

### 5.2 Attribution (Phase 2)
`packages/shared/src/messageActor.ts` classifies every message as one of:
- CUSTOMER;
- MEMBER(id);
- MEMBER_UNMAPPED (`isFromTeamMember` was stamped but the person is no longer on the roster);
- OPERATOR(userId), for a dashboard manual reply;
- AI, RULE or BROADCAST;
- BUSINESS_PHONE (our number, no outbound match);
- SYSTEM.

`loadTeamReport` is untouched. A sibling loader adds the outbound join for the new reports. Nothing
is ever assigned to an employee unless the roster match is exact.

### 5.3 Session 2.0 and cases (Phases 3, 5)
- **Case (derived).** It starts at a customer message that starts a wait. It contains the following
  exchange in that group until one of:
  - a resolution signal;
  - an inactivity gap longer than the case gap (configurable, default 4 h);
  - a Dhaka day boundary with no reply pending.

  A customer message after a resolution signal within the reopen window (default 24 h) is
  **REOPENED**, not a new case. A case's states (ACTIVE / WAITING_CUSTOMER / WAITING_INTERNAL /
  ESCALATED / RESOLVED / REOPENED / ABANDONED / MISSED) are derived and explained.
- **Session (per employee per group).** It starts at their first message in a case and ends at
  their last, split on the idle gap. It is used for coverage, outcomes and counts. Time stays the
  observed single timeline (§3.6). The existing "Support time" is unchanged; the new figure is
  named **Observed Support Session Time** only where it differs.
- **Ownership.** The owner is the employee who sent the last employee message before the case's
  resolution signal. The case also records who acknowledged it first, who stated a hand-off, and
  who returned to the customer.

### 5.4 Feedback (Phases 7, 8)
`packages/shared/src/customerFeedback.ts` holds a phrase catalogue (Bangla, Banglish, English), with
an SQL pre-filter like Call Activity. It classifies BASIC_THANKS / POSITIVE_FEEDBACK /
EXPLICIT_EMPLOYEE_PRAISE / REPEAT_PREFERENCE.

Who the feedback targets:

| Confidence | Evidence |
|---|---|
| **High** | Quotes an employee's message, or @mentions an employee |
| **Medium** | Names the employee, or exactly one employee replied in that case |
| **Low** | Several employees replied |
| **None** | Addressed to everyone ("সবাই", "everyone", "team") |

Only High and Medium affect analytics. Every signal opens its message. Preference needs at least
5 interactions and 2 explicit signals before it is shown.

### 5.5 Complexity (Phase 9)
Rule-based and explained, from exchanges, duration, SLA escalation level, a stated hand-off,
reopening and group priority. It is shown as SIMPLE / NORMAL / COMPLEX / CRITICAL with the reasons
listed.

### 5.6 Duty (Phase 4)
Extend `dutyWorkload` to split time beyond the shift into **before** and **after**, and expose
"scheduled support / additional support / outside-duty contribution". Outside-duty time never adds
to a score.

### 5.7 Effectiveness (Phases 10–14, 20, 30)
- **Score.** Eight dimensions, each a rate with a clear denominator:

  | Dimension | Measure |
  |---|---|
  | Response | Human SLA % and median response per wait handled |
  | Resolution | High/Medium resolutions ÷ cases owned |
  | Ownership | Cases carried to a resolution signal ÷ cases touched |
  | Efficiency | Resolved cases per observed hour |
  | Coverage | Distinct groups served ÷ groups assigned or active |
  | Customer feedback | High/Medium appreciation per 100 cases |
  | Escalation handling | Resolved after a hand-off or SLA escalation ÷ those cases |
  | Reliability | Missed rate, consistency across verified weeks |

- **Fairness.**
  - Each rate is shrunk toward the team rate in proportion to its sample (an empirical-Bayes prior
    of k observations), then converted to a 0–100 percentile among eligible employees.
  - Eligibility needs at least 20 waits handled and 3 verified active days. Below that, "Limited
    sample" and no rank.
  - A dimension with no opportunity, such as no escalations, is left out and renormalised, never
    scored 0.
  - Group difficulty is accounted for through the group's own baseline response time.
- **Display.** Score, breakdown, raw metrics, sample size and confidence, always together. Ten
  separate leaderboards. Wording: "Support Effectiveness", never "best employee". A note says it
  measures only support visible in WhatsApp records.

### 5.8 Group and executive intelligence (Phases 15–19)
- **New reports:**
  - `/reports/group-health` (HEALTHY / WATCH / AT_RISK / CRITICAL / INACTIVE / NO_DATA, with
    reasons);
  - `/reports/aging-support` (age buckets, oldest first);
  - `/reports/support-trend` (current vs previous equivalent period, absolute and %);
  - `/reports/customer-appreciation`;
  - `/reports/employee-effectiveness` and `/reports/employee-effectiveness/[employeeId]`.
- **Group detail:** the existing `/team-report/group/[groupId]` drill-down gains the new sections.
- **Group Activity Trend** gains previous-period comparison, and **Executive Support Health** gains
  the Demand / Support / Quality / Risk / Team / Customer blocks. Both are additive; existing
  figures keep their meaning.
- **Categories.** The catalogue is regrouped into Executive / Employee / Group & Client / Quality /
  Activity / Duty. Routes do not move.

### 5.9 Performance
- `loadTeamReport` already reads every message in the period. The new loader adds:
  - the outbound join, which needs the new index;
  - body text only for pre-filtered candidates (feedback, completion and hand-off phrases), the way
    Call Activity does.
- If a 92-day period becomes slow, the answer is a nightly per-day aggregate, decided after
  measuring, not up front.

---

## 6. Data confidence model

Every advanced figure carries:
- **sample size**, the denominator that produced it;
- **verification:** VERIFIED (inside verified-from, no gap), RECOVERED (a gap was back-filled) or
  UNVERIFIED (before verified-from, or an unrecovered gap);
- **inference level:** FACT (counted from records) or INFERRED (High/Medium from text).

Scores and leaderboards use VERIFIED days only. Everything else stays visible with its label.

---

## 7. Database changes (each needs your approval before the migration is written)

| # | Change | Why it cannot be derived |
|---|---|---|
| M1 | `CollectionGap` table (projectId, accountId, startedAt, endedAt, cause, recoveredCount, recoveryFailed) + same-project trigger | Collection history is not stored anywhere; without it no period can ever be called verified |
| M2 | `SupportActivitySettings.reportingVerifiedFrom DateTime?` | An admin's decision must be stored |
| M3 | Index on `OutboundMessage(providerMessageId)`, created CONCURRENTLY (the documented escape hatch) | The actor join scans the table otherwise |

Deliberately **not** proposed now:
- `SupportIssue` / `SupportIssueEvent`: cases are derivable, and persisting a guess would freeze it.
- `CustomerFeedbackSignal`: derivable.
- `EmployeeSupportMetricSnapshot`: compute live, as every report does today.

Optional later: a small `SupportCaseReview` table if you want the inbox "Resolved / Escalated to …"
action (§3.1), or admin confirmation of inferred resolutions. That would turn inference into
recorded fact.

No migration changes or deletes an existing row.

---

## 8. Files that will change

- **packages/shared/src (new):**
  - `dataHealth.ts`, `messageActor.ts`, `supportCases.ts` (sessions, cases, resolution,
    ownership, complexity);
  - `customerFeedback.ts`, `effectiveness.ts`, `periodComparison.ts`;
  - unit tests for each.
- **packages/shared/src (extended):**
  - `supportReports.ts` (`dutyWorkload` before/after split);
  - `reportCatalogue.ts` (categories, new entries);
  - `projectFeatures.ts` (routes).
- **packages/db:** schema + migrations M1–M3.
- **apps/worker:** `provider/openwa/connectionState.ts`, `health/collectionWatchdog.ts` and
  `pipeline/catchUpMissedMessages.ts` open and close `CollectionGap` rows. Integration tests.
- **apps/web/src/server:**
  - `reports/intelligenceLoader.ts`: the sibling of `loadTeamReport` with the actor join and the
    phrase pre-filters;
  - new builders: `reports/effectivenessReports.ts`, `reports/groupHealthReports.ts`,
    `reports/agingReports.ts`, `reports/trendReports.ts`, `reports/feedbackReports.ts`;
  - `reports/index.ts`;
  - additive changes to `executiveReports.ts` and `groupReports.ts`;
  - `dataHealth.ts`.
- **apps/web pages:**
  - the generic report page (data-health strip);
  - `reports/employee-effectiveness/[employeeId]/page.tsx`;
  - additions to the group drill-down;
  - Support Activity Setup (verified-from field);
  - `navigation.ts` icons.
- **Tests:**
  - shared unit fixtures for every case in request Phase 31;
  - web integration tests with ISP Digital + Bizify + a third project sharing group ids;
  - `reportsCatalogue.test.ts`, `rawSqlProjectFilter.test.ts`.
- **Docs:** REPORTS.md (every metric, formula, threshold, limitation), CLAUDE.md summary.

**Unchanged:**
- every existing report's figures, URL, permission and export;
- `loadTeamReport` and `computeTeamReport`;
- the permission model;
- project isolation.

---

## 9. Build order, and where to stop and look

Each stage is its own commit (or commits), tested, mutation-checked against the code it protects,
and browser-checked on the throwaway database.

1. **Audit.** This document.
2. **Data health + attribution:** M1–M3, gap recording, verified-from, health strip, actor
   classifier.
3. **Sessions, cases, resolution, ownership, complexity:** the derived model, with a read-only
   validation script for real groups.
   - **Stop here and validate against real ISP Digital conversations** before anything is scored.
     If the inferred resolutions do not match what really happened, a score built on them would be
     exactly the "beautiful dashboard with unreliable numbers" the request warns against.
4. **Customer feedback and preference.**
5. **Employee effectiveness:** score, leaderboards, employee detail page.
6. **Group intelligence:** Group Health, Aging, trend comparison, group detail.
7. **Executive intelligence:** blocks, Support Trend & Change.
8. **Documentation:** REPORTS.md complete, known limitations.

This is several weeks of work in the request's own terms. Stages 2–3 are the foundation everything
else depends on.

---

## 10. Risks

- **Inferred outcomes treated as facts.** Mitigation: the confidence column everywhere, Low never
  counted, evidence always one click away, and the stop after stage 3.
- **Scores used for employment decisions.** The data sees only WhatsApp. Mitigation: wording,
  on-page notes, components shown with every score. Ultimately a management policy question (D1).
- **Phrase lists miss real messages or misread jokes.** Mitigation: phrase catalogues are
  unit-tested in both directions (as `parseStyleGuidance` is); results are sampled during validation.
- **Business-phone use hides individuals.** Mitigation: the unattributable share is shown on the
  page; comparison is flagged when it is large.
- **Query cost on 92-day periods.** Mitigation: measure; add the index (M3); pre-filter text in SQL;
  aggregate later only if needed.
- **History looks precise but is not provable.** Mitigation: verified-from defaults to empty;
  history is labelled UNVERIFIED.

---

## 11. Decisions needed before stage 2

| # | Decision |
|---|---|
| D1 | Confirm reversing the earlier "no scores, no employee ranking" decision, for the Effectiveness Score and leaderboards described in §5.7 |
| D2 | Approve migrations M1–M3 (local and test DB only; nothing deployed) |
| D3 | The reporting verified-from date for ISP Digital. Suggested: the date the September collection fixes were deployed, or the deployment date of M1 (gaps are recorded only from then). |
| D4 | Resolution, ownership and hand-offs: accept inferred-with-confidence (§3.1–3.2), or add the one-click inbox "Resolved / Escalated to …" action so they become recorded facts |
| D5 | Real-world validation (§3.9): you run a read-only script I provide, or you grant read-only access |
| D6 | Defaults: case gap 4 h, reopen window 24 h, eligibility 20 waits + 3 verified days, preference 5 interactions + 2 signals |
