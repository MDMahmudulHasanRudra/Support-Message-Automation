# 03 — Data architecture and migration (Unified Messaging Reporting)

Status: PLAN (phase 1 of plan → implement → review). Baseline: branch `rudra`, HEAD `a3c0c60`.
Read with: `04-identity-and-attribution-spec.md`, `05-group-and-personal-reporting-spec.md`,
`06-algorithms-and-metric-definitions.md`, `07-api-and-ui-contracts.md`, `00-implementation-plan.md`.

## 0. Summary of the decision

**The first release needs NO migration.** Every figure is computed at read time from tables that
already exist (`Message`, `OutboundMessage`, `WhatsAppGroup`, `InternalTeamMember`, `TeamMembership`,
`GroupResponsibilityChange`, `CollectionGap`, `SupportActivitySettings`, `IdentityReattribution`,
`ProjectFeature`). The feature flag is a `ProjectFeature` row whose absence means "off", which by
design needs no migration (`packages/shared/src/projectFeatures.ts` header). This is the same
read-time philosophy the codebase already enforces: "Attribution is decided at read time, never
stored" (CLAUDE.md, WhatsApp identity), "computed live … never pre-aggregated" (Support Activity),
"a stored derivation drifts from its own inputs" (Team Management).

There is **no second message database**. A "unified read model" in this document is a TypeScript
contract produced by loaders over `Message`, not a table.

## 1. Logical read model (contract, not storage)

New file `packages/shared/src/unifiedReporting/readModel.ts` (types only, no runtime code besides
two small helpers). Loaders in apps/web produce it; pure functions in packages/shared consume it.

```ts
import type { IntelActor } from "../intelligence/model.js";
import type { SenderMatchStatus } from "../whatsappIdentity.js";

/** Which collection a conversation belongs to. Derived from the chat id, never stored. */
export type ConversationKind = "GROUP" | "PERSONAL";

/** The scope a report is computed for (URL `scope=`). */
export type ReportScope = "group" | "personal" | "combined";

/**
 * One LOGICAL message (copies collapsed), classified once at read time.
 * GROUP:    conversationKey = WhatsApp group id (`WhatsAppGroup.whatsappGroupId`) — one key per real
 *           group whichever account stored it (identical to ReportMessage.groupKey today).
 * PERSONAL: conversationKey = `${accountId}|${chatId}` — a personal chat belongs to the account
 *           that holds its messages (CLAUDE.md "Groups and Personal": same customer on two numbers
 *           is two chats).
 */
export interface UnifiedMessage {
  conversationKind: ConversationKind;
  conversationKey: string;
  /** `logicalMessageKey(chatId, whatsappMessageId)` — stable across copies. */
  logicalKey: string;
  accountId: string;            // the kept copy's account
  chatId: string;
  ts: number;                   // Message.timestampWa (event time), epoch ms
  storedAt: number;             // Message.createdAt of the kept copy — tie-break and late-arrival
  /** Existing three-way kind (ReportMessage.kind) — every legacy figure is decided by this alone. */
  kind: "CUSTOMER" | "MEMBER" | "BUSINESS";
  actor: IntelActor;            // CUSTOMER | MEMBER | MEMBER_UNMAPPED | OPERATOR | AI | RULE | BROADCAST | BUSINESS_PHONE
  memberId: string | null;      // credited roster member (MEMBER, or OPERATOR via linked login)
  operatorUserId: string | null;// OutboundMessage.createdById for OPERATOR
  /** How the person was matched (null for the business's own messages). */
  matchStatus: SenderMatchStatus | null;
  /** CUSTOMER only: every person id (parseWhatsAppId(..).user) any stored copy named, sorted, unique. */
  customerIds: string[];
  /** Logical key of the message this one quotes (Message.quotedMessageId → quoted row), or null. */
  quotedKey: string | null;
  /** Message.mentionedPhones (digits-only ids) of the kept copy. */
  mentionedIds: string[];
  /** Body only where the Support-Intelligence prefilter allows it (closing-remark detection). Never exported. */
  text: string | null;
  /** True for rows inside [rangeStart, rangeEnd); false for context and look-ahead rows. */
  inPeriod: boolean;
}

export const conversationKeyOf = (kind: ConversationKind, accountId: string, chatId: string, whatsappGroupId: string | null): string =>
  kind === "GROUP" ? (whatsappGroupId ?? chatId) : `${accountId}|${chatId}`;
```

Rules of the contract:

- `kind` / `actor` / `memberId` / `matchStatus` come ONLY from `createReportClassifier(...).classify`
  (apps/web `server/messageIdentity.ts`). No new classifier.
