# Unified Messaging Reporting — 01. Existing-system audit

Phase 1 (planning) deliverable. Read-only audit: no code, schema, test, config or database was touched.
Every claim cites `file:line` or `file:function`. "Group" = a `@g.us` chat with a `WhatsAppGroup` row;
"personal" = a `@c.us` / `@lid` chat stored with `Message.groupId IS NULL`.

---

## 1. Revision inspected, and what production runs

| Ref | Commit | Date | Note |
|---|---|---|---|
| `HEAD` (`rudra`, = `github/rudra`, = `origin/rudra`) | `a3c0c60` | 19 Oct 2026 23:27 | **Inspected revision** |
| `github/main` | `e2e5f6f` | 18 Oct 23:54 | Merge of PR #21 (store sweep, `ac9f04c`). HEAD is 8 commits ahead, 0 behind on content (2 merge commits only on main) |
| `github/hotfix/personal-messages` = `origin/hotfix/...` | `59cd153` | 18 Oct 22:00 | Fully contained in HEAD |
| `origin/main` (GitLab) | `dd5b38c` | 19 Oct 00:09 | "Restore main to d5b9248 (16 Sep 2026)": tree equals `d5b9248`; newest migration there is `20260916140000_whatsapp_pairing_method` |

Commits on HEAD but not on `github/main` (the "report accuracy audit"): `9ab5915`, `34b2f85`, `d39b89b`,
`f59a178`, `48a0183`, `1a62363`, `252fa4d`. They add three migrations not on any `main`:
`20261019100000_report_accuracy_episode_twins`, `20261019110000_report_accuracy_history`,
`20261019120000_member_default_shift_changed_at`.

**The deployed revision cannot be confirmed from the repository.** Evidence points different ways: the
user's memory notes call GitLab `main` the production line, and that branch was reset to 16 Sep content.
`README.md` §Status says PR #19 (personal-message hotfix) is "merged to `main` … not deployed". The VPS
deploys with `git pull` (DEPLOY.md), and nothing in the repo records which branch or commit it pulled.
**Before any phase depends on production behaviour, confirm it on the server.**
`scripts/diagnose-personal-messages.sh` fingerprints the running build inside the containers, and
`_prisma_migrations` shows which of the three 19 Oct migrations are applied. The rest of this audit
describes HEAD.

---

## 2. Inventory

### 2a. Database tables relevant to reporting (`packages/db/prisma/schema.prisma`)

