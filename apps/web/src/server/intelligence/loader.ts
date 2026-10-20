import { Prisma } from "@prisma/client";
import {
  appreciationSignals,
  buildCases,
  buildSessions,
  customerPreferences,
  DEFAULT_CASE_GAP_MS,
  DEFAULT_REOPEN_WINDOW_MS,
  effectivenessOf,
  employeeMetrics,
  formatDhakaDateKey,
  gapIsIncomplete,
  humanWaits,
  INTELLIGENCE_SQL_PREFILTER,
  logicalMessageKey,
  preferenceSignals,
  SCHEDULED_DUTY_STATUSES,
  shiftWindow,
  toDhakaDateOnly,
  type AppreciationSignal,
  type CaseFacts,
  type CustomerPreference,
  type DutyWindow,
  type EmployeeEffectiveness,
  type HumanWait,
  type IntelActor,
  type IntelMessage,
  type IntelSettings,
  type PreferenceSignal,
  type SupportCase,
  type SupportSession2,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { loadReportIdentity, messageKeySql, outboundByKeyJoin, preferSenderCopySql, storedCopiesSql } from "@/server/messageIdentity";
import { measuredTo as measuredToOf, type ReportContext } from "@/server/reports/context";

/**
 * Support Intelligence data for one report context (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md).
 *
 * One bounded query reads the period's messages — from one case gap before the period (so a case
 * already running at midnight is not cut in half) to 24 hours after it (so a reply can still close a
 * wait), exactly as the Team Report bounds its own — with three things the Team Report does not need:
 *   - who sent each outgoing message (the OutboundMessage it echoes: operator, rule, AI, broadcast —
 *     or none, which is somebody on the business phone);
 *   - the quoted message's author and the @mentions, for attribution;
 *   - the text, ONLY for messages the phrase pre-filter selects or short enough to be an
 *     acknowledgement, truncated in SQL.
 * Everything after the query is the pure model in packages/shared. Raw SQL names "projectId" on
 * every table it reads; the rest goes through the scoped client.
 */

export interface IntelligenceData {
  messages: IntelMessage[];
  /** Cases opened inside the period. */
  cases: SupportCase[];
  /** Every case built, including those opened in the look-behind — attribution context only. */
  allCases: SupportCase[];
  sessions: SupportSession2[];
  waits: HumanWait[];
  appreciation: AppreciationSignal[];
  preferenceSignals: PreferenceSignal[];
  preferences: CustomerPreference[];
  effectiveness: EmployeeEffectiveness[];
  memberNames: Map<string, string>;
  /** Each member's current Team name (or null). */
  memberTeams: Map<string, string | null>;
  settings: IntelSettings;
  measuredTo: number;
  /** Dhaka days of the period whose data is not verified. */
  unverifiedDays: Set<string>;
}

interface Row {
  wgid: string;
  wamid: string;
  ts: Date;
  storedAt: Date;
  direction: string;
  fromTeam: boolean;
  sender: string;
  senderJid: string | null;
  senderName: string | null;
  mentions: string[] | null;
  body: string | null;
  quotedKey: string | null;
  quotedSender: string | null;
  quotedSenderJid: string | null;
  quotedDirection: string | null;
  quotedAt: Date | null;
  copies: string[] | null;
  obMatched: boolean | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

const LOOKAHEAD_MS = 24 * 3_600_000;


export async function loadIntelligence(ctx: ReportContext): Promise<IntelligenceData> {
  const projectId = await activeProjectId();
  const from = new Date(ctx.rangeStart - DEFAULT_CASE_GAP_MS);
  const to = new Date(ctx.rangeEnd + LOOKAHEAD_MS);
  const { groupKeys, accountId } = ctx.filters;
  const groupFilter = groupKeys?.length ? Prisma.sql`AND g."whatsappGroupId" IN (${Prisma.join(groupKeys)})` : Prisma.empty;
  const accountFilter = accountId ? Prisma.sql`AND m."accountId" = ${accountId}` : Prisma.empty;
  // With an account chosen, the report reads the messages THAT account stored, but who sent each one is
  // still decided from every account's copies (as the Team Report does): the copies window below sees all
  // of them and only the outer `onAccount` test narrows to the chosen account.
  const onAccount = accountId
    ? Prisma.sql`bool_or(m."accountId" = ${accountId}) OVER (PARTITION BY g."whatsappGroupId", ${messageKeySql()})`
    : Prisma.sql`true`;
  const ownCopy = accountId ? Prisma.sql`(m."accountId" = ${accountId})` : Prisma.sql`true`;

  const [rows, earlier, members, identity, escalations, completions, duties] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON (c.wgid, c.k)
        c.wgid, c.wamid, c.ts, c."storedAt", c.direction, c."fromTeam", c.sender, c."senderJid", c."senderName", c.mentions, c.body,
        c."quotedKey", c."quotedSender", c."quotedSenderJid", c."quotedDirection", c."quotedAt", c.copies,
        c."obMatched", c."actionType", c."ruleId", c."createdById"
      FROM (
        SELECT
          g."whatsappGroupId" AS wgid, ${messageKeySql()} AS k, m."id" AS mid,
          m."whatsappMessageId" AS wamid, m."timestampWa" AS ts, m."createdAt" AS "storedAt",
          m."direction"::text AS direction, m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender,
          m."senderJid" AS "senderJid",
          m."senderName" AS "senderName", m."mentionedPhones" AS mentions,
          CASE WHEN length(m."body") BETWEEN 1 AND 24 OR m."body" ~* ${INTELLIGENCE_SQL_PREFILTER} THEN left(m."body", 400) END AS body,
          q."whatsappMessageId" AS "quotedKey", q."senderPhone" AS "quotedSender", q."senderJid" AS "quotedSenderJid",
          q."direction"::text AS "quotedDirection", q."timestampWa" AS "quotedAt",
          ${storedCopiesSql(Prisma.sql`g."whatsappGroupId"`)} AS copies,
          ${onAccount} AS "onAccount", ${ownCopy} AS "ownCopy",
          (m."direction" = 'OUTGOING') AS p1, (left(m."whatsappMessageId", 5) = 'true_') AS p2, m."isFromTeamMember" AS p3,
          o."obMatched" AS "obMatched", o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId}
        LEFT JOIN "Message" q ON q."id" = m."quotedMessageId" AND q."projectId" = ${projectId}
        ${outboundByKeyJoin(projectId, from, to)}
        WHERE m."projectId" = ${projectId}
          AND m."timestampWa" >= ${from} AND m."timestampWa" < ${to}
          AND m."direction" <> 'SYSTEM'
          ${groupFilter}
      ) c
      WHERE c."onAccount"
      -- preferSenderCopySql's order (OUTGOING, true_, staff-stamped); with an account chosen, its own copy first.
      ORDER BY c.wgid, c.k, c."ownCopy" DESC, c.p1 DESC, c.p2 DESC, c.p3 DESC, c.ts, c.mid`,
    // Each group's last message before that window, as the Team Report reads it: a customer still
    // waiting from earlier is continuing that wait, not starting a new one at the window's edge.
    prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON (gg."whatsappGroupId")
        gg."whatsappGroupId" AS wgid, p."whatsappMessageId" AS wamid, p."timestampWa" AS ts, p."createdAt" AS "storedAt",
        p."direction"::text AS direction, p."isFromTeamMember" AS "fromTeam", p."senderPhone" AS sender,
        p."senderJid" AS "senderJid", p."senderName" AS "senderName", p."mentionedPhones" AS mentions,
        CASE WHEN length(p."body") BETWEEN 1 AND 24 OR p."body" ~* ${INTELLIGENCE_SQL_PREFILTER} THEN left(p."body", 400) END AS body,
        NULL::text AS "quotedKey", NULL::text AS "quotedSender", NULL::text AS "quotedSenderJid",
        NULL::text AS "quotedDirection", NULL::timestamp AS "quotedAt", NULL::text[] AS copies,
        o."obMatched" AS "obMatched", o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
      FROM (
        SELECT DISTINCT m."groupId"
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
        WHERE m."projectId" = ${projectId}
          AND m."timestampWa" >= ${new Date(ctx.rangeStart)} AND m."timestampWa" < ${to}
          ${groupFilter}
          ${accountFilter}
      ) r
      JOIN "WhatsAppGroup" gg ON gg."id" = r."groupId" AND gg."projectId" = ${projectId}
      CROSS JOIN LATERAL (
        SELECT x.*
        FROM "Message" x
        WHERE x."groupId" = r."groupId" AND x."projectId" = ${projectId}
          AND x."timestampWa" < ${from} AND x."direction" <> 'SYSTEM'
          ${accountId ? Prisma.sql`AND x."accountId" = ${accountId}` : Prisma.empty}
        ORDER BY x."timestampWa" DESC
        LIMIT 1
      ) p
      ${outboundByKeyJoin(projectId, new Date(from.getTime() - 30 * 86_400_000), to, "p")}
      ORDER BY gg."whatsappGroupId", p."timestampWa" DESC, ${preferSenderCopySql("p")}, p."id"`,
    prisma.internalTeamMember.findMany({
      select: { id: true, name: true, team: { select: { name: true } } },
    }),
    loadReportIdentity(projectId),
    prisma.supportEscalationCase.findMany({
      where: { createdAt: { gte: from, lt: to } },
      select: { createdAt: true, status: true, humanRepliedAt: true, resolvedAt: true, resolvedById: true, updatedAt: true, group: { select: { whatsappGroupId: true } } },
    }),
    prisma.supportSession.findMany({
      where: { status: "COMPLETED", completionActivityId: { not: null }, completedAt: { gte: from, lt: to } },
      select: { completedAt: true, completedByTeamMemberId: true, group: { select: { whatsappGroupId: true } } },
    }),
    prisma.dutyAssignment.findMany({
      // Dhaka date bounds, as Duty & Workload reads them — a @db.Date compared with a timestamp is
      // truncated, which silently dropped the period's last day. From the day before, so a shift
      // that started the evening before still owns its hours.
      where: {
        dutyDate: { gte: toDhakaDateOnly(new Date(ctx.rangeStart - 86_400_000)), lte: toDhakaDateOnly(new Date(ctx.rangeEnd - 1)) },
        status: { in: [...SCHEDULED_DUTY_STATUSES] as never },
      },
      select: { teamMemberId: true, dutyDate: true, shiftStartMinute: true, shiftEndMinute: true },
    }),
  ]);

  // ---- Roster: the one identity rule the Team Report and the live pipeline use (WHATSAPP_IDENTITY.md).
  const resolver = identity.resolver;
  // At the time of the message it is read for: a quote of a line written before somebody's "count
  // their messages from" date is a quote of a customer, not of the member they later became.
  const memberFor = (raw: string | null, jid: string | null = null, at: number | null = null) =>
    raw ? resolver.resolve(raw, jid, at).memberId : null;
  const memberNames = new Map(members.map((m) => [m.id, m.name]));
  const memberTeams = new Map(members.map((m) => [m.id, m.team?.name ?? null]));

  // ---- Groups in scope (Team / member filter), the way every group report decides it.
  const inScopeGroup = (groupKey: string) => ctx.groupInScope(groupKey, ctx.data.groups.get(groupKey)?.assignedMemberId ?? null);

  const messages: IntelMessage[] = [];
  // Oldest first, and messages in the same second in the order they were stored — the Team Report's
  // own order, so a reply and its question pair the same way in both.
  const ordered = [...earlier, ...rows].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.storedAt.getTime() - b.storedAt.getTime());
  for (const row of ordered) {
    if (!inScopeGroup(row.wgid)) continue;
    // The one rule every report shares (messageIdentity.ts): our own posts, every stored copy, and
    // the member's attribute-from date at the message's time.
    const decided = identity.classify(row, row.ts.getTime());
    const actor: IntelActor = decided.actor;
    const memberId: string | null = decided.memberId;
    messages.push({
      // The LOGICAL key, so a quote resolves to the message whichever account's copy was kept.
      key: logicalMessageKey(row.wgid, row.wamid),
      groupKey: row.wgid,
      ts: row.ts.getTime(),
      actor,
      memberId,
      operatorUserId: actor === "OPERATOR" ? row.createdById : null,
      sender: row.sender,
      senderName: row.senderName,
      text: row.body,
      quotedKey: row.quotedKey ? logicalMessageKey(row.wgid, row.quotedKey) : null,
      quotedMemberId: row.quotedDirection === "INCOMING" ? memberFor(row.quotedSender, row.quotedSenderJid, row.quotedAt?.getTime() ?? null) : null,
      mentionedMemberIds: [
        ...new Set((row.mentions ?? []).map((m) => memberFor(m, null, row.ts.getTime())).filter((id): id is string => Boolean(id))),
      ],
    });
  }

  const settings: IntelSettings = {
    caseGapMs: DEFAULT_CASE_GAP_MS,
    reopenWindowMs: DEFAULT_REOPEN_WINDOW_MS,
    sessionGapMs: ctx.idleGapMs,
    // The Team Report's own threshold, as it stood when the customer asked (GroupResponsibilityChange).
    thresholdMs: (groupKey, at) => ctx.data.missedAfterMs(groupKey, at),
  };
  const facts: CaseFacts = {
    escalations: escalations.map((e) => ({
      groupKey: e.group.whatsappGroupId,
      openedAt: e.createdAt.getTime(),
      closedAt: (e.humanRepliedAt ?? e.resolvedAt ?? (["HUMAN_REPLIED", "RESOLVED", "CANCELLED"].includes(e.status) ? e.updatedAt : null))?.getTime() ?? null,
      resolvedByAdminAt: e.status === "RESOLVED" && e.resolvedById && e.resolvedAt ? e.resolvedAt.getTime() : null,
    })),
    // One completion per WhatsApp group per moment: a session is kept per group ROW, so one completing
    // reply in a group two of our numbers share closed two sessions and read as two completions.
    keywordCompletions: [
      ...new Map(
        completions
          .filter((c) => c.completedAt)
          .map((c) => {
            const completion = { groupKey: c.group.whatsappGroupId, at: c.completedAt!.getTime(), memberId: c.completedByTeamMemberId };
            return [`${completion.groupKey}|${Math.floor(completion.at / 60_000)}|${completion.memberId ?? ""}`, completion] as const;
          }),
      ).values(),
    ],
  };

  const measuredTo = measuredToOf(ctx);
  const allCases = buildCases(messages, measuredTo, settings, facts);
  const cases = allCases.filter((c) => c.openedAt >= ctx.rangeStart && c.openedAt < ctx.rangeEnd);

  // Sessions and waits answered count only while the employee is in scope (the Team Report's rule).
  const scope = ctx.data.scope;
  const scopedMemberMessages = scope ? messages.filter((m) => m.actor !== "MEMBER" || (m.memberId !== null && scope(m.memberId, m.ts))) : messages;
  const sessions = buildSessions(scopedMemberMessages, allCases, settings).filter((s) => s.end >= ctx.rangeStart && s.start < ctx.rangeEnd);
  const waits = humanWaits(messages, { rangeStart: ctx.rangeStart, rangeEnd: ctx.rangeEnd, measuredTo, thresholdMs: settings.thresholdMs });
  const signalOpts = { rangeStart: ctx.rangeStart, rangeEnd: ctx.rangeEnd, caseGapMs: settings.caseGapMs };
  const appreciation = appreciationSignals(messages, allCases, memberNames, signalOpts);
  const prefSignals = preferenceSignals(messages, allCases, appreciation, memberNames, signalOpts);
  const preferences = customerPreferences(cases, prefSignals);

  // ---- Who is evaluated: the chosen member, the members of the chosen Team in the period, or
  // everyone who supported anybody in the period.
  const { memberId: chosen, teamId } = ctx.filters;
  const active = new Set([...sessions.map((s) => s.memberId), ...waits.flatMap((w) => (w.repliedBy?.memberId ? [w.repliedBy.memberId] : []))]);
  const evaluated = chosen ? [chosen] : teamId ? (ctx.data.teamMemberIds[teamId] ?? []).filter((id) => active.has(id)) : [...active];

  const dutyWindows = new Map<string, DutyWindow[]>();
  for (const d of duties) {
    if (d.shiftStartMinute === null || d.shiftEndMinute === null) continue;
    const day = d.dutyDate.toISOString().slice(0, 10);
    const w = shiftWindow(day, d.shiftStartMinute, d.shiftEndMinute);
    if (w.end <= ctx.rangeStart || w.start >= ctx.rangeEnd) continue;
    dutyWindows.set(d.teamMemberId, [...(dutyWindows.get(d.teamMemberId) ?? []), { day, start: Math.max(w.start, ctx.rangeStart), end: Math.min(w.end, ctx.rangeEnd) }]);
  }

  const unverifiedDays = new Set<string>();
  const health = ctx.dataHealth;
  for (let t = ctx.rangeStart; t < ctx.rangeEnd; t += 86_400_000) {
    const dayStart = t;
    const dayEnd = Math.min(t + 86_400_000, ctx.rangeEnd);
    const unverified = health.unverified !== null && dayStart < health.unverified.to && dayEnd > health.unverified.from;
    const gap = health.gaps.some((g) => gapIsIncomplete(g) && g.startedAt < dayEnd && (g.endedAt ?? ctx.now.getTime()) > dayStart);
    if (unverified || gap) unverifiedDays.add(formatDhakaDateKey(new Date(dayStart)));
  }

  const scopedWaits = scope ? waits.filter((w) => !w.repliedBy?.memberId || scope(w.repliedBy.memberId, w.repliedAt!)) : waits;
  const effectiveness = effectivenessOf(
    employeeMetrics({
      memberIds: evaluated,
      cases,
      sessions,
      waits: scopedWaits,
      appreciation,
      preferences,
      dutyWindows,
      assignedMemberFor: (groupKey, at) => ctx.data.responsibilityAt(groupKey, at).assigned,
      rangeStart: ctx.rangeStart,
      rangeEnd: ctx.rangeEnd,
      unverifiedDays,
    }),
  );

  return {
    messages,
    cases,
    allCases,
    sessions,
    waits,
    appreciation,
    preferenceSignals: prefSignals,
    preferences,
    effectiveness,
    memberNames,
    memberTeams,
    settings,
    measuredTo,
    unverifiedDays,
  };
}
