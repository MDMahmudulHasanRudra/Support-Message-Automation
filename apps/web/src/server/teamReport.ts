
import { Prisma } from "@prisma/client";
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { loadReportIdentity, messageKeySql, outboundByKeyJoin, preferSenderCopySql, storedCopiesSql } from "@/server/messageIdentity";
import { loadDutyResolver } from "@/server/overtimeDuty";
import {
  computeResponseMetrics,
  computeTeamReport,
  DEFAULT_CASE_GAP_MS,
  DHAKA_OFFSET_MS,
  emptyActorCounts,
  formatDhakaDateKey,
  getDhakaDayRange,
  getDhakaMonthRange,
  getDhakaWeekRange,
  humanWaits,
  inTeamAt,
  INTELLIGENCE_SQL_PREFILTER,
  logicalMessageKey,
  membersOfTeamDuring,
  NO_TEAM,
  type IntelActor,
  type IntelMessage,
  type ReliabilityCounts,
  type ReportGranularity,
  type ReportMessage,
  type ResponseMetrics,
  type TeamMembershipInterval,
  type TeamReportResult,
} from "@support-automation/shared";

/**
 * Loads the Team Report. The counting itself is `computeTeamReport` in packages/shared — one pure,
 * unit-tested function — so this file only decides WHICH messages go in and what each one is.
 *
 * Sources, all existing tables (nothing is duplicated or pre-aggregated):
 *   Message                   every stored group message in the period (+24h, see LOOKAHEAD_MS), the
 *                             4 hours before it and each group's last earlier message as CONTEXT
 *                             (never counted — see CONTEXT_MS)
 *   OutboundMessage           which send an outgoing message echoes: AI, rule, broadcast or a
 *                             dashboard user (Phase 2 reply provenance; none = the business phone)
 *   WhatsAppGroup             name, priority and assigned team member per group
 *   InternalTeamMember        who a sender is — every member, including deactivated ones, so a
 *                             person who has since left still owns their history
 *   Team, TeamMembership      the Team filter: which Team each member was in at each moment, so a
 *                             person who changed team is counted where they were at the time
 *   SupportPriorityPolicy     a prioritised group's first-alert time = its "missed" threshold
 *   SupportActivitySettings   the idle gap (offlineAfterMinutes) and the "missed after" default
 *
 * Reads Message rather than SupportActivity on purpose, like Duty History: activity tracking is off
 * by default, and a report built on it would silently be empty.
 */

export type ReportPeriod = "day" | "week" | "month" | "custom";
const PERIODS: readonly ReportPeriod[] = ["day", "week", "month", "custom"];
const GRANULARITIES: readonly ReportGranularity[] = ["day", "week", "month"];

const DAY_MS = 86_400_000;
/** A custom range longer than this is refused: the report is computed on the server per request. */
export const MAX_CUSTOM_DAYS = 92;
/**
 * How far past the period a reply is still looked for. A customer who asked at 23:50 on the last
 * day and was answered at 00:10 was answered — without this they would read as unanswered. A wait
 * still open a day after the period ends is reported as unanswered, which it was.
 */
const LOOKAHEAD_MS = DAY_MS;
/**
 * How far before the period messages are read as CONTEXT, never counted (Phase 2, PHASE2.md Stage 7):
 * Support Intelligence's own look-back, so the human-only wait is measured exactly as Human Response
 * SLA measures it. Each group's last message before that is read too, so a customer line just after
 * midnight that continues a wait begun the evening before is never counted as a second wait — a
 * month's waits are the sum of its days'.
 */
const CONTEXT_MS = DEFAULT_CASE_GAP_MS;

export interface TeamReportFilters {
  period: ReportPeriod;
  /** The anchor day for day/week/month, YYYY-MM-DD (Dhaka). */
  date: string;
  from: string;
  to: string;
  memberId: string | null;
  /** A Team id, NO_TEAM ("none") for members in no Team, or null for all Teams. */
  teamId: string | null;
  granularity: ReportGranularity;
  /**
   * WhatsApp group ids (`whatsappGroupId`) to restrict to; empty or absent = every group. Only the
   * messages of these groups are read, so support time and waits are the time and waits in them.
   */
  groupKeys?: string[];
  /** One WhatsApp account's stored copies only; null or absent = every account. */
  accountId?: string | null;
}