| Table | Purpose | Key columns / constraints | Scope |
|---|---|---|---|
| `Message` | Every stored WhatsApp message, one row **per account copy** | `@@unique([accountId, whatsappMessageId])` (the dedup guard); `chatId`, `groupId?`, `senderPhone` (JID domain stripped), `senderJid?` (domain kept), `isFromTeamMember` (stamp taken at arrival), `direction`, `timestampWa`, `createdAt`, `quotedMessageId`, `mentionedPhones`, `loadedFromHistoryAt`, `revokedAt` | group + personal |
| `OutboundMessage` | Send queue and send provenance | `actionType`, `ruleId`, `createdById` (who pressed send), `providerMessageId` (joins to the echo), `relatedMessageId`, `replyToMessageId`, `idempotencyKey @unique` | group + personal |
| `WhatsAppGroup` | One row per (account, WhatsApp group) | `whatsappGroupId`, `isActive`, `isMonitored`, `priority`, `assignedTeamMemberId` (FK `SetNull`) | group |
| `WhatsAppAccount` | Our numbers | `phoneNumber`, `isPrimary`, `status` | — |
| `InternalTeamMember` | Roster | `phoneNumber` and `whatsappId` (unique per project), `attributeFrom?` ("count their messages from"), `status`, `userId?` (link to a login), `teamId` | — |
| `Team`, `TeamMembership` | Team history | `startedAt?` (null = "since before Teams were recorded"), `endedAt?` | — |
| `GroupResponsibilityChange` | Assignee/priority history per WhatsApp group (19 Oct) | `whatsappGroupId`, previous/new assignee + priority, `changedAt` | group |
| `IdentityReattribution` | Queue of roster-change re-stamps (19 Oct) | `status` (PENDING/RUNNING/DONE/FAILED as a free `String`), `identifiers[]`, `memberIds[]`, `result Json`, `attempts` | both (stamp) |
| `SupportActivity` | Rule-detected team work, **only while the module is on** | `messageId @unique`, `groupId` (required), `teamMemberId?`, `actor` (TEAM_MEMBER/AI) | group |
| `SupportSession` | Keyword-completed sessions | `durationSeconds` written on completion only | group |
| `SupportResponseEpisode` | One wait per group **row** (account × group) | `groupId` required, `status`, `supportMemberId`, `responseSeconds`, `isTwin` (19 Oct) | group |
| `TeamAttendanceDay` (+`TeamAttendanceGroup`) | Duty History evidence | `@@unique([teamMemberId, activityDate])`, counts, first/last, `override` | group |
| `CollectionGap` | Outage record per account | `cause`, `startedAt/endedAt`, `recoveryStatus`, `recoveredCount`; **no chat-kind column** | account |
| `ProcessingCheckpoint` | Last processed message per account (shared by every chat) | `accountId @unique` | account |
| `MessageDropCounter` | Dropped messages per account/day/reason | `@@id([accountId, day, reason])`; **no chat-kind column** | account |
| `PersonalChatReview` | Inbox "seen" mark for a personal chat | `@@unique([projectId, accountId, chatId])` | personal |
| `ChannelConversation` / `ChannelMessage` | Messenger, Instagram, Telegram (OMNICHANNEL) | separate tables by design, never in `Message` | other channels |
| `SupportActivitySettings` | Report rules | `offlineAfterMinutes`, `missedReplyAfterMinutes`, `reportingVerifiedFrom`, `responseTrackingTeamIds` | — |

There are **no aggregate, rollup or snapshot tables for reporting.** A schema search for
`Daily|Rollup|Aggregate|Snapshot|Summary|Report` models finds only `WorkerHealthSnapshot` and
`AiEvidenceSnapshot`, and neither is a reporting table.

### 2b. Identity-matching functions

| Function | File | Rule | Used by |
|---|---|---|---|
| `parseWhatsAppId`, `isPersonKind`, `whatsappIdKey` | `packages/shared/src/whatsappIdentity.ts:73-97` | domain → kind (PHONE / LID / GROUP / …) | everything below |
| `createSenderResolver(members).resolve(phone, jid, at?)` | same file, `:170` | exact `whatsappId`, then digits-only phone. CONFLICT and AMBIGUOUS credit nobody but stay `isRosterMember`. `at` drops members whose `attributeFrom` is later than the message | worker `teamFilter.ts` (ACTIVE members); every web loader (ALL members); reattribution; attendance `identifiersFor` |
| `identifiersFor(memberId)` | same, `:241` | the stored forms that resolve back to that member | `attendance.ts:recomputeAttendanceDay`, `deleteTeamMember` |
| `attributeAcrossCopies(resolver, copies, at)` | same, `:401` | every stored INCOMING copy is a witness | `messageIdentity.ts:createReportClassifier` |
| `logicalMessageKey` / `parseMessageKey` | same, `:278-305` | `chatId|keyId` (3rd segment of the OpenWA id) | Team Report, intelligence |
| `messageKeySql`, `preferSenderCopySql`, `storedCopiesSql`, `outboundByKeyJoin` | `apps/web/src/server/messageIdentity.ts:39-100` | SQL twins of the above. The outbound join is bounded by `sentAt` ± 2 days | every report loader |
| `loadOwnSenderIds` / `isOwnSender` | `messageIdentity.ts:110-140`; `whatsappIdentity.ts:439` | our account digits plus ids we have SENT from in groups | report classifier |
| `isOwnAccountMessage` / `rememberOwnSender` | `apps/worker/src/pipeline/ownAccounts.ts` | the same evidence plus a recent outbound with the same key | live pipeline, history store |
| `createReportClassifier(...).classify(row, at)` | `messageIdentity.ts:175` | ours (→ AI / RULE / BROADCAST / OPERATOR / BUSINESS_PHONE via `outgoingActorFor`, and OPERATOR → linked member) or `attributeAcrossCopies` | `teamReport.ts`, `attributedMessages.ts`, `intelligence/loader.ts`, `reports/activityReports.ts:buildCalls` |
| `recoverSenderJid` | `whatsappIdentity.ts:313` | backfills a NULL `senderJid` from what the row itself proves | `packages/db/prisma/reconcileMessages.ts` (dry run by default; `--apply` fills NULLs only) |
| `getRosterIdentityHealth` | `apps/web/src/server/rosterIdentityHealth.ts` | own-number members, quiet members, unknown senders active in ≥3 groups (30 days) | Team Members → Identity check |
| `toRawIncomingMessage` | `apps/worker/src/provider/openwa/OpenWAProvider.ts:436` | group: `author` → `sender.id` → `from`; personal: `from`; `direction` from `fromMe` | every collection path |

