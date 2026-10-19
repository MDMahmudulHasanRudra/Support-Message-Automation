# 06 — Algorithms and metric definitions

## 1. Metric comparison matrix (legacy vs enhanced)

"Legacy" = Team Report at HEAD `a3c0c60` (`computeTeamReport`, `computeResponseMetrics`,
`computeReportingReliability`). **Every legacy figure keeps its value and meaning**; "enhanced"
figures are new and sit beside them.

| Figure | Legacy (group) | Enhanced — group | Enhanced — personal | Combined |
|---|---|---|---|---|
| Customer messages | CUSTOMER logical msgs in period | unchanged | CUSTOMER msgs in non-excluded 1:1 chats | additive |
| Team replies (`memberReplies`) | MEMBER msgs (incl. linked-login OPERATOR) | unchanged | n/a — see verified employee replies | group only |
| Business replies | BUSINESS msgs | unchanged | all non-CUSTOMER msgs not employee-credited | additive |
| Verified employee replies | — | — (group: = memberReplies minus unattributed) | OPERATOR + linked member only | additive (group memberReplies − unattributedStaffReplies + personal) |
| Waits / Missed / Recall / Never answered | Team Report wait, any reply closes | unchanged | same algorithm, per conversation, threshold = missedReplyAfterMinutes, no charge-to | additive |
| First observed response (median/p90) | `responseStats(waits)` | unchanged | `responseStats(personalWaits)` | recomputed over union |
| First human response | `humanWaits` (verified = MEMBER/OPERATOR) | unchanged | same function over personal intel msgs | recomputed over union |
| Who closed the wait (6 categories) | `firstReplyBy` | unchanged | same categories | additive |
| Customer-specific response (per customer, Tier1/2) | — | NEW section: asks, linked by quote/mention/sequence, median customer-specific wait | not needed (1:1 = one customer; personal wait IS customer-specific) | not combined |
| Groups supported, active members | as today | unchanged | — | group only |
| Support time / Overtime | group timeline | unchanged | not computed in v1 | group only |
| Waiting now | — (Team Performance's `getGroupsAwaitingReply` elsewhere) | — | `waitingConversations` | not combined |
| Stored copies / logical / duplicates | reliability counts | unchanged + run metadata | same counts over personal rows | shown per scope |
| Attribution strength / conflicts / unidentified | reliability counts | unchanged | identity coverage (OPERATOR linked/unlinked, internal chats) | per scope |
| Collection gaps / incomplete / unverified days | `computeReportingReliability` | unchanged | same (account-level) | same (shown once) |
| Late-arriving, loaded from history, revoked, excluded | — | NEW counts (§5) | NEW counts | per scope |
| Pending re-attributions | Team Members identity check only | NEW line in run metadata | same | same |

## 2. Event-time, time zone and boundary rules (all scopes)

1. **Event time = `Message.timestampWa`** (WhatsApp's own time). `createdAt` (stored time) is used
   ONLY for (a) the `storedBy` export bound, (b) same-second tie-break, (c) late-arrival counts.
2. **Period is half-open `[start, end)`**, both Asia/Dhaka midnights (`resolveTeamReportRange`).
   Day/week(Sunday start)/month buckets via `bucketKeyFor` / `formatDhakaDateKey`.
3. **Context** `[start − 4 h, start)` + each conversation's last earlier message: read, never counted.
4. **Look-ahead** `[end, end + 24 h)`: only replies to waits that started inside the period.
5. **measuredTo** = `min(now, end + 24 h)`; a wait unanswered at measuredTo and older than its
   threshold is MISSED, else PENDING.
6. **Ordering:** `(ts asc, storedAt asc)` then the loader's stable order — the Team Report's exact
   order; every new algorithm consumes messages in this order and must not re-sort with a
   different key.
7. **Data cutoff:** page = now (reads everything stored); export with `asof` = `storedBy = asof + 5 s`
   (`exportStoredBy`). The run metadata prints both `generatedAt` and `dataCutoff`.
8. **SQL time zone:** any new SQL that buckets by day must use
   `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'` (CLAUDE.md: single-argument form is a bug). v1
   adds no SQL bucketing (all bucketing is in TS).
9. Future-dated rows: `lastMessageAt` already clamps to `≤ now` (`loadDataHealth`); new code follows.

## 3. Customer-specific reply attribution (groups)

Purpose: in a GROUP, the legacy wait is per group ("somebody replied in the group"). This section
answers, beside it, "which customer did that reply answer?", only from evidence.

### 3.1 Inputs (all from `Message`, via the opt-in evidence columns of `loadTeamReport`)

```ts
export interface ReplyEvidenceMessage {
  key: string;                // logicalMessageKey(wgid, wamid)
  groupKey: string;           // wgid
  ts: number;
  kind: "CUSTOMER" | "MEMBER" | "BUSINESS";
  actor: IntelActor;
  memberId: string | null;
  customerIds: string[];      // CUSTOMER only: user parts of every incoming copy's senderJid ?? senderPhone, sorted unique
  quotedKey: string | null;   // logical key of Message.quotedMessageId's row (same group), else null
  mentionedIds: string[];     // Message.mentionedPhones (kept copy), digits-only
  inPeriod: boolean;
}
```

Evidence limits (see `02-openwa-capability-matrix.md` §2.3): `quotedMessageId` is resolved by the
pipeline on the SAME account only and is null when WhatsApp did not load the quoted message
(`isQuotedMsgAvailable: false`) — such replies fall through to Tier2/Tier4, never guessed. Because the
quote is mapped to its LOGICAL key here, a quote resolved on account A still links to the customer
whose ask was kept from account B's copy. `mentionedPhones` drops the domain, so a mentioned LID and a
mentioned phone are both compared by user part against the customer cluster's ids — correct for both
because cluster ids are user parts too. Counting "reply quoted something we could not resolve" needs a
worker counter (02 recommendation 3) and is DEFERRED (no worker change in release 1).

### 3.2 Tiers

```ts
export const REPLY_LINK_TIERS = ["TIER1_QUOTE", "TIER2_MENTION", "TIER2_SEQUENCE", "TIER3_PROBABLE", "TIER4_UNRESOLVED"] as const;
export type ReplyLinkTier = (typeof REPLY_LINK_TIERS)[number];
export const VERIFIED_LINK_TIERS: ReadonlySet<ReplyLinkTier> = new Set(["TIER1_QUOTE", "TIER2_MENTION", "TIER2_SEQUENCE"]);
export const REPLY_ATTRIBUTION_VERSION = "reply-attribution-1";
```

`TIER3_PROBABLE` is RESERVED in v1 (never produced; the enum keeps it so exports and UI need no
change later). AI-suggested links never use any tier value (§6).

### 3.3 Algorithm — `computeReplyAttribution(messages, opts)` (pure)

```ts
export function computeReplyAttribution(
  messages: readonly ReplyEvidenceMessage[],   // already in Team Report order (§2.6)
  opts: { rangeStart: number; rangeEnd: number; measuredTo: number; thresholdMs: (groupKey: string, at: number) => number; sequenceWindowMs?: number /* default 4 h = DEFAULT_CASE_GAP_MS */ },
): ReplyAttributionResult;
```

Step 0 — customer identity clusters (union-find, whole input): for each CUSTOMER message, union all
its `customerIds` (copies of ONE message name ONE person, so a LID and a phone seen on two accounts
are joined). `customerKey(id)` = lexicographically smallest id in its cluster. Deterministic.

Step 1 — per group, walk messages in order, keeping `open: Map<customerKey, Ask>`:

```ts
interface Ask { customerKey: string; groupKey: string; askedAt: number; askKey: string; keys: Set<string>; lastAt: number }
```

- CUSTOMER message `c` (key K = customerKey of c.customerIds[0]; a message with no ids is skipped
  as `NO_CUSTOMER_ID` and counted): if `open.has(K)` → add `c.key` to its `keys`, set `lastAt`;
  else open a new Ask. Also record `lastCustomerSpokeAt[K] = c.ts`.
- A reply `r` (kind MEMBER or BUSINESS, actor ≠ BROADCAST; broadcasts are counted as
  `NOT_A_REPLY`) is linked by the FIRST rule that yields exactly one candidate:
  1. **TIER1_QUOTE**: `r.quotedKey` is in some Ask's `keys` → that Ask. If `r.quotedKey` is a
     CUSTOMER message whose Ask is already closed → link recorded as `TIER1_QUOTE` with
     `closesAsk: false` (a follow-up answer; does not reopen anything). If it quotes a non-customer
     message → fall through.
  2. **TIER2_MENTION**: candidates = open Asks whose cluster contains any `r.mentionedIds` value
     (compare digits: `normalizePhoneNumber(id) ?? id`). Exactly one → link. Two or more → stop:
     `TIER4_UNRESOLVED` reason `MULTIPLE_MENTIONED`.
  3. **TIER2_SEQUENCE**: exactly one open Ask in the group AND `r.ts − ask.lastAt ≤ sequenceWindowMs`
     AND no OTHER customer cluster spoke in the group in `(ask.askedAt, r.ts)` (the "no
     contradicting candidate" condition) → link.
  4. Otherwise `TIER4_UNRESOLVED` with reason `NO_OPEN_ASK` | `MULTIPLE_OPEN_ASKS` |
     `OTHER_CUSTOMER_SPOKE` | `OUTSIDE_WINDOW`.
- A Tier1/Tier2 link with an open Ask closes it: `answeredAt = r.ts`, `answeredBy = { actor,
  memberId }`, `tier`. An UNRESOLVED reply closes nothing.
- Same-timestamp ties: order is the input order (§2.6). Multiple Asks quoted at once is impossible
  (one quote per message). Union-find root choice is lexical → stable.

Step 2 — close out: Asks still open at the end are `UNANSWERED` (older than the group's threshold at
`askedAt` at `measuredTo`) or `PENDING`. Only Asks with `askedAt ∈ [rangeStart, rangeEnd)` are
counted; replies are counted when `r.inPeriod` OR they close a counted Ask (look-ahead).

### 3.4 Output

```ts
export interface ReplyAttributionResult {
  version: typeof REPLY_ATTRIBUTION_VERSION;
  asks: { total: number; answeredTier1: number; answeredTier2Mention: number; answeredTier2Sequence: number; unanswered: number; pending: number; noCustomerId: number };
  replies: { total: number; byTier: Record<ReplyLinkTier, number>; unresolvedReasons: Record<string, number>; notAReply: number };
  /** Median / p90 customer-specific wait over asks answered by a VERIFIED tier only. */
  customerSpecificWait: { medianSeconds: number | null; p90Seconds: number | null; samples: number };
  /** Per group: asks and how they were answered — the drill-down. */
  byGroup: Array<{ groupKey: string; asks: number; answeredVerified: number; unanswered: number; repliesUnresolved: number }>;
  /** Per member (verified tiers only): asks they answered and median wait. */
  byMember: Array<{ memberId: string; asksAnswered: number; medianSeconds: number | null }>;
  /** Drill-down detail (one group): never text. */
  asksDetail?: Array<{ groupKey: string; customerKey: string; askedAt: number; answeredAt: number | null; tier: ReplyLinkTier | null; answeredBy: { actor: IntelActor; memberId: string | null } | null }>;
}
```

`asksDetail` is filled only when the caller passes one group (drill-down). `customerKey` is shown in
UI through `describeSenderId` (phone formatted, LID shown as "Hidden number ···1234") — never raw.

### 3.5 Presentation rules

- Shown as "Customer-specific replies (evidence-based)" BESIDE the group wait figures; the headline
  group figures are not changed by it.
- "Unanswered" here is NOT "Missed": a reply nobody can link to a customer is not evidence that the
  customer was ignored. Copy: "No reply could be linked to this customer by quote, mention or
  sequence."
- Never a percentage of "accuracy"; tiers are counts.

## 4. Personal chats: first observed vs first human response

- Build `ReportMessage[]` with `groupKey = conversationKey` and run the UNCHANGED
  `computeTeamReport(messages, { rangeStart, rangeEnd, now, idleGapMs, missedAfterMs: () => missedReplyAfterMinutes*60_000, assignedMemberFor: () => null, memberId: null, scope: null, granularity, dutyFor: null })`.
  Read only `result.waits`, `summary.customerMessages`, `summary.businessReplies`,
  `summary.memberReplies`, `buckets[].customerMessages/memberMessages/businessReplies/missed/recalled`.
  IGNORE `members`, `overtimeDays`, `activeSeconds`, `groupsSupported` (group concepts).
  Rationale: zero change to the legacy function, identical wait semantics.
- First observed response = `responseStats(result.waits)` + `firstReplyBy` from
  `computeResponseMetrics({ waits, humanWaits })` (reused as is).
- First human response = `humanWaits(intel, { rangeStart, rangeEnd, measuredTo, thresholdMs })`
  over `IntelMessage`s built exactly as `loadTeamReport` builds them (`groupKey = conversationKey`,
  `text` = prefiltered body so closing remarks are recognised, `quotedKey: null`,
  `mentionedMemberIds: []`).
- Verified human (existing rule) = MEMBER or OPERATOR. Employee-credited (new, personal) =
  OPERATOR with memberId. `humanWaits` is not changed; the employee split is computed from
  `HumanWait.repliedBy.memberId`.

## 5. Run metadata and data quality

### 5.1 Calculation versions

New `packages/shared/src/unifiedReporting/versions.ts`:

```ts
/** The group Team Report algorithm exactly as at a3c0c60 (teamReport.ts + teamReportReliability.ts). */
export const GROUP_CALCULATION_VERSION = "group-2026.10.19";
export const PERSONAL_CALCULATION_VERSION = "personal-1";
export const COMBINED_CALCULATION_VERSION = "combined-1";
export { REPLY_ATTRIBUTION_VERSION } from "./replyAttribution.js";
export { IDENTITY_PREVIEW_VERSION } from "./identityPreview.js";
```

Rule: any change to a figure's meaning bumps the version string in the same commit;
`versions.test.ts > group version is pinned` asserts the literal so a bump is a deliberate edit.

### 5.2 `ReportRunMetadata`

```ts
export interface ReportRunMetadata {
  report: "team-report";
  scope: ReportScope;
  calculationVersions: string[];       // group → [GROUP]; personal → [PERSONAL]; combined → [GROUP, PERSONAL, COMBINED]; + REPLY_ATTRIBUTION when that section ran
  timezone: "Asia/Dhaka";
  generatedAt: number;                 // report `now`
  dataCutoff: number;                  // storedBy (export asof) or generatedAt
  period: { start: number; end: number; label: string; contextMs: number; lookaheadMs: number };
  filters: Array<{ label: string; value: string }>; // period, team, member, groups(count), account, scope, granularity
  identityMode: string;                // IDENTITY_MODE_STATEMENT
  collection: { status: DataHealthStatus; gaps: number; incompleteGaps: number; recoveredMessages: number; daysTotal: number; daysIncomplete: number; daysUnverified: number; lastMessageAt: number | null; lastProcessedAt: number | null };
  identity: { logicalMessages: number; strong: number; single: number; linkedLogin: number; unlinkedOperator: number; conflicting: number; unidentifiedStaffSenders: number; pendingReattributions: number };
}
export function buildReportRunMetadata(input: {...}): ReportRunMetadata;   // pure
export function runMetadataLines(meta: ReportRunMetadata): Array<{ label: string; value: string; note: string }>;
```

### 5.3 Data-quality counts (new, counts only)

```ts
export interface DataQualityCounts {
  storedCopies: number;          // non-SYSTEM rows in period (same as ReliabilityCounts.storedCopies for group)
  excludedSystem: number;        // direction = SYSTEM
  excludedNonConversation: number; // personal scope only: groupId IS NULL and not PERSONAL_CHAT_SQL (status/newsletter/orphaned @g.us)
  excludedOwnNumberChats: number;  // personal: conversations excluded as our own numbers
  excludedInternalChats: number;   // personal: conversations with a roster member
  lateArriving: number;          // createdAt > timestampWa + LATE_ARRIVAL_MINUTES and loadedFromHistoryAt IS NULL
  loadedFromHistory: number;     // loadedFromHistoryAt IS NOT NULL
  revoked: number;               // revokedAt IS NOT NULL (kept and counted)
}
export const LATE_ARRIVAL_MINUTES = 15; // = the worker's CATCHUP_AUTOMATION_WINDOW_MINUTES default; a message stored later than this was recovered, not seen live
```

Lines are appended under a new heading "Collection detail" in the Reliability section and the
Excel "Data quality" sheet — counts and plain notes, no score, no percentage (the existing
"a test refuses one" rule extends: `runMetadata.test.ts > no line value is a percentage`).

## 6. AI enrichment (interface only, no implementation)

`packages/shared/src/unifiedReporting/enrichment.ts`:

```ts
export interface ReplyLinkSuggestion {
  replyKey: string;
  customerKey: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  source: "AI";
  /** Provider/model id for audit, e.g. AiModelConfig id. */
  modelRef: string;
}
export interface ReplyLinkEnricher {
  /** Only UNRESOLVED replies are ever offered; returns suggestions, never decisions. */
  suggest(input: { groupKey: string; unresolvedReplyKeys: readonly string[] }): Promise<ReplyLinkSuggestion[]>;
}
export interface IdentityHintEnricher {
  suggestRosterMatches(input: { senderIds: readonly string[] }): Promise<Array<{ senderId: string; memberId: string; confidence: "LOW" | "MEDIUM" | "HIGH"; source: "AI"; modelRef: string }>>;
}
```

Invariants (documented on the interface and asserted by a type-level test): a suggestion is never
counted in any `VERIFIED_LINK_TIERS` total, never changes an `AttributionOutcome`, is shown (if ever)
under its own "AI-suggested (not verified)" label, and any implementation must go through
`packages/ai-client` (text-only) — no tool calling, no new provider. No implementation ships in v1.

## 7. Determinism and testing rules for every new pure function

- Input order = Team Report order; functions must not depend on `Map` insertion order for output
  (sort explicitly with a total order: ts, then key).
- No `Date.now()` inside pure functions — `now`/`measuredTo` are parameters.
- Every pure function gets a "same input twice → deep-equal" test and a "shuffled equal-timestamp
  input keeps the documented tie-break" test.
- Fixtures use synthetic ids (`100000000001@lid`, `8801000000001@c.us`, group `120000000000000001@g.us`).
