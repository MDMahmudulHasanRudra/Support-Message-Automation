# 07 — API and UI contracts

All paths below are relative to the repo root. `@/` = `apps/web/src/`. Project-scoped Prisma only
(`import { prisma } from "@/server/db"`); every `$queryRaw` names `"projectId"`.

## 1. packages/shared (pure, unit-tested, exported from `src/index.ts`)

New folder `packages/shared/src/unifiedReporting/` with an `index.ts` re-exporting every file below;
add `export * from "./unifiedReporting/index.js";` to `packages/shared/src/index.ts`.

### 1.1 `reportScope.ts`

```ts
export type ReportScope = "group" | "personal" | "combined";
export const REPORT_SCOPES: readonly ReportScope[] = ["group", "personal", "combined"];
export const REPORT_SCOPE_PARAM = "scope";
/** Anything unrecognised (or absent) is "group": old URLs keep opening exactly what they opened. */
export function parseReportScope(raw: string | null | undefined): ReportScope;
/** The scope actually applied, and why it differs from the requested one. */
export function resolveReportScope(input: {
  requested: ReportScope;
  featureEnabled: boolean;
  canViewPersonal: boolean;
}): { scope: ReportScope; note: string | null };
// featureEnabled=false → { scope: "group", note: null }  (silent: the flag-off page must be identical)
// personal/combined && !canViewPersonal → { scope: "group", note: "Personal chat reporting needs the View Messages permission." }
```

### 1.2 `readModel.ts`, `attributionOutcome.ts`, `versions.ts`, `enrichment.ts`
As specified in 03 §1, 04 §1, 06 §5.1, 06 §6.

### 1.3 `personalReport.ts`

```ts
export interface PersonalReportMessage {
  conversationKey: string;     // `${accountId}|${chatId}`
  accountId: string;
  chatId: string;
  key: string;                 // logicalMessageKey(chatId, wamid)
  ts: number;
  kind: "CUSTOMER" | "MEMBER" | "BUSINESS";
  actor: IntelActor;
  memberId: string | null;
  operatorUserId: string | null;
  sender: string;
  text: string | null;         // prefiltered, server-only
}

export interface PersonalReportOptions {
  rangeStart: number; rangeEnd: number; now: number; measuredTo: number;
  missedAfterMs: number;
  granularity: ReportGranularity;
  /** Team/member scope, same predicate shape as the group report; null = everyone. */
  scope: ((memberId: string, ts: number) => boolean) | null;
  /** Conversations excluded before counting (own-number, internal) — decided by the loader. */
  excluded: ReadonlyMap<string, "OWN_NUMBER" | "INTERNAL">;
  /** conversationKey → ts of the newest stored message before the context window (null/absent = none). */
  earlierMessageAt: ReadonlyMap<string, number>;
}

export interface PersonalConversationRow {
  conversationKey: string; accountId: string; chatId: string;
  customerMessages: number; businessReplies: number; verifiedEmployeeReplies: number; automatedReplies: number;
  waits: number; missed: number; recalled: number; unrecovered: number;
  firstObservedMedianSeconds: number | null;
  waiting: boolean; isNew: boolean;
  firstAt: number | null; lastAt: number | null;
  employeeIds: string[];
}

export interface PersonalReportSummary {
  conversations: number; customerConversations: number; newConversations: number;
  customerMessages: number; businessReplies: number;
  verifiedEmployeeReplies: number; unlinkedOperatorReplies: number;
  automatedReplies: { ai: number; rule: number };
  businessPhoneReplies: number; broadcastMessages: number;
  waits: number; missed: number; recalled: number; unrecovered: number; pending: number;
  waitingConversations: number;
  excluded: { ownNumber: number; internal: number };
}

export interface PersonalReportResult {
  summary: PersonalReportSummary;
  response: ResponseMetrics;              // computeResponseMetrics(waits, humanWaits) — reused
  employeeAnsweredHumanWaits: number;     // human waits ended by OPERATOR with memberId
  conversations: PersonalConversationRow[]; // sorted by customerMessages desc, then key
  buckets: Array<{ key: string; customerMessages: number; businessReplies: number; verifiedEmployeeReplies: number; waits: number; missed: number; recalled: number }>;
  members: Array<{ memberId: string; verifiedReplies: number; conversations: number; humanWaitsAnswered: number; medianSeconds: number | null }>;
  waits: ReportWait[];                    // groupKey = conversationKey
  humanWaits: HumanWait[];
}

export function computePersonalReport(messages: readonly PersonalReportMessage[], opts: PersonalReportOptions): PersonalReportResult;
```

