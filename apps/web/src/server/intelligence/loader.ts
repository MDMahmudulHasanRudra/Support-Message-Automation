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
  normalizePhoneNumber,
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
import { senderIdentifiers } from "@/server/teamReport";
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
  direction: string;
  fromTeam: boolean;
  sender: string;
  senderName: string | null;
  mentions: string[] | null;
  body: string | null;
  quotedKey: string | null;
  quotedSender: string | null;
  quotedDirection: string | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

const LOOKAHEAD_MS = 24 * 3_600_000;

/** Who sent an outgoing message, from the send it echoes. No send at all: the business phone. */
function outgoingActor(row: Pick<Row, "actionType" | "ruleId">): IntelActor {
  switch (row.actionType) {
    case null:
      return "BUSINESS_PHONE";
    case "MANUAL_REPLY":
      return "OPERATOR";
    case "GROUP_BROADCAST":
      return "BROADCAST";
    case "AUTO_REPLY":
      // The AI fallback, its holding reply and its handover mention send without a rule.
      return row.ruleId ? "RULE" : "AI";
    default:
      return "RULE";
  }
}

export async function loadIntelligence(ctx: ReportContext): Promise<IntelligenceData> {
  const projectId = await activeProjectId();
  const from = new Date(ctx.rangeStart - DEFAULT_CASE_GAP_MS);
  const to = new Date(ctx.rangeEnd + LOOKAHEAD_MS);
  const { groupKeys, accountId } = ctx.filters;
  const groupFilter = groupKeys?.length ? Prisma.sql`AND g."whatsappGroupId" IN (${Prisma.join(groupKeys)})` : Prisma.empty;
  const accountFilter = accountId ? Prisma.sql`AND m."accountId" = ${accountId}` : Prisma.empty;

  const [rows, members, escalations, completions, duties] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON (g."whatsappGroupId", m."whatsappMessageId")
        g."whatsappGroupId" AS wgid, m."whatsappMessageId" AS wamid, m."timestampWa" AS ts,
        m."direction"::text AS direction, m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender,
        m."senderName" AS "senderName", m."mentionedPhones" AS mentions,
        CASE WHEN length(m."body") BETWEEN 1 AND 24 OR m."body" ~* ${INTELLIGENCE_SQL_PREFILTER} THEN left(m."body", 400) END AS body,
        q."whatsappMessageId" AS "quotedKey", q."senderPhone" AS "quotedSender", q."direction"::text AS "quotedDirection",
        o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId" AND g."projectId" = ${projectId}
      LEFT JOIN "Message" q ON q."id" = m."quotedMessageId" AND q."projectId" = ${projectId}
      LEFT JOIN LATERAL (
        SELECT ob."actionType", ob."ruleId", ob."createdById"
        FROM "OutboundMessage" ob
        WHERE m."direction" = 'OUTGOING' AND ob."providerMessageId" = m."whatsappMessageId" AND ob."projectId" = ${projectId}
        ORDER BY ob."createdAt" DESC
        LIMIT 1
      ) o ON true
      WHERE m."projectId" = ${projectId}
        AND m."timestampWa" >= ${from} AND m."timestampWa" < ${to}
        AND m."direction" <> 'SYSTEM'
        ${groupFilter}
        ${accountFilter}
      ORDER BY g."whatsappGroupId", m."whatsappMessageId", m."timestampWa", m."id"`,
    prisma.internalTeamMember.findMany({
      select: { id: true, name: true, phoneNumber: true, whatsappId: true, team: { select: { name: true } } },
    }),
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

  // ---- Roster: the same identifiers the Team Report matches on.
  const identifierToMember = new Map<string, string>();
  for (const member of members) {
    for (const identifier of senderIdentifiers(member)) if (!identifierToMember.has(identifier)) identifierToMember.set(identifier, member.id);
  }
  const memberFor = (raw: string | null) => (raw ? (identifierToMember.get(raw) ?? identifierToMember.get(normalizePhoneNumber(raw) ?? "") ?? null) : null);
  const memberNames = new Map(members.map((m) => [m.id, m.name]));
  const memberTeams = new Map(members.map((m) => [m.id, m.team?.name ?? null]));

  // ---- Groups in scope (Team / member filter), the way every group report decides it.
  const inScopeGroup = (groupKey: string) => ctx.groupInScope(groupKey, ctx.data.groups.get(groupKey)?.assignedMemberId ?? null);

  const messages: IntelMessage[] = [];
  for (const row of rows) {
    if (!inScopeGroup(row.wgid)) continue;
    let actor: IntelActor;
    let memberId: string | null = null;
    if (row.direction === "OUTGOING") actor = outgoingActor(row);
    else {
      memberId = memberFor(row.sender);
      actor = memberId ? "MEMBER" : row.fromTeam ? "MEMBER_UNMAPPED" : "CUSTOMER";
    }
    messages.push({
      key: row.wamid,
      groupKey: row.wgid,
      ts: row.ts.getTime(),
      actor,
      memberId,
      operatorUserId: actor === "OPERATOR" ? row.createdById : null,
      sender: row.sender,
      senderName: row.senderName,
      text: row.body,
      quotedKey: row.quotedKey,
      quotedMemberId: row.quotedDirection === "INCOMING" ? memberFor(row.quotedSender) : null,
      mentionedMemberIds: [...new Set((row.mentions ?? []).map(memberFor).filter((id): id is string => Boolean(id)))],
    });
  }

  const rules = ctx.data.rules;
  const settings: IntelSettings = {
    caseGapMs: DEFAULT_CASE_GAP_MS,
    reopenWindowMs: DEFAULT_REOPEN_WINDOW_MS,
    sessionGapMs: ctx.idleGapMs,
    thresholdMs: (groupKey) => {
      const priority = ctx.data.groups.get(groupKey)?.priority;
      const minutes = priority && rules.policyMinutes[priority] ? rules.policyMinutes[priority]! : rules.missedAfterMinutes;
      return minutes * 60_000;
    },
  };
  const facts: CaseFacts = {
    escalations: escalations.map((e) => ({
      groupKey: e.group.whatsappGroupId,
      openedAt: e.createdAt.getTime(),
      closedAt: (e.humanRepliedAt ?? e.resolvedAt ?? (["HUMAN_REPLIED", "RESOLVED", "CANCELLED"].includes(e.status) ? e.updatedAt : null))?.getTime() ?? null,
      resolvedByAdminAt: e.status === "RESOLVED" && e.resolvedById && e.resolvedAt ? e.resolvedAt.getTime() : null,
    })),
    keywordCompletions: completions
      .filter((c) => c.completedAt)
      .map((c) => ({ groupKey: c.group.whatsappGroupId, at: c.completedAt!.getTime(), memberId: c.completedByTeamMemberId })),
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
      assignedMemberFor: (groupKey) => ctx.data.groups.get(groupKey)?.assignedMemberId ?? null,
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
