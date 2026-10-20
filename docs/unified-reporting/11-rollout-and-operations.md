# 11 - Rollout and operations (as built)

## What this release changes

| Area | Change |
|---|---|
| Database | **No migration.** No table, column, index or trigger. |
| Worker | One reattribution fix (B1, below). No change to message ingestion, the pipeline, any queue or any loop. |
| Web | New server loaders and Team Report sections behind `UNIFIED_REPORTING`; the identity preview; three report fixes (B2-B4). |
| Permissions | No new key. |
| Dependencies | None added. |

The feature is a project feature: off in every project until a Main Admin switches it on (Main Admin Portal,
the project's feature list: "Unified messaging reports"). It owns no page and no route, so it never blocks one.

## Deploy checklist

`DEPLOY.md` is the authority; the points specific to this release:

1. **Migrations first, as always** (`docker compose run --rm migrate` before `docker compose up -d --no-deps
   app worker`). This release adds none, but the branch it sits on contains the 19 Oct migrations
   (`20261019110000_report_accuracy_history`, `20261019120000_member_default_shift_changed_at`). If the
   target database does not have them, a report fails with a `P2022` "column does not exist" error; that is an
   undeployed migration, not a new bug (CLAUDE.md).
2. **Build and restart `app` and `worker`.** The worker needs the restart only for B1 (Duty History after an
   identity change). Nothing connected to WhatsApp is touched: the account sessions, the registry and the
   queues are not changed.
3. **Leave the flag off.** Open the Team Report and download the CSV and Excel: they must be what the
   previous release produced. `teamReportParity.integration.test.ts` asserts this against a committed snapshot.
4. **Enable `UNIFIED_REPORTING` for ONE project** and walk the manual checklist in 08.
5. Enable it elsewhere when that project has been reviewed.

## Rollback

- **Feature rollback:** switch `UNIFIED_REPORTING` off for the project. Every unified surface disappears and the
  Team Report, its exports and Team Members behave exactly as before. Nothing is stored for the feature, so
  nothing needs cleaning up. The System Log entries that carry a `preview` object stay (they are history).
- **Code rollback of the four fixes:** they are independent commits. Each changes one query or one function and
  stores nothing new.
- **There is no database rollback** because there is no database change.

## What to watch after enabling

- **Team Report load time** with `scope=personal` on the biggest project. The benchmark says seconds at 2,000
  chats (09); a month that takes much longer is the signal for the partial index in 09.
- **The Run information panel** is the operator's view of data quality: late-arriving and history-loaded counts,
  excluded rows, pending re-attributions. A large "stored later than they were sent" count for a period means
  the number was offline or recovering then; the report says so, it does not guess.
- **System Logs, scope `team-members`:** an identity change logs before/after identifiers, and (only when the
  person previewed first) the preview digest and counts. "Why did last month's figures move?" starts there.
- **Pending re-attributions** (shown on Team Members as "Syncing history..."): reports follow the new roster the
  moment a save commits; stored stamps, Activity Feed and Duty History follow within minutes.

## Operating notes

- The preview is read-only and safe to press repeatedly. It reads at most 20,000 messages per press.
- A deactivated team member's Duty History is now recomputed by a re-attribution (B1), so correcting an
  identifier that used to belong to a former colleague moves the days to the right person.
- Deleting a team member who was never active now records the groups they leave unassigned; a member whose only
  work was dashboard replies is deactivated instead of deleted (B3).

## Release note draft (enter in Release Notes as DRAFT; do not publish before the deploy)

A release note is a database row (Release Notes module), so this file holds the text and nothing was written to
any database. Type: Feature. Affected modules: Team Report, Team Members, WhatsApp Chat, Support Intelligence,
Team Management. Version: chosen by whoever publishes.

- **Title:** Unified messaging reports
- **Summary:** The Team Report can now cover personal chats, shows how its data was collected, links replies to
  the customer they answered, and previews what a team-member identity change would do before you save it.
  Switched on per project by a Main Admin; off, nothing changes.
- **What's new:**
  - Personal and combined scopes on the Team Report (needs View Messages).
  - Run information: calculation versions, data cutoff and collection counts beside every report.
  - Customer-specific replies: which customer a reply answered, from quotes, mentions and sequence only.
  - Preview impact on Team Members and WhatsApp Chat: counts of what would be attributed differently, read-only.
- **Bug fixes:**
  - Support Intelligence and Calls now agree with the Team Report about who sent a message when one WhatsApp
    account is chosen.
  - Deleting a team member records the groups they leave unassigned, so earlier Missed waits stay charged to
    them; a member whose only work was dashboard replies is deactivated instead of deleted.
  - Correcting an identifier that belonged to a deactivated member now moves their Duty History days too.
  - A group's assignee no longer depends on the order the database returns its copies in.
- **Known issues:** the customer-specific reply links and personal waits are validated on constructed
  conversations only; the preview's figures are an estimate for the latest month.
- **Technical notes:** no migration; rollback is switching the feature off; see docs/unified-reporting/11.
