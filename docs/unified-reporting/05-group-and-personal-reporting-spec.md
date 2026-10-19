# 05 — Group and personal reporting spec

## 1. Scope rules

| Scope | Conversations included | Detection (one rule, two languages) |
|---|---|---|
| `group` (default, legacy) | `Message` rows with a `WhatsAppGroup` (`JOIN "WhatsAppGroup" g ON g."id" = m."groupId"`) — EXACTLY what `loadTeamReport` reads today | unchanged |
| `personal` | `Message` rows with `PERSONAL_CHAT_SQL`: `m."groupId" IS NULL AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid')` | SQL: `PERSONAL_CHAT_SQL` (make it `export` in `apps/web/src/server/chatInbox.ts`, no other change). TS: `isPersonalChatId` (packages/shared `whatsappChats.ts`). The pinning test that already ties them stays the authority. |
| `combined` | both, computed SEPARATELY and shown side by side, plus a combined column for additive figures only (§4) | — |

Never included in any scope: `status@broadcast`, `@newsletter`, broadcast lists, any other non-group
`groupId IS NULL` chat; `direction = 'SYSTEM'` rows (joins/leaves). A `groupId IS NULL` row whose
chat ends `@g.us` (group row deleted, `SetNull`) is neither scope — counted in the data-quality line
"Excluded: not a collected conversation" (06 §5).

**Personal is never mixed into the group report by default.** `scope` absent or anything
unrecognised → `group`. Flag off → `group` whatever the URL says. Group figures, group exports and
every `/reports/<id>` page never read personal rows (they keep calling `loadTeamReport`, whose SQL is
untouched except the opt-in evidence columns in 07 §2.1).

### 1.1 Personal conversation identity and exclusions

- Key: `${accountId}|${chatId}`. The same customer writing to two of our numbers is two
  conversations (CLAUDE.md "A personal chat belongs to the account with the messages").
- A customer seen as `…@c.us` and later `…@lid` on the same account is two chat ids → two
  conversations. No merge (no evidence links them). Stated in Help as a known limitation.
- **Own-number chat** — the chat's user part is in `loadOwnSenderIds(projectId)` (one of our numbers
  writing to another): EXCLUDED from every personal figure, counted in data quality as
  "own-number chats excluded".
- **Internal chat** — any incoming logical message in the conversation (inside the loaded window)
  classified `kind = MEMBER` (a roster member DMing the business number): EXCLUDED from customer
  metrics, counted as `internalConversationsExcluded`. Decided over the loaded window, per
  conversation (a colleague is not a customer for part of a chat).
- A personal message is stored by one account only; `DISTINCT ON (m."accountId", m."chatId", key)`
  is still applied (defensive, cheap).

## 2. Personal metrics (definitions)