### 2c. Reports and metrics

All of these are computed live at request time. None are pre-aggregated.

| Report / metric | Source | Dedup | Identity | Time rule | Scope |
|---|---|---|---|---|---|
| Team Report (`server/teamReport.ts:loadTeamReport` → `computeTeamReport`) | `Message` JOIN `WhatsAppGroup` (`:365`) + `OutboundMessage` | `DISTINCT ON (whatsappGroupId, logical key)`, sender copy kept; with `account=`, that account's copy first while identity still uses every copy (`:359-374`) | read-time classifier at the message's own time | Dhaka periods, ≤92 days; −4 h context window plus each group's last earlier message; +24 h look-ahead; `asof`/`storedBy` for exports | **groups only** |
| Missed / Recall / threshold | `GroupResponsibilityChange` + current group (`teamReport.ts:519-545`) | — | assignee at ask time | priority SLA `firstAlertMinutes`, else `missedReplyAfterMinutes` | groups |
| Support Overtime | `overtimeDuty.ts:loadDutyResolver` + member timelines | — | as above | idle gap, split at Dhaka midnight | groups |
| Reliability section | `teamReportReliability.ts:computeReportingReliability` | counts stored copies against logical messages | match-strength counts | period | groups |
| 17 `/reports/<id>` builders (`server/reports/index.ts:53-71`) | cut `loadTeamReport`'s dataset (`ctx.data`) | inherited | inherited | inherited | groups |
| Support Intelligence ×5 (`intelligence/loader.ts:loadIntelligence`) | `Message` JOIN `WhatsAppGroup` | same logical key | classifier, **but see bug B2** | case gap before the period, +24 h after | groups |
| Calls (`activityReports.ts:buildCalls`) | `Message` filtered by a text regex | logical key | classifier, **bug B2** | period | groups |
| WhatsApp User Activity (`userActivityReports.ts:loadSends`) | `OutboundMessage` | none needed | `createdById` + `attributeOutbound` | `createdAt` | **group + personal** (the only one) |
| Team Performance, availability, first response, Overview charts (`attributedMessages.ts:loadAttributedMessages`) | `Message` JOIN `WhatsAppGroup` (`:68`) | logical key | classifier | caller's window | groups |
| Activity Feed + export (`supportActivityReports.ts`) | `SupportActivity` | `messageId @unique` (rows were written per account copy before re-attribution) | stored `teamMemberId` | `occurredAt` | groups |
| Response Time / Unanswered Groups (`server/supportResponse.ts`) | `SupportResponseEpisode` | `isTwin = false` unless an account is chosen (`:71`, `:222`) | decided at reply time and **never re-decided** | episode timestamps | groups |
| Duty History | `TeamAttendanceDay` | logical key per WhatsApp group (`attendance.ts:160-175`) | ACTIVE roster, `senderPhone` forms | Dhaka day | groups |
| Chat inbox counts / waiting | `Message` (`chatInbox.ts:inboxBaseSql`, `PERSONAL_CHAT_SQL :237`) | per account | **stored `isFromTeamMember` stamp** (`:206`, `:267`) | newest message | group + personal |
| Data health strip (`server/dataHealth.ts:loadDataHealth`, `shared/dataHealth.ts:computeDataHealth`) | `CollectionGap`, `reportingVerifiedFrom`, newest `Message`, `ProcessingCheckpoint` | — | — | overlap with the period | per account, kind-blind |

