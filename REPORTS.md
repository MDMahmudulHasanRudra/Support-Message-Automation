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