Implementation contract: filters `excluded`; calls `computeTeamReport` (06 §4) and `humanWaits`;
everything else is straightforward counting. No new wait logic.

### 1.4 `combinedReport.ts`

```ts
export type Additivity = "ADDITIVE" | "RECOMPUTED" | "ADDITIVE_DIFFERENT_UNITS" | "GROUP_ONLY" | "NOT_COMBINABLE";
export interface CombinedLine { label: string; group: number | string | null; personal: number | string | null; combined: number | string | null; additivity: Additivity; note: string }
export function combineReportSummaries(input: {
  group: { summary: TeamReportSummary; response: ResponseMetrics; waits: readonly ReportWait[]; humanWaits: readonly HumanWait[]; groupsWithMessages: number };
  personal: PersonalReportResult;
}): CombinedLine[];
```

Lines and additivity exactly as 05 §4. Medians via `responseStats` / `median` over concatenated waits.

### 1.5 `replyAttribution.ts`
As 06 §3 (`ReplyEvidenceMessage`, `computeReplyAttribution`, `ReplyAttributionResult`, tiers).

### 1.6 `runMetadata.ts`
As 06 §5.2–5.3 (`ReportRunMetadata`, `buildReportRunMetadata`, `runMetadataLines`,
`DataQualityCounts`, `dataQualityLines(counts, scope)`, `LATE_ARRIVAL_MINUTES`,
`IDENTITY_MODE_STATEMENT`).

### 1.7 `identityPreview.ts`
As 04 §4.1.

## 2. apps/web server

### 2.1 `@/server/teamReport.ts` — two opt-in options, legacy path untouched

```ts
export async function loadTeamReport(
  filters: TeamReportFilters,
  now: Date,
  onlyWhatsappGroupId?: string,
  options: {
    storedBy?: Date;
    /** NEW. Adds quote/mention evidence and returns `replyEvidence`. Off = the exact HEAD SQL. */
    withReplyEvidence?: boolean;
    /** NEW. Classify with this identity instead of loadReportIdentity() — the identity preview's KPI estimate only. */
    identity?: ReportIdentity;
  } = {},
): Promise<TeamReportData>;

// TeamReportData gains (optional, absent unless asked):
replyEvidence?: ReplyEvidenceMessage[];
```

SQL when `withReplyEvidence`: in the main query's inner SELECT add
`q."whatsappMessageId" AS "quotedWamid", m."mentionedPhones" AS mentions` and
`LEFT JOIN "Message" q ON q."id" = m."quotedMessageId" AND q."projectId" = ${projectId}`; outer
SELECT carries both through; the "earlier" query selects `NULL::text AS "quotedWamid", NULL::text[] AS mentions`.
Build with `Prisma.sql` fragments that are `Prisma.empty` when the option is off, so the off SQL
text is identical to HEAD (asserted by `teamReportParity` test via a captured-SQL comparison or, at
minimum, identical results). `customerIds` = `parseStoredCopies(row.copies)` → each copy's
`parseWhatsAppId(senderJid ?? senderPhone)?.user`, sorted unique (only for CUSTOMER).
`quotedKey` = `logicalMessageKey(row.wgid, row.quotedWamid)` when present.

### 2.2 `@/server/personalReport.ts` (new)

```ts
export interface PersonalReportData {
  filters: TeamReportFilters;           // reused filter shape; groupKeys ignored (note)
  range: ResolvedRange;
  result: PersonalReportResult;
  reliabilityCounts: ReliabilityCounts; // same shape as group, over personal rows
  dataQuality: DataQualityCounts;
  conversationNames: Map<string, string>; // conversationKey → newest incoming senderName or personalChatFallbackName(chatId)
  accountLabels: Map<string, string>;
  memberNames: Map<string, string>;
  filterNote: string | null;
  computedAt: number;
}
export async function loadPersonalReport(
  filters: TeamReportFilters,
  now: Date,
  options?: { storedBy?: Date; identity?: ReportIdentity; onlyConversationKey?: string },
): Promise<PersonalReportData>;
```