### 2d. Collection-repair and background jobs

| Job | File | Trigger | Bounds | Writes |
|---|---|---|---|---|
| Catch-up | `pipeline/catchUpMissedMessages.ts` | after every connect (initial, RECONNECT, recovery) | ≤12 h look-back, ≤2,000 messages, minimum 60 s gap. Within 15 min of the message: full pipeline; older: `storeMissedMessage` (no rules) | `Message`; `CollectionGap` recovery result; checkpoint not moved after an incomplete read |
| Reconcile | `reconcileRecentMessages.ts:reconcileRecentMessages` | every 10 min (`MESSAGE_RECONCILE_INTERVAL_MINUTES`) | 30 min look-back, ≤500 messages | same split as catch-up |
| Store sweep | same file, `sweepMessageStore` | every 60 s (`…SWEEP_INTERVAL_SECONDS`, 0 = off) | 30 min look-back, ≤3,000 refs, ≤100 full reads, skips messages under 20 s old | same split |
| Personal backfill | `personalBackfill.ts` | operator, `/backfill/personal` on the loopback port | ≤14 days, ≤2,000 chats (500 by default), ≤10 earlier pages; dry run unless `mode=write&confirm=WRITE` | `storeHistoryMessages` (`messageUpdates.ts:122`): store only, `loadedFromHistoryAt` set, `IGNORED`/`PROCESSED` |
| Identity re-attribution | `teamManagement/reattribution.ts` | `IdentityReattribution` rows queued by Team Members actions (create, update identifiers, link sender, add from group or identity check) | every 30 s, one request per project per tick, 3 attempts, 30 min stuck reset; Support Activity backfill ≤5,000 rows; attendance ≤365 days; **Message re-stamp unbounded** | `Message.isFromTeamMember`, `SupportActivity.teamMemberId`, `TeamAttendanceDay` |
| Attendance | `teamManagement/attendance.ts:recordTeamAttendance` / `recomputeAttendanceDay` | each stored staff message; the dashboard-reply echo | one member-day under an advisory lock | `TeamAttendanceDay` (recomputed, never incremented) |
| Response tracker | `supportResponse/tracker.ts:trackSupportResponse` | inside `persistIncomingMessage` | returns at once for `groupId = null` (`:47`); needs a Support Team configured | `SupportResponseEpisode` |
| Collection watchdog / gaps | `health/collectionWatchdog.ts`, `health/collectionGaps.ts` | worker loops | — | `CollectionGap`; in-memory `collectionByKind` metrics (not persisted) |
| `reconcile:messages` | `packages/db/prisma/reconcileMessages.ts` | manual | dry run by default | fills NULL `senderJid` only |

---

## 3. Capability classification against the master spec