- For GROUP the existing `loadTeamReport` remains the producer of `ReportMessage[]`; the
  `UnifiedMessage` fields beyond `ReportMessage` (`customerIds`, `quotedKey`, `mentionedIds`) are
  produced only when the caller opts in (`withReplyEvidence`, see 07 §2.1) so the legacy path is
  byte-identical when the flag is off.
- For PERSONAL the new `loadPersonalReport` is the producer (05, 07).
- `text` never leaves the server: no export column, no client prop.

### 1.1 Mapping onto existing tables

| Contract field | Source | Notes |
|---|---|---|
| conversationKind | `Message.groupId` + `Message.chatId` | GROUP = `JOIN WhatsAppGroup g ON g.id = m.groupId` (legacy). PERSONAL = `PERSONAL_CHAT_SQL` (`m."groupId" IS NULL AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid')`, `server/chatInbox.ts`, pinned to `isPersonalChatId`). Anything else (status, newsletter, broadcast) is excluded. |
| logicalKey | `messageKeySql()` / `logicalMessageKey()` | existing, pinned by `whatsappIdentityReports.integration.test.ts` |
| kept copy | `DISTINCT ON (conversation, key)` + `preferSenderCopySql` order | existing |
| copies | `storedCopiesSql(partitionKey)` | GROUP partitions on `g."whatsappGroupId"`; PERSONAL partitions on `m."accountId", m."chatId"` (a concatenated SQL key, see 07 §2.2) |
| actor / operator | `outboundByKeyJoin(projectId, from, to, "m")` | joins on `OutboundMessage.chatId` + logical key — works unchanged for personal chats (`chatId` is the `@c.us`/`@lid` id on a MANUAL_REPLY) |
| memberId via login | `InternalTeamMember.userId` (`loadReportIdentity`) | existing; honours `attributeFrom` |
| quotedKey | `LEFT JOIN "Message" q ON q."id" = m."quotedMessageId" AND q."projectId" = $p` → `logicalMessageKey(chatId, q.whatsappMessageId)` | PK lookup; same join Support Intelligence's loader already does (`server/intelligence/loader.ts` line ~123) |
| mentionedIds | `Message.mentionedPhones` | digits-only; for a LID mention it is the LID user part |
| responsibility at time | `GroupResponsibilityChange` | existing `responsibilityAt` |
| team at time | `TeamMembership` | existing `inTeamAt` |
| collection coverage | `CollectionGap` + `SupportActivitySettings.reportingVerifiedFrom` | existing `loadDataHealth` / `computeDataHealth` |
| late arrival | `Message.createdAt - Message.timestampWa` | new COUNT only, no column |
| history-loaded | `Message.loadedFromHistoryAt IS NOT NULL` | existing column |
| revoked | `Message.revokedAt IS NOT NULL` | existing column; counted, never excluded (text kept on record) |
| pending re-attribution | `IdentityReattribution.status IN ('PENDING','RUNNING')` | existing, `rosterIdentityHealth.ts` already counts it |

## 2. Candidate structures A–E

| # | Candidate | Decision | Reason |
|---|---|---|---|
| A | **Identity evidence table** (per sender: which member, by which evidence, since when) | **REJECT** (v1) / DEFER a dated LID→phone map | Identity is a function of the CURRENT roster + every stored copy (`attributeAcrossCopies`), applied at read time; a stored evidence table is a second answer that drifts whenever Team Members changes (the exact failure the 19 Oct report accuracy audit removed). WHATSAPP_IDENTITY.md §9 / CLAUDE.md: "No LID→phone table exists, because no provider evidence for one does; add one only when a provider supplies it." Revisit only if a provider exposes LID↔phone evidence. |
| B | **Attribution decisions table** (per reply: which customer it answered) | **REJECT** for Tier1/Tier2 (computed, deterministic, cheap); **DEFER** for human-confirmed / AI-suggested links | Tier1/Tier2 are pure functions of `quotedMessageId`, `mentionedPhones` and order — recomputable at any time; storing them would freeze an answer that a roster change must be able to move. A table becomes necessary only if a PERSON confirms a Tier3/AI link (a fact that is not derivable). That is out of scope for v1 (AI enrichment is interface-only). |
| C | **Report run metadata table** (`ReportRun`: who generated what, with which version) | **REJECT** (v1), DEFER | The run metadata the owner asked for (version, filters, timezone, generated-at, cutoff, coverage) is computed per request and printed on the page and in every export (Run sheet). `asof` already makes an export reproducible against the page. A persisted run log would add a write on every page view (report pages are read-only today, `isReadKey`) and a retention question. Revisit if auditors need "show me the file that was sent on date X". |
| D | **Incremental aggregates** (daily per-group / per-member rollups) | **DEFER** (explicitly risky) | Every figure depends on read-time identity and on responsibility/threshold "at that moment"; a rollup computed yesterday is wrong the moment a colleague's WhatsApp id is linked, and invalidation would need the identity-change set the preview computes. CLAUDE.md: "If volume ever makes it the bottleneck the answer is a nightly rollup… the wait definition must stay identical". Only after `phase2ReportBenchmark.integration.test.ts` shows a 92-day report breaching its budget. |
| E | **Evidence indexes** on `Message` (e.g. GIN on `mentionedPhones`, partial `(projectId, timestampWa) WHERE groupId IS NULL`) | **DEFER**, measure first | `quotedMessageId` is already indexed and the quote join is by PK. Mentions are read from rows already loaded (no lookup by mention). The personal loader can use the existing partial index `Message_personal_chat_idx ("projectId","accountId","chatId","timestampWa") WHERE "groupId" IS NULL` (per-account LATERAL probes and a bounded scan of the partial index). Any new index on `Message` (the largest table) is a write-blocking build inside Prisma's migration transaction; see §3. |

