# 04 — Identity and attribution spec

Baseline: `packages/shared/src/whatsappIdentity.ts` (`createSenderResolver`, `attributeAcrossCopies`,
`SenderMatchStatus`), `apps/web/src/server/messageIdentity.ts` (`createReportClassifier`,
`loadReportIdentity`, `loadOwnSenderIds`), `apps/web/src/server/reattribution.ts`
(`queueReattribution`), worker `teamManagement/reattribution.ts`, WHATSAPP_IDENTITY.md §3/§10.

**Hard rule carried forward:** there is ONE classifier. Nothing in this upgrade decides who sent a
message any other way. The new things in this document are (a) a reporting-facing *outcome* label
derived from the classifier's existing output, and (b) a read-only *preview* that runs the same
classifier twice (current roster vs proposed roster).

## 1. Attribution outcome enum (derived, never stored)

New file `packages/shared/src/unifiedReporting/attributionOutcome.ts`.

```ts
export const ATTRIBUTION_OUTCOMES = [
  "VERIFIED_ID_AND_PHONE",      // person, both identifiers name the same member
  "VERIFIED_SINGLE_IDENTIFIER", // person, WhatsApp id only OR phone only
  "VERIFIED_LINKED_LOGIN",      // dashboard MANUAL_REPLY, login linked to a member (credited)
  "OPERATOR_UNLINKED",          // dashboard MANUAL_REPLY, login not linked to any member (verified person, no employee credit)
  "STAFF_CONFLICT",             // staff, identifiers name two members — nobody credited
  "STAFF_AMBIGUOUS",            // staff, identifier shared by several members — nobody credited
  "STAFF_UNMAPPED",             // stamped staff, roster no longer knows them (former/deleted member)
  "CUSTOMER",                   // nobody on the roster (or before the member's attributeFrom)
  "AUTOMATED_AI",
  "AUTOMATED_RULE",
  "BUSINESS_BROADCAST",
  "BUSINESS_PHONE",             // our number, matches no send of ours — a person nobody can name
  "NOT_A_PERSON",               // group/broadcast/newsletter id
] as const;
export type AttributionOutcome = (typeof ATTRIBUTION_OUTCOMES)[number];

/** Mapping from the existing classifier's decision. Pure. */
export function attributionOutcomeOf(d: {
  kind: "MEMBER" | "CUSTOMER" | "BUSINESS";
  memberId: string | null;
  actor: IntelActor;
  status: SenderMatchStatus | null;
}): AttributionOutcome;

/** Whether an outcome credits a NAMED employee (the only outcomes any per-member figure may use). */
export const isEmployeeCredited = (o: AttributionOutcome) =>
  o === "VERIFIED_ID_AND_PHONE" || o === "VERIFIED_SINGLE_IDENTIFIER" || o === "VERIFIED_LINKED_LOGIN";
```

Mapping table (exhaustive; the unit test `attributionOutcome.test.ts > maps every classifier
decision` iterates every `IntelActor` × `SenderMatchStatus | null` combination the classifier can
produce):

| classifier `actor` | `status` | `memberId` | → outcome |
|---|---|---|---|
| MEMBER | WHATSAPP_ID_AND_PHONE_MATCH | set | VERIFIED_ID_AND_PHONE |
| MEMBER | WHATSAPP_ID_MATCH / PHONE_MATCH | set | VERIFIED_SINGLE_IDENTIFIER |
| OPERATOR | null | set | VERIFIED_LINKED_LOGIN |
| OPERATOR | null | null | OPERATOR_UNLINKED |
| MEMBER_UNMAPPED | CONFLICT | null | STAFF_CONFLICT |
| MEMBER_UNMAPPED | AMBIGUOUS | null | STAFF_AMBIGUOUS |
| MEMBER_UNMAPPED | any other / UNRESOLVED (stamp fallback) | null | STAFF_UNMAPPED |
| CUSTOMER | UNRESOLVED | null | CUSTOMER |
| CUSTOMER | NOT_A_PERSON | null | NOT_A_PERSON |
| AI | null | null | AUTOMATED_AI |
| RULE | null | null | AUTOMATED_RULE |
| BROADCAST | null | null | BUSINESS_BROADCAST |
| BUSINESS_PHONE | null | null | BUSINESS_PHONE |

Relation to the existing reliability vocabulary: `REPLY_CATEGORIES` (teamReportReliability.ts) stays
the page's six-way split. `AttributionOutcome` is finer and is used only by (a) the identity-coverage
lines of the run metadata, (b) the preview's transition matrix. `replyCategoryOf(actor)` is NOT
changed.