| Capability | Classification | Evidence |
|---|---|---|
| **Group reporting** | **Already implemented correctly** (with the bugs in §4) | `loadTeamReport` → `computeTeamReport`, 17 builders, Intelligence; pinned by `teamReport.test.ts`, `teamReportAudit.*`, `reportAccuracy*.integration.test.ts`, `whatsappIdentityReports.integration.test.ts` |
| **Personal reporting** | **Missing (additive extension)** | Every report loader inner-joins `WhatsAppGroup` (`teamReport.ts:365,389,414`, `attributedMessages.ts:68`, `intelligence/loader.ts`, `activityReports.ts`, `responseReports.ts:227`). The tracker skips personal chats (`tracker.ts:47`). Attendance skips them (`attendance.ts:54`, `"groupId" IS NOT NULL`). `SupportActivity.groupId` and `SupportResponseEpisode.groupId` are required columns. Personal messages are *collected* (catch-up, sweep, backfill) and *shown* (inbox), but no report reads them, except outbound sends in User Activity |
| **Combined scope (group + personal)** | **Missing** | No loader takes a kind filter. `computeTeamReport` keys everything by `groupKey`; a personal `chatId` could serve as a key, but group concepts (assignee, priority, `isMonitored`, `GroupResponsibilityChange`) have no personal equivalent |
| **Logical dedup** | **Already implemented correctly** for group reports | `logicalMessageKey` ↔ `messageKeySql`, pinned by test; `preferSenderCopySql`; `storedCopiesSql`; episode `isTwin`; attendance logical key. **Requires design for personal**: two of our numbers in a 1:1 chat with each other store the same message under two different `chatId`s, so `chatId|keyId` cannot merge them (the own-account path stores the receiving copy as OUTGOING, `processIncomingMessage.ts:99`) |
| **Identity resolution** | **Already implemented correctly** | `createSenderResolver`: one rule with CONFLICT/AMBIGUOUS/NOT_A_PERSON, tested in `whatsappIdentity.test.ts` |
| **Historical attribution** | **Implemented but incomplete** | Present: `attributeFrom` (start date), `TeamMembership` intervals (`inTeamAt`), `GroupResponsibilityChange`, read-time classification. Missing: an **end** date (no `attributeUntil`). Reports pass ALL members (`loadReportSenderResolver`), so a former colleague who later writes as a customer is still counted as staff. Login→member link is undated (`messageIdentity.ts` comment in `loadReportIdentity`). Responsibility history starts 19 Oct 2026; earlier waits use today's assignment |
| **Re-attribution preview** | **Missing** | `updateTeamMember` commits the change, then `queueReattribution` (`teamMembers.ts:539-605`); nothing shows the impact first. After the fact, `getMemberHistorySync` reports counts |
| **Customer-specific reply attribution** | **Implemented but incomplete** | Team Report waits are per group: the next MEMBER/BUSINESS message closes the group's wait, whichever customer asked (`computeFirstResponseWaits` docs, `computeTeamReport`). Intelligence uses quotes (`quotedKey`, `model.ts:302`) and mentions for case linking. The Team Report's intel feed passes `quotedKey: null` and `mentionedMemberIds: []` (`teamReport.ts` loop), so its human-wait figure never uses quotes |
| **Reporting run metadata / calculation version** | **Implemented but incomplete** | `computedAt` and `asof`/`storedBy` exist for exports (`teamReport.ts:reportNow`, `exportStoredBy`). No calculation version, run record or persisted inputs anywhere (search for `calculationVersion|REPORT_VERSION`: none) |
| **Data-quality indicators** | **Implemented but incomplete** | `computeDataHealth`, `groupDataConfidence`, reliability counts, `reportingVerifiedFrom`, Identity check. Kind-blind: `CollectionGap` and `MessageDropCounter` have no GROUP/PERSONAL column, and `uncheckedKinds` lives only in `recoveryNote` text and in-memory metrics, so a personal-only gap cannot be told apart from a group gap |
| **Incremental aggregates** | **Missing (additive), and risky** | Nothing is pre-aggregated, deliberately. CLAUDE.md: "never pre-aggregated, so changing the setting retroactively reinterprets history"; and "if volume ever makes it the bottleneck the answer is a nightly rollup". Read-time identity means any aggregate must be invalidated on every roster change, `attributeFrom` change, Team move or responsibility change |
| **AI enrichment hooks** | **Missing for reporting** (and must stay optional) | Intelligence is deterministic (`textSignals.ts`, `INTELLIGENCE_SQL_PREFILTER`). `AiEvidenceSnapshot` belongs to the AI fallback, not reporting. `packages/ai-client` is the right channel (text-only, no tools) |
| **Attribution review UI** | **Implemented but incomplete** | Identity check (`rosterIdentityHealth.ts`), `linkWhatsAppSender` from the chat contact panel, add-from-sender, the reliability section's conflict/unmapped counts. There is no per-message review queue and no way to see *which* messages are CONFLICT or AMBIGUOUS |
| **Permissions for personal content** | **Missing** | Personal chats are gated by `messages.view` + the `WHATSAPP_CHAT` feature, exactly like groups. `permissions.ts` has no personal-specific key, and project-role sections are per page, not per chat kind. Team Report pages are gated by `support_activity.view` (`team-report/page.tsx:56`, both export routes) |
| Unified view of other channels | **Unnecessary or risky to merge** | OMNICHANNEL.md: channel rows must never go into `Message`; ~40 readers assume WhatsApp. A unified report should read `ChannelMessage` beside `Message`, not merge them |

