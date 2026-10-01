
import { Prisma } from "@prisma/client";
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import {
  computeTeamReport,
  DHAKA_OFFSET_MS,
  formatDhakaDateKey,
  getDhakaDayRange,
  getDhakaMonthRange,
  getDhakaWeekRange,
  inTeamAt,
  membersOfTeamDuring,
  NO_TEAM,
  normalizePhoneNumber,
  type ReportGranularity,
  type ReportMessage,
  type TeamMembershipInterval,
  type TeamReportResult,
} from "@support-automation/shared";

/**
 * Loads the Team Report. The counting itself is `computeTeamReport` in packages/shared — one pure,
 * unit-tested function — so this file only decides WHICH messages go in and what each one is.
 *
 * Sources, all existing tables (nothing is duplicated or pre-aggregated):
 *   Message                   every stored group message in the period (+24h, see LOOKAHEAD_MS)
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
    date: params.date && DATE_RE.test(params.date) ? params.date : today,
    from: params.from && DATE_RE.test(params.from) ? params.from : today,
    to: params.to && DATE_RE.test(params.to) ? params.to : today,
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
}

/** Every form a member's senderPhone may be stored in — the same set Duty History matches on. */
export function senderIdentifiers(member: { phoneNumber: string; whatsappId: string | null }): string[] {
  const candidates = [member.whatsappId, member.phoneNumber, normalizePhoneNumber(member.phoneNumber)];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
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
  // Both empty by default, which leaves the query exactly as it always was.
  const groupFilter = filters.groupKeys?.length
    ? Prisma.sql`AND g."whatsappGroupId" IN (${Prisma.join(filters.groupKeys)})`
    : Prisma.empty;
  const accountFilter = filters.accountId ? Prisma.sql`AND m."accountId" = ${filters.accountId}` : Prisma.empty;

  const [members, settings, policies, teams, membershipRows, rows] = await Promise.all([
    prisma.internalTeamMember.findMany({
      select: { id: true, name: true, phoneNumber: true, whatsappId: true, status: true },
      orderBy: { name: "asc" },
    }),
    prisma.supportActivitySettings.findUnique({
      where: { id: "global" },
      select: { offlineAfterMinutes: true, missedReplyAfterMinutes: true },
    }),
    prisma.supportPriorityPolicy.findMany({ select: { priority: true, firstAlertMinutes: true } }),
    prisma.team.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
    prisma.teamMembership.findMany({ select: { teamMemberId: true, teamId: true, startedAt: true, endedAt: true } }),
    // One row per real message. DISTINCT ON collapses the copies a message gets when two of our
    // numbers are in the same group (each account stores its own row). Bounded by the timestamp
    // index; nothing unbounded is scanned, and only six narrow columns cross to Node.
    onlyWhatsappGroupId
      ? prisma.$queryRaw<Array<{ wgid: string; ts: Date; direction: string; fromTeam: boolean; sender: string }>>`
          SELECT DISTINCT ON (m."whatsappMessageId")
            g."whatsappGroupId" AS wgid, m."timestampWa" AS ts, m."direction"::text AS direction,
            m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender
          FROM "Message" m
          JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
          WHERE g."whatsappGroupId" = ${onlyWhatsappGroupId}
            AND m."projectId" = ${await activeProjectId()}
            AND m."timestampWa" >= ${range.start} AND m."timestampWa" < ${lookaheadEnd}
            ${accountFilter}
          ORDER BY m."whatsappMessageId", m."timestampWa", m."id"`
      : prisma.$queryRaw<Array<{ wgid: string; ts: Date; direction: string; fromTeam: boolean; sender: string }>>`
          SELECT DISTINCT ON (g."whatsappGroupId", m."whatsappMessageId")
            g."whatsappGroupId" AS wgid, m."timestampWa" AS ts, m."direction"::text AS direction,
            m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender
          FROM "Message" m
          JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
          WHERE m."timestampWa" >= ${range.start} AND m."timestampWa" < ${lookaheadEnd}
            AND m."projectId" = ${await activeProjectId()}
            ${groupFilter}
            ${accountFilter}
          ORDER BY g."whatsappGroupId", m."whatsappMessageId", m."timestampWa", m."id"`,
  ]);

  const identifierToMember = new Map<string, string>();
  for (const member of members) {
    for (const identifier of senderIdentifiers(member)) {
      if (!identifierToMember.has(identifier)) identifierToMember.set(identifier, member.id);
    }
  }

  const messages: ReportMessage[] = [];
  for (const row of rows) {
    if (row.direction === "SYSTEM") continue; // joins, leaves, subject changes — nobody said anything
    if (row.direction === "OUTGOING") {
      messages.push({ groupKey: row.wgid, ts: row.ts.getTime(), kind: "BUSINESS", memberId: null });
      continue;
    }
    const memberId = identifierToMember.get(row.sender) ?? null;
    messages.push({
      groupKey: row.wgid,
      ts: row.ts.getTime(),
      // A sender stamped as a team member at the time but no longer on the roster still replied as
      // one: counted as a reply, attributed to nobody.
      kind: memberId || row.fromTeam ? "MEMBER" : "CUSTOMER",
      memberId,
    });
  }

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
  const teamId = filters.teamId && filters.teamId in teamMemberIds ? filters.teamId : null;
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

  const result = computeTeamReport(messages, {
    rangeStart: range.start.getTime(),
    rangeEnd: range.end.getTime(),
    now: now.getTime(),
    idleGapMs: idleGapMinutes * 60_000,
    missedAfterMs: (groupKey) => {
      const priority = groups.get(groupKey)?.priority;
      const minutes = priority && policyMinutes[priority] ? policyMinutes[priority]! : missedAfterMinutes;
      return minutes * 60_000;
    },
    assignedMemberFor: (groupKey) => groups.get(groupKey)?.assignedMemberId ?? null,
    memberId,
    scope,
    granularity: filters.granularity,
  });

  return {
    filters: applied,
    messages,
    scope,
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
  };
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