SQL (main):

```sql
SELECT DISTINCT ON (c.aid, c.chat, c.k)
  c.aid, c.chat, c.wamid, c.ts, c."storedAt", c.direction, c."fromTeam", c.sender, c."senderJid", c."senderName",
  c.copies, c.body, c."obMatched", c."actionType", c."ruleId", c."createdById"
FROM (
  SELECT m."accountId" AS aid, m."chatId" AS chat, ${messageKeySql()} AS k, m."id" AS mid,
         m."whatsappMessageId" AS wamid, m."timestampWa" AS ts, m."createdAt" AS "storedAt",
         m."direction"::text AS direction, m."isFromTeamMember" AS "fromTeam",
         m."senderPhone" AS sender, m."senderJid" AS "senderJid", m."senderName" AS "senderName",
         ${storedCopiesSql(Prisma.sql`m."accountId", m."chatId"`)} AS copies,
         (m."direction" = 'OUTGOING') AS p1, (left(m."whatsappMessageId", 5) = 'true_') AS p2, m."isFromTeamMember" AS p3,
         ${bodyOf("m")} AS body,
         o."obMatched", o."actionType"::text AS "actionType", o."ruleId", o."createdById"
  FROM "Message" m
  ${outboundByKeyJoin(projectId, contextStart, lookaheadEnd, "m")}
  WHERE m."projectId" = ${projectId} AND ${PERSONAL_CHAT_SQL}
    AND m."timestampWa" >= ${contextStart} AND m."timestampWa" < ${lookaheadEnd}
    AND m."createdAt" <= ${storedBy}
    ${accountFilter}
) c
ORDER BY c.aid, c.chat, c.k, c.p1 DESC, c.p2 DESC, c.p3 DESC, c.ts, c.mid
```

Note `storedCopiesSql(groupKey)` takes a `Prisma.Sql` partition expression; passing
`m."accountId", m."chatId"` is valid inside `PARTITION BY`. `bodyOf` is the same helper as in
teamReport.ts — move it to `@/server/messageIdentity.ts` as `prefilteredBodySql(alias)` and import
it from both (pure move; teamReport parity test guards it).

SQL (earlier probe, one per active conversation, on `Message_personal_chat_idx`):

```sql
SELECT r.aid, r.chat, p."timestampWa" AS ts, p.<same columns as above>
FROM (SELECT DISTINCT m."accountId" AS aid, m."chatId" AS chat FROM "Message" m
      WHERE m."projectId" = ${projectId} AND ${PERSONAL_CHAT_SQL}
        AND m."timestampWa" >= ${range.start} AND m."timestampWa" < ${lookaheadEnd} AND m."createdAt" <= ${storedBy} ${accountFilter}) r
CROSS JOIN LATERAL (
  SELECT x.* FROM "Message" x
  WHERE x."projectId" = ${projectId} AND x."accountId" = r.aid AND x."groupId" IS NULL AND x."chatId" = r.chat
    AND x."timestampWa" < ${contextStart} AND x."direction" <> 'SYSTEM'
  ORDER BY x."timestampWa" DESC LIMIT 1
) p
${outboundByKeyJoin(projectId, contextStart, lookaheadEnd, "p")}
```

Plus: `count(*)` of stored copies in the period (personal), and `loadDataQualityCounts` (2.3).
Classification: `identity.classify(row, ts)` exactly as the group loader; `excluded` built from
`isOwnSender(ownIds, null, chat)` (OWN_NUMBER) and any in-window INCOMING classified `kind=MEMBER`
(INTERNAL). Scope predicate built with the same Team/member logic as `loadTeamReport` (extract the
~25 lines that compute `teamId`, `memberId`, `filterNote`, `scope` into an exported
`resolveTeamScope(filters, members, teams, intervals, range)` in teamReport.ts and call it from both
— a pure move; parity tests guard it).

### 2.3 `@/server/unifiedReporting.ts` (new)

