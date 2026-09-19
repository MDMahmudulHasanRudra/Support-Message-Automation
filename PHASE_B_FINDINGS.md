# Phase B — reproducing the 53 audit leads

**Baseline: `c308545`, working tree clean, isolated DB on :5433 at 72 migrations.**
No fix, no code change, no schema change is made during reproduction. A lead is not a fact until it
has been reproduced against the real code or the real database.

**Progress: 20 of 53 classified.**

| Class | Count |
|---|---|
| CONFIRMED | 14 |
| FALSE_POSITIVE | 2 |
| DUPLICATE | 3 |
| ALREADY_FIXED | 1 |
| *remaining* | *33* |

---

## CONFIRMED

### `supportactivity-missing-groupid-index`
**Reproduction:** `getGroupSupportHistory` queries `where: { groupId, occurredAt: { gte, lt } }` —
**no `accountId`**. Every useful index on `SupportActivity` leads with `accountId`; the only
non-`accountId` ones are `[occurredAt]` and `[actor, occurredAt]`.
**Expected:** an index probe on the group. **Observed:** Postgres can only range-scan `[occurredAt]`
across the whole window and filter `groupId` after, or sequential-scan.
**Impact:** grows with the date range, not with the group's own volume.
**Contract:** none.

### `supportsession-no-startedat-index`
**Reproduction:** `getGroupSessionHistory` queries `where: { startedAt: { gte, lt }, groupId? }` —
**no `status`**. Indexes present: `[accountId, groupId, status]`, `[status, startedAt]`,
`[completedByTeamMemberId, completedAt]`.
**Correction to the lead:** `startedAt` *is* indexed — as the trailing column of `[status,
startedAt]`. It is unusable here because `status` is not in the predicate, which is a different
defect from "no index exists" and points at a different fix.
**Contract:** none.

### `supportrule-join-tables-missing-reverse-index`
**Reproduction:** `SupportRuleKeyword`/`SupportRuleGroup`/`SupportRuleTeamMember` carry **zero
`@@index`**; each has only `@@id([ruleId, x])`, which indexes the leading column. `detector.ts:68-69`
does the reverse lookup — `groups: { some: { groupId } }` and `teamMembers: { some: { teamMemberId } }`.
**Severity correction: `low` → `medium`.** This is the hot path — it runs for every team-member
message, not on a report somebody opens occasionally.
**Conditional:** a deployment using `appliesToAllGroups: true` has no join rows at all, so the cost
only appears once rules are scoped. Worth stating in the fix rather than assuming it always bites.
**Contract:** none.

### `shift-colourslot-dead-setting`
**Reproduction:** `ShiftTemplate.colourSlot` is written (`teamManagement.ts:111`, clamped 1–6) and
edited (`ShiftTemplateManager.tsx`). Grep for any render of it as a colour: **nothing**. It reaches
only `shifts/page.tsx` and its own editor; the Roster and calendar never receive it.
**Its own schema comment states the promise it does not keep** — *"so a shift is recognisable at a
glance on the calendar without reading its name."*
**This is the `countingMode` shape exactly:** saved, validated, offered in the form, read by nothing.
**Contract:** none.

### `leave-allowance-never-checked`
**Reproduction:** `LeaveType.annualAllowanceDays` appears only in `LeaveTypesAndHolidays.tsx` — the
form that edits it and prints it back. No reader in the leave request or approval path.
**Observed:** 100 days can be approved against a 10-day allowance with no warning.
**Contract:** none.

### `help-text-cites-deleted-counting-mode`
**Reproduction:** three pages describe a setting that was deleted —
`support-activity/page.tsx:106` ("which Counting Mode is configured in Settings"),
`reports/page.tsx:75` ("reflects the UNIQUE_GROUP counting mode"),
`settings/page.tsx:24` ("the global counting mode").
`SupportActivitySettingsForm.tsx:32` even carries the comment explaining its removal.
**Worst of the three is `reports/page.tsx:75`**, which asserts a specific mode is in effect.
**Contract:** none.

### `team-export-exports-wrong-dataset`
**Reproduction:** `team/page.tsx:106` builds `exportParams = \`from=…&to=…\`` with **no `type`**.
The route (`export/route.ts:41`) reads
`rawType === "team" ? "team" : rawType === "sessions" ? "sessions" : "activities"`.
**Expected:** the eight rows on screen. **Observed:** the raw activity log.
**Note that narrows the fix:** the route *already implements* `type=team`, including the
"Team Performance" sheet name (lines 55, 83). One missing query parameter, not a missing feature.
**Contract:** none.

### `no-pagination-on-unbounded-lists`
**Reproduction:** `components/ui/Pagination.tsx` exists and is used by four pages (ai-learning ×3,
conversation-learning ×1). **Support Activity uses it nowhere.**
**Contract:** none.