## 3. Columns / indexes (none in v1) and lock-impact notes for the deferred ones

No column or index is added in the first release. Recorded here so a later phase does not re-derive
the risk:

1. **Deferred index** `Message_personal_period_idx ON "Message"("projectId","timestampWa") WHERE "groupId" IS NULL`
   - Trigger: EXPLAIN (ANALYZE, BUFFERS) of the personal loader's period query on production shows a
     scan of `Message_personal_chat_idx` above ~200 ms for a 31-day period.
   - Lock impact: a plain `CREATE INDEX` holds a SHARE lock on `Message` (blocks INSERTs = blocks
     message collection) for the build. Follow the existing convention of
     `20261011090600_message_personal_chat_index/migration.sql`: write `CREATE INDEX IF NOT EXISTS`
     in the migration, with a DEPLOY NOTE telling the operator to run
     `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` by hand first and then
     `prisma migrate resolve --applied <name>`. Partial index → not expressible in `schema.prisma`;
     declare in SQL only. Name the migration after `20261019120000_member_default_shift_changed_at`
     (CLAUDE.md: migration names run ahead of the calendar; name by hand after the last one).
2. **Deferred column** `IdentityReattribution.preview Json?` (the approved preview's summary)
   - Small table, nullable column with no default → metadata-only `ALTER TABLE`, instant, no rewrite.
   - v1 instead writes the preview digest into the existing System Log entry (`logIdentityChange`),
     see 04 §5. Add the column only if the owner wants the preview visible on the re-attribution row.
3. **Deferred** GIN index on `Message.mentionedPhones` — only if a future feature must find messages
   BY mention across history. Not needed for any v1 algorithm.

## 4. Migration checklist (for any later phase that adds one of the above)

1. `git log` the migrations folder; name the new folder after the newest one (lexical order).
2. Additive only: nullable columns, no defaults that rewrite, no NOT NULL on existing rows.
3. Large-table index → DEPLOY NOTE + `IF NOT EXISTS` + manual `CONCURRENTLY` instructions.
4. A new relation between two project-owned tables needs its `<Child>_<column>_same_project`
   trigger (`projectIntegrity.integration.test.ts` fails otherwise).
5. Verify against the isolated DB only (`docker compose -f docker-compose.test.yml up -d --wait`,
   `pnpm --filter @support-automation/web test:isolated`).
6. Deploy per `DEPLOY.md`: `docker compose run --rm migrate` BEFORE `up -d --no-deps app|worker`.
   Never run `migrate deploy` against live without Rudra's explicit go-ahead (CLAUDE.md).
7. After deploy: check `_prisma_migrations` before treating any P2022 as a bug.

## 5. Rollback

- **v1 (no migration):** set `ProjectFeature(UNIFIED_REPORTING).enabled = false` (or delete the row)
  from the Main Admin Portal → takes effect within the 5 s feature cache
  (`server/projectFeatures.ts` `FEATURE_TTL_MS`). The Team Report renders the legacy page and the
  legacy export byte-for-byte (guarded by the parity tests in WP2). Nothing to restore: nothing
  was written.
- **Code rollback:** revert the WP commits; no data depends on them.
- **Deferred migrations:** additive columns/indexes can stay in place when code is rolled back
  (unused). Dropping a deferred index is `DROP INDEX CONCURRENTLY` by hand, never inside a migration.

## 6. Non-goals (explicit)

- No copy of `Message` into a reporting table; no per-project reporting schema; no partitioning of
  `Message` (DEFERRED: partitioning a live, FK-referenced, trigger-guarded table is a project of its
  own, and the multi-project integrity triggers would all need re-validation).
- No worker change in v1. Collection, catch-up, and the identity re-attribution loop are untouched.
- No AI infrastructure: AI enrichment is a typed interface only (06 §6).
