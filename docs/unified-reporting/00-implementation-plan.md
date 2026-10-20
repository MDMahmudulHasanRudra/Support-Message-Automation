# 00 — Implementation plan (Unified Messaging Reporting, release 1)

For the implementers (phase 2). Specs: 03 (data), 04 (identity), 05 (scopes), 06 (algorithms),
07 (API/UI). Follow the specs exactly; where a spec and the code disagree, stop and ask — do not
improvise a second rule.

## Ground rules (every WP)

- Branch `rudra`. One WP = one commit (or a small series), each green on its own.
- No migration in release 1. No worker change. No new permission key. No new dependency.
- Shared pure code → `packages/shared/src/unifiedReporting/` + unit tests in
  `packages/shared/src/__tests__/` (`pnpm --filter @support-automation/shared test`).
- Web integration tests → `apps/web/src/__tests__/*.integration.test.ts`, run ONLY via
  `docker compose -f docker-compose.test.yml up -d --wait` +
  `pnpm --filter @support-automation/web test:isolated` (never against the live DB).
- Every new test must be shown to FAIL against a deliberately broken implementation before it is
  kept (CLAUDE.md). Record the "how I broke it" in the PR/commit body.
- Fixtures: synthetic ids only (`8801000000001`, `100000000001@lid`, `120000000000000001@g.us`), no
  real numbers, no real message text; digits-only for team-member phone numbers.
- Raw SQL names `"projectId"` (`rawSqlProjectFilter.test.ts` must stay green); web code imports
  `prisma` from `@/server/db` only.
- `pnpm typecheck` and `pnpm lint` green; `pnpm --filter @support-automation/shared test` green.

## Release-1 work packages

### WP1 — Feature flag + scope parsing (no behaviour change)
- Modify `packages/shared/src/projectFeatures.ts`: add `UNIFIED_REPORTING` (05 §6, exact object).
- Create `packages/shared/src/unifiedReporting/{index.ts,reportScope.ts,versions.ts,readModel.ts}`
  (07 §1.1, 06 §5.1, 03 §1). Export from `packages/shared/src/index.ts`.
- Create `apps/web/src/server/unifiedReporting.ts` with `isUnifiedReportingEnabled()` and
  `resolvePageScope()` only (07 §2.3).
- Modify `apps/web/src/server/teamReport.ts`: `TeamReportFilters.scope?: ReportScope`;
  `parseTeamReportFilters` reads `params.scope` via `parseReportScope`; `teamReportQuery` writes
  `scope` only when ≠ `group`.
- Tests:
  - `reportScope.test.ts`: `absent/unknown → group`, `flag off → group with no note`,
    `personal without messages.view → group with note`, `combined allowed with both`.
  - `versions.test.ts`: `group version is pinned` (literal `"group-2026.10.19"`).
  - extend `apps/web/src/__tests__/teamReportAudit.integration.test.ts` or new
    `teamReportScopeUrl.test.ts`: `teamReportQuery omits scope=group` (old URLs byte-identical).
  - the Main Admin feature list test (whatever enumerates `PROJECT_FEATURES`) still passes.
- Acceptance: flag visible in the Main Admin Portal, off by default; Team Report unchanged.

### WP2 — Legacy parity harness (guards everything after it)
- Create `apps/web/src/__tests__/teamReportParity.integration.test.ts`: seed a two-account,
  two-group, one-personal-chat fixture (copies across accounts, an AI reply, a linked-login manual
  reply, a CONFLICT sender, a recall, a miss, a context-window wait). Snapshot (JSON) of
  `loadTeamReport(...)` result + summary, `buildMembersTable/buildBucketsTable/buildGroupsTable`,
  and the CSV and XLSX bytes (sheet names + cell values) from the export route handler — captured at
  HEAD before any later WP. Snapshot stored as a committed JSON fixture.
- Cases: `flag off: loadTeamReport output identical to baseline`,
  `flag off: CSV identical`, `flag off: XLSX sheets and cells identical`,
  `personal messages never change group figures` (add 50 personal messages → group result unchanged).
- Acceptance: green at HEAD; it is re-run after every later WP.

### WP3 — Run metadata + data-quality indicators (group scope)
- Create `packages/shared/src/unifiedReporting/runMetadata.ts` (06 §5.2–5.3, 04 §2
  `IDENTITY_MODE_STATEMENT`) and `attributionOutcome.ts` (04 §1).
