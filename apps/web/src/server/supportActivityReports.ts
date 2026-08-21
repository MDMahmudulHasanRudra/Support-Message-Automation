import { prisma } from "@support-automation/db";
import type { SupportActivityCountingMode } from "@prisma/client";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";

// Server-component-only read helpers for Support Activity Tracking's dashboard pages — no
// "use server" directive, these are never invoked from a client event handler. Aggregates across
// all connected WhatsApp accounts by default, matching every other multi-query dashboard summary
// in this app (see dashboardSummary.ts) — every underlying SupportActivity row still carries its
// own accountId, so a future per-account breakdown is a filter away, not a schema change.

export interface DateRange {
  start: Date;
  end: Date;
}

/** EVERY_ACTIVITY: count every valid activity in the period. */
export async function getEveryActivityCount(range: DateRange): Promise<number> {
  return prisma.supportActivity.count({ where: { occurredAt: { gte: range.start, lt: range.end } } });
}

/** UNIQUE_GROUP: each group counted once per period regardless of how many activities it had. */
export async function getUniqueGroupCount(range: DateRange): Promise<number> {
  const groups = await prisma.supportActivity.groupBy({
    by: ["groupId"],
    where: { occurredAt: { gte: range.start, lt: range.end } },
  });
  return groups.length;
}

export interface TeamMemberBreakdownRow {
  teamMemberId: string;
  name: string;
  activityCount: number;
}

/**
 * PER_TEAM_MEMBER: total activity count broken down per team member. Confirmed against the master
 * prompt's own worked example (section 7): two activities by the same member in the SAME group
 * still count as 2 — this is "every activity, broken down by member," not "unique groups per
 * member."
 */