/** At most this many groups in a filter — a URL, not a database dump. */
export const MAX_FILTER_GROUPS = 200;

export interface ResolvedRange {
  start: Date;
  end: Date;
  label: string;
  /** Set when the requested custom range had to be corrected, so the page can say so. */
  note: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A YYYY-MM-DD that names a real day in a year a report can mean. The shape alone let 9999-12-31
 * through, whose period end (plus the reply look-ahead) is past the last instant Prisma can send to
 * Postgres, so the query threw and the page went to the error boundary; 2025-13-45 rolled over to a
 * different real date. Anything else falls back to today, as a malformed date always has.
 */
export function isReportDateKey(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (y < 2000 || y > 2999) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Dhaka midnight at the start of a YYYY-MM-DD, as a real instant. */
function dhakaMidnight(dateKey: string): Date | null {
  if (!DATE_RE.test(dateKey)) return null;
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d) - DHAKA_OFFSET_MS;
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Reads the URL into filters, falling back to "this month, whole team, by day" for anything unrecognised. */
export function parseTeamReportFilters(params: Record<string, string | undefined>, now: Date): TeamReportFilters {
  const today = formatDhakaDateKey(now);
  const period = PERIODS.includes(params.period as ReportPeriod) ? (params.period as ReportPeriod) : "month";
  const granularity = GRANULARITIES.includes(params.by as ReportGranularity)
    ? (params.by as ReportGranularity)
    : period === "month" || period === "custom" || period === "week"
      ? "day"
      : "day";
  return {
    period,
    date: isReportDateKey(params.date) ? params.date : today,
    from: isReportDateKey(params.from) ? params.from : today,
    to: isReportDateKey(params.to) ? params.to : today,
    memberId: params.member?.trim() || null,
    teamId: params.team?.trim() || null,
    granularity,
    groupKeys: [
      ...new Set(
        (params.groups ?? "")
          .split(",")
          .map((key) => key.trim())
          .filter((key) => key.length > 0 && key.length <= 200),
      ),
    ].slice(0, MAX_FILTER_GROUPS),
    accountId: params.account?.trim() || null,
  };
}

const fmt = (date: Date, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", ...options }).format(date);

export function resolveTeamReportRange(filters: TeamReportFilters, now: Date): ResolvedRange {
  if (filters.period === "custom") {
    let from = dhakaMidnight(filters.from) ?? getDhakaDayRange(now).start;
    let to = dhakaMidnight(filters.to) ?? getDhakaDayRange(now).start;
    let note: string | null = null;
    if (to < from) [from, to] = [to, from];
    let end = new Date(to.getTime() + DAY_MS);
    if (end.getTime() - from.getTime() > MAX_CUSTOM_DAYS * DAY_MS) {
      end = new Date(from.getTime() + MAX_CUSTOM_DAYS * DAY_MS);
      note = `Custom ranges are limited to ${MAX_CUSTOM_DAYS} days, so this shows the first ${MAX_CUSTOM_DAYS} days from the start date.`;
    }
    const last = new Date(end.getTime() - DAY_MS);
    return {
      start: from,
      end,
      label: `${fmt(from, { day: "numeric", month: "short", year: "numeric" })} – ${fmt(last, { day: "numeric", month: "short", year: "numeric" })}`,
      note,
    };
  }
  const anchor = dhakaMidnight(filters.date) ?? now;
  if (filters.period === "day") {
    const range = getDhakaDayRange(anchor);
    return { ...range, label: fmt(range.start, { weekday: "short", day: "numeric", month: "long", year: "numeric" }), note: null };
  }
  if (filters.period === "week") {
    const range = getDhakaWeekRange(anchor);
    const last = new Date(range.end.getTime() - DAY_MS);
    return {
      ...range,
      label: `Week of ${fmt(range.start, { day: "numeric", month: "short" })} – ${fmt(last, { day: "numeric", month: "short", year: "numeric" })}`,
      note: null,
    };
  }
  const range = getDhakaMonthRange(anchor);
  return { ...range, label: fmt(range.start, { month: "long", year: "numeric" }), note: null };
}

export interface GroupMeta {
  /** A representative WhatsAppGroup row id — the Primary account's copy when there is one. */
  id: string;
  whatsappGroupId: string;
  name: string;
  priority: string | null;
  assignedMemberId: string | null;
}

export interface TeamOption {
  id: string;
  name: string;
  status: string;
}

export interface TeamReportData {
  /** The filters actually applied — a member outside the chosen Team is reset to all its members. */
  filters: TeamReportFilters;
  /**
   * The classified messages `result` was computed from (the period plus the reply look-ahead). The
   * reports at /reports/<id> cut these another way, so they never re-decide who is a customer.
   */
  messages: ReportMessage[];
  /** The Team/member scope `result` was computed with, or null for the whole team. */
  scope: ((memberId: string, ts: number) => boolean) | null;
  range: ResolvedRange;
  result: TeamReportResult;
  memberNames: Map<string, string>;
  members: Array<{ id: string; name: string; status: string }>;
  teams: TeamOption[];
  /** For each Team id (and NO_TEAM), the members who were in it at some point of the period. */
  teamMemberIds: Record<string, string[]>;
  /** The chosen Team's name, "No team", or null for all Teams. */
  teamName: string | null;
  /** Set when a chosen member was not in the chosen Team this period, so the page can say so. */
  filterNote: string | null;
  groups: Map<string, GroupMeta>;
  rules: {
    idleGapMinutes: number;
    missedAfterMinutes: number;
    /** Priority → first-alert minutes, for the groups whose threshold comes from their SLA. */
    policyMinutes: Record<string, number>;
  };
  /**
   * Who answered, and the three response measures — beside the figures in `result`, never changing
   * one (packages/shared/src/teamReportReliability.ts).
   */
  response: ResponseMetrics;
  /** What was read for the period: stored copies, logical messages, senders and attribution strength. */
  reliabilityCounts: ReliabilityCounts;
}

interface LoadedRow {
  wgid: string;
  wamid: string;
  ts: Date;
  /** When this copy was stored: the order two messages in the same second arrived in. */
  storedAt: Date;
  direction: string;
  fromTeam: boolean;
  sender: string;
  senderJid: string | null;
  /** Every incoming copy of this logical message (`storedCopiesSql`). */
  copies: string[] | null;
  body: string | null;
  obMatched: boolean | null;
  actionType: string | null;
  ruleId: string | null;
  createdById: string | null;
}

/**
 * @param onlyWhatsappGroupId  restrict to one group — the drill-down page — which also narrows the
 *                             query instead of computing the whole team and discarding most of it.
 */
export async function loadTeamReport(
  filters: TeamReportFilters,
  now: Date,
  onlyWhatsappGroupId?: string,
): Promise<TeamReportData> {
  const range = resolveTeamReportRange(filters, now);
  const lookaheadEnd = new Date(range.end.getTime() + LOOKAHEAD_MS);
  const contextStart = new Date(range.start.getTime() - CONTEXT_MS);
  const projectId = await activeProjectId();
  // One group (the drill-down), the filtered groups, or every group; one account or every account.
  const groupFilter = onlyWhatsappGroupId
    ? Prisma.sql`AND g."whatsappGroupId" = ${onlyWhatsappGroupId}`
    : filters.groupKeys?.length
      ? Prisma.sql`AND g."whatsappGroupId" IN (${Prisma.join(filters.groupKeys)})`
      : Prisma.empty;
  const accountFilter = filters.accountId ? Prisma.sql`AND m."accountId" = ${filters.accountId}` : Prisma.empty;
  // The send a message echoes — matched on the LOGICAL key, so the copy another of our numbers stored
  // of our own post still finds it (messageIdentity.ts). Joined once as a hash, bounded by `sentAt`.
  const outboundOf = (alias: string) => outboundByKeyJoin(projectId, contextStart, lookaheadEnd, alias);
  // A message's text only where the human-only wait can read it: a line that may be a customer's
  // (incoming) and short or possibly a closing remark — Support Intelligence's own pre-filter, so the
  // two decide a closing remark identically. Not narrowed by the stored team-member stamp: who is
  // staff is decided at read time, and a stamp taken before somebody joined or left is not that.
  const bodyOf = (alias: string) => {
    const col = (name: string) => Prisma.raw(`${alias}."${name}"`);
    return Prisma.sql`CASE WHEN ${col("direction")} = 'INCOMING'
      AND (length(${col("body")}) BETWEEN 1 AND 24 OR ${col("body")} ~* ${INTELLIGENCE_SQL_PREFILTER}) THEN left(${col("body")}, 400) END`;
  };

  const [members, identity, settings, policies, teams, membershipRows, rows, earlier, copies] = await Promise.all([
    prisma.internalTeamMember.findMany({
      select: { id: true, name: true, status: true },
      orderBy: { name: "asc" },
    }),
    // Who sent each message: the one identity rule (WHATSAPP_IDENTITY.md), over every member, every
    // stored copy, and our own numbers (messageIdentity.ts).
    loadReportIdentity(projectId),
    prisma.supportActivitySettings.findUnique({
      where: { id: "global" },
      select: { offlineAfterMinutes: true, missedReplyAfterMinutes: true },
    }),
    prisma.supportPriorityPolicy.findMany({ select: { priority: true, firstAlertMinutes: true } }),
    prisma.team.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
    prisma.teamMembership.findMany({ select: { teamMemberId: true, teamId: true, startedAt: true, endedAt: true } }),
    // One row per real message. DISTINCT ON collapses the copies a message gets when two of our
    // numbers are in the same group (each account stores its own row) — on the LOGICAL message key,
    // not the stored id, which differs between the sending account's copy and every other's
    // (WHATSAPP_IDENTITY.md); the sending account's own copy is the one kept. Bounded by the
    // timestamp index; nothing unbounded is scanned. From CONTEXT_MS before the period.
    prisma.$queryRaw<LoadedRow[]>`
      SELECT DISTINCT ON (g."whatsappGroupId", ${messageKeySql()})
        g."whatsappGroupId" AS wgid, m."whatsappMessageId" AS wamid, m."timestampWa" AS ts, m."createdAt" AS "storedAt",
        m."direction"::text AS direction,
        m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender, m."senderJid" AS "senderJid",
        ${storedCopiesSql(Prisma.sql`g."whatsappGroupId"`)} AS copies,
        ${bodyOf("m")} AS body,
        o."obMatched" AS "obMatched", o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
      ${outboundOf("m")}
      WHERE m."timestampWa" >= ${contextStart} AND m."timestampWa" < ${lookaheadEnd}
        AND m."projectId" = ${projectId}
        ${groupFilter}
        ${accountFilter}
      ORDER BY g."whatsappGroupId", ${messageKeySql()}, ${preferSenderCopySql()}, m."timestampWa", m."id"`,
    // Each group's last message before the context window: one index probe per group with activity
    // in the period. Only ever the message BEFORE the first one read, so a wait already open then is
    // continued rather than counted again.
    prisma.$queryRaw<LoadedRow[]>`
      SELECT DISTINCT ON (gg."whatsappGroupId")
        gg."whatsappGroupId" AS wgid, p."whatsappMessageId" AS wamid, p."timestampWa" AS ts, p."createdAt" AS "storedAt",
        p."direction"::text AS direction,
        p."isFromTeamMember" AS "fromTeam", p."senderPhone" AS sender, p."senderJid" AS "senderJid",
        NULL::text[] AS copies,
        ${bodyOf("p")} AS body,
        o."obMatched" AS "obMatched", o."actionType"::text AS "actionType", o."ruleId" AS "ruleId", o."createdById" AS "createdById"
      FROM (
        SELECT DISTINCT m."groupId"
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
        WHERE m."projectId" = ${projectId}
          AND m."timestampWa" >= ${range.start} AND m."timestampWa" < ${lookaheadEnd}
          ${groupFilter}
          ${accountFilter}
      ) r
      JOIN "WhatsAppGroup" gg ON gg."id" = r."groupId" AND gg."projectId" = ${projectId}
      CROSS JOIN LATERAL (
        SELECT x.*
        FROM "Message" x
        WHERE x."groupId" = r."groupId" AND x."projectId" = ${projectId}
          AND x."timestampWa" < ${contextStart} AND x."direction" <> 'SYSTEM'
          ${filters.accountId ? Prisma.sql`AND x."accountId" = ${filters.accountId}` : Prisma.empty}
        ORDER BY x."timestampWa" DESC
        LIMIT 1
      ) p
      ${outboundOf("p")}
      ORDER BY gg."whatsappGroupId", p."timestampWa" DESC`,
    // Every stored copy in the period, for the reliability section: copies minus logical messages is
    // how much the dedup collapsed.
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
      WHERE m."projectId" = ${projectId}
        AND m."timestampWa" >= ${range.start} AND m."timestampWa" < ${range.end}
        AND m."direction" <> 'SYSTEM'
        ${groupFilter}
        ${accountFilter}`,
  ]);

  const rangeStart = range.start.getTime();
  const rangeEnd = range.end.getTime();

  // Every classified message, context included (oldest group context first), and the same messages
  // in Support Intelligence's shape for the human-only wait.
  const all: ReportMessage[] = [];
  const intel: IntelMessage[] = [];
  const counts: ReliabilityCounts = {
    storedCopies: copies[0]?.n ?? 0,
    logicalMessages: 0,
    byActor: emptyActorCounts(),
    attribution: { idAndPhone: 0, idOnly: 0, phoneOnly: 0 },
    conflicting: 0,
    unattributedSenders: 0,
  };
  const unattributed = new Set<string>();
  // Oldest first, and two messages in the same second in the order they were stored: the rows arrive
  // sorted by group and key, and a reply sorted ahead of the question it answers closed the wait
  // with a later reply instead (a false Recall or Missed).
  const ordered = [...earlier, ...rows].sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.storedAt.getTime() - b.storedAt.getTime());
  for (const row of ordered) {
    if (row.direction === "SYSTEM") continue; // joins, leaves, subject changes — nobody said anything
    const ts = row.ts.getTime();
    const inPeriod = ts >= rangeStart && ts < rangeEnd;
    // At the message's time: before a member's attribute-from date their number is a customer's
    // (WHATSAPP_IDENTITY.md). A copy of our own post is the business's; a dashboard reply is the
    // linked team member's; a colleague whose identifiers conflict is staff credited to nobody.
    const decided = identity.classify(row, ts);
    const kind: ReportMessage["kind"] = decided.kind;
    const memberId = decided.memberId;
    const actor: IntelActor = decided.actor;
    if (inPeriod && decided.status) {
      if (decided.status === "WHATSAPP_ID_AND_PHONE_MATCH") counts.attribution.idAndPhone += 1;
      else if (decided.status === "WHATSAPP_ID_MATCH") counts.attribution.idOnly += 1;
      else if (decided.status === "PHONE_MATCH") counts.attribution.phoneOnly += 1;
      else if (decided.status === "CONFLICT" || decided.status === "AMBIGUOUS") counts.conflicting += 1;
      if (actor === "MEMBER_UNMAPPED") unattributed.add(row.senderJid ?? row.sender);
    }
    all.push({ groupKey: row.wgid, ts, kind, memberId, actor });
    intel.push({
      key: logicalMessageKey(row.wgid, row.wamid),
      groupKey: row.wgid,
      ts,
      actor,
      memberId,
      operatorUserId: actor === "OPERATOR" ? row.createdById : null,
      sender: row.sender,
      senderName: null,
      text: row.body,
      quotedKey: null,
      quotedMemberId: null,
      mentionedMemberIds: [],
    });
    if (inPeriod) {
      counts.logicalMessages += 1;
      counts.byActor[actor] += 1;
    }
  }
  counts.unattributedSenders = unattributed.size;
  // What the reports at /reports/<id> read, exactly as before: the period and its look-ahead only.
  const messages = all.filter((m) => m.ts >= rangeStart);

  const groupKeys = [...new Set(messages.map((m) => m.groupKey))];
  const groupRows = groupKeys.length
    ? await prisma.whatsAppGroup.findMany({
        where: { whatsappGroupId: { in: groupKeys } },
        select: {
          id: true,
          whatsappGroupId: true,
          name: true,
          priority: true,
          assignedTeamMemberId: true,
          account: { select: { isPrimary: true } },
        },
      })
    : [];
  const groups = new Map<string, GroupMeta>();
  for (const row of groupRows) {
    const existing = groups.get(row.whatsappGroupId);
    const better = !existing || row.account.isPrimary;
    const merged: GroupMeta = {
      id: better ? row.id : existing!.id,
      whatsappGroupId: row.whatsappGroupId,
      name: better ? row.name : existing!.name,
      // Any copy's setting counts: priority and assignment are set per row, and one account's copy
      // is often the only one anybody configured.
      priority: (better ? row.priority : existing!.priority) ?? existing?.priority ?? row.priority ?? null,
      assignedMemberId:
        (better ? row.assignedTeamMemberId : existing!.assignedMemberId) ??
        existing?.assignedMemberId ??
        row.assignedTeamMemberId ??
        null,
    };
    groups.set(row.whatsappGroupId, merged);
  }

  const idleGapMinutes = Math.min(24 * 60, Math.max(5, settings?.offlineAfterMinutes ?? 120));
  const missedAfterMinutes = Math.min(24 * 60, Math.max(1, settings?.missedReplyAfterMinutes ?? 30));
  const policyMinutes: Record<string, number> = {};
  for (const policy of policies) policyMinutes[policy.priority] = policy.firstAlertMinutes;

  // ---- Team filter ----
  const intervals: TeamMembershipInterval[] = membershipRows.map((row) => ({
    memberId: row.teamMemberId,
    teamId: row.teamId,
    startedAt: row.startedAt?.getTime() ?? null,
    endedAt: row.endedAt?.getTime() ?? null,
  }));
  const memberIds = members.map((m) => m.id);
  const teamMemberIds: Record<string, string[]> = {};
  for (const teamKey of [...teams.map((t) => t.id), NO_TEAM]) {
    teamMemberIds[teamKey] = membersOfTeamDuring(intervals, memberIds, teamKey, range.start.getTime(), range.end.getTime());
  }
  const memberNames = new Map(members.map((m) => [m.id, m.name]));
  // An unknown Team (deleted, or a mistyped link) falls back to all Teams rather than an empty report.
  // An OWN key only: `in` also matched "toString", "constructor" and every other inherited name, so
  // ?team=toString reached the code below as a function and the page threw (2 Oct audit).
  const teamId = filters.teamId && Object.prototype.hasOwnProperty.call(teamMemberIds, filters.teamId) ? filters.teamId : null;
  const teamName = teamId === null ? null : teamId === NO_TEAM ? "No team" : (teams.find((t) => t.id === teamId)?.name ?? null);
  let memberId = filters.memberId;
  let filterNote: string | null = null;
  if (teamId && memberId && !teamMemberIds[teamId]!.includes(memberId)) {
    filterNote = `${memberNames.get(memberId) ?? "That team member"} was not in ${teamName} during ${range.label}, so this shows all of ${teamName}.`;
    memberId = null;
  }
  const applied: TeamReportFilters = { ...filters, teamId, memberId };
  const scope = teamId
    ? (id: string, ts: number) => (memberId === null || id === memberId) && inTeamAt(intervals, id, teamId, ts)
    : null;

  const missedAfterMs = (groupKey: string) => {
    const priority = groups.get(groupKey)?.priority;
    const minutes = priority && policyMinutes[priority] ? policyMinutes[priority]! : missedAfterMinutes;
    return minutes * 60_000;
  };
  // Context included: it is never counted, only read as the message before the period's first.
  const result = computeTeamReport(all, {
    rangeStart,
    rangeEnd,
    now: now.getTime(),
    idleGapMs: idleGapMinutes * 60_000,
    missedAfterMs,
    assignedMemberFor: (groupKey) => groups.get(groupKey)?.assignedMemberId ?? null,
    memberId,
    scope,
    granularity: filters.granularity,
    // Support Overtime: each member's regular duty for each day (TEAM_OVERTIME.md).
    dutyFor: await loadDutyResolver(range),
  });

  // The human-only wait (Human Response SLA's), over the same groups as this report's waits: every
  // group with activity, or — in a Team/member report — the groups its members supported.
  const reportGroups = new Set(result.groups.map((g) => g.groupKey));
  const response = computeResponseMetrics({
    waits: result.waits,
    humanWaits: humanWaits(intel, { rangeStart, rangeEnd, measuredTo: Math.min(rangeEnd, now.getTime()), thresholdMs: missedAfterMs }),
    inScope: (groupKey) => reportGroups.has(groupKey),
  });

  return {
    filters: applied,
    messages,
    // The scope computeTeamReport actually applied: the Team predicate, or — with only a member
    // chosen — that member alone. Returning the Team predicate alone left every member report at
    // /reports/<id> ignoring a member-only filter (found in the 2 Oct audit).
    scope: scope ?? (memberId ? (id: string) => id === memberId : null),
    range,
    result,
    memberNames,
    members: members.map((m) => ({ id: m.id, name: m.name, status: m.status })),
    teams,
    teamMemberIds,
    teamName,
    filterNote,
    groups,
    rules: { idleGapMinutes, missedAfterMinutes, policyMinutes },
    response,
    reliabilityCounts: counts,
  };
}

/**
 * The moment a report is computed as of. An export carries the page's own moment (`asof`, epoch ms)
 * so a file downloaded from an open period says what the page said: computed a minute later, a wait
 * could turn from "still waiting" into Missed between the screen and the file. Only a moment in the
 * last 24 hours and not in the future is accepted; anything else is now.
 */
export function reportNow(params: Record<string, string | undefined>, real: Date = new Date()): Date {
  const asOf = Number(params.asof);
  if (!Number.isFinite(asOf) || asOf > real.getTime() || asOf < real.getTime() - DAY_MS) return real;
  return new Date(asOf);
}

/** The URL for a report with some filters changed — shared by the page, its links and the exports. */
export function teamReportQuery(filters: TeamReportFilters, overrides: Partial<TeamReportFilters> & { page?: number } = {}): string {
  const merged = { ...filters, ...overrides };
  const qs = new URLSearchParams();
  qs.set("period", merged.period);
  if (merged.period === "custom") {
    qs.set("from", merged.from);
    qs.set("to", merged.to);
  } else {
    qs.set("date", merged.date);
  }
  if (merged.teamId) qs.set("team", merged.teamId);
  if (merged.memberId) qs.set("member", merged.memberId);
  qs.set("by", merged.granularity);
  if (merged.groupKeys?.length) qs.set("groups", merged.groupKeys.join(","));
  if (merged.accountId) qs.set("account", merged.accountId);
  if (overrides.page && overrides.page > 1) qs.set("page", String(overrides.page));
  return qs.toString();
}

/** A human label for a bucket key: 2026-09-10 → "10 Sep", week → "Week of 6 Sep", 2026-09 → "Sep 2026". */
export function bucketLabel(key: string, granularity: ReportGranularity): string {
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number) as [number, number];
    return fmt(new Date(Date.UTC(y, m - 1, 15)), { month: "short", year: "numeric" });
  }
  const date = dhakaMidnight(key);
  if (!date) return key;
  const label = fmt(date, { day: "numeric", month: "short" });
  return granularity === "week" ? `Week of ${label}` : label;
}

/** "Support Team · All members", "Support Team · Rudra", "All teams · All team members" — the report's scope in words. */
export function scopeLabel(teamName: string | null, memberName: string | null): string {
  const member = memberName ?? (teamName ? "All members" : "All team members");
  return teamName ? `${teamName} · ${member}` : memberName ?? "All team members";
}

/** A person's name for a report row, including the two rows that are not people. */
export function memberLabel(memberId: string | null, names: Map<string, string>): string {
  if (!memberId || memberId === "UNASSIGNED") return "Unassigned";
  if (memberId === "BUSINESS") return "Business number";
  return names.get(memberId) ?? "Former team member";
}