- `apps/web/src/server/unifiedReporting.ts`: add `loadDataQualityCounts`, `loadPendingReattributions`.
- Page: `team-report/page.tsx` — when `enabled`, load data-quality counts + pending re-attributions
  in the existing `Promise.all`, build metadata, render new `team-report/RunInformation.tsx`; pass
  extra "Collection detail" lines into `ReliabilitySection` (new optional prop `extraLines`).
- Export route: "Run information" sheet + "Collection detail" lines in "Data quality" (flag on only).
- Tests:
  - `runMetadata.test.ts`: `calculationVersions by scope`, `dataCutoff = storedBy when asof given`,
    `no line value is a percentage`, `deterministic`.
  - `attributionOutcome.test.ts` (04 §6).
  - `unifiedReportingDataQuality.integration.test.ts`: `late-arriving counts createdAt > ts+15m only`,
    `history-loaded counted separately, not as late`, `SYSTEM rows counted as excluded`,
    `revoked counted and still in logical messages`, `other project's rows never counted`.
- Acceptance: flag on shows the panel and lines; WP2 parity still green with flag off.

### WP4 — Personal scope: pure compute
- Create `packages/shared/src/unifiedReporting/personalReport.ts` (07 §1.3) and
  `combinedReport.ts` (07 §1.4).
- Tests `personalReport.test.ts`:
  - `a run of customer lines is one wait` · `any reply closes the observed wait`
  - `AI reply closes observed wait but not the human wait` · `closing remark opens no human wait`
  - `only OPERATOR with memberId counts as verified employee reply`
  - `unlinked operator is a verified human but not employee-credited`
  - `own-number and internal conversations are excluded and counted`
  - `same customer on two accounts is two conversations`
  - `context messages are never counted; look-ahead replies close period waits`
  - `missed uses missedReplyAfterMinutes; nobody is charged`
  - `waitingConversations = latest message is customer at measuredTo`
  - `member scope narrows employee replies and conversations`
  - `computeTeamReport is called unchanged` (spy/compare waits to a direct computeTeamReport call)
- Tests `combinedReport.test.ts`: `additive lines add`, `medians are recomputed over the union, not averaged`,
  `distinct customers not offered`, `overtime is GROUP_ONLY`.
- Acceptance: shared tests green; no web change yet.

### WP5 — Shared moves (pure refactors, parity-guarded)
- Move `createReportClassifier` body to `packages/shared/src/whatsappIdentity.ts` (re-export from
  `messageIdentity.ts`; add optional `parsedCopies` to the row type) — 04 §4.1.
- Move `bodyOf` → `prefilteredBodySql(alias)` in `messageIdentity.ts`; export `PERSONAL_CHAT_SQL`
  from `chatInbox.ts`; extract `resolveTeamScope(...)` in `teamReport.ts` (07 §2.2).
- Tests: existing `whatsappIdentity.test.ts`, `reportAccuracy*.integration`, WP2 parity — all green
  unchanged; add `whatsappIdentity.test.ts > createReportClassifier moved without change`.
- Acceptance: zero output difference (WP2).

### WP6 — Personal scope: loader, page, export
- Create `apps/web/src/server/personalReport.ts` (`loadPersonalReport`, 07 §2.2).
- Modify `teamReportTables.ts` (personal builders, 07 §2.5), `team-report/page.tsx` (scope
  branches, 07 §3), `TeamReportFilters.tsx` + new `ScopeSelector.tsx`,
  `CombinedSummaryTable.tsx`, `api/team-report/export/route.ts` and `table-export/route.ts`
  (07 §4), Help sections.
- Tests `personalReport.integration.test.ts` (isolated DB, two projects):
  - `reads only @c.us/@lid with groupId NULL` (status@broadcast, @newsletter, orphan @g.us excluded)
  - `matches PERSONAL_CHAT_SQL and isPersonalChatId on the same fixture`
  - `linked-login manual reply is a verified employee reply; unlinked is not`
  - `AI reply in a personal chat is automated (outboundByKeyJoin on chatId)`
  - `Bizify's personal chats never appear in ISP Digital` (add to `projectReports.integration.test.ts` style)
  - `scope=personal without messages.view renders group with the note` (page/route level)
  - `export scope=personal CSV columns and BOM`, `xlsx starts with Personal summary`
  - `combined: group figures equal the group-only report` (no cross-contamination)
  - benchmark case added to `phase2ReportBenchmark.integration.test.ts`: 31-day personal report on
    the benchmark fixture under the existing budget; record EXPLAIN plan in the commit body.
