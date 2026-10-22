# 08 - Testing and validation (as built)

Describes the tests that exist for release 1 and what each one proves. It is derived from the WP1-WP8
commits (`git log -p 9f0c405..HEAD`), not from the plan. Specs: 04 (identity), 05 (scopes), 06 (algorithms).

## How to run

| Suite | Command | Needs a database |
|---|---|---|
| shared (pure) | `pnpm --filter @support-automation/shared test` | no |
| engine | `pnpm --filter @support-automation/engine test` | no |
| web integration + unit | `pnpm --filter @support-automation/web test:isolated` | the throwaway Postgres on `localhost:5433` |
| worker | `pnpm --filter @support-automation/worker test:isolated` | the same throwaway Postgres |

Never run the web integration files or the worker suite against the live database. The shared package
must be rebuilt (`pnpm --filter @support-automation/shared build`) before web tests see a new export.

## The rule that governs every test below

A new test is kept only after it has been shown to FAIL against the code it protects (CLAUDE.md). Each WP
commit body records what was broken and how many cases went red. Two cases show why it matters here:

- The first WP2 parity fixture did not depend on the context window at all, so setting `CONTEXT_MS = 0` left it
  green. A third group (a wait opened by a message before the period) was added, and only then did the
  snapshot guard that constant.
- In the WP8 preview, removing the project predicate from the FIRST query (the hit search) leaves "never returns
  another project's messages" green, because the second query (the copy read) also names the project and
  returns nothing for the other project's hits. Only the cap test, which counts hits, went red. The test that
  names the other project's rows fails only when both predicates are removed, and was confirmed that way.

## Inventory

### Guard: legacy parity (WP2)
`teamReportParity.integration.test.ts` seeds a two-account, three-group, one-personal-chat fixture (copies on
both numbers, an AI reply, a linked-login dashboard reply, a CONFLICT sender, a recall, a miss, a wait opened
in the context window) and compares `loadTeamReport`, the three table builders, the CSV and the XLSX with a
committed JSON snapshot (`fixtures/teamReportParity.snapshot.json`). With the feature off, every byte must
match. The snapshot was regenerated exactly once (the follow-up that added the third group; the diff was
additive) and is never regenerated to make a later change pass. The bug fixes B1-B4 left it untouched.

### Pure functions (packages/shared)
| File | What it pins |
|---|---|
| `reportScope.test.ts`, `versions.test.ts` | scope parsing and fallback; the pinned calculation versions |
| `whatsappIdentity.test.ts` | the moved classifier equals a frozen copy of its old body over thousands of rows |
| `attributionOutcome.test.ts` | the outcome mapping is exhaustive and credits only the verified outcomes |
| `runMetadata.test.ts` | no line is a percentage; output is deterministic |
| `personalReport.test.ts` | the personal counting rules; `computeTeamReport` is called unchanged |
| `combinedReport.test.ts` | additive lines add; medians are recomputed over the union; overtime is group only |
| `replyAttribution.test.ts` | Tier 1 / Tier 2 rules, every unresolved reason, no Tier 3 |
| `identityPreview.test.ts` | the preview's classification, ordering, caps and KPI scope |

### Integration (apps/web, isolated database, two projects)
| File | What it pins |
|---|---|
| `unifiedReportingDataQuality.integration.test.ts` | late-arriving, history-loaded, SYSTEM, revoked counts; other projects never counted |
| `personalReport.integration.test.ts` | only `@c.us`/`@lid` with no group; project isolation; the permission gate on the page and both exports; no text in any export |
| `customerSpecificReplies.integration.test.ts` | quote and mention evidence joins; LID never shown as a phone number; the Excel sheet only with the flag on |
| `phase2ReportBenchmark.integration.test.ts` | a 31-day group report and a personal report under their time budgets |
| `identityPreview.integration.test.ts` | the preview finds every copy, never reads another project, truncates at its cap, refuses without the key or with the flag off, hides personal without `messages.view`, writes nothing; a save carries and logs its digest, and a save without one logs exactly as before |
| `reportAccountFilterIdentity.integration.test.ts` | bug B2 |
| `teamMemberDeleteAndGroupMerge.integration.test.ts` | bugs B3 and B4 |

### Integration (apps/worker)
`identityReattribution.integration.test.ts` covers bug B1 beside the existing re-attribution cases.

## What the tests do not prove

- They run on constructed conversations. Until somebody compares a real group's report with the WhatsApp
  app, customer-specific reply attribution and the personal waits are verified against the rules, not
  against reality. Support Intelligence carries the same caveat (REPORTS.md 9.6) and it stays.
- No test can say how much real traffic arrives late or out of order; the Run information panel counts it.
- The preview's KPI estimate is a re-run of the report, so it is only as right as the report.

## Manual validation checklist (before enabling for a second project)

1. Flag off: open the Team Report, download the CSV and the Excel file; they are the files the release
   before this one produced.
2. Flag on, `scope=group`: every figure equals the flag-off figure; the Run information panel and Collection
   detail lines appear and contain counts only.
3. `scope=personal` as a viewer with `messages.view`: conversations listed per account; a colleague's chat
   with the business number and a chat between our own numbers are named as excluded, never counted.
4. The same viewer without `messages.view` gets the group report and a one-line note.
5. Team Members: type a LID into a member, press Preview impact, read the counts, press Save, then open System
   Logs: the entry carries the digest and the three counts. Repeat without previewing: the entry has no
   `preview` key.
6. Press Preview impact on a number with no stored message: it says nothing would change, and nothing was
   written (the Team Members "history synced" badge does not appear for a preview).
