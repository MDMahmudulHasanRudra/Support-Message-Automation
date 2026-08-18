import { prisma } from "@support-automation/db";
import type { SupportActivityCountingMode } from "@prisma/client";

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