Inputs: classified personal messages from `[rangeStart − CONTEXT_MS, rangeEnd + LOOKAHEAD_MS)`
(the Team Report's own constants, 4 h and 24 h), plus each active conversation's last message before
the context window (LATERAL on `Message_personal_chat_idx`). Only messages with
`rangeStart ≤ ts < rangeEnd` are COUNTED; earlier rows are context, later rows are only replies.

| Metric | Definition |
|---|---|
| `conversations` | Distinct non-excluded conversation keys with ≥1 logical message in the period. |
| `customerConversations` | … with ≥1 CUSTOMER message in the period. |
| `newConversations` | Conversations whose FIRST STORED logical message (no earlier row found by the probe and none in the context window) is in the period. Labelled "first stored in this period" (collection may have started later). |
| `customerMessages` | CUSTOMER logical messages in the period. |
| `businessReplies` | Every non-CUSTOMER logical message in the period (= kind BUSINESS + kind MEMBER from a linked login). |
| `verifiedEmployeeReplies` | `actor = OPERATOR` AND `memberId != null` (dashboard MANUAL_REPLY by a login linked to a roster member, after that member's `attributeFrom`). The ONLY personal figure credited to an employee. |
| `unlinkedOperatorReplies` | `actor = OPERATOR` AND `memberId = null`: a verified dashboard user with no team-member link. |
| `automatedReplies` | `actor ∈ {AI, RULE}` (split shown: AI / rule). |
| `businessPhoneReplies` | `actor = BUSINESS_PHONE`: sent from the phone (or a worker alert) — a person nobody can name. |
| `broadcastMessages` | `actor = BROADCAST` (expected 0 in 1:1; shown only when > 0). |
| `waits` | The Team Report wait definition, per conversation: a CUSTOMER message starts a wait when the previous message in the conversation was a reply or none; ends at the next reply of ANY kind (first observed response). Computed by calling the UNCHANGED `computeTeamReport` with `groupKey = conversationKey` (06 §4). |
| `missed` / `recalled` / `unrecovered` / `pending` | Same statuses; threshold = `SupportActivitySettings.missedReplyAfterMinutes` (personal chats have no priority/escalation policy). No assignee → nothing is charged to a person (no per-member Missed in personal). |
| `firstObserved` | `responseStats(waits)` (median, p90, within/late/never/pending). |
| `firstHuman` | `humanWaits(intel, …)` (Human Response SLA's wait: only MEMBER/MEMBER_UNMAPPED/OPERATOR/BUSINESS_PHONE end it; closing remarks open none). `answeredVerified` = ended by OPERATOR (linked or not) — the existing `isVerifiedHumanActor`; `answeredByEmployee` = ended by OPERATOR with memberId; `answeredUnverified` = ended by BUSINESS_PHONE; median/p90 over verified only. |
| `waitingConversations` | Conversations whose latest logical message at `measuredTo = min(now, rangeEnd + LOOKAHEAD_MS)` is CUSTOMER and whose last wait is not answered. `PersonalChatReview` is NOT read (review ≠ answer, same rule as `getGroupsAwaitingReply`). |
| `identityCoverage` | Outgoing logical messages by provenance: echoes a send (`obMatched`) vs not; OPERATOR linked vs unlinked; incoming senders resolved as staff (internal) vs customer. Counts only. |
| `collection` | `loadDataHealth` for the period (account-level `CollectionGap`s apply to personal chats too — a gap is per account, not per chat kind). |

Member/Team filter in personal scope: narrows `verifiedEmployeeReplies` and the member table to
in-scope members (`scope(memberId, ts)` exactly as the group report builds it), and conversation-level
figures to conversations where an in-scope member sent a verified reply in the period
("conversations they answered"). Help says so. Group filter (`groups=`): ignored in personal scope,
with a filterNote "The group filter does not apply to personal chats." Account filter
(`account=`): applies (personal conversations of that account).

## 3. Group scope

Unchanged figures and meaning (calculation version `GROUP_CALCULATION_VERSION`, 06 §7). Additions
shown only with the flag on, BESIDE existing sections, never altering a figure:

1. Run information panel (06 §5 / 07 §3).
2. Data-quality additions (late-arriving, loaded from history, excluded, revoked, pending
   re-attributions) appended to the existing Reliability section as a new section group.
3. "Customer-specific replies" section (Tier1/Tier2 reply attribution, 06 §3).

## 4. Combined semantics

`combined` = group report + personal report, computed independently, then
`combineReportSummaries(group, personal)` (pure, 07 §1.4) builds one table with three value
columns: Groups | Personal | Combined. Every Combined cell carries `additivity`:

| Figure | Combined value | Additivity label |
|---|---|---|
| Customer messages, replies by category, waits, missed, recalled, unrecovered, pending | group + personal (conversations are disjoint by construction) | `ADDITIVE` |
| Median / p90 first observed response | recomputed over the UNION of both wait lists (`responseStats([...groupWaits, ...personalWaits])`) | `RECOMPUTED` — never an average of two medians |
| Median first human response | recomputed over the union of human waits, verified only | `RECOMPUTED` |
| Conversations | groups-with-a-message + personal conversations | `ADDITIVE_DIFFERENT_UNITS` — "a group and a personal chat are each one conversation" |
| Distinct customers | not shown | `NOT_COMBINABLE` — a person in a group and in a DM may appear as a LID in one and a phone in the other |
| Active members, Support time, Support Overtime | group values only, personal "—" | `GROUP_ONLY` — support time is the group timeline (TEAM_OVERTIME.md); personal replies do not enter it in v1 |
| Groups supported | group only | `GROUP_ONLY` |

Page heading in combined scope: "Groups and personal chats — shown side by side. Combined figures
add only what can be added; a customer who wrote in a group and in a personal chat is counted in
both." The Excel "Combined" sheet carries the `additivity` column.

## 5. Permission rules

| What | Required |
|---|---|
| Team Report page, group scope (unchanged) | `support_activity.view` (`requireAccess`, as today) |
| Personal or combined scope (page, CSV, Excel, table export) | `support_activity.view` AND `messages.view` |
| Identity-change preview | `whatsapp.manage`; personal parts additionally `messages.view` |

Rationale: `messages.view` is the key that already gates personal-chat content in WhatsApp Chat and
the WhatsApp Chat User Activity report (REPORTS.md §10); reusing it means no new key, no seed
change, no migration, and page-level project roles (`ProjectRole.sectionAccess`) apply unchanged
because `hasPermission` derives a sectioned role's keys from its pages. A role that cannot open
Messages/WhatsApp Chat therefore cannot see personal reporting. (Alternative — a new key
`reports.personal.view` — REJECTED for v1: a new key must be granted on deploy to every role that
should keep seeing it, the seed is add-only, and it would diverge from the chat's own gate.)

Implementation: `resolveReportScope` (07 §1.1) takes `canViewPersonal = await hasPermission(session, "messages.view")`
(`@/server/permissions`). A request for personal/combined without it falls back to `group` with
filterNote "Personal chat reporting needs the View Messages permission." The export routes repeat
the same check (routes are public endpoints). Personal content shown: counts, conversation display
name (`personalChatFallbackName(chatId)` or the stored `senderName`), last activity, figures. Never
message text. Conversation links point to `/chat/account/<accountId>/personal/<chatId>` only when the
viewer may open WhatsApp Chat (WHATSAPP_CHAT feature on); otherwise plain text.

## 6. Feature flag

- Key: **`UNIFIED_REPORTING`**, added to `PROJECT_FEATURES` in `packages/shared/src/projectFeatures.ts`:

```ts
{
  key: "UNIFIED_REPORTING",
  label: "Unified messaging reports",
  description:
    "Team Report additions: personal-chat and combined scopes, run information, data-quality detail, customer-specific replies, and the identity-change impact preview. Off = the Team Report exactly as before.",
  // A presentation switch like CHAT_UI_V2: it owns no page and no key, so it never blocks a page.
  defaultEnabled: false,
  routes: [],
  permissionKeys: [],
  workerEffect: "Nothing runs in the background for it; the reports read stored messages.",
},
```

- Read: `isUnifiedReportingEnabled()` in new `apps/web/src/server/unifiedReporting.ts`
  (`!(await activeDisabledFeatures()).has("UNIFIED_REPORTING")`), same shape as
  `isChatUiV2Enabled()`.
- Checked in: Team Report page (`team-report/page.tsx`), group drill-down page
  (`team-report/group/[groupId]/page.tsx` — only for the customer-specific replies list),
  `api/team-report/export/route.ts`, `api/team-report/table-export/route.ts`,
  `previewTeamMemberIdentityChange` action, Team Members edit/add forms and the chat contact link
  panel (whether to render "Preview impact").
- Off ⇒ every surface byte-identical to HEAD (parity tests, 00 WP2).
- Main Admin Portal lists it automatically (catalogue-driven). Rollback = switch off.
- The worker never reads it.
