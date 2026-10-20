# 12 - Deferred work, known limits and the audit's bugs (as built)

## Audit bugs (01 section 4)

| Bug | Status | Where it was fixed |
|---|---|---|
| B1 A deactivated member's Duty History is never corrected by re-attribution | **Fixed** | `apps/worker/src/teamManagement/attendance.ts`: `recomputeAttendanceDay` now recomputes a deactivated member too (roster = ACTIVE members plus that one; for an active member the roster is exactly what it was). |
| B2 Intelligence and Calls drop the other accounts' witnesses when an account is chosen | **Fixed** | `intelligence/loader.ts` and `reports/activityReports.ts`: the copies window sees every account, an outer `onAccount` test narrows, the chosen account's own copy is kept first (the Team Report's own shape). With no account chosen the SQL returns the same rows. |
| B3 A hard delete erases group assignment history with no record | **Fixed** | `deleteTeamMember`: the delete and one `GroupResponsibilityChange` per WhatsApp group whose merged assignee changes run in one transaction. A member whose only work is dashboard replies through a linked login is deactivated, not deleted. |
| B4 Group assignee merge is order-dependent in the Team Report | **Fixed** | `loadTeamReport` reads the group rows ordered Primary first, then lowest id, the order `mergedGroupResponsibility` records history in. |
| B5 Missed-support message text uses the stored stamp | **Not fixed** | The audit does not mark it trivial and safe (display only, but the right replacement (read-time identity for which of two same-millisecond lines to print) touches `responseReports.ts` ordering). Left for its own change. |
| B6 Attendance credits across a cross-copy CONFLICT | **Not fixed** | It would change Duty History counts (a number people read), so it is not trivial; the proper fix is to run `attributeAcrossCopies` inside the attendance SQL path. That is a behaviour change and needs an owner decision. |

Each fix has a test that was shown to fail against the pre-fix code: `identityReattribution.integration.test.ts`
(worker), `reportAccountFilterIdentity.integration.test.ts`, `teamMemberDeleteAndGroupMerge.integration.test.ts`.

## Deferred from release 1 (with reasons)

| Item | Why deferred |
|---|---|
| Tier 3 "probable" reply links | An inference that can be wrong. `TIER3_PROBABLE` is reserved and never produced. Measure how many replies stay unresolved first. |
| AI enrichment | Interfaces only (`enrichment.ts`, types). Any implementation must use `packages/ai-client` (text only, no tools), and its suggestions can never count as verified. |
| Personal support time and overtime | Would change what Support Overtime means (TEAM_OVERTIME.md); needs an owner decision. Overtime is group only in the combined view. |
| A `Message` index for personal reads | The benchmark does not need it (09). Write-blocking build on the largest table; only on a measured breach. |
| Rollups, incremental aggregates, partitioning | They conflict with read-time identity and "as at the event" responsibility. |
| A persisted run log (`ReportRun`) and a preview column on `IdentityReattribution` | No audit requirement yet; System Log plus the export's Run information sheet cover release 1. |
| Previewing a login-link change | Affects only dashboard replies; needs an `OutboundMessage.createdById` hit set. Low volume. |
| Dated identity history ("roster as of a date") | Needs an identity evidence table, rejected in 03. |
| Personal scope on `/reports/<id>` | Each report's definitions are group specific; extend one at a time after the Team Report proves out. |

## Known limits of what was built

- **Reply attribution covers groups only.** A personal chat has one customer, so there is nothing to attribute.
- **A reply with no quote, no mention and no single open ask is unresolved**, and unresolved closes nothing: the
  group wait it belongs to is unchanged. The section says how many replies stayed unresolved and why.
- **Customers are ids, not people.** A LID and a phone number are one customer only when one stored message
  carried both; ids are compared exactly, never digit-normalised, and a LID is never turned into a number.
- **The preview's KPI estimate is for the most recent impacted month and the 200 most-changed groups.** It is
  labelled as an estimate. A longer history is shown as counts by month, not as figures.
- **The preview does not check who already holds a number or WhatsApp id.** Field validation is the save
  action's own (`readIdentityFields`), but the duplicate-holder checks stay on Save, which still refuses.
- **The preview is advisory.** It never blocks Save, and the digest a save records is what the browser carried.
  A preview older than ten minutes shows a notice; a form edited after the preview drops the digest, so a save
  never records a preview of values it did not save.
- **Older limits remain** (01 section 4, L1-L8): re-attribution is unbatched over all history, status toggles
  queue no re-attribution, `reportingVerifiedFrom` ships empty (nothing is "verified"), and history before the
  19 Oct tables uses today's responsibility values.