```ts
export async function isUnifiedReportingEnabled(): Promise<boolean>;
export async function resolvePageScope(params: Record<string, string | undefined>, session: Session): Promise<{ scope: ReportScope; note: string | null; enabled: boolean; canViewPersonal: boolean }>;
export async function loadDataQualityCounts(input: {
  kind: "GROUP" | "PERSONAL"; start: Date; end: Date; storedBy?: Date; accountId?: string | null; groupKeys?: string[];
}): Promise<DataQualityCounts>;
export async function loadPendingReattributions(): Promise<number>; // identityReattribution.count PENDING|RUNNING
```

`loadDataQualityCounts` SQL (GROUP; PERSONAL swaps the JOIN for `PERSONAL_CHAT_SQL`, and a second
FILTER counts `m."groupId" IS NULL AND NOT (PERSONAL_CHAT_SQL)` as `excludedNonConversation`):

```sql
SELECT
  count(*) FILTER (WHERE m."direction" <> 'SYSTEM')::int AS stored,
  count(*) FILTER (WHERE m."direction" = 'SYSTEM')::int AS system,
  count(*) FILTER (WHERE m."loadedFromHistoryAt" IS NOT NULL)::int AS history,
  count(*) FILTER (WHERE m."loadedFromHistoryAt" IS NULL AND m."createdAt" > m."timestampWa" + make_interval(mins => ${LATE_ARRIVAL_MINUTES}))::int AS late,
  count(*) FILTER (WHERE m."revokedAt" IS NOT NULL)::int AS revoked
FROM "Message" m JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
WHERE m."projectId" = ${projectId} AND m."timestampWa" >= ${start} AND m."timestampWa" < ${end}
  AND m."createdAt" <= ${storedBy} ${groupFilter} ${accountFilter}
```

### 2.4 Identity preview
`@/server/identityPreview.ts` (`loadIdentityPreviewInput`, `estimateIdentityKpiDeltas`) and
`@/server/actions/identityPreview.ts` (`previewTeamMemberIdentityChange`) — 04 §4.

### 2.5 `@/server/teamReportTables.ts`

```ts
export type TeamReportTableId = "members" | "days" | "groups" | "personal-conversations" | "personal-days" | "personal-members";
export function buildPersonalConversationsTable(data: PersonalReportData, opts: { linkToChat: boolean }): ReportTableData;
export function buildPersonalBucketsTable(data: PersonalReportData): ReportTableData;
export function buildPersonalMembersTable(data: PersonalReportData): ReportTableData;
```

`buildReportTable(id, data)` keeps its signature for the three legacy ids; a new
`buildPersonalReportTable(id, data)` handles the `personal-*` ids (no union-typed `data` param, so
legacy callers do not change).

## 3. Page and URL

`/p/<slug>/team-report` (and the Main Admin Workspace rewrite of it — no change needed there).

- New URL param **`scope=group|personal|combined`**. Absent ⇒ `group`. `teamReportQuery(filters, overrides)`
  writes `scope` only when it is not `group` (so every existing link, preset and export URL is
  unchanged). Add `scope?: ReportScope` to `TeamReportFilters` and to `parseTeamReportFilters`
  (via `parseReportScope`).
- The scope selector renders only when `enabled && canViewPersonal`: a 3-option segmented control
  in `TeamReportFilters.tsx` ("Groups" | "Personal chats" | "Both"), submitted with the existing GET
  form (hidden input when not shown).