Note on "Tier"/"verified" vocabulary: an AttributionOutcome is about WHO SENT a message. A reply
TIER (06 §3) is about WHICH CUSTOMER a reply answered. Never mix the two words in UI copy:
"verified sender" vs "linked to a customer (quote / mention / sequence)".

## 2. Historical attribution modes (fixed per dimension, not user-selectable)

| Dimension | Mode | Source | Existing code |
|---|---|---|---|
| Who sent a message (identity) | **CURRENT ROSTER, read time** — corrections to identifiers apply retroactively; deactivated members still own history | `InternalTeamMember` (all statuses) + every stored copy | `loadReportIdentity`, `attributeAcrossCopies` |
| From when a member's messages count | **AS RECORDED: attributeFrom cut-off** at the message's own time | `InternalTeamMember.attributeFrom` | `resolve(phone, jid, at)`; also applied to linked-login replies (`createReportClassifier.linked`) |
| Fallback for a sender the roster no longer knows at all | **STORED STAMP** (`Message.isFromTeamMember`) | `Message` | `attributeAcrossCopies` last branch |
| Which Team a member was in | **AS AT EVENT** | `TeamMembership` intervals | `inTeamAt`, `membersOfTeamDuring` |
| Who owned a group / its SLA threshold | **AS AT EVENT (customer's ask time)** | `GroupResponsibilityChange` | `responsibilityAt`, `ReportWait.chargedTo` |
| Login → member link | **CURRENT LINK** (not dated; re-linking moves past dashboard replies — System Log keeps it) | `InternalTeamMember.userId` | `loadReportIdentity` comment |
| Personal-chat employee credit | same as login link (only VERIFIED_LINKED_LOGIN credits) | `OutboundMessage.createdById` | `outboundByKeyJoin` |

Decision: **no "roster as of date X" mode** (would need structure A, rejected in 03 §2). The run
metadata prints the identity mode line verbatim: *"Senders are identified with the team roster as it
is now; Team membership and group assignment are taken as they were at the time of each message."*
The constant lives in `packages/shared/src/unifiedReporting/runMetadata.ts`
(`IDENTITY_MODE_STATEMENT`).

## 3. What changes the attribution of stored history (input to the preview)

Exactly the actions that already call `queueReattribution` in
`apps/web/src/server/actions/teamMembers.ts`:

| Action | Line (HEAD) | Preview supported in v1 |
|---|---|---|
| `createTeamMember` (add one) | ~210 | yes (rosterBefore = current, rosterAfter = current + new) |
| add from group (bulk) | ~529 | yes, aggregated over all new members (cap 50 per preview) |
| `updateTeamMember` (phone / whatsappId / attributeFrom) | ~587 | yes |
| `linkWhatsAppSender` (chat contact panel) | ~659 | yes |
| add from identity check | ~819 | yes |
| login link (`userId`) change | (edit form) | **DEFERRED** — affects only OPERATOR replies; needs an `OutboundMessage.createdById` hit-set. Recorded as v2. |
| deactivate (`toggleTeamMemberStatus`) | — | not needed: reports pass every member regardless of status, so deactivation changes no report figure |

## 4. Preview algorithm

### 4.1 Pure function (packages/shared)

New file `packages/shared/src/unifiedReporting/identityPreview.ts`.

```ts
import type { RosterIdentity, StoredCopyIdentity } from "../whatsappIdentity.js";

export const IDENTITY_PREVIEW_VERSION = "identity-preview-1";
export const PREVIEW_DEFAULT_DAYS = 92;      // MAX_CUSTOM_DAYS of the Team Report
export const PREVIEW_MAX_DAYS = 365;         // ATTENDANCE_LOOKBACK_DAYS of the worker re-attribution
export const PREVIEW_MAX_LOGICAL = 20_000;   // beyond this the result says `truncated: true`

export interface PreviewRosterEntry extends RosterIdentity {
  /** InternalTeamMember.userId — the login link, for OPERATOR replies. */
  userId: string | null;
}

/** One logical message touched by the identifiers, with every stored copy as a witness. */
export interface PreviewMessage {
  logicalKey: string;
  conversationKind: "GROUP" | "PERSONAL";
  conversationKey: string;          // whatsappGroupId, or `${accountId}|${chatId}`
  ts: number;
  storedCopies: number;             // rows behind this logical message
  keptCopy: {                       // the copy DISTINCT ON keeps (preferSenderCopySql order)
    direction: "INCOMING" | "OUTGOING" | "SYSTEM";
    sender: string;
    senderJid: string | null;
    fromTeam: boolean;
    obMatched: boolean;
    actionType: string | null;
    ruleId: string | null;
    createdById: string | null;
  };
  incomingCopies: StoredCopyIdentity[];
}

export type AttributionLabel = "CUSTOMER" | "STAFF_UNIDENTIFIED" | "BUSINESS" | `MEMBER:${string}`;

export interface IdentityPreviewResult {
  version: typeof IDENTITY_PREVIEW_VERSION;
  window: { from: number; to: number };
  truncated: boolean;
  examined: { logicalMessages: number; storedMessages: number };
  affected: {
    logicalMessages: number;
    storedMessages: number;
    groups: number;                 // distinct GROUP conversationKeys with ≥1 changed message
    personalConversations: number;  // distinct PERSONAL conversationKeys with ≥1 changed message
  };
  /** previous → proposed, counted over changed logical messages, sorted by count desc. */
  transitions: Array<{ from: AttributionLabel; to: AttributionLabel; count: number }>;
  /** per member: messages they would gain / lose credit for. */
  byMember: Array<{ memberId: string; gained: number; lost: number }>;
  /** Dhaka days and months containing changed messages (period keys `YYYY-MM-DD` / `YYYY-MM`). */
  impactedDays: Array<{ day: string; changed: number }>;
  impactedMonths: Array<{ month: string; changed: number }>;
  /** Up to 20 sample changes for the UI — conversation key + time + labels only, NEVER text. */
  samples: Array<{ conversationKind: "GROUP" | "PERSONAL"; conversationKey: string; ts: number; from: AttributionLabel; to: AttributionLabel }>;
}

export function previewIdentityChange(input: {
  rosterBefore: readonly PreviewRosterEntry[];
  rosterAfter: readonly PreviewRosterEntry[];
  ownIds: ReadonlySet<string>;
  messages: readonly PreviewMessage[];
  window: { from: number; to: number };
  truncated: boolean;
}): IdentityPreviewResult;
```

Algorithm (deterministic):

1. Build `before = createReportClassifierPure(createSenderResolver(rosterBefore), ownIds, loginMap(rosterBefore))`
   and `after` likewise. **Prerequisite refactor (WP5):** move the body of
   `createReportClassifier` from `apps/web/src/server/messageIdentity.ts` into
   `packages/shared/src/whatsappIdentity.ts` as `createReportClassifier` (pure; it already has no
   Prisma dependency), and re-export it from messageIdentity.ts unchanged so every existing import
   keeps working. Test `whatsappIdentity.test.ts > createReportClassifier moved without change`
   re-runs the existing classifier cases against the shared export.
2. For each `PreviewMessage` `m`: `b = before.classify(rowOf(m), m.ts)`,
   `a = after.classify(rowOf(m), m.ts)` where `rowOf` builds a `ReportSenderRow` with
   `copies` = the `incomingCopies` re-serialised (or pass copies directly — add an optional
   `parsedCopies` field to `ReportSenderRow`, used before `copies` when present).
3. `label(d)` = `d.kind === "BUSINESS"` → `"BUSINESS"` unless `d.memberId` (linked login) →
   `MEMBER:<id>`; `d.memberId` → `MEMBER:<id>`; `d.kind === "MEMBER"` → `"STAFF_UNIDENTIFIED"`;
   else `"CUSTOMER"`.
4. Changed iff `label(b) !== label(a)`. Accumulate affected sets, transitions, byMember
   (`MEMBER:x` in `b` and not in `a` → x.lost++; reverse → gained++), Dhaka day/month buckets
   (`formatDhakaDateKey`), samples (first 20 by ts desc).
5. Sorting: transitions by count desc then `from`,`to` lexical; byMember by `gained+lost` desc then
   id; days/months ascending. Pure → identical output for identical input.

### 4.2 SQL inputs (apps/web `server/identityPreview.ts`)

```ts
export async function loadIdentityPreviewInput(input: {
  identifiers: string[];             // memberIdentifiers(before) ∪ memberIdentifiers(after), all forms
  window: { from: Date; to: Date };  // default now − 92 days → now
}): Promise<{ messages: PreviewMessage[]; truncated: boolean; ownIds: Set<string> }>;
```

`identifiers` is expanded to every stored form: raw typed, `normalizePhoneNumber(raw)`,
`whatsappIdKey(raw)`, and the `88`-prefixed local form already produced by `normalizePhoneNumber`.

Query 1 — hits (uses `Message_senderPhone_timestampWa_idx`):

```sql
SELECT DISTINCT m."chatId" AS chat, m."timestampWa" AS ts, <messageKeySql('m')> AS k
FROM "Message" m
WHERE m."projectId" = ${projectId}
  AND m."senderPhone" = ANY(${identifiers})
  AND m."timestampWa" >= ${from} AND m."timestampWa" < ${to}
  AND m."direction" <> 'SYSTEM'
ORDER BY m."timestampWa" DESC
LIMIT ${PREVIEW_MAX_LOGICAL + 1}
```

`senderPhone` holds the domain-stripped id for both phone and LID senders (WHATSAPP_IDENTITY.md
§2), so it covers `senderJid` matches; no `senderJid` index is needed. `LIMIT N+1` → `truncated`.

Query 2 — every copy of each hit (uses `Message_chatId_timestampWa_idx`; copies of one WhatsApp
message carry the same WhatsApp timestamp, ±2 s tolerance for safety):

```sql
SELECT m."id", m."accountId", m."chatId", m."groupId", g."whatsappGroupId" AS wgid,
       m."whatsappMessageId" AS wamid, m."timestampWa" AS ts, m."createdAt" AS "storedAt",
       m."direction"::text AS direction, m."senderPhone" AS sender, m."senderJid",
       m."isFromTeamMember" AS "fromTeam",
       o."obMatched", o."actionType"::text AS "actionType", o."ruleId", o."createdById"
FROM unnest(${chats}::text[], ${tss}::timestamp[], ${keys}::text[]) AS h(chat, ts, k)
JOIN "Message" m ON m."projectId" = ${projectId} AND m."chatId" = h.chat
     AND m."timestampWa" BETWEEN h.ts - interval '2 seconds' AND h.ts + interval '2 seconds'
     AND <messageKeySql('m')> = h.k
LEFT JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId}
${outboundByKeyJoin(projectId, from, to, "m")}
```

Assembly in TS: group rows by `(chat, k)`; kept copy = first by the `preferSenderCopySql` order
(OUTGOING, `true_`, staff-stamped, then id); conversationKind from `wgid` (GROUP) else
`isPersonalChatId(chat)` (PERSONAL) else skip. Both queries name `"projectId"` (required by
`rawSqlProjectFilter.test.ts`) and run through the scoped `prisma` from `@/server/db`.

### 4.3 Expected KPI deltas (estimate, bounded)

```ts
export async function estimateIdentityKpiDeltas(input: {
  preview: IdentityPreviewResult;
  rosterBefore: PreviewRosterEntry[];
  rosterAfter: PreviewRosterEntry[];
  now: Date;
}): Promise<IdentityKpiDelta | null>;

export interface IdentityKpiDelta {
  month: string;                     // the most recent impacted month (YYYY-MM)
  groupsConsidered: number;          // ≤ MAX_FILTER_GROUPS (200) affected groups, most-changed first
  group: Array<{ field: "customerMessages" | "memberReplies" | "businessReplies" | "waits" | "missed" | "recalled" | "unrecovered" | "unattributedStaffReplies" | "overtimeSeconds"; before: number; after: number }>;
  personal: Array<{ field: "customerMessages" | "verifiedEmployeeReplies" | "waits" | "firstHumanAnsweredVerified"; before: number; after: number }> | null; // null when flag/permission hides personal
  byMember: Array<{ memberId: string; repliesBefore: number; repliesAfter: number; missedBefore: number; missedAfter: number }>;
}
```

Implementation: call `loadTeamReport({ period: "month", date: <month>-01, groupKeys: affectedGroups.slice(0,200), … }, now, undefined, { identity: identityFor(rosterBefore) })`
and again with `rosterAfter` (new `options.identity` override, 07 §2.1), diff `result.summary` and
member rows. Personal: `loadPersonalReport` twice with the same override, restricted to affected
accounts. Returns null when nothing changed. Always labelled "estimate for <month>, affected groups
only".

### 4.4 Server action (read-only)

`apps/web/src/server/actions/identityPreview.ts`:

```ts
"use server";
export interface IdentityPreviewRequest {
  memberId: string | null;          // null = a new member
  proposed: { phoneNumber: string; whatsappId: string | null; attributeFrom: string | null /* ISO */ } | null;
  /** linkWhatsAppSender: the sender id being linked to memberId (proposed derived server-side). */
  linkSenderId?: string;
  days?: number;                    // clamped to [1, PREVIEW_MAX_DAYS], default PREVIEW_DEFAULT_DAYS
}
export type IdentityPreviewResponse =
  | { ok: true; preview: IdentityPreviewResult; kpi: IdentityKpiDelta | null; digest: string; showPersonal: boolean }
  | { ok: false; error: string };
export async function previewTeamMemberIdentityChange(req: IdentityPreviewRequest): Promise<IdentityPreviewResponse>;
```

Gates, in order: `checkPermission("whatsapp.manage")` (the key of the actions being previewed);
feature `UNIFIED_REPORTING` on (`isUnifiedReportingEnabled()`), else `{ ok:false, error: "Impact
preview is not enabled for this project." }`; the proposed values go through the SAME validation
the save action uses (`readTeamMemberForm`-equivalent pure validator extracted if needed — no
duplicate rules). Personal counts (`affected.personalConversations`, personal KPI deltas, PERSONAL
samples) are zeroed/omitted unless the viewer also holds `messages.view`
(`hasPermission(session, "messages.view")`) — `showPersonal` tells the UI. Writes nothing.

`digest` = SHA-256 hex of the canonical JSON (sorted keys) of
`{ version, window, affected, transitions, byMember }` — used in §5.

## 5. Approval and IdentityReattribution

The preview never applies anything. Approval is the EXISTING save:

1. The edit form / add form / chat link panel shows a "Preview impact" button (only when the flag
   is on). The panel renders the result and keeps `digest` in a hidden input `previewDigest`.
2. The user presses the existing Save. The existing action runs unchanged (validation, conflict
   checks, transaction, `applyTeamChange`), then:
   - `logIdentityChange(..., via, preview?)` — new optional last parameter
     `preview?: { digest: string; affectedLogical: number; affectedGroups: number; affectedPersonal: number; window: { from: string; to: string } }`
     stored in the System Log entry's details. The server RECOMPUTES nothing here; the digest
     records what the user saw. If the form carries no digest (flag off, or user skipped preview),
     behaviour is exactly as today.
   - `queueReattribution(...)` unchanged → `IdentityReattribution` row → worker re-stamps
     `isFromTeamMember`, `SupportActivity.teamMemberId`, Duty History (as today).
3. Reports already follow the new roster at read time the moment the save commits; the preview's
   "Reports change immediately; stored stamps, Activity Feed and Duty History follow within a few
   minutes (history sync)" line states this.
4. Staleness: if the save happens > 10 minutes after the preview, the panel shows "Preview is older
   than 10 minutes — preview again" (client-side timer), but Save is never blocked (the preview is
   advisory; blocking a roster fix on a report computation would be worse).

