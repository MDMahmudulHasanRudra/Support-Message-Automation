import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  attributeAcrossCopies,
  createSenderResolver,
  isOwnSender,
  normalizePhoneNumber,
  outgoingActorFor,
  parseStoredCopies,
  type IntelActor,
  type SenderMatchStatus,
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
  const col = `${alias}."whatsappMessageId"`;
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
  return Prisma.sql`
      LEFT JOIN (
        SELECT DISTINCT ON (ob."chatId", split_part(ob."providerMessageId", '_', 3))
          ob."chatId" AS "obChat", split_part(ob."providerMessageId", '_', 3) AS "obKey", true AS "obMatched",
          ob."actionType", ob."ruleId", ob."createdById"
        FROM "OutboundMessage" ob
        WHERE ob."projectId" = ${projectId} AND ob."providerMessageId" ~ '^(true|false)_[^_]*@[^_]*_[^_]+'
          AND ob."sentAt" >= ${new Date(from.getTime() - slack)} AND ob."sentAt" < ${new Date(to.getTime() + slack)}
        ORDER BY ob."chatId", split_part(ob."providerMessageId", '_', 3), ob."createdAt" DESC
      ) o ON o."obChat" = ${Prisma.raw(`${alias}."chatId"`)} AND o."obKey" = ${messageKeySql(alias)}`;
}

/**
 * The ids our own numbers send from (the worker's `ownAccounts.ts` evidence, read here at report
 * time): every account's phone digits, and every sender id one of our accounts stored an OUTGOING
 * group message under — usually our number's LID. A copy one of our numbers stored as INCOMING
 * before the worker recognised our own posts is the business's message, never a customer's.
 */
export async function loadOwnSenderIds(projectId: string): Promise<Set<string>> {
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

/** What a report loader selects about one kept message, for `ReportIdentity.classify`. */
export interface ReportSenderRow {
  direction: string;
  sender: string;
  senderJid: string | null;
  fromTeam: boolean;
  /** `storedCopiesSql`; null/absent = this row is the only witness. */
  copies?: string[] | null;
  /** From `outboundByKeyJoin`: true when the message echoes one of our sends. */
  obMatched?: boolean | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

export interface ReportSenderDecision {
  kind: "MEMBER" | "CUSTOMER" | "BUSINESS";
  memberId: string | null;
  actor: IntelActor;
  /** How a person was matched (null for the business's own messages). */
  status: SenderMatchStatus | null;
}

export interface ReportIdentity {
  resolver: SenderResolver;
  classify(row: ReportSenderRow, at: number): ReportSenderDecision;
}

/**
 * Who sent one kept message, the ONE way every report decides it:
 *  1. Our own message — the kept copy is OUTGOING, it echoes one of our sends, or a copy's sender is
 *     one of our numbers → the business's. Who: the send it echoes (`outgoingActorFor`). A reply a
 *     dashboard user typed is credited to the team member linked to that login (Team Members → login
 *     link), because it is that person's work; unlinked, it stays the business number's.
 *  2. Otherwise every stored copy is a witness (`attributeAcrossCopies`).
 */
export function createReportClassifier(
  resolver: SenderResolver,
  ownIds: ReadonlySet<string>,
  memberByUserId: ReadonlyMap<string, string>,
): ReportIdentity {
  return {
    resolver,
    classify(row, at) {
      const copies = row.copies?.length
        ? parseStoredCopies(row.copies)
        : [{ senderPhone: row.sender, senderJid: row.senderJid, fromTeam: row.fromTeam }];
      const ours =
        row.direction === "OUTGOING" ||
        Boolean(row.obMatched) ||
        isOwnSender(ownIds, row.sender, row.senderJid) ||
        copies.some((copy) => isOwnSender(ownIds, copy.senderPhone, copy.senderJid));
      if (ours) {
        const actor: IntelActor = row.obMatched || row.direction === "OUTGOING" ? outgoingActorFor(row.actionType, row.ruleId) : "BUSINESS_PHONE";
        const operatorMember = actor === "OPERATOR" && row.createdById ? (memberByUserId.get(row.createdById) ?? null) : null;
        return operatorMember
          ? { kind: "MEMBER", memberId: operatorMember, actor, status: null }
          : { kind: "BUSINESS", memberId: null, actor, status: null };
      }
      const decided = attributeAcrossCopies(resolver, copies, at);
      return {
        kind: decided.isStaff ? "MEMBER" : "CUSTOMER",
        memberId: decided.memberId,
        actor: decided.memberId ? "MEMBER" : decided.isStaff ? "MEMBER_UNMAPPED" : "CUSTOMER",
        status: decided.status,
      };
    },
  };
}

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
  const memberByUserId = new Map(members.filter((m) => m.userId).map((m) => [m.userId!, m.id]));
  return createReportClassifier(createSenderResolver(members), ownIds, memberByUserId);
}
