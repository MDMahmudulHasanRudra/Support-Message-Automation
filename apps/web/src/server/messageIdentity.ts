import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  createReportClassifier,
  createSenderResolver,
  INTELLIGENCE_SQL_PREFILTER,
  normalizePhoneNumber,
  type ReportIdentity,
  type ReportSenderDecision,
  type ReportSenderRow,
  type SenderResolver,
} from "@support-automation/shared";

/**
 * The web side of WHATSAPP_IDENTITY.md: who sent a message, and which stored rows are one message.
 * Every report and the chat read these two, so a sender is the same person on every screen.
 */

/**
 * ONE logical WhatsApp message in SQL — the same rule as `logicalMessageKey` in packages/shared,
 * pinned to it by `whatsappIdentityReports.integration.test.ts`.
 *
 * `whatsappMessageId` starts with `true_` on the account that sent a message and `false_` on every
 * other of our accounts that received it, and carries the author's id as that account saw it — so
 * `DISTINCT ON (whatsappMessageId)` kept BOTH copies of anything one of our numbers posted in a group
 * another of our numbers is also in: once as the business's reply, once as a customer message that
 * opened a wait nobody could close. WhatsApp's own key id (the third segment) is shared by every
 * copy. An id not in OpenWA's shape is its own key and is never merged with anything.
 *
 * Use with `PREFER_SENDER_COPY_SQL` in the ORDER BY, so the copy kept is the sending account's own
 * (OUTGOING) record rather than another account's echo of it.
 */
export function messageKeySql(alias = "m"): Prisma.Sql {
  return keyOfIdSql(`${alias}."whatsappMessageId"`);
}

/** The logical key of a stored WhatsApp id column (`messageKeySql`'s rule, for any column). */
function keyOfIdSql(col: string): Prisma.Sql {
  return Prisma.raw(`(CASE WHEN ${col} ~ '^(true|false)_[^_]*@[^_]*_[^_]+' THEN split_part(${col}, '_', 3) ELSE ${col} END)`);
}

/**
 * ORDER BY tiebreak: of two copies of one message, keep the one our sending account stored (OUTGOING,
 * and its id starts `true_`), then a copy stamped as a team member's. Ordering on direction alone let
 * two OUTGOING copies of one of our posts (the sender's and, since `ownAccounts.ts`, another number's)
 * tie, and the kept one was then decided by row id — when it was the other number's, no send matched
 * it and an AI reply was reported as a person's.
 */
export function preferSenderCopySql(alias = "m"): Prisma.Sql {
  return Prisma.raw(
    `(${alias}."direction" = 'OUTGOING') DESC, (left(${alias}."whatsappMessageId", 5) = 'true_') DESC, ${alias}."isFromTeamMember" DESC`,
  );
}

/**
 * Every INCOMING stored copy of the same logical message, as "phone␟jid␟0|1" strings
 * (`parseStoredCopies`) — so the identity rule hears every copy, not only the one DISTINCT ON keeps
 * (`attributeAcrossCopies`). A window over the same partition DISTINCT ON uses; select it beside the
 * DISTINCT ON columns. `groupKey` is the SQL naming the WhatsApp group (or chat) of the row.
 */
export function storedCopiesSql(groupKey: Prisma.Sql, alias = "m"): Prisma.Sql {
  const col = (name: string) => Prisma.raw(`${alias}."${name}"`);
  return Prisma.sql`array_agg(concat_ws(chr(31), ${col("senderPhone")}, coalesce(${col("senderJid")}, ''),
      CASE WHEN ${col("isFromTeamMember")} THEN '1' ELSE '0' END))
    FILTER (WHERE ${col("direction")} = 'INCOMING')
    OVER (PARTITION BY ${groupKey}, ${messageKeySql(alias)})`;
}

/**
 * The send each stored message echoes, matched on the LOGICAL key (chat + WhatsApp's key id) rather
 * than the stored id — so the copy another of our numbers stored of our own post (`false_…`) still
 * finds it, and is reported as the AI, rule or person who sent it instead of "the business phone".
 * Bounded to sends made around the window, by `sentAt` (indexed): the old join read the project's
 * entire send history on every report load. Selects `o."obMatched"`, `o."actionType"`, `o."ruleId"`
 * and `o."createdById"`.
 */
export function outboundByKeyJoin(projectId: string, from: Date, to: Date, alias = "m"): Prisma.Sql {
  const slack = 2 * 86_400_000;
  const obKey = keyOfIdSql(`ob."providerMessageId"`);
  return Prisma.sql`
      LEFT JOIN (
        SELECT DISTINCT ON (ob."chatId", ${obKey})
          ob."chatId" AS "obChat", ${obKey} AS "obKey", true AS "obMatched",
          ob."actionType", ob."ruleId",
          -- A template test send (🧪 TEST, Notification Templates) is the business's message, never a
          -- person's reply: who pressed the button is not credited.
          CASE WHEN ob."idempotencyKey" LIKE 'template-test:%' THEN NULL ELSE ob."createdById" END AS "createdById"
        FROM "OutboundMessage" ob
        WHERE ob."projectId" = ${projectId} AND ob."providerMessageId" IS NOT NULL
          AND ob."sentAt" >= ${new Date(from.getTime() - slack)} AND ob."sentAt" < ${new Date(to.getTime() + slack)}
        ORDER BY ob."chatId", ${obKey}, ob."createdAt" DESC
      ) o ON o."obChat" = ${Prisma.raw(`${alias}."chatId"`)} AND o."obKey" = ${messageKeySql(alias)}`;
}

