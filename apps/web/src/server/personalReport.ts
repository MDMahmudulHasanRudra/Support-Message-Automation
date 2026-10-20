import { Prisma } from "@prisma/client";
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { PERSONAL_CHAT_SQL } from "@/server/chatInbox";
import { personalChatFallbackName } from "@/lib/chatConversationType";
import { loadOwnSenderIds, loadReportIdentity, messageKeySql, outboundByKeyJoin, prefilteredBodySql, preferSenderCopySql, storedCopiesSql } from "@/server/messageIdentity";
import { CONTEXT_MS, LOOKAHEAD_MS, resolveTeamReportRange, resolveTeamScope, type ResolvedRange, type TeamOption, type TeamReportFilters } from "@/server/teamReport";
import { loadDataQualityCounts } from "@/server/unifiedReporting";
import {
  computePersonalReport,
  emptyActorCounts,
  isOwnSender,
  logicalMessageKey,
  type DataQualityCounts,
  type IntelActor,
  type PersonalReportMessage,
  type PersonalReportResult,
  type ReliabilityCounts,
  type ReportIdentity,
  type TeamMembershipInterval,
} from "@support-automation/shared";

/**
 * The personal-chat (one-to-one) side of the Team Report (UNIFIED_REPORTING, WP6;
 * docs/unified-reporting/05 §1–§2, 07 §2.2). It only decides WHICH messages go in and what each one is;
 * the counting is `computePersonalReport` in packages/shared, which calls the Team Report's own
 * `computeTeamReport` and Human Response SLA's `humanWaits` unchanged.
 *
 *   Message          the project's `PERSONAL_CHAT_SQL` rows (a `@c.us` / `@lid` chat with no group): never a
 *                    group row, never status@broadcast / @newsletter / an orphaned @g.us. A personal chat
 *                    belongs to the account holding its messages, so the same customer writing to two of our
 *                    numbers is two conversations.
 *   OutboundMessage  which send an outgoing message echoes (AI, rule, a dashboard user) — joined on the
 *                    LOGICAL key like the group report.
 *   InternalTeamMember / Team / TeamMembership   the one identity rule, the Team and member scope — the same
 *                    `loadReportIdentity` / `resolveTeamScope` the group report uses. No second algorithm.
 *
 * Message TEXT is read only where Human Response SLA's pre-filter allows (a short line, to recognise a
 * closing remark) and never leaves this process: nothing returned or exported carries a body.
 */

export interface PersonalReportData {
  /** The filters actually applied. `groupKeys` is ignored here (see `filterNote`). */
  filters: TeamReportFilters;
  range: ResolvedRange;
  result: PersonalReportResult;
  /** Every classified message the result was computed from (period, context and look-ahead), no text. */
  messages: Array<Omit<PersonalReportMessage, "text">>;
  /** Stored copies, logical messages and attribution over the period's personal rows (what was READ). */
  reliabilityCounts: ReliabilityCounts;
  dataQuality: DataQualityCounts;
  /** conversationKey → the newest incoming sender name on record, else `personalChatFallbackName(chatId)`. */
  conversationNames: Map<string, string>;
  accountLabels: Map<string, string>;
  memberNames: Map<string, string>;
  members: Array<{ id: string; name: string; status: string }>;
  teams: TeamOption[];
  teamMemberIds: Record<string, string[]>;
  teamName: string | null;
  filterNote: string | null;
  rules: { missedAfterMinutes: number };
  computedAt: number;
}