export async function getPerTeamMemberBreakdown(range: DateRange): Promise<TeamMemberBreakdownRow[]> {
  const grouped = await prisma.supportActivity.groupBy({
    by: ["teamMemberId"],
    where: { occurredAt: { gte: range.start, lt: range.end }, teamMemberId: { not: null } },
    _count: { teamMemberId: true },
  });
  if (grouped.length === 0) return [];

  const members = await prisma.internalTeamMember.findMany({
    where: { id: { in: grouped.map((g) => g.teamMemberId as string) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(members.map((m) => [m.id, m.name]));

  return grouped
    .map((g) => ({
      teamMemberId: g.teamMemberId as string,
      name: nameById.get(g.teamMemberId as string) ?? "(removed team member)",
      activityCount: g._count.teamMemberId,
    }))
    .sort((a, b) => b.activityCount - a.activityCount);
}

/** Dispatches on SupportActivitySettings.countingMode for a single headline number. */
export async function computeSupportActivityCount(range: DateRange, mode: SupportActivityCountingMode): Promise<number> {
  switch (mode) {
    case "UNIQUE_GROUP":
      return getUniqueGroupCount(range);
    case "EVERY_ACTIVITY":
      return getEveryActivityCount(range);
    case "PER_TEAM_MEMBER": {
      const breakdown = await getPerTeamMemberBreakdown(range);
      return breakdown.reduce((sum, m) => sum + m.activityCount, 0);
    }
  }
}

export interface RecentActivityRow {
  id: string;
  occurredAt: Date;
  groupName: string;
  teamMemberName: string | null;
  keywordValue: string | null;
  messageBody: string;
}

/** Most recent N activities across every group/account, for a quick pulse-check. */
export async function getRecentActivities(take = 10): Promise<RecentActivityRow[]> {
  const rows = await prisma.supportActivity.findMany({
    orderBy: { occurredAt: "desc" },
    take,
    include: {
      group: { select: { name: true } },
      teamMember: { select: { name: true } },
      keyword: { select: { value: true } },
      message: { select: { body: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurredAt,
    groupName: r.group.name,
    teamMemberName: r.teamMember?.name ?? null,
    keywordValue: r.keyword?.value ?? null,
    messageBody: r.message.body,
  }));
}

/** Daily incoming-activity counts for the last N Dhaka calendar days, oldest first — feeds the
 *  Activity page's trend Sparkline. Follows dashboardSummary.ts's getRecentMessageActivity() day-
 *  bucketing pattern, but Dhaka-correct (via getDhakaDayRange) since this is a dedicated feature
 *  page, not the general dashboard. */
export async function getActivityTrend(days = 30): Promise<number[]> {
  const now = new Date();
  const dayRanges: DateRange[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dayRanges.push(getDhakaDayRange(new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
  }
  return Promise.all(dayRanges.map((range) => getEveryActivityCount(range)));
}

export interface ExportActivityRow {
  occurredAt: Date;
  groupName: string;
  teamMemberName: string | null;
  keywordValue: string | null;
  triggerType: string | null;
  messageBody: string;
}

/** Full raw activity rows for a date range (and optionally one group), bounded only by the date
 *  range itself — feeds the CSV/Excel export endpoint. */
export async function getActivitiesForExport(range: DateRange, groupId?: string): Promise<ExportActivityRow[]> {
  const rows = await prisma.supportActivity.findMany({
    where: { occurredAt: { gte: range.start, lt: range.end }, ...(groupId ? { groupId } : {}) },
    orderBy: { occurredAt: "desc" },
    include: {
      group: { select: { name: true } },
      teamMember: { select: { name: true } },
      keyword: { select: { value: true } },
      rule: { select: { triggerType: true } },
      message: { select: { body: true } },
    },
  });
  return rows.map((r) => ({
    occurredAt: r.occurredAt,
    groupName: r.group.name,
    teamMemberName: r.teamMember?.name ?? null,
    keywordValue: r.keyword?.value ?? null,
    triggerType: r.rule?.triggerType ?? null,
    messageBody: r.message.body,
  }));
}

/** How long a group's OPEN session must have been running before it's flagged "stale"/needs
 *  attention — a pure display-time threshold, never a stored status (see SupportSession's own
 *  doc comment in schema.prisma for why). */
export const STALE_SESSION_THRESHOLD_MS = 4 * 60 * 60 * 1000;

/** 30-minute "available now" window, confirmed requirement — how recent a team member's last
 *  group message must be to still count as actively available. */
const AVAILABLE_WINDOW_MS = 30 * 60 * 1000;

export interface HoursWorkedRow {
  teamMemberId: string;
  name: string;
  totalSeconds: number;
}

/** Confirmed "hours worked" definition: sum of durationSeconds across every SupportSession a
 *  member closed (completedByTeamMemberId) whose completedAt falls in the given range — resolved
 *  support-session handling time, not attendance/clock-in hours. OPEN sessions never contribute
 *  (durationSeconds is null until completion); a manually-closed session only contributes if it
 *  happens to have a non-null completedByTeamMemberId, which today it never does (manual close
 *  always attributes to the admin instead — see getGroupSessionHistory's completedByLabel). */
export async function getDailyHoursWorked(range: DateRange): Promise<HoursWorkedRow[]> {
  const grouped = await prisma.supportSession.groupBy({
    by: ["completedByTeamMemberId"],
    where: {
      status: "COMPLETED",
      completedByTeamMemberId: { not: null },
      completedAt: { gte: range.start, lt: range.end },
    },
    _sum: { durationSeconds: true },
  });
  if (grouped.length === 0) return [];

  const members = await prisma.internalTeamMember.findMany({
    where: { id: { in: grouped.map((g) => g.completedByTeamMemberId as string) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(members.map((m) => [m.id, m.name]));

  return grouped
    .map((g) => ({
      teamMemberId: g.completedByTeamMemberId as string,
      name: nameById.get(g.completedByTeamMemberId as string) ?? "(removed team member)",
      totalSeconds: g._sum.durationSeconds ?? 0,
    }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
}

export interface TeamAvailabilityRow {
  teamMemberId: string;
  name: string;
  workingToday: boolean;
  availableNow: boolean;
}

/**
 * Two independently-computed, always-live indicators per active InternalTeamMember — never
 * stored/cached, since "available now" is inherently a moving window. Both are pure derived
 * queries over existing SupportActivity.occurredAt timestamps; no presence/heartbeat infra of any
 * kind. The base list is every ACTIVE member (not just those with a groupBy hit), so a member with
 * zero activity today still shows as "Off today" rather than being silently omitted.
 */
export async function getTeamAvailability(now: Date = new Date()): Promise<TeamAvailabilityRow[]> {
  const members = await prisma.internalTeamMember.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  if (members.length === 0) return [];

  const todayRange = getDhakaDayRange(now);
  const availableCutoff = new Date(now.getTime() - AVAILABLE_WINDOW_MS);

  const [workingTodayRows, availableNowRows] = await Promise.all([
    prisma.supportActivity.groupBy({
      by: ["teamMemberId"],
      where: { teamMemberId: { not: null }, occurredAt: { gte: todayRange.start, lt: todayRange.end } },
    }),
    prisma.supportActivity.groupBy({
      by: ["teamMemberId"],
      where: { teamMemberId: { not: null }, occurredAt: { gte: availableCutoff } },
    }),
  ]);
  const workingToday = new Set(workingTodayRows.map((r) => r.teamMemberId));
  const availableNow = new Set(availableNowRows.map((r) => r.teamMemberId));

  return members.map((m) => ({
    teamMemberId: m.id,
    name: m.name,
    workingToday: workingToday.has(m.id),
    availableNow: availableNow.has(m.id),
  }));
}

export interface GroupSessionRow {
  id: string;
  status: string;
  startedAt: Date;
  startedByName: string | null;
  completedAt: Date | null;
  /** Null while OPEN. For a COMPLETED session, either the team member who sent the completion
   *  keyword, or "Admin" (optionally with the admin's own name) for a manual close — the two are
   *  mutually exclusive at the data level (completedByTeamMemberId vs completedByUserId). */
  completedByLabel: string | null;
  durationSeconds: number | null;
  isStale: boolean;
}

/** Session-level (open/closed + duration) view for one group — filters on startedAt within range,
 *  same single-timestamp-range convention as getGroupSupportHistory's own occurredAt filter. */
export async function getGroupSessionHistory(groupId: string, range: DateRange, now: Date = new Date()): Promise<GroupSessionRow[]> {
  const sessions = await prisma.supportSession.findMany({
    where: { groupId, startedAt: { gte: range.start, lt: range.end } },
    orderBy: { startedAt: "desc" },
    include: {
      startedByTeamMember: { select: { name: true } },
      completedByTeamMember: { select: { name: true } },
      completedByUser: { select: { name: true } },
    },
  });
  return sessions.map((s) => ({
    id: s.id,
    status: s.status,
    startedAt: s.startedAt,
    startedByName: s.startedByTeamMember?.name ?? null,
    completedAt: s.completedAt,
    completedByLabel: s.completedByTeamMember?.name ?? (s.completedByUser ? `Admin (${s.completedByUser.name})` : null),
    durationSeconds: s.durationSeconds,
    isStale: s.status === "OPEN" && now.getTime() - s.startedAt.getTime() > STALE_SESSION_THRESHOLD_MS,
  }));
}

export interface SessionExportRow {
  groupName: string;
  status: string;
  startedAt: Date;
  startedByName: string | null;
  completedAt: Date | null;
  completedByLabel: string | null;
  durationSeconds: number | null;
}

/** Feeds the export endpoint's `type=sessions` branch. Exports raw durationSeconds, not a
 *  human-formatted string — exports stay the canonical/raw data source, formatting is a UI
 *  concern. */
export async function getSessionsForExport(range: DateRange, groupId?: string): Promise<SessionExportRow[]> {
  const sessions = await prisma.supportSession.findMany({
    where: { startedAt: { gte: range.start, lt: range.end }, ...(groupId ? { groupId } : {}) },
    orderBy: { startedAt: "desc" },
    include: {
      group: { select: { name: true } },
      startedByTeamMember: { select: { name: true } },
      completedByTeamMember: { select: { name: true } },
      completedByUser: { select: { name: true } },
    },
  });
  return sessions.map((s) => ({
    groupName: s.group.name,
    status: s.status,
    startedAt: s.startedAt,
    startedByName: s.startedByTeamMember?.name ?? null,
    completedAt: s.completedAt,
    completedByLabel: s.completedByTeamMember?.name ?? (s.completedByUser ? `Admin (${s.completedByUser.name})` : null),
    durationSeconds: s.durationSeconds,
  }));
}

/** Feeds the main landing page's "Avg Resolution Time" stat tile — COMPLETED sessions only within
 *  the period; OPEN (including stale) sessions have no durationSeconds yet, so they're naturally
 *  excluded, never specially filtered out. */
export async function getAverageResolutionTime(range: DateRange): Promise<number | null> {
  const result = await prisma.supportSession.aggregate({
    where: { status: "COMPLETED", completedAt: { gte: range.start, lt: range.end } },
    _avg: { durationSeconds: true },
  });
  return result._avg.durationSeconds;
}

/** Count of currently-OPEN sessions across every group that have been running longer than the
 *  stale threshold — feeds a landing-page Alert so unresolved sessions stay highly visible to
 *  admins without requiring them to check every group individually on the Reports page. */
export async function getStaleSessionCount(now: Date = new Date()): Promise<number> {
  return prisma.supportSession.count({
    where: { status: "OPEN", startedAt: { lt: new Date(now.getTime() - STALE_SESSION_THRESHOLD_MS) } },
  });
}

/** Group Support History: one group's activity timeline plus the raw-vs-counted distinction. */
export async function getGroupSupportHistory(groupId: string, range: DateRange) {
  const activities = await prisma.supportActivity.findMany({
    where: { groupId, occurredAt: { gte: range.start, lt: range.end } },
    orderBy: { occurredAt: "desc" },
    include: { teamMember: { select: { name: true } }, keyword: { select: { value: true } }, message: { select: { body: true } } },
  });
  return {
    activities: activities.map((a) => ({
      id: a.id,
      occurredAt: a.occurredAt,
      teamMemberName: a.teamMember?.name ?? null,
      keywordValue: a.keyword?.value ?? null,
      messageBody: a.message.body,
    })),
    rawActivityCount: activities.length,
    // Within a single group, UNIQUE_GROUP collapses to "1 if any activity occurred, else 0".
    countedSupport: activities.length > 0 ? 1 : 0,
  };
}