- Acceptance: flag off → WP2 parity green; flag on + permission → three scopes work; no text in exports.

### WP7 — Customer-specific reply attribution (Tier1/Tier2), additional section
- Create `packages/shared/src/unifiedReporting/replyAttribution.ts` (06 §3) and `enrichment.ts`
  (06 §6, types only).
- `teamReport.ts`: `withReplyEvidence` option (07 §2.1). Page (group/combined, flag on) loads with
  it and renders new `CustomerSpecificReplies.tsx`; drill-down renders `asksDetail`; Excel sheet
  "Customer-specific replies".
- Tests `replyAttribution.test.ts`:
  - `quote of a customer's line links Tier1 and closes that customer's ask only`
  - `quote of a staff message falls through`
  - `single mention of an open customer links Tier2 mention`
  - `mentions of two open customers are UNRESOLVED (MULTIPLE_MENTIONED)`
  - `single open ask, no other customer spoke, inside window → Tier2 sequence`
  - `another customer spoke in between → UNRESOLVED (OTHER_CUSTOMER_SPOKE)`
  - `outside the 4h window → UNRESOLVED (OUTSIDE_WINDOW)`
  - `LID and phone copies of one customer are one cluster`
  - `unresolved reply closes nothing; legacy group wait is unaffected` (compare computeTeamReport output with and without evidence)
  - `broadcast is NOT_A_REPLY` · `TIER3_PROBABLE is never produced` · `deterministic on equal timestamps`
- `teamReportParity` extended: `withReplyEvidence=false SQL path returns identical rows`.
- Acceptance: section shows counts beside group figures; no group figure moves.

### WP8 — Identity-change preview (read-only)
- Create `packages/shared/src/unifiedReporting/identityPreview.ts` (04 §4.1),
  `apps/web/src/server/identityPreview.ts` (04 §4.2–4.3, `identity` override of 07 §2.1 and
  `loadPersonalReport`), `apps/web/src/server/actions/identityPreview.ts` (04 §4.4),
  `apps/web/src/components/teamMembers/IdentityImpactPanel.tsx`.
- Modify `EditTeamMemberForm.tsx`, `AddTeamMemberForm.tsx`, `chat/ChatPanelActions.tsx` (button +
  panel + hidden `previewDigest`), `server/actions/teamMembers.ts` (`logIdentityChange` optional
  `preview` param, read from the form's `previewDigest` + counts; nothing else changes).
- Tests: 04 §6 lists (`identityPreview.test.ts`, `identityPreview.integration.test.ts`), plus
  `teamMembers save without previewDigest logs exactly as before`.
- Acceptance: preview writes nothing; save path unchanged apart from the System Log detail.

### WP9 — Docs and release
- Update `REPORTS.md` (new section "Unified messaging reporting"), `PROJECT_REFERENCE.md` (Team
  Report page fields), CLAUDE.md (short rules-worth-not-undoing block), README status line.
- Release note draft (Release Notes module, DRAFT only).
- Deploy note: no migration; enable `UNIFIED_REPORTING` for one project first; rollback = switch off.

Dependency order: WP1 → WP2 → (WP3, WP4, WP5 in any order) → WP6 → WP7 → WP8 → WP9.

## Deferred (not in release 1) — with reasons

| Item | Why deferred |
|---|---|
| TIER3_PROBABLE links | Inference that can be wrong; ship verified tiers first, measure how many replies stay unresolved. |
| AI enrichment implementation | Owner asked for interfaces only; any implementation must use `packages/ai-client` and its suggestions can never count as verified. |
| Personal support time / overtime | Would change Support Overtime's meaning (TEAM_OVERTIME.md); needs an owner decision. |
| New `Message` index (`projectId,timestampWa WHERE groupId IS NULL`) | Write-blocking build on the largest table; only if WP6's EXPLAIN/benchmark shows need (03 §3). |
| Incremental aggregates / rollups / partitioning | Conflict with read-time identity and "as at event" responsibility; only after a measured breach. |
| Persisted run log (`ReportRun`) and `IdentityReattribution.preview` column | No current audit requirement; System Log + export Run sheet cover v1. |
| Login-link (`userId`) change preview | Needs an OutboundMessage-based hit set; low volume. |
| Dated identity history ("roster as of date") | Requires an identity evidence table rejected in 03 §2. |
| Personal scope on `/reports/<id>` pages | Each report's definitions are group-specific; extend one by one after the Team Report proves out. |