### `group-picker-not-used-for-1848-groups`
**Reproduction:** `reports/page.tsx:36` — `whatsAppGroup.findMany({ where: { isActive: true },
orderBy: { name: "asc" } })` with **no `take`**, rendered at line 94 via `groups.map`.
**Observed:** every active group becomes an `<option>`, with no search. `GroupPicker` exists for
exactly this.
**Contract:** none.

### Previously reproduced in this session

| Finding | Evidence |
|---|---|
| `no-backfill-path-for-either-module` | No job, no `WorkerCommand`, no admin surface. Documented in `REBUILD_CONTRACT.md` — **this one does bear on the contract; it is the contract** |
| `coverage-unavailable-column-always-zero` | Approving leave sets `status: "LEAVE"`; `getCoverageForDate` filters `status in (DUTY, COVERAGE, EXTRA_DUTY)`, so those rows are excluded before the subtraction. **Narrower than the lead claimed** — the `gap` is still correct via undercounting `assigned`; it is the "On leave" column and the explanation that are wrong |
| `any-message-rule-leaks-sessions-forever` | `updateSupportSessionForActivity` calls `openSessionIfNeeded` with no trigger check; nothing can close an `ANY_MESSAGE` session |
| `awaiting-reply-count-capped-at-100` | `LIMIT 100` at `supportActivityReports.ts:690`, reported as the headline total |
| `duty-history-500-cap-poisons-summary-and-export` | `take: 500` at line 483; the export calls the same `getDutyHistory` deliberately, so the cap propagates. **Contract-relevant** — recorded in `REBUILD_CONTRACT.md`, since the export is how a rebuild would be verified |

---

## FALSE_POSITIVE

### `any-message-trigger-label-missing`
`SupportRuleForm.tsx:70` — `<option value="ANY_MESSAGE">Any Message</option>`, with conditional help
text at line 61. The label exists.

### `team-management-imports-support-activity-module`
The only matches in `teamManagementReports.ts` are **comments** referencing the other module for
contrast ("deliberately does NOT duplicate /support-activity/team"). No import exists.

---

## DUPLICATE

| Lead | Duplicate of | Why |
|---|---|---|
| `support-activity-help-cites-deleted-setting` | `help-text-cites-deleted-counting-mode` | Same stale `countingMode` references |
| `whatsappgroup-full-list-in-select` | `group-picker-not-used-for-1848-groups` | Same unbounded `findMany` + `<select>`, filed once as performance and once as UX |
| `duty-history-export-silently-truncated` | `duty-history-500-cap-poisons-summary-and-export` | Same `take: 500`, shared by page and export |

---

## ALREADY_FIXED

### `account-delete-desyncs-attendance-evidence`
Fixed in `83e2746`. `TeamAttendanceGroup` cascades with the account while `TeamAttendanceDay`
survives; affected day ids are now collected before the delete and recomputed after, via
`reconcileAttendanceAfterAccountRemoval`. Covered by `accountDeletionSafety.integration.test.ts`.

---

## Not yet reproduced — 33 remaining

Behavioural, needing the isolated DB: `cross-midnight-shift-punctuality-garbage` ·
`holiday-is-a-noop-after-rostering` · `attendance-double-counts-shared-groups-across-accounts` ·
`absent-excused-counted-nowhere` · `worked-override-erases-holiday-and-leave-conflict` ·
`days-scheduled-counts-off-and-leave-days` · `coverage-ignores-absent-override` ·
`duty-history-empty-without-materialised-roster` · `business-phone-replies-earn-no-attendance-credit` ·
`attendance-lost-outside-catchup-window` · `unsynced-group-drops-both-modules-permanently` ·
`delete-team-member-destroys-team-management-history` · `avg-resolution-time-tile-structurally-empty`

Query-cost, needing EXPLAIN against seeded volume: `sa-landing-count-distinct-full-scan` ·
`first-response-stats-unbounded-window-scan` · `attendance-recompute-scans-lifetime-messages` ·
`unique-group-count-transfers-rows-to-count-them` · `avg-resolution-wrong-index-column` ·
`dutyassignmentchange-no-dutydate-index` · `shifts-page-unbounded-groupby` ·
`duty-history-relation-orderby-and-cap` · `export-route-unbounded-range` ·
`materialise-roster-transaction-per-member`

Per-request query counts: `schedule-page-triple-duplicate-queries` · `roster-refetch-per-message` ·
`team-page-settings-read-five-times` · `settings-upsert-on-read-path`

UI: `no-filterable-activity-list` · `stale-session-alert-links-to-page-that-hides-them` ·
`landing-export-range-differs-from-table` · `date-range-silently-falls-back-to-today` ·
`date-inputs-have-no-accessible-name` · `no-groupid-leading-index`