Optional (DEFERRED, needs 03 §3.2 column): persist the preview summary on the
`IdentityReattribution` row and show it on Team Members' "history synced" badge.

## 6. Tests (identity)

- `packages/shared/src/__tests__/attributionOutcome.test.ts`
  - `maps every classifier decision` (exhaustive table above)
  - `isEmployeeCredited only for the three verified outcomes`
- `packages/shared/src/__tests__/identityPreview.test.ts` (fixtures: synthetic ids `100000000001@lid`,
  `8801000000001`, no real numbers)
  - `linking a LID moves that sender's group messages from CUSTOMER to MEMBER:x`
  - `a copy naming another member yields STAFF_UNIDENTIFIED (conflict), not MEMBER`
  - `attributeFrom later than a message keeps it CUSTOMER`
  - `our own number's copy stays BUSINESS whatever the roster`
  - `linked-login OPERATOR reply follows the member, honours attributeFrom`
  - `unchanged messages are examined but not affected`
  - `personal and group conversations are counted separately`
  - `output is deterministic (same input twice → deep-equal, stable ordering)`
- `apps/web/src/__tests__/identityPreview.integration.test.ts` (isolated DB, two projects)
  - `finds every copy of a hit across two accounts`
  - `never returns another project's messages` (Bizify fixture with the same identifier)
  - `truncates at PREVIEW_MAX_LOGICAL+1 and says so` (set a small cap through an exported test seam)
  - `refuses without whatsapp.manage; hides personal without messages.view; refuses with the flag off`
  - `writes nothing` (row counts of Message, IdentityReattribution, SystemLog unchanged)
- Confirm-it-fails rule (CLAUDE.md): each test must be shown red against a deliberately broken
  implementation (e.g. classifier called once instead of twice; copies ignored) before it is kept.