- Page composition (`team-report/page.tsx`):
  - `enabled === false` → render the HEAD page unchanged (no run panel, no new sections).
  - `scope = group` → HEAD page + `<RunInformation meta>` (collapsed `<details>` under the header
    line) + Reliability section gets the "Collection detail" lines + `<CustomerSpecificReplies>`
    section (after the Groups table, before Reliability) when `withReplyEvidence` ran.
  - `scope = personal` → header "Team Report — personal chats"; StatTiles: Conversations, Customer
    messages, Verified employee replies (hint: "+ N automated · N business phone · N dashboard
    (unlinked)"), Waiting now, Missed (hint never answered), Recall, Median first response, Median
    first human response; ChartCard ColumnChart "Personal chat activity" (buckets); ReportDataTables
    for personal-members (hidden when a member is chosen), personal-days, personal-conversations;
    `ReliabilitySection` reused with personal `response` + reliability; `DataHealthStrip` reused;
    `RunInformation`.
  - `scope = combined` → the group page's tiles block, a `<CombinedSummaryTable lines>` card
    (Groups | Personal | Combined | "How combined" column showing the additivity label in words),
    then group tables, then personal tables, each under an `<h2>`; reliability for both.
- New components in `team-report/`: `RunInformation.tsx` (server component; `<details>` with
  `runMetadataLines`), `CustomerSpecificReplies.tsx` (StatTiles + `StackedBar` of
  TIER1/TIER2 mention/TIER2 sequence/unresolved, using `--chart-1..4` identity colours, never
  status colours), `CombinedSummaryTable.tsx` (plain `Table`), `ScopeSelector.tsx` (client, inside
  the filters form). Reuse `Card`, `StatTile`, `ChartCard`, `ColumnChart`, `StackedBar`,
  `ReportDataTable`, `Alert`, `HelpSection`. No new UI library, no charting library.
- Help (`CalculationHelp`): when `enabled`, add HelpSections "Personal chats", "Groups and personal
  together", "Customer-specific replies", "Run information"; the existing sentence "One-to-one
  (personal) chats are not counted here" is kept for `scope=group` and replaced by a scope-aware
  sentence only when enabled.
- Group drill-down `team-report/group/[groupId]/page.tsx`: with the flag on, load with
  `withReplyEvidence` and render the per-ask list (`asksDetail`) under the existing waits list:
  asked at, customer (`describeSenderId`), answered at, linked by (tier words), answered by.

## 4. Exports

`/p/<slug>/api/team-report/export?…&scope=…&format=csv|xlsx` (same route).

- Gates: `requireAccess("support_activity.view")` (as today) + when `scope ≠ group`:
  `hasPermission(session, "messages.view")` else the scope silently resolves to group exactly as the
  page does (`resolvePageScope`), so the file matches the page.
- Flag off ⇒ byte-identical output (parity test).
- CSV: `scope=group` unchanged; `scope=personal` → personal conversations table (columns:
  Conversation, Account, Chat type (Phone / Hidden number), Customer messages, Business replies,
  Verified employee replies, Automated replies, Waits, Missed, Recall, Never answered, Median first
  response (h m), Waiting now, First message, Last message); `scope=combined` → the CombinedLine table
  (Figure, Groups, Personal, Combined, How combined, Note). UTF-8 BOM + header always (existing `toCsv`).
- Excel (flag on), sheets appended in this order after the existing ones:
  - "Run information" (every scope) — `runMetadataLines`.
  - "Customer-specific replies" (group/combined when evidence ran) — summary lines + byGroup rows.
  - "Personal summary", "Personal conversations", "Personal by <granularity>", "Personal members"
    (personal/combined).
  - "Combined" (combined) — with the `How combined` (additivity) column.
  - The existing "Data quality" sheet gains the "Collection detail" lines.
  - For `scope=personal` the group sheets (Summary/Team Members/Groups/period/Missed & Recall) are
    NOT written; the workbook starts with "Personal summary".
- File name: existing pattern + ` - personal` / ` - groups and personal` suffix when scope ≠ group.
- Every text cell through `sanitizeExcelRow`; no message text anywhere; personal display names are
  sanitized like group names.
- `table-export` route: accepts the three `personal-*` table ids; same gates.

## 5. Identity preview UI

- `team-members/[id]/edit` form and the add form: a secondary button "Preview impact" (flag on only)
  that calls `previewTeamMemberIdentityChange` with the form's current phone/WhatsApp id/attributeFrom
  values; renders `<IdentityImpactPanel>` (new, `components/teamMembers/IdentityImpactPanel.tsx`):
  window, examined vs affected counts, groups/personal conversations, transitions table
  (from → to → count, member names resolved client-side from the existing members list), per-member
  gained/lost, impacted months, the KPI estimate table (field, before, after, Δ) with the label
  "estimate for <month>, affected groups only", and a hidden `previewDigest` input inside the form.
- Chat contact panel link (`linkWhatsAppSender`): same panel in a disclosure before "Link".
- Copy rules: counts only; "Reports change as soon as you save; history sync updates stored
  records in the background." No message text, no customer numbers in samples (conversation names
  via `describeSenderId`/group name).

## 6. Implementation plan

The ordered work packages (WP1–WP9), their files, tests and acceptance checks, and the deferred list
are in `00-implementation-plan.md`.