interface PersonalRow {
  aid: string;
  chat: string;
  wamid: string;
  ts: Date;
  storedAt: Date;
  direction: string;
  fromTeam: boolean;
  sender: string;
  senderJid: string | null;
  senderName: string | null;
  copies: string[] | null;
  body: string | null;
  obMatched: boolean | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

export const conversationKeyOfChat = (accountId: string, chatId: string) => `${accountId}|${chatId}`;

/** `${accountId}|${chatId}` back into its parts; null for anything malformed. */
export function parseConversationKey(key: string): { accountId: string; chatId: string } | null {
  const at = key.indexOf("|");
  if (at <= 0 || at === key.length - 1) return null;
  return { accountId: key.slice(0, at), chatId: key.slice(at + 1) };
}

/**
 * @param options.onlyConversationKey  restrict to one conversation (a drill-down, a test) — narrows the query.
 * @param options.identity             classify with this identity instead of the project's (the identity preview).
 */
export async function loadPersonalReport(
  filters: TeamReportFilters,
  now: Date,
  options: { storedBy?: Date; identity?: ReportIdentity; onlyConversationKey?: string } = {},
): Promise<PersonalReportData> {
  const range = resolveTeamReportRange(filters, now);
  const lookaheadEnd = new Date(range.end.getTime() + LOOKAHEAD_MS);
  const contextStart = new Date(range.start.getTime() - CONTEXT_MS);
  const projectId = await activeProjectId();
  const only = options.onlyConversationKey ? parseConversationKey(options.onlyConversationKey) : null;
  // One account when chosen (the Account filter applies to personal chats), and/or one conversation.
  const accountId = only?.accountId ?? filters.accountId ?? null;
  const accountFilter = accountId ? Prisma.sql`AND m."accountId" = ${accountId}` : Prisma.empty;
  const chatFilter = only ? Prisma.sql`AND m."chatId" = ${only.chatId}` : Prisma.empty;
  const storedBy = options.storedBy ? new Date(options.storedBy.getTime() + 5_000) : new Date("9999-12-31T00:00:00Z");

  const [members, identity, ownIds, settings, teams, membershipRows, accounts, rows, earlier, copies] = await Promise.all([
    prisma.internalTeamMember.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
    options.identity ?? loadReportIdentity(projectId),
    loadOwnSenderIds(projectId),
    prisma.supportActivitySettings.findUnique({ where: { id: "global" }, select: { missedReplyAfterMinutes: true } }),
    prisma.team.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
    prisma.teamMembership.findMany({ select: { teamMemberId: true, teamId: true, startedAt: true, endedAt: true } }),
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true } }),
    // One row per real message. A personal message is stored by ONE account, so the DISTINCT ON is
    // defensive (and cheap): it collapses a repeated delivery of the same WhatsApp key within an
    // account's chat. Bounded by project, the personal-chat predicate and the period's index range.
    prisma.$queryRaw<PersonalRow[]>`
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
          ${prefilteredBodySql("m")} AS body,
          o."obMatched" AS "obMatched", o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
        FROM "Message" m
        ${outboundByKeyJoin(projectId, contextStart, lookaheadEnd, "m")}
        WHERE m."projectId" = ${projectId} AND ${PERSONAL_CHAT_SQL}
          AND m."timestampWa" >= ${contextStart} AND m."timestampWa" < ${lookaheadEnd}
          AND m."createdAt" <= ${storedBy}
          ${accountFilter}
          ${chatFilter}
      ) c
      ORDER BY c.aid, c.chat, c.k, c.p1 DESC, c.p2 DESC, c.p3 DESC, c.ts, c.mid`,
    // Each active conversation's last message before the context window: one probe per conversation
    // with activity in the period (Message_personal_chat_idx). Read as the message before the first one
    // loaded, so a wait already open then is continued rather than counted again.
    prisma.$queryRaw<PersonalRow[]>`
      SELECT r.aid, r.chat, p."whatsappMessageId" AS wamid, p."timestampWa" AS ts, p."createdAt" AS "storedAt",
        p."direction"::text AS direction, p."isFromTeamMember" AS "fromTeam",
        p."senderPhone" AS sender, p."senderJid" AS "senderJid", p."senderName" AS "senderName",
        NULL::text[] AS copies,
        ${prefilteredBodySql("p")} AS body,
        o."obMatched" AS "obMatched", o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
      FROM (
        SELECT DISTINCT m."accountId" AS aid, m."chatId" AS chat
        FROM "Message" m
        WHERE m."projectId" = ${projectId} AND ${PERSONAL_CHAT_SQL}
          AND m."timestampWa" >= ${range.start} AND m."timestampWa" < ${lookaheadEnd}
          AND m."createdAt" <= ${storedBy}
          ${accountFilter}
          ${chatFilter}
      ) r
      CROSS JOIN LATERAL (
        SELECT x.*
        FROM "Message" x
        WHERE x."projectId" = ${projectId} AND x."accountId" = r.aid AND x."groupId" IS NULL AND x."chatId" = r.chat
          AND x."timestampWa" < ${contextStart} AND x."direction" <> 'SYSTEM'
        ORDER BY x."timestampWa" DESC, ${preferSenderCopySql("x")}, x."id"
        LIMIT 1
      ) p
      ${outboundByKeyJoin(projectId, contextStart, lookaheadEnd, "p")}`,
    // Every stored copy in the period, for the reliability section (the group report's own count).
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND ${PERSONAL_CHAT_SQL}
        AND m."timestampWa" >= ${range.start} AND m."timestampWa" < ${range.end}
        AND m."direction" <> 'SYSTEM'
        AND m."createdAt" <= ${storedBy}
        ${accountFilter}
        ${chatFilter}`,
  ]);

  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();
  const measuredTo = Math.min(now.getTime(), rangeEnd + LOOKAHEAD_MS);

  const counts: ReliabilityCounts = {
    storedCopies: copies[0]?.n ?? 0,
    logicalMessages: 0,
    byActor: emptyActorCounts(),
    attribution: { idAndPhone: 0, idOnly: 0, phoneOnly: 0 },
    conflicting: 0,
    unattributedSenders: 0,
  };
  const unattributed = new Set<string>();
  const excluded = new Map<string, "OWN_NUMBER" | "INTERNAL">();
  const earlierMessageAt = new Map<string, number>();
  const newestName = new Map<string, { ts: number; name: string }>();
  const messages: PersonalReportMessage[] = [];

  // Oldest first, and two messages in the same second in the order they were stored (the group report's order).
  const ordered = [...earlier, ...rows].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.storedAt.getTime() - b.storedAt.getTime());
  const earlierSet = new Set(earlier);
  for (const row of ordered) {
    if (row.direction === "SYSTEM") continue; // joins, leaves, subject changes — nobody said anything
    const ts = row.ts.getTime();
    const inPeriod = ts >= rangeStart && ts < rangeEnd;
    const key = conversationKeyOfChat(row.aid, row.chat);
    if (earlierSet.has(row) && !earlierMessageAt.has(key)) earlierMessageAt.set(key, ts);
    // The chat's own id is one of our numbers: one of our numbers writing to another, never a customer.
    if (isOwnSender(ownIds, null, row.chat)) excluded.set(key, "OWN_NUMBER");
    const decided = identity.classify(row, ts);
    // A colleague writing to the business number from their own phone makes the chat internal. Only an
    // INCOMING roster member counts: a linked login's dashboard reply is OUTGOING and is the business's.
    if (row.direction === "INCOMING" && (decided.actor === "MEMBER" || decided.actor === "MEMBER_UNMAPPED") && !excluded.has(key)) excluded.set(key, "INTERNAL");
    if (inPeriod && decided.status) {
      if (decided.status === "WHATSAPP_ID_AND_PHONE_MATCH") counts.attribution.idAndPhone += 1;
      else if (decided.status === "WHATSAPP_ID_MATCH") counts.attribution.idOnly += 1;
      else if (decided.status === "PHONE_MATCH") counts.attribution.phoneOnly += 1;
      else if (decided.status === "CONFLICT" || decided.status === "AMBIGUOUS") counts.conflicting += 1;
      if (decided.actor === "MEMBER_UNMAPPED") unattributed.add(row.senderJid ?? row.sender);
    }
    if (inPeriod) {
      counts.logicalMessages += 1;
      counts.byActor[decided.actor] += 1;
    }
    if (row.direction === "INCOMING" && row.senderName && row.senderName.trim()) {
      const seen = newestName.get(key);
      if (!seen || ts >= seen.ts) newestName.set(key, { ts, name: row.senderName.trim() });
    }
    messages.push({
      conversationKey: key,
      accountId: row.aid,
      chatId: row.chat,
      key: logicalMessageKey(row.chat, row.wamid),
      ts,
      kind: decided.kind,
      actor: decided.actor satisfies IntelActor,
      memberId: decided.memberId,
      operatorUserId: decided.actor === "OPERATOR" ? row.createdById : null,
      sender: row.sender,
      text: row.body,
    });
  }
  counts.unattributedSenders = unattributed.size;

  // ---- Team / member filter: the group report's own rule, so a Team means the same in both ----
  const intervals: TeamMembershipInterval[] = membershipRows.map((row) => ({
    memberId: row.teamMemberId,
    teamId: row.teamId,
    startedAt: row.startedAt?.getTime() ?? null,
    endedAt: row.endedAt?.getTime() ?? null,
  }));
  // The group list is ignored here, so a "first N groups only" note would describe a filter that does not apply.
  const resolved = resolveTeamScope({ ...filters, groupsTruncated: false }, members, teams, intervals, range);
  const { memberId } = resolved;
  const scope = resolved.scope ?? (memberId ? (id: string) => id === memberId : null);
  const notes = [resolved.filterNote, filters.groupKeys?.length ? "The group filter does not apply to personal chats." : null].filter(Boolean);

  const missedAfterMinutes = Math.min(24 * 60, Math.max(1, settings?.missedReplyAfterMinutes ?? 30));
  const result = computePersonalReport(messages, {
    rangeStart,
    rangeEnd,
    now: now.getTime(),
    measuredTo,
    missedAfterMs: missedAfterMinutes * 60_000,
    granularity: filters.granularity,
    scope,
    excluded,
    earlierMessageAt,
  });

  const dataQuality = await loadDataQualityCounts({ kind: "PERSONAL", start: range.start, end: range.end, storedBy: options.storedBy, accountId });
  dataQuality.excludedOwnNumberChats = result.summary.excluded.ownNumber;
  dataQuality.excludedInternalChats = result.summary.excluded.internal;

  const conversationNames = new Map<string, string>();
  for (const row of result.conversations) {
    conversationNames.set(row.conversationKey, newestName.get(row.conversationKey)?.name ?? personalChatFallbackName(row.chatId));
  }

  return {
    filters: { ...resolved.applied, accountId: filters.accountId ?? null },
    range,
    result,
    messages: messages.map((m) => ({ conversationKey: m.conversationKey, accountId: m.accountId, chatId: m.chatId, key: m.key, ts: m.ts, kind: m.kind, actor: m.actor, memberId: m.memberId, operatorUserId: m.operatorUserId, sender: m.sender })),
    reliabilityCounts: counts,
    dataQuality,
    conversationNames,
    accountLabels: new Map(accounts.map((a) => [a.id, a.label])),
    memberNames: resolved.memberNames,
    members: members.map((m) => ({ id: m.id, name: m.name, status: m.status })),
    teams,
    teamMemberIds: resolved.teamMemberIds,
    teamName: resolved.teamName,
    filterNote: notes.length ? notes.join(" ") : null,
    rules: { missedAfterMinutes },
    computedAt: now.getTime(),
  };
}