---

## 4. Verified bugs and known limitations

### Bugs provable from code

**B1. A deactivated member's Duty History is never corrected by re-attribution.**
`reattribute()` calls `recomputeAttendanceDay(memberId, …)` for every member involved
(`reattribution.ts:251`). `recomputeAttendanceDay` loads only `status: "ACTIVE"` members
(`attendance.ts:98`) and returns at `:102` when the member is not among them.

Scenario: member X is deactivated. An admin then corrects X's phone number, because it actually
belonged to Y. The re-attribution moves the messages to Y and recounts Y's days, but X's
`TeamAttendanceDay` rows are left untouched. The same messages are now counted on both X's and Y's
Duty History.

The same ACTIVE-only roster also makes Duty History disagree with the Team Report, which credits
deactivated members' messages to them.

**B2. Intelligence and Calls reports drop the other accounts' witnesses when an account is chosen.**
`loadIntelligence` puts `${accountFilter}` in the WHERE clause of the same query that computes
`storedCopiesSql` (`intelligence/loader.ts:129,149`). `buildCalls` does the same
(`activityReports.ts:132`). The window function therefore sees only that account's copies.

`loadTeamReport` deliberately keeps every copy as a witness (`teamReport.ts:344-374`).

Scenario: account A stored a colleague's message under a LID, and account B stored it under the phone
number on file. With `?account=A`, the Team Report credits the colleague, while Human Response SLA,
Support Cases, Effectiveness and Calls classify the same message as a CUSTOMER. A wait opens, and the
two pages disagree for the same filter.

**B3. A team member's hard delete erases group assignment history with no record.**
`WhatsAppGroup.assignedTeamMember` is `onDelete: SetNull` (`schema.prisma:1231`). `deleteTeamMember`
hard-deletes a member who has no Support Activity, no attendance and no INCOMING message
(`teamMembers.ts:717-733`). Only `groups.ts` and `accounts.ts` write `GroupResponsibilityChange`.

Scenario: a newly added member who has not yet written anything is assigned groups, then deleted. The
FK nulls the assignment with no change row. `responsibilityAt` falls back to the group "as it is now"
(`teamReport.ts:536-541`), so every earlier Missed wait of those groups moves to "Unassigned".

A related case: `deleteTeamMember` checks only INCOMING messages. A member whose only work is
dashboard replies through a linked login (and who has no attendance because `TEAM_MANAGEMENT` is off)
is deleted outright, and their replies revert to "Business number".