/**
 * A message's text only where the human-only wait can read it: a line that may be a customer's
 * (incoming) and short or possibly a closing remark — Support Intelligence's own pre-filter, so the
 * two decide a closing remark identically. Not narrowed by the stored team-member stamp: who is
 * staff is decided at read time, and a stamp taken before somebody joined or left is not that.
 * (Moved here from `loadTeamReport`, unified reporting WP5; the SQL is unchanged.)
 */
export function prefilteredBodySql(alias: string): Prisma.Sql {
  const col = (name: string) => Prisma.raw(`${alias}."${name}"`);
  return Prisma.sql`CASE WHEN ${col("direction")} = 'INCOMING'
      AND (length(${col("body")}) BETWEEN 1 AND 24 OR ${col("body")} ~* ${INTELLIGENCE_SQL_PREFILTER}) THEN left(${col("body")}, 400) END`;
}

/**
 * The ids our own numbers send from (the worker's `ownAccounts.ts` evidence, read here at report
 * time): every account's phone digits, and every sender id one of our accounts stored an OUTGOING
 * group message under — usually our number's LID. A copy one of our numbers stored as INCOMING
 * before the worker recognised our own posts is the business's message, never a customer's.
 */
const OWN_IDS_CACHE_MS = 60_000;
const ownIdsCache = new Map<string, { at: number; ids: Promise<Set<string>> }>();

/**
 * Cached per project for a minute (the worker keeps the same set for five): it reads every outgoing
 * group message the project ever stored, and every report, export and drill-down needs it.
 */
export async function loadOwnSenderIds(projectId: string): Promise<Set<string>> {
  const hit = ownIdsCache.get(projectId);
  if (hit && Date.now() - hit.at < OWN_IDS_CACHE_MS) return hit.ids;
  const ids = readOwnSenderIds(projectId);
  ownIdsCache.set(projectId, { at: Date.now(), ids });
  ids.catch(() => ownIdsCache.delete(projectId));
  return ids;
}

/** Test-only: forget the cached ids. */
export function resetOwnSenderIdsCacheForTests(): void {
  ownIdsCache.clear();
}

async function readOwnSenderIds(projectId: string): Promise<Set<string>> {
  const [accounts, sent] = await Promise.all([
    prisma.whatsAppAccount.findMany({ select: { phoneNumber: true } }),
    prisma.$queryRaw<Array<{ sender: string }>>`
      SELECT DISTINCT m."senderPhone" AS sender FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."direction" = 'OUTGOING'
        AND m."chatId" LIKE '%@g.us' AND m."senderPhone" <> split_part(m."chatId", '@', 1)`,
  ]);
  const ids = new Set(sent.map((row) => row.sender).filter(Boolean));
  for (const account of accounts) {
    const digits = normalizePhoneNumber(account.phoneNumber ?? "");
    if (digits) ids.add(digits);
  }
  return ids;
}

// The classifier and its row/decision types moved to packages/shared (unified reporting WP5) so the
// identity preview can run it against two rosters; every existing import of them from here still works.
export { createReportClassifier };
export type { ReportIdentity, ReportSenderDecision, ReportSenderRow };

/**
 * The project's roster as a sender resolver — every member, deactivated ones included, because a
 * report describes history and a person who has since left still owns what they sent. The live
 * pipeline (apps/worker teamFilter.ts) passes ACTIVE members only; the rule is the same.
 */
export async function loadReportSenderResolver(): Promise<SenderResolver> {
  const members = await prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true, attributeFrom: true } });
  return createSenderResolver(members);
}

/**
 * The report identity for a project: the whole roster, our own numbers' ids, and the login → team
 * member links. One instance per report load.
 */
export async function loadReportIdentity(projectId: string): Promise<ReportIdentity> {
  const [members, ownIds] = await Promise.all([
    prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true, attributeFrom: true, userId: true } }),
    loadOwnSenderIds(projectId),
  ]);
  // The login → member link as it stands now (a link is not dated; re-linking a login moves its past
  // dashboard replies to the new member — the change is in System Logs).
  const memberByUserId = new Map(members.filter((m) => m.userId).map((m) => [m.userId!, { id: m.id, attributeFrom: m.attributeFrom }]));
  return createReportClassifier(createSenderResolver(members), ownIds, memberByUserId);
}
