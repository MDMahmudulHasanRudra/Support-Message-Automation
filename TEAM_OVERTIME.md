# Support Overtime

What the Team Report's **Support Overtime** means, how it is calculated, and what it deliberately
does not show. Written 12 Oct 2026. Code: `packages/shared/src/overtime.ts` (the rule),
`packages/shared/src/teamReport.ts` (where every figure is produced), `apps/web/src/server/overtimeDuty.ts`
(reading the schedule).

## 1. What was wrong

From 5 Oct 2026, "Support Overtime" was a label on the Team Report's **support time**
(`activeSeconds`): every stretch of a person's WhatsApp work, first to last message, all day. Nothing
was subtracted. A support executive who answered customers from 10:00 to 19:00 on a 10:00–19:00
shift showed 9 hours of "overtime". The label was put on knowing this; the real calculation was left
for later. This is that calculation.

## 2. The rule

For each team member, for each Asia/Dhaka day:

```
daily overtime  = max(0, support time that day − regular duty that day)
period overtime = sum of the daily overtime
```

- **Per day, never over the whole period.** A 10-hour Monday and a 6-hour Tuesday on 8-hour days are
  2 hours of overtime, not zero.
- **Only overtime is shown.** Regular duty is used inside the calculation and is never displayed or
  exported by the Team Report: not as a column, a tooltip, a breakdown or a file column.

## 3. Support time: what counts as work

This is the Team Report's existing support time, unchanged:

- A member's messages across **all** groups form one timeline. Answering two groups at once is one
  hour, not two.
- A new stretch starts after more than the idle gap without a message (Support Activity Setup →
  "Offline after", 120 minutes by default) and at Dhaka midnight.
- A stretch counts first to last message. A lone message is zero. **Silence longer than the idle gap
  is never counted**, so a message at 10:00 and one at 22:00 are two moments, not twelve hours of
  work.
- One WhatsApp message stored by two of our numbers counts once (`WHATSAPP_IDENTITY.md` §5).
- **WhatsApp activity is evidence of work, not attendance.** Time on the phone, in a meeting or in a
  group this system does not store is not counted. Overtime can therefore read low, but never
  inflated by guessing.

**Overnight shifts.** The part of a stretch inside a shift window counts for the day that shift
STARTED, so 01:00 inside a 22:00–06:00 shift is the evening's work. Everything else counts on its own
calendar day. This is the same cut the Duty & Workload report makes.

## 4. Regular duty: where it comes from

`resolveRegularDuty`, in priority order:

1. **The roster entry for that date** (`DutyAssignment`). It keeps its own snapshot of the shift
   times, so history stays as it was:
   - **On duty** or **Coverage** with shift times: the length of that shift.
   - **Off**, **Leave**, **Holiday**, **Extra duty**: no regular duty. All support time that day is
     overtime.
   - **On duty without times**: a working day; the length comes from steps 3–5.
   - **Unassigned**: nobody decided; treated as no entry.
2. **An organisation holiday** (Team → Holidays) with no roster decision: no regular duty.
3. **The weekly pattern** for that weekday. An entry with no shift means "decided: off", so no
   regular duty.
4. **The member's default shift.**
5. **The project's default duty length**: Settings → Support Activity Setup → "Default duty length
   for overtime (hours)". It defaults to **8 hours**, is stored in minutes, and is clamped to 1–16
   hours.

**A shift's length is its configured start-to-end time.** End at or before start means it runs past
midnight. Nothing is inferred from a shift's name. This app records no breaks, so none is deducted.

**History is never rewritten by today's settings.** The weekly pattern and the default shift have no
history of their own. Each is used for a date only if it provably applied then: the entry, its shift
template and (for the default shift) the member record must all be unchanged since before that day
ended. Otherwise the day falls to the default duty length rather than getting today's schedule.
The roster is dated, so it always applies to its own date.

### Decisions to confirm

- **Extra duty is all overtime.** The status means "working beyond their normal schedule at the
  manager's request", so it carries no regular duty to subtract. If extra duty should instead count
  as a normal working day, change `NO_DUTY_STATUSES` in `overtime.ts`.
- **Off-day and holiday work is all overtime.** No separate policy existed to override this.

## 5. Where it is shown

| Where | Figure |
|---|---|
| Team Report tile, Team members table, By day table, chart | overtime |
| Team Report exports: Summary, Team Members, Daily/Weekly/Monthly | "Support Overtime (hours)" |
| Team Report Excel, sheet "Overtime by day" | one row per person per day: overtime, plus the schedule source by name (Roster / Weekly pattern / Default shift / Day off… / No schedule) — never a length |
| Executive Support Health tile, "Workload by team" | overtime |
| Team Report Groups table, group page | **support time** in that group. Overtime belongs to a person's day, not a group |
| Team Workload, Workload Distribution, Employee Support Breakdown, Employee Effectiveness hint | **support time** (relabelled from "Support Overtime"; these analyse time worked) |
| Duty & Workload report | unchanged: its purpose is scheduled time against recorded time |

- **Chart.** A period with no recorded team work is drawn hatched ("no data"), never as a measured
  zero. Hovering shows the exact duration.
- **Data-quality note.** When any member-day used the default duty length, the Team Report says how
  many and where to fix it. It never states the length.
- **Team → Today.** The "Not scheduled" tile links to the Roster and explains the effect on overtime.

## 6. Tests

- `packages/shared/src/__tests__/overtime.test.ts` covers:
  - the duty/worked/overtime table (8h/6h → 0 … 9h/12h → 3h);
  - per-day aggregation;
  - day off;
  - overnight shifts;
  - every source in priority order;
  - the fallback clamp;
  - parallel groups not double-counted;
  - duplicate events;
  - sparse messages not becoming hours;
  - per-member duty;
  - a historical roster;
  - scope;
  - "no work" reported as no row rather than a confirmed zero.
- `apps/web/src/__tests__/teamOvertime.integration.test.ts` runs against real rows:
  - roster 3h, day off 2h, no schedule 2h;
  - a weekly pattern created after the date is not applied;
  - table, by-day table and buckets agree;
  - no duty-named column;
  - the configured default followed.

## 7. Limits

- **Activity-based.** Work not visible in stored WhatsApp messages is not counted (§3).
- **No break policy.** No break field exists, so a shift's whole length is regular duty.
- **History.** Dates before a weekly pattern or default shift was last changed use the default duty
  length unless the roster covers them. Fill or materialise the roster for exact historical figures.
- **A Team-scoped report on the day someone changed Team.** That day's in-scope support time is
  measured against the whole day's duty.
- **The period's first morning.** After-midnight work inside a shift that began the evening before
  the period belongs to that earlier day, so it is outside the period.
