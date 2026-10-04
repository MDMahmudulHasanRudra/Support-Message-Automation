# Reports

**Status (1 Oct 2026):** built and verified locally, not pushed and not deployed. No migration.

This file is the reference for the reporting layer: what each report answers, how every figure is
calculated, and how the reports share one dataset. The page-level Help on each report repeats its
formulas in the words the page uses.

## 1. Audit (before this phase)

**A. Existing, unchanged by this phase**

| Report | Route | Built on |
|---|---|---|
| Team Report | `/team-report` (+ group drill-down) | `computeTeamReport` (packages/shared, pure) over `loadTeamReport`'s classified messages |
| Support Activity | `/support-activity/reports` | `SupportActivity` / `SupportSession` (off by default) |
| Duty History | `/team-management/attendance` | `DutyAssignment` + `TeamAttendanceDay` + leave (`getDutyHistory`) |
| Team Performance | `/support-activity/team` | `getExecutiveWorkload`, `getFirstResponseStats`, `getGroupsAwaitingReply` |

**B. Partly there**
- Duty versus activity: Duty History compares the shift with the first and last message of the day.
  It has no idle-gap support time, no time outside the shift, and no overnight attribution.
- Missed and late replies: every wait, with its status, already exists in `computeTeamReport`'s
  `waits`. Only Excel's "Missed & Recall" sheet shows them.
- Employee × group: only the group drill-down shows per-member figures, one group at a time.

**C. Missing**
- inactive groups;
- SLA percentages and response-time distribution;
- coverage per group;
- an hour × weekday heatmap;
- a group activity trend;
- workload shares;
- duty versus recorded support time;
- call activity.

**WhatsApp calls are not recorded anywhere.** OpenWA call events are not subscribed to. A call-log
message has no text, so the pipeline drops it as empty (it is counted in `MessageDropCounter` and
nothing else). Call activity can therefore only be **inferred from what people wrote**: "call me",
"কল দিন", "ami call dicchi". The report says so on screen. It shows a duration only when the
message itself states one.

**D. Reused, not re-implemented**
- the message classification and dedup in `loadTeamReport`;
- `computeTeamReport`: waits, Missed/Recall thresholds, scope rules, stretches;
- `splitIntoStretches` (support time);
- `inTeamAt` / `membersOfTeamDuring` (Team history);
- `ReportDataTable` (selection, search, sort, paging, export);
- the export shape of the Team Report routes;
- `sanitizeExcelRow`.

**E. Database:** no change needed. Everything is read from existing tables. Admin-editable call
phrases would need a settings column, so they are a code catalogue instead
(`CALL_PHRASES` in packages/shared/src/supportReports.ts).

## 2. Structure

```
packages/shared/src/reportCatalogue.ts   every report: id, route, category, question, exports; date presets
packages/shared/src/supportReports.ts    the pure calculations of every new report (unit-tested)
apps/web/src/server/teamReport.ts        loadTeamReport — now also takes groups[] and account, and
                                         returns its classified messages and scope (additive)
apps/web/src/server/reports/             one builder per report → BuiltReport (tiles, tables, notes)
app/p/[project]/(dashboard)/reports/[report]/page.tsx     ONE page renders every built report
app/p/[project]/api/reports/[report]/export               CSV (detailed) / Excel (Summary, Detailed, Breakdown)
app/p/[project]/api/reports/[report]/table-export         one table, selected/page/all rows
```

**One dataset.** Each report runs `loadTeamReport` with the same filters the Team Report reads.
So a report's figures are the Team Report's figures cut another way, never a second definition:
- a support time equals the Team Report's;
- a wait is the Team Report's wait;
- a missed threshold is the Team Report's.

**Exports recompute.** An export recomputes the report from the URL's filters with the same builder
the page rendered, so a file cannot disagree with the screen.

## 3. Common filters

Defaults keep every existing URL meaning what it meant:

| Filter | URL | Default |
|---|---|---|
| Date presets | sets `period` / `date` / `from` / `to` | this month |
| Team | `team` | all teams |
| Team member | `member` | all |
| Groups | `groups=<wgid>,<wgid>` | all groups |
| WhatsApp account | `account` | all accounts |
| Break down by | `by` | day |

**Date presets:**
- Today, Yesterday, This week, Last week, This month and Last month map onto the existing
  `period` / `date` values.
- This year and Custom map onto `period=custom`. A custom range keeps the existing 92-day limit, and
  the page says when it applied it. "This year" past 92 days therefore shows its first 92 days, with
  that note.
- A report can offer its own preset row. Inactive Groups shows Today, Yesterday, **Last 7 / 30 / 60 /
  90 days**, This month and Last month. A "last N days" preset is `period=custom` from N−1 days ago
  to today, so 90 days stays inside the 92-day limit. No other report's preset row changed.

The Team Report gets the Groups and Account filters too. With both empty its SQL, its figures and its
exports are byte-identical to before.