**B4. Group assignee merge is order-dependent in the Team Report.**
`teamReport.ts:487-512` reads group rows with no `orderBy`, and merges with "first non-Primary row
seen wins". `mergedGroupResponsibility` (`groupResponsibility.ts:22`) orders by
`isPrimary desc, id asc`.

Scenario: no Primary copy is assigned, and two non-Primary copies are assigned to different members.
The report's current assignee depends on the order Postgres returns the rows, and may differ from the
value recorded in `GroupResponsibilityChange`.

**Requires verification**: confirm it on data, because it needs multiple divergent non-Primary
assignments.

**B5. Missed-support message text uses the stored stamp.** `responseReports.ts:237` picks between two
same-millisecond lines with `isFromTeamMember ASC`, the arrival-time stamp. The wait itself was decided
by read-time identity. The shown text can therefore be a colleague's line (pre-roster stamp `false`).
Display only; no figure changes.

**B6. Attendance credits across a cross-copy CONFLICT.** `recomputeAttendanceDay` selects by
`senderPhone = ANY(identifiers)` per copy (`attendance.ts:140`). It does not apply
`attributeAcrossCopies`, so a logical message whose other copy names a *different* member still counts
for this member on Duty History, while the Team Report credits nobody.

### Limitations (by design or not yet built)

- **L1. Personal messages are absent from every report** (§3), and from Duty History and the response
  tracker. Personal replies typed on the business phone are BUSINESS_PHONE with no person. Only
  dashboard replies carry `createdById`.
- **L2. Re-attribution re-stamps `Message` with unbatched UPDATEs over all history**
  (`reattribution.ts:259-272`), including personal chats, with no lookback. A busy sender is one
  large statement on the largest table. It also leaves `SupportResponseEpisode` unchanged on purpose,
  so Response Time keeps the old attribution while the Team Report follows the roster.
- **L3. The status toggle queues no re-attribution** (`toggleTeamMemberStatus`, `teamMembers.ts:670`).
  The live stamp for that person changes from then on, but the reports' all-members resolver does not,
  so the inbox (stamp-based, `chatInbox.ts:206,267`) and the reports diverge for that sender.
- **L4. No attribution end date** (see historical attribution in §3).
- **L5. History starts late.** `GroupResponsibilityChange` and `IdentityReattribution` exist only from
  migration `20261019110000`. Before the first change row, the report uses today's values.
  `reportingVerifiedFrom` ships empty, so nothing is "verified".
- **L6. Recomputed on every request.** Team Report's 92-day cap and the Intelligence windows are the
  only cost controls. A combined group+personal scope will add `@c.us`/`@lid` volume to the same
  per-request scans. The partial index `Message_personal_chat_idx` exists for the inbox, not for
  time-range reads.
- **L7. Data health is account-level only** (§3). The `CATCHUP`/sweep outcomes per kind are not
  persisted.
- **L8. The 19 Oct migrations are probably not deployed.** None is on any `main`, so their columns
  (`isTwin`, `GroupResponsibilityChange`, `IdentityReattribution`, `defaultShiftChangedAt`) may not
  exist live. Per CLAUDE.md, a live `P2022` there is an undeployed migration, not a new bug.

### What already exists and should be reused, not rebuilt

`createSenderResolver`, `attributeAcrossCopies`, `createReportClassifier`, `messageKeySql` /
`storedCopiesSql` / `outboundByKeyJoin`, `computeTeamReport`, `computeResponseMetrics` /
`computeReportingReliability`, `computeDataHealth`, `isPersonalChatId` / `PERSONAL_CHAT_SQL`,
`storeHistoryMessages`, and the `IdentityReattribution` queue. A unified platform should extend these
loaders with a chat-kind dimension. A second identity rule, a second dedup key, or a parallel message
store would each re-create the drift the 19 Oct audit spent three phases removing.