**Group filter.** With groups chosen, only messages in those groups are read:
- support time is the time spent in those groups;
- waits are those groups' waits.

**Account filter.** With an account chosen, only that number's stored copy of each message is read.

**Scope in group reports.** In a group-oriented report (Inactive Groups, Coverage, Trend, SLA by
group, Missed Support), a Team or member includes a group when either:
- its assigned team member is in scope (during the period), or
- an in-scope member replied in it during the period.

Everything in such a group counts, including business-number replies.

Member-oriented reports (Workload, Distribution, Employee breakdown, Duty & Workload) use the Team
Report's own scope: a member's work counts while they were in the chosen Team.

## 4. Reports and formulas

Every report has the common filters. Time is Asia/Dhaka throughout.

| Report | Category | Question |
|---|---|---|
| Executive Support Health | Executive | How much support was asked for, how much was handled, and what needs attention? |
| Team Report | Support Performance | What did the team do, and what was missed? |
| Support Activity | Support Performance | Which support activity was recorded, per group and session? |
| Employee Support Breakdown | Team & Employee | Which groups did each person support, and how? |
| Duty History | Team & Employee | Did each person's day match their shift? |
| Duty & Workload | Team & Employee | How does recorded support time compare with the scheduled shift? |
| Inactive Groups | Group / Client Health | Which groups had no communication at all during this period? |
| Group Support Coverage | Group / Client Health | In each group, how many customer waits got an answer? |
| Group Activity Trend | Group / Client Health | Are groups getting busier or quieter? |
| Response SLA | Response & SLA | How fast are customers answered, and how often within the target? |
| Missed Support | Response & SLA | Which customer waits went unanswered or were answered late? |
| Team Workload | Activity & Workload | How much support work did each person record? |
| Support Activity Heatmap | Activity & Workload | When in the week do customers write and the team reply? |
| WhatsApp Call Activity | Activity & Workload | Where did people ask for, or mention, a call? |
| Workload Distribution | Management | How is the work shared across the team? |

**Executive Support Health** (4 Oct 2026; `/reports/executive-health`, `support_activity.view`, the
Team Reports feature). One page management reads in half a minute. It is a snapshot plus an exception
list, and deliberately **not** a ranking: there is no score, no best or worst person or group. Every
figure is one another report already defines, cut together and never re-decided:

| Tile | Definition (owner) |
|---|---|
| Monitored groups | monitored and active today, one per WhatsApp group (Inactive Groups) |
| Active / No-communication groups | at least one / no stored message of any kind in the period (Inactive Groups) |
| Customer messages, Team replies | the Team Report summary; replies include the business number |
| Unanswered customer waits | waits with no reply yet, whether still pending or missed; a run of customer messages is one wait |
| Missed support | answered late + never answered (the Team Report's Missed) |
| Average / Median first response, SLA % | Response SLA, over the same waits |
| Recorded support time, Active team members | the Team Report summary |
| Groups requiring attention / with declining activity / with prolonged unanswered | counts of the attention list |

**Attention required.** Monitored groups only, **one row per group** under its most urgent issue, with
any others under "Also". The rules are pure and unit-tested (`packages/shared/src/executiveHealth.ts`):
1. **Prolonged unanswered**: a customer with no reply for at least *Prolonged after* (1, 2, 6 or 24
   hours; default 2), measured to the period end, or to now if it has not ended.
2. **Unanswered**: the same, shorter.
3. **SLA breach**: answers after the group's threshold; the worst one is the Waiting figure.
4. **No communication**: no stored message in the period, with days since the last one ("never
   recorded" when there is none).
5. **Declining activity**: at most half the messages of the previous period of the same length, from
   at least 10. A drop from 0 has no percentage (never "∞%"), a drop from 8 to 1 is too small to
   call, and a group gone silent is No communication rather than Declining.

Columns: Group, Issue, Detail, Also, Last activity, Waiting, Assigned, Team. Most urgent issue first,
then the longest wait or silence.

**Workload by team.** Active members, replies, share of replies, recorded support time and charged
Missed per Team (each person's current Team; "No team" otherwise). A distribution of the work, not a
score.

**Previous period.** One raw query counts distinct messages per group in the equal-length period
before, excluding system events, naming `"projectId"` and honouring the account filter.

**Exports.** CSV is the attention list. Excel: Summary (filters, tiles, formulas), Detailed (the
attention list), Breakdown (workload by team).

**Isolation.** `executiveHealth.integration.test.ts` gives Bizify the same WhatsApp groups with
different messages (busy in "decline" in September, a customer in "silent" in October); it fails when
the previous-period query's project filter is removed. It also fails if system events count as
activity, if a pending wait is not "unanswered", if a late answer is not "missed", or if the Prolonged
setting is ignored.

**Inactive Groups — No Communication** (enriched 4 Oct 2026; same report, same route).

**The question.** Which monitored, active groups had **no stored WhatsApp message of any kind** in the
period? That is the default view (Show → No communication). Above the list, a line names the range and
the count: "No communication · 1 Oct 2025 – 31 Oct 2025: 3 of 6 monitored groups had no recorded
WhatsApp activity during this period". When there are none it says "All monitored groups had activity
during this period".

**Statuses.** Every group (one row per WhatsApp group) gets one status for the period:

| Status | Rule |
|---|---|
| No communication | no stored message of any kind — customer, team member or business number — in the period |
| No customer activity | messages in the period, but none from a customer (only the team posted) |
| Customer activity, no reply | customer messages, and no reply from a member or the business number |
| Low activity | fewer than N messages in total (N = 5 by default, selectable) |
| Active | everything else |

**Columns:**
- Group, WhatsApp account (every account holding it, within the account filter), and Team (the
  assigned member's Team today).
- Status.
- Last activity and Last activity by: the latest stored message before the period END. For a silent
  group, that is its latest message before the period. Senders are classed customer / team member /
  business number by the Team Report's own identifiers.
- Days since last activity = (the earlier of the period end and now) − last activity.
- Messages in period, Customer messages, and Team replies (team members plus the business number).
- Monitoring: monitored, and the account's connection state.
- "Never recorded" means the group has no stored message at all. "None before the period end" means
  its first message came after the period. The two are kept apart because only the first is a group
  with no history.

**Tiles.** Monitored groups, With communication, No communication, No-communication share, Longest
silence (days, naming the group and its last date), Never recorded, and Customer activity with no reply.

**Exports.**
- CSV is the shown list.
- Excel has three sheets: Summary (filters, tiles, formulas), Detailed (the list) and Breakdown (the
  activity summary: groups per status).

**Isolation.** Message counts come from the scoped Team Report dataset. Both raw last-activity queries
name `"projectId"`. `inactiveGroups.integration.test.ts` gives Bizify the same WhatsApp groups and
names with different messages, and fails when either project filter is removed.

**Group Support Coverage.** Per group with customer waits in the period:
- **Coverage** = waits answered ÷ waits that needed an answer.
  - Answered = answered in time + answered late.
  - Needed an answer = answered + never answered. Waits still inside their threshold are excluded.
- **In time** = answered in time ÷ the same denominator.

**Response SLA.** The SLA target of a wait is its Missed threshold: the group's escalation first alert
if it has a priority, else "missed after".
- **Within SLA** = answered in time.
- **Breached** = answered late + never answered.
- **SLA %** = within ÷ (within + breached). Waits still inside the target are excluded.
- **Response time** is measured over answered waits only: median (the headline), average, 90th
  percentile, worst.
- Per member: the waits that member's reply closed.

**Missed Support.** Every wait that started in the period, with one status:

| Status | Meaning |
|---|---|
| Waiting | not answered, still inside the threshold |
| Answered | answered in time |
| Answered late | Recall |
| Never answered | Missed, unrecovered |

The default view hides "Answered". Each row shows the customer's first line.

**Team Workload.** Per member, in scope:
- replies;
- groups;
- waits they answered;
- support time (the Team Report's figure);
- work stretches;
- active days;
- average support time per active day;
- first and last message.

**Workload Distribution.** One metric at a time: replies, support time, groups or waits answered.
- **Share** = member's value ÷ the sum over the members listed.
- The denominator is printed under the table.
- For groups, a group two people supported counts once for each, so the sum is group-member pairs.

**Employee Support Breakdown.** One row per member × group:
- replies;
- the group's customer messages;
- waits they answered and their median response;
- Recall credited to them;
- support time in that group, measured over their messages in that group alone. A person's rows can
  therefore add up to more than their own total when they worked groups in parallel, and the page
  says so.

**Support Activity Heatmap.** A count per Dhaka weekday × hour of one metric: customer messages, team
replies (members + business number), or waits started.

**Group Activity Trend.** Per day, week or month:
- customer messages;
- replies;
- groups with any message;
- groups whose customers wrote and got no reply in that bucket;
- waits;
- Missed.

"Monitored groups with no message" uses today's monitored list, which is stated on the page.

**Duty & Workload.** Per member per day. Gated on `team_management.view`, in the Team Management
feature, as Duty History is.
- **Scheduled** = the part of the shift inside the period, for DUTY / COVERAGE / EXTRA_DUTY rows with
  times (a 22:00–06:00 shift is 2h of its own day's report and 6h of the next day's).
  - An end at or before the start crosses midnight (+24 h).
  - The shift belongs to the day it starts, as `DutyAssignment` defines.
- **Recorded support time** = the Team Report's stretches, cut against the shift windows:
  - time inside a window counts as "in shift" for that window's duty date;
  - any other time counts as "outside shift" on its own calendar day.
- **Beyond schedule** = outside-shift time on a day with a shift.
- **On an off day** = recorded time on a day without one.
- **Scheduled, no recorded activity** = scheduled − in shift.

It is labelled exactly that, never "idle" or "absent": silence is not evidence of not working.

In shift + outside shift over a member's rows equals their Team Report support time; a test pins it.

**WhatsApp Call Activity.** Messages whose text matches the call phrases, in three kinds:

| Kind | Example |
|---|---|
| Call requested | "please call me", "কল দিন" |
| Missed call mentioned | "missed call", "call dhorlen na" |
| Call mentioned | "ami call dicchi", "called you" |

- Each row shows who wrote it (customer, team member, business number).
- Duration is shown only when the message states one ("12 min call"), and is labelled "Stated in
  message". Otherwise it reads "Duration unavailable".
- Nothing is a call record.

## 5. Permissions, features and projects

- Every new report needs `support_activity.view`, the Team Report's key. Duty & Workload needs
  `team_management.view`, Duty History's key. **No key was added**, and project access levels apply
  unchanged (all reads).
- New routes belong to the TEAM_REPORTS feature, and Duty & Workload belongs to TEAM_MANAGEMENT. Off
  means no card, no tab and no page.
- Raw SQL names `"projectId"` (`rawSqlProjectFilter.test.ts`). The reports run in the Main Admin
  Workspace with project tabs, like every module.

## 6. Verification (1 Oct 2026)

| Suite | Result |
|---|---|
| shared `supportReports.test.ts` | 29 |
| web `reportsCatalogue.test.ts` | 9 |
| web `reports.integration.test.ts` (isolated DB) | 35 |
| Browser, dev server on the throwaway DB | 55/55 |

**Unit tests (shared)** cover every calculation:
- SLA %, coverage, median and p90;
- the four group statuses;
- support time equal to the Team Report's, with parallel groups counted once;
- shares;
- weekday × hour in Dhaka;
- trend buckets;
- overnight shifts, in-shift and beyond-schedule time, off days, and in shift + outside shift =
  Team Report time;
- call phrases in three languages, false positives, a duration only when stated, both encodings
  of য়;
- presets.

**Integration test.** A hand-worked fixture in ISP Digital on a fixed day pins every report's
figures. It also covers:
- the date, Team, member, group and account filters;
- the Team Report unchanged with the new filters empty;
- isolation: all 11 reports byte-identical for ISP Digital after Bizify fills the same WhatsApp
  group, including a cross-project "last message" trap, and Bizify's own figures exactly its rows;
- an empty project;
- Excel sheets matching the tables, CSV, and formula-safe cells.

**Mutation checks.** Each of these fails at least one test:
- removing the project filter from each new raw query;
- the loader ignoring the group or account filter;
- the group scope losing "replied in";
- overnight shifts treated as same-day;
- in-shift time credited to the calendar day;
- "no reply" merged into "no activity";
- pending waits counted in SLA %;
- a loose call-duration pattern;
- parallel groups double-counted.

**Browser** covers:
- the hub categories and cards, with the three old cards kept;
- all 11 reports opening;
- statuses, call honesty and the overnight shift on screen;
- the presets, the Team filter, the Groups picker (this caught a real bug, fixed: a hidden field
  React reset on re-render), and the account filter;
- CSV, Excel and table exports, plus the Team Report and its export;
- workspace tabs and per-project data;
- feature-off refusal and hidden cards;
- permission refusals for page and export;
- no project access → 404;
- no horizontal scroll at 390px;
- dark mode.

**Known:** an unknown report id renders the not-found page with HTTP 200 in the browser. The
dashboard's `loading.tsx` starts streaming before the page runs, so `notFound()` cannot change the
status. Detail pages across the app behave the same way.

## 7. QA audit (2 Oct 2026)

The review found these bugs. Each is fixed and has a regression test that fails with the fix removed.

| Bug | Effect | Fix |
|---|---|---|
| A member-only filter was ignored by member reports | `?member=` with no Team still listed everyone in Team Workload, Distribution, Employee Breakdown, Duty & Workload, SLA "by who answered", the replies heatmap and Calls | `loadTeamReport` returns the scope it actually applied |
| `?metric=toString`, `?team=toString` (any inherited name) | 500 on the page and both exports. The `team` one predates this phase and crashed the Team Report too | own-key checks instead of `in` |
| `?date=9999-12-31` and impossible dates | 500 (past what Prisma can send), or a rolled-over date | only real dates in years 2000–2999 are accepted; anything else means today |
| An overnight shift counted in full in two reports | "Scheduled" and "Scheduled, no recorded activity" were inflated at period edges | scheduled time is clipped to the period |
| Bangla "সকল" ("all") read as "কল" ("call"); "pls phone number din" read as a call request | false call rows | no Bengali letter may precede a Bangla call phrase; "phone number" is excluded |
| Table export cut off at 5,000 rows silently | a partial file that looked complete | HTTP 413 with the reason, shown as a toast (Team Report tables too) |
| Call rows keyed by position | a selected-rows export after new messages arrived named other rows | keyed by the message's own id |
| A member whose only reply fell in the 24h look-ahead | that wait was missing from "Waits answered" | they get a row of their own |
| Groups picker | more than 200 groups could be ticked though only 200 are kept; ticks survived closing; Back kept a stale selection | capped with a note; closing forgets ticks; keyed on the applied selection |
| Very large tables | every row went to the browser (Missed Support "every wait" over 92 days) | at most 5,000 rows on screen with a note; files carry all |
| Missed Support customer line | could match a team member's same-millisecond message | customer messages only |
| Missed Support and Call Activity searched by timestamp | a table's search reads its first column, which was the time | the group is the first column (its WhatsApp id is searchable under it) |

**Open, needs a decision:** "This year" keeps the existing 92-day limit, so it shows 1 Jan to 2 Apr
with the limit note. The cap could be raised for this preset, or the preset changed to "last 92
days"; both change how much one request reads.

**Verification after the fixes** (fresh isolated database): shared 251, engine 79, ai-client 31,
web 172, worker 869; browser 72/72 (workspace), 37/37 (Main Admin and access levels), 77/77 (reports,
roles, audit fixes) and 5/5 (selected / page / filtered table exports).

## 8. Reporting data health (4 Oct 2026, Support Intelligence stage 1)

A report must not claim more certainty than the data supports. "No stored message" is not "no
communication": collection can stop. Two records now decide how far a period can be trusted.
SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md has the reasoning.

**CollectionGap (worker-written, one row per outage per WhatsApp account).**

| Opened when | Started at |
|---|---|
| The session leaves CONNECTED (`recordConnectionState`) | Now |
| The worker restarts while a session was live (`reconcileAccountStatusesOnBoot`) | The account's last heartbeat |
| The watchdog proves the listener deaf (NOT_COLLECTING) or the session unreadable (UNREADABLE) | The last message stored before the silence |
| The watchdog finds an account down, stuck reconnecting or needing a re-link with no gap open yet | The last message stored before the silence |

It is closed when the session reaches CONNECTED again, or when the watchdog sees messages arriving.
The catch-up sweep that runs after a reconnect records its result on the gap:

| Recovery status | Meaning |
|---|---|
| RECOVERED | The sweep read the whole gap |
| PARTIAL | The gap began before the sweep's 12-hour look-back, or the sweep hit its 2,000-message cap |
| FAILED | The session could not be read, or the sweep threw |
| NOT_ATTEMPTED | The account had never processed a message, so there was no position to recover from |

- One open gap per account is a database rule (a partial unique index).
- Recording is best effort and never breaks a connection-state write or a sweep.
- Gaps are recorded from the day this shipped; nothing earlier can be reconstructed.

**Verified from** (`SupportActivitySettings.reportingVerifiedFrom`, per project). It is set on
Support Activity Setup → Reporting data health by `support_activity.manage`, in Asia/Dhaka time.
- It cannot be in the future.
- It is logged in System Logs.
- It is empty by default, meaning nothing is verified yet: collection health was never recorded
  before, so no earlier period can be proven complete.

**Status of a report period** (`computeDataHealth`, packages/shared/src/dataHealth.ts):

| Status | When |
|---|---|
| DATA_GAP | A gap overlapping the period is still open, or was not fully RECOVERED |
| UNVERIFIED_HISTORY | Verified-from is not set, or is later than the period start |
| WARNING | Every overlapping gap was RECOVERED ("Verified — a collection pause was recovered") |
| HEALTHY | None of the above ("Verified") |

The statuses rank in that order. An open gap is measured to now. Only accounts in at least one group
count: a spare number in no group cannot lose a group message.

**Where it shows.**
- **Every `/reports/<id>` page and the Team Report** show a data-health strip above the figures:
  - status and headline;
  - every caveat with its exact hours ("Reporting data may be incomplete between 20 Oct 2025,
    09:00 – 23:00 — Primary Account: disconnected; only part of it could be recovered");
  - last message stored, last processed, and verified-from.
- **Every Excel export's Summary sheet** carries "Data health", "Data health detail", "Verified
  from" and one "Data caveat" row per caveat.
- **Inactive Groups** has a **Data** column per group:
  - Data gap: one of the group's accounts had an incomplete gap;
  - Historical / unverified;
  - Verified.

  When the period is not Verified it adds the note that "no communication RECORDED is not proof
  that none occurred".
- **Executive Support Health** adds the same caveat when the period is DATA_GAP or
  UNVERIFIED_HISTORY.

**Nothing else changed.** No existing figure, label, route, permission or export column was altered.
The additions are the strip, the Summary rows, Inactive Groups' new last column and the notes.

**Known limits.**
- Gaps are per account. When two of our numbers share a group and only one dropped, the group was
  still collected, but the gap is reported anyway. That is conservative: it claims less certainty,
  never more.
- A sweep that read nothing from a healthy session is RECOVERED even when WhatsApp no longer held old
  messages. The sweep is bounded by what WhatsApp Web still returns.
- The verified-from field lives on Support Activity Setup, so it needs the Support Activity feature
  switched on for the project.

## 9. Support Intelligence (5 Oct 2026, stages 2–14)

Five reports in a new **Support Intelligence** category on All Reports. They sit ABOVE the
operational reports. No existing report, figure, label, route, permission or export column changed.
SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md has the reasoning and the decisions.

| Report | Route | Question |
|---|---|---|
| Executive Support Intelligence | `/reports/support-intelligence` | What is happening in support, where are the problems, and what changed? |
| Employee Effectiveness | `/reports/employee-effectiveness` (`?member=<id>` = one person) | How effectively did each person handle support — and on how much evidence? |
| Support Cases | `/reports/support-cases` (`?status=` filter) | Customer problems as cases: owner, hand-offs, resolution, reopened and complex cases, sessions |
| Human Response SLA | `/reports/human-response-sla` | How long did customers wait for a PERSON? |
| Customer Appreciation & Preference | `/reports/customer-signals` | Where did customers thank or praise the team — and whom, on what evidence? |

All five use:
- the `support_activity.view` permission and the `TEAM_REPORTS` feature — no new permission was added;
- the Team Report's filters: period up to 92 days, team, member, groups, account;
- the generic page and exports: CSV is the Detailed table; Excel is Summary + Detailed + Breakdown
  sheets.

### 9.1 Where the figures come from

- **One loader** (`apps/web/src/server/intelligence/loader.ts`) and **one pure model**
  (`packages/shared/src/intelligence/`). The page, both exports and the validation script call the
  same functions, so they cannot disagree.
- It reads `Message` from the period start minus 4 hours to the period end plus 24 hours:
  - the look-behind lets a case that opened just before the period be understood;
  - the look-ahead finds late replies;
  - only cases and waits that START inside the period are counted.
- One row per real message: `DISTINCT ON (whatsappGroupId, whatsappMessageId)`, as in the Team Report.
- The text is loaded only when it is 24 characters or shorter, or when a phrase catalogue could match
  it. That check is a superset prefilter in SQL (`INTELLIGENCE_SQL_PREFILTER`, tested).
- Raw SQL names `"projectId"` on every project-owned table, including the joined `OutboundMessage`.
- The only database change is one index, `OutboundMessage(providerMessageId)` (migration
  `20261008090000_outbound_provider_message_index`).

**Who sent each message** (`IntelActor`):

| Actor | Rule |
|---|---|
| CUSTOMER | incoming, sender not on the roster |
| MEMBER | incoming, sender matched to a roster member (whatsappId, raw or digits-only phone; deactivated members included) |
| MEMBER_UNMAPPED | stamped `isFromTeamMember` when it arrived, but nobody on the roster matches now |
| OPERATOR | ours, with an `OutboundMessage` of type MANUAL_REPLY (typed in the dashboard chat) |
| AI | ours, `AUTO_REPLY` with no rule |
| RULE | ours, `AUTO_REPLY` with a rule (and any other automated type) |
| BROADCAST | ours, `GROUP_BROADCAST` |
| BUSINESS_PHONE | ours, with no `OutboundMessage` — somebody typing on the business phone |

A **human reply** is MEMBER, MEMBER_UNMAPPED, OPERATOR or BUSINESS_PHONE. AI, rules and broadcasts
never are.

### 9.2 Definitions and formulas

**Support Session.** One employee's messages in one group, split wherever they were quiet in that
group longer than the Team Report's idle gap (`offlineAfterMinutes`). It runs from their first
message to their last; a session of one message is 0 seconds.

**Observed Support Session Time.** The union of one employee's sessions across every group, so
overlapping groups count once. A 10:00–10:30, B 10:10–10:40 and C 10:20–10:50 is 50 minutes, not 90.
Peak concurrency (3) and average concurrency (1.8) are shown beside it. It is shown next to the Team
Report's **Support Time**, never instead of it, and Support Time is unchanged.

**Duty vs actual.** Observed time is cut against the person's `DutyAssignment` shifts:
- inside a shift: **during duty**;
- on a day with a shift but outside it: **before shift** or **after shift**;
- on a day with no shift: **off-day**.

A cross-midnight shift belongs to the day it starts, as in Duty History. Time outside duty is shown,
never scored.

**Support Case.** One customer problem in one group.

| Rule | Detail |
|---|---|
| Opens | A customer message when no case is open in the group |
| Never opens | A **closing remark**: "ok", "thanks", "yes it is working now", an emoji — with no question mark and nothing saying it is still broken |
| Closes | After 4 hours with no message (`DEFAULT_CASE_GAP_MS`) |
| Reopens | A customer message within 24 hours of a resolution, ONLY when it carries the problem on: it quotes one of the case's messages, or says it is still not working |
| New case instead | Any other new question after a resolution |
| No case | A team message with no case open (a greeting, an announcement) |

| State | Meaning |
|---|---|
| ACTIVE | The case is open and moving |
| WAITING_CUSTOMER | Waiting for the customer |
| WAITING_INTERNAL | After a hand-off |
| ESCALATED | An SLA escalation is open |
| RESOLVED | A resolution was inferred (below) |
| REOPENED | The customer carried the problem on after a resolution |
| ABANDONED | Shown as "No further contact" |
| MISSED | No human reply before the group's Missed threshold |

**Resolution (inferred), with confidence.** Only messages after the latest reopen count.

| Confidence | Evidence, strongest first |
|---|---|
| HIGH | An admin resolved the group's SLA escalation case (a recorded fact) |
| HIGH | The customer confirms it works, after a human reply |
| MEDIUM | An employee says it is fixed, and the customer does not say it is still broken afterwards |
| MEDIUM | A completion keyword closed the `SupportSession` |
| MEDIUM | The customer thanked the team (not "thanks everyone") after a human reply |
| — | The conversation stops: "No further contact", **never counted as resolved** |

"Still not working" from the customer cancels every earlier signal. The resolution rate counts High
and Medium only.

**Internal hand-off (inferred).** The employee's own words about passing the problem on:

| Confidence | Example phrases |
|---|---|
| HIGH | developer, technical team, forwarded, escalated, "team ke janacchi" |
| MEDIUM | "I'll check", "check kore janacchi", "update dicchi" |
| LOW | "please wait", "ektu somoy din" |

The hand-off "came back" when the same employee wrote again at least 5 minutes later. A hand-off is
NOT an SLA escalation, which is the system's alert ladder and a recorded fact. The two are reported
separately.

**Owner (inferred).** Not simply the last replier. Points:

| Points | Reason |
|---|---|
| 1 | First to respond |
| 2 | Took it on: a HIGH or MEDIUM hand-off |
| 2 | Came back after the hand-off |
| 2 | Told the customer it was fixed. Counts only after the latest reopen: a fix that did not hold earns nothing |
| 2 | Took it on again: the first employee to reply after the customer reopened it |
| 1 | The last employee to reply before the resolution |
| 1 | Wrote MORE than half the team's replies (a 50/50 split gives it to nobody) |

Ties go to whoever replied first. Owner confidence:
- **HIGH**: the owner came back after a hand-off, or stated a fix that a High or Medium resolution
  supports — and nobody tied them;
- **MEDIUM**: the only employee, or a clear lead without that evidence;
- **LOW**: a tie.

The reasons are printed on every case.

**Complexity.**

| Points | Reason |
|---|---|
| 1 | 6+ back-and-forth turns |
| 2 | 12+ turns (instead of 1) |
| 1 | Ran over an hour |
| 2 | Ran 4+ hours (instead of 1) |
| 2 | Passed to the developer/technical team (a HIGH hand-off) |
| 1 | Only "I'll check and let you know" (a MEDIUM hand-off) |
| 1 | Several employees involved |
| 2 | An SLA escalation opened |
| 1 | Reopened |

Simple is 0–1 points, Moderate 2–3, Complex 4+.

**Human Response SLA.** It has the Team Report's wait shape: a run of customer lines is one wait,
measured from the first. There are two differences:
- only a HUMAN reply ends it — an AI or rule reply is recorded beside the wait ("AI after 1m") and
  does not end it;
- a closing remark starts no wait.

The status is judged against the group's Missed threshold: its escalation policy's
`firstAlertMinutes`, otherwise `missedReplyAfterMinutes`.

| Status | Meaning |
|---|---|
| On time | Answered by a person within the threshold |
| Late | Answered by a person after it |
| Missed | Never answered by a person, and the threshold has passed |
| Pending | Still inside the threshold |

Human SLA = on time ÷ answered. The existing **Response SLA**, where any reply counts, is shown
beside it, unchanged.

**Appreciation.** Two kinds, weighted differently:
- GENERAL_THANKS ("thanks", "ধন্যবাদ") weighs 0.5;
- EMPLOYEE_PRAISE ("onek valo support den", "great support") weighs 1.

Who it is for, strongest evidence first:

| Evidence | Attributed to | Confidence |
|---|---|---|
| Quotes the employee's message, or @mentions one employee | that employee | HIGH |
| Names one employee | that employee | MEDIUM |
| Only one employee replied in that case | that employee | MEDIUM |
| Several employees replied | the case owner | LOW |
| Addressed to everyone ("thanks everyone", "সবাইকে ধন্যবাদ") | nobody | — |

Only HIGH and MEDIUM count toward a person.

**Preference.** A customer prefers an employee only with at least 5 cases together AND at least 2
explicit signals: a request by name, or praise attributed to them. Below that the pair is
"Insufficient sample", never a negative mark.

### 9.3 Support Effectiveness score

Eight dimensions, each scored 0–100 and shown with its formula, raw ratio and sample:

| Dimension | Weight | Formula |
|---|---|---|
| Human response (SLA) | 20 | waits answered on time ÷ waits answered |
| Resolution | 20 | owned cases resolved (High/Medium) ÷ cases owned |
| Ownership | 15 | cases owned ÷ cases taken part in |
| Efficiency | 15 | resolved owned cases per observed hour, relative to the team: 50 = team average, 100 = twice it or more |
| Reliability | 10 | owned cases not reopened ÷ cases owned |
| Customer appreciation | 10 | weighted appreciation per case taken part in, relative to the team (50 = average) |
| Hand-off follow-through | 5 | cases with a stated hand-off that ended resolved ÷ those cases |
| Complex cases | 5 | owned Complex cases ÷ cases owned |

Fairness rules:
- **Shrinkage.** Every rate is pulled toward the team rate by 10 pseudo-observations (5 pseudo-hours
  for efficiency). Three perfect cases land near the average; 200 good ones earn their distance
  from it.
- **No opportunity is not zero.** A dimension with no sample is left out and the weights are
  renormalised.
- **Rates, never totals.** More groups or more messages never raise a score by themselves. When high
  volume comes with low efficiency, a note says so rather than hiding either.
- **Eligibility.** At least 20 human waits answered AND 3 verified active days. A verified day is on
  or after verified-from and touched by no incomplete collection gap. Below that the result is
  **Insufficient sample**, never a low score.
- **Confidence.** HIGH needs 100+ waits and 10+ verified days; otherwise MEDIUM.

**Leaderboards** cover eligible people only, top 3 each:
- Best overall effectiveness
- Most active
- Most efficient
- Best human SLA
- Strongest resolver
- Strongest ownership
- Customer favourite
- High-complexity handler

Each leaderboard says what it is ranked by.

**Executive Support Intelligence** compares each figure with the previous period of equal length:
- as a change in value or in percentage points — never as a percentage of zero ("new (0 → 35)");
- it lists what needs attention;
- it carries the inference caveat.

### 9.4 Data confidence

- Every Support Intelligence page shows the §8 data-health strip and carries the Summary-sheet rows.
- Eligibility counts verified days only.
- Every inferred column is labelled "(inferred)" and carries its confidence.
- Recorded facts are named as facts: SLA escalations, admin resolution, completion keywords.

### 9.5 Known limitations

- The phrase catalogues cover English, Bangla and Banglish as written in this deployment's groups.
  A phrasing outside them reads as no signal. That is conservative: no hand-off and no resolution
  are claimed.
- "update dicchi" counts as a MEDIUM hand-off; it may only be a status note.
- A case that stops after an employee's hand-off with no return closes as "No further contact":
  not resolved, and not charged as missed.
- BUSINESS_PHONE replies count as human replies but carry no person. They earn no ownership, no
  duration and no score.
- A participant known only by a LID with no roster entry is treated as a CUSTOMER.
- Cases and waits are per group (the WhatsApp group id), not per customer.
- The 92-day period cap applies.

### 9.6 Validation status

- **Tests.** Every test was confirmed to fail against the code it protects, and survivors were
  mutation-checked.
  - The pure model has unit tests: `intelligenceTextSignals`, `intelligenceModel`,
    `intelligenceEffectiveness`, `dataHealth`.
  - The reports have a two-project integration test, `supportIntelligence.integration.test.ts`.
- **Browser.** Checked against a constructed fixture set:
  - all five pages and their CSV/Excel exports;
  - the employee detail page;
  - Bizify isolation;
  - the empty state;
  - 390 px width.
- **Real data: NOT YET VALIDATED.** The page itself says so. Before relying on the inferred figures,
  run the read-only script against a few real groups and compare each case with WhatsApp:

  ```bash
  VALIDATION_DATABASE_URL="postgresql://<read-only user>@<host>/<db>" \
  VALIDATE_PROJECT=isp-digital VALIDATE_FROM=2026-10-01 VALIDATE_TO=2026-10-03 \
  VALIDATE_GROUP_NAMES="ABC ISP,Dhaka Fiber" VALIDATE_OUT=si-validation.md \
  pnpm --filter @support-automation/web validate:intelligence
  ```

  How the script stays safe:
  - it opens one connection and sets it READ ONLY;
  - before reading anything, it proves Postgres refuses a no-op UPDATE on that connection;
  - it writes only the local Markdown file;
  - it allows at most 14 days and 10 groups.

  Its first run against the fixtures found four rule faults, all since fixed:
  - a fix that did not hold still earned ownership;
  - a 50/50 split counted as "most replies";
  - a thank-you opened a new wait;
  - "I'll check" weighed as much as a developer hand-off.

