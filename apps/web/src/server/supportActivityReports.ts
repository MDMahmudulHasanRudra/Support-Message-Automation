
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { Prisma, type SupportActivityActor } from "@prisma/client";
import { loadReportIdentity, messageKeySql } from "@/server/messageIdentity";
import { computeFirstResponseWaits, computeMemberWorkloads, loadAttributedMessages, median } from "@/server/attributedMessages";
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

/**
 * Restricts a report to one actor. Omitted means "all support delivered, however it was
 * delivered" — the honest headline number now that AI can resolve a conversation on its own.
 * Anything measuring a *person* (per-member breakdowns, availability) passes TEAM_MEMBER
 * explicitly, so AI work can never be attributed to someone who did not do it.
 */
export type ActorFilter = SupportActivityActor | undefined;

/**
 * Support Activity rows in a period, ONE per logical message and per WhatsApp group (report accuracy
 * audit, 19 Oct 2026). Each of our numbers in a group stores its own copy of a message and the
 * detector records an activity on each, so with two numbers in a group every activity counted twice
 * and every group was "two groups". Grouped on the WhatsApp group id and the logical message key —
 * the Team Report's rule — keeping the copy that names a member when one does.
 */
async function distinctActivities(range: DateRange, actor?: ActorFilter) {
  return prisma.$queryRaw<Array<{ wgid: string; actor: string; memberId: string | null }>>`
    SELECT DISTINCT ON (g."whatsappGroupId", ${messageKeySql()})
      g."whatsappGroupId" AS wgid, a."actor"::text AS actor, a."teamMemberId" AS "memberId"
    FROM "SupportActivity" a
    JOIN "Message" m ON m."id" = a."messageId"
    JOIN "WhatsAppGroup" g ON g."id" = a."groupId"
    WHERE a."projectId" = ${await activeProjectId()}
      AND a."occurredAt" >= ${range.start} AND a."occurredAt" < ${range.end}
      ${actor ? Prisma.sql`AND a."actor" = ${actor}::"SupportActivityActor"` : Prisma.empty}
    ORDER BY g."whatsappGroupId", ${messageKeySql()}, (a."teamMemberId" IS NULL) ASC, a."id"`;
}

/** EVERY_ACTIVITY: count every valid activity in the period — each message once, however many of our numbers stored it. */
export async function getEveryActivityCount(range: DateRange, actor?: ActorFilter): Promise<number> {
  return (await distinctActivities(range, actor)).length;
}

/** UNIQUE_GROUP: each WhatsApp group counted once per period regardless of how many activities (or of our numbers) it had. */
export async function getUniqueGroupCount(range: DateRange, actor?: ActorFilter): Promise<number> {
  return new Set((await distinctActivities(range, actor)).map((row) => row.wgid)).size;
}

export interface ActorBreakdown {
  teamMemberCount: number;
  aiCount: number;
  /** Groups that were supported at all in the period, by anyone. */
  uniqueGroups: number;
  /** Groups where the ONLY support delivered came from AI — nobody on the team touched them. */
  aiOnlyGroups: number;
}

/**
 * Human-vs-AI split for the period.
 *
 * `aiOnlyGroups` is the number worth watching: a group AI handled entirely is a group nobody
 * checked, which is either the automation working exactly as intended or a group quietly going
 * unattended. The report states the fact; which of the two it is depends on the group.
 */
export async function getActorBreakdown(range: DateRange): Promise<ActorBreakdown> {
  const rows = await distinctActivities(range);
  const human = rows.filter((row) => row.actor === "TEAM_MEMBER");
  const ai = rows.filter((row) => row.actor === "AI");
  const humanGroupIds = new Set(human.map((row) => row.wgid));
  const aiGroupIds = new Set(ai.map((row) => row.wgid));

  return {
    teamMemberCount: human.length,
    aiCount: ai.length,
    uniqueGroups: new Set([...humanGroupIds, ...aiGroupIds]).size,
    aiOnlyGroups: [...aiGroupIds].filter((id) => !humanGroupIds.has(id)).length,
  };
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
  // Explicitly TEAM_MEMBER, not merely "has a teamMemberId". AI rows carry a null member so they are
  // already excluded, but stating the intent means this cannot start counting AI work against a
  // person if AI attribution ever changes. Once per logical message (distinctActivities).
  const counts = new Map<string, number>();
  for (const row of await distinctActivities(range, "TEAM_MEMBER")) {
    if (row.memberId) counts.set(row.memberId, (counts.get(row.memberId) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  const members = await prisma.internalTeamMember.findMany({
    where: { id: { in: [...counts.keys()] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(members.map((m) => [m.id, m.name]));

  return [...counts]
    .map(([teamMemberId, activityCount]) => ({
      teamMemberId,
      name: nameById.get(teamMemberId) ?? "(removed team member)",
      activityCount,
    }))
    .sort((a, b) => b.activityCount - a.activityCount);
}

export interface RecentActivityRow {
  id: string;
  occurredAt: Date;
  groupName: string;
  actor: SupportActivityActor;
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
    actor: r.actor,
    teamMemberName: r.teamMember?.name ?? null,
    keywordValue: r.keyword?.value ?? null,
    messageBody: r.message.body,
  }));
}

/**
 * Daily incoming-activity counts for the last N Dhaka calendar days, oldest first — feeds the
 * Activity page's trend Sparkline.
 *
 * ONE query. This used to be `Promise.all` over N separate `COUNT(*)`s — thirty of them for a
 * thirty-day sparkline, each a full pass over `SupportActivity`, every time the page was opened.
 * Collapsed to a single `date_trunc` + `GROUP BY`, which is the shape `getMessageLoadSeries`
 * already uses for the same job on the dashboard.
 *
 * Bucketed by Dhaka calendar day, not UTC: UTC midnight falls at 06:00 local, so a UTC-bucketed
 * day would split every Dhaka morning across two columns. The values are identical to what
 * `getDhakaDayRange` produced per day, which is the point — this changes how the number is
 * fetched, never what it is.
 *
 * **`AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'`, and the first half is not redundant.** Prisma
 * maps `DateTime` to `timestamp WITHOUT time zone` here, so `occurredAt` is a bare wall-clock value
 * that happens to hold UTC. Postgres's two `AT TIME ZONE` overloads do opposite things: applied to
 * a `timestamptz` it CONVERTS to that zone, but applied to a plain `timestamp` it INTERPRETS the
 * value as already being in that zone. So the single-argument form reads a UTC instant as though it
 * were Dhaka local and shifts it six hours the wrong way — verified against the database:
 * `2026-09-18 02:00` (08:00 Dhaka, plainly the 18th) buckets as the 17th. The first cast makes it a
 * `timestamptz`; only then does the second convert.
 *
 * Bucketed as text rather than as a timestamp on purpose. `date_trunc` here returns a
 * `timestamp without time zone` holding a Dhaka wall clock, and node-postgres parses that through
 * the JS `Date` constructor in the SERVER's local timezone — so the key would silently depend on
 * the container's `TZ`. A `YYYY-MM-DD` string has no such ambiguity.
 */
export async function getActivityTrend(days = 30): Promise<number[]> {
  const now = new Date();
  // The window still comes from getDhakaDayRange, so the first and last buckets line up exactly
  // with the per-day version this replaces.
  const oldest = getDhakaDayRange(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));
  const newest = getDhakaDayRange(now);

  const rows = await prisma.$queryRaw<Array<{ day: string; total: bigint }>>`
    SELECT
      to_char(
        date_trunc('day', a."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka'),
        'YYYY-MM-DD'
      ) AS day,
      COUNT(*) AS total
    FROM "SupportActivity" a
    WHERE a."projectId" = ${await activeProjectId()}
      AND a."occurredAt" >= ${oldest.start} AND a."occurredAt" < ${newest.end}
    GROUP BY 1
  `;

  const totalByDay = new Map(rows.map((row) => [row.day, Number(row.total)]));

  return Array.from({ length: days }, (_, index) => {
    // The same instants getDhakaDayRange produced per day before, so the buckets line up exactly
    // with the thirty separate counts this replaces.
    const dayStart = getDhakaDayRange(
      new Date(now.getTime() - (days - 1 - index) * 24 * 60 * 60 * 1000),
    ).start;
    return totalByDay.get(new Date(dayStart.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10)) ?? 0;
  });
}

/** Dhaka is UTC+6 with no daylight saving, so one constant is enough — see `toDhakaDateOnly`. */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

export interface ExportActivityRow {
  occurredAt: Date;
  groupName: string;
  actor: SupportActivityActor;
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
    actor: r.actor,
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

/**
 * Ceilings on what the Reports page renders in one go.
 *
 * All three reads below accept an arbitrary date range from the UI and had no bound at all, which
 * on this deployment — 1,848 groups running an `ANY_MESSAGE` rule — makes "last month" a full
 * table scan serialised into HTML. These are display ceilings only: every count the page reports
 * is read separately and stays true.
 *
 * Open sessions get the smaller number deliberately. There should never be five hundred
 * conversations open at once, so hitting that cap is itself the finding.
 */
const OPEN_SESSION_LIMIT = 500;
const FINISHED_SESSION_LIMIT = 500;
const ACTIVITY_TIMELINE_LIMIT = 500;

/** 30-minute "available now" window, confirmed requirement — how recent a team member's last
 *  group message must be to still count as actively available. */
/**
 * How long somebody can go quiet before they count as offline (`offlineAfterMinutes`).
 *
 * Read rather than hardcoded because it is load-bearing in two places at once now — the online
 * badge and the length of a stretch of work — and those two must never disagree. They did: this
 * was 30 minutes while work time was measured per group per day, so somebody could show as offline
 * in the middle of a stretch the same page was counting.
 */
async function getPresenceTimeoutSeconds(): Promise<number> {
  const settings = await prisma.supportActivitySettings.findUnique({
    where: { id: "global" },
    select: { offlineAfterMinutes: true },
  });
  // Clamped rather than trusted: a zero would make every message its own stretch and show everyone
  // permanently offline, which reads as a broken report rather than a misconfigured one.
  const minutes = Math.min(24 * 60, Math.max(5, settings?.offlineAfterMinutes ?? 120));
  return minutes * 60;
}

export interface ExecutiveWorkloadRow {
  teamMemberId: string;
  name: string;
  /** Distinct groups this person handled in the period. */
  groupsHandled: number;
  messageCount: number;
  /**
   * Time on support: one timeline per person across every group, split wherever they went quiet
   * for longer than `offlineAfterMinutes`, each stretch measured first message to last.
   *
   * Across all groups rather than per group, which is the correction that matters. Measuring each
   * group separately and adding them up double-counts anyone working two conversations at once —
   * an executive in group A from 10:00 to 11:00 who also answers group B at 10:30 was credited 60
   * minutes plus 15, for one hour of actual work. Handling several groups at once is the normal
   * shape of this job, so that was not an edge case; it inflated the busiest people most.
   *
   * The idle gap is what keeps a single timeline honest. Without it, one message at 09:00 and one
   * at 18:00 would read as nine hours on support.
   *
   * A stretch containing one message is zero seconds, which is honest rather than flattering — a
   * single reply has no duration. The message and session counts beside it stop that reading as
   * "did nothing".
   */
  activeSeconds: number;
  /** How many separate stretches of work — how many times they came back to it. */
  sessionCount: number;
  firstAt: Date;
  lastAt: Date;
  /** Messaged within the offline threshold of now. */
  isOnline: boolean;
}

/**
 * What each executive handled in a period: how many groups, how many messages, how many separate
 * stretches of work, and how long they were actually on support.
 *
 * Reads `Message` through the Team Report's own identity rule (attributedMessages.ts), and measures
 * support time with the Team Report's own rule — so this page and the Team Report can no longer
 * disagree about the same person on the same day (report accuracy audit, 19 Oct 2026). It used to
 * read `SupportActivity`, which only exists while Support Activity tracking is on, only for the
 * messages a rule matched, once per account copy (two of our numbers in a group doubled everyone),
 * and attributed against the roster at the moment the message arrived (adding a colleague or their
 * WhatsApp ID later never reached it).
 *
 * Never SupportSession.durationSeconds: that is written only when a session COMPLETES, which needs a
 * completion keyword, so it is permanently empty on the "any message counts" setup.
 */
export async function getExecutiveWorkload(range: DateRange, now: Date = new Date()): Promise<ExecutiveWorkloadRow[]> {
  return (await getExecutiveWorkloads({ range }, now)).range;
}

/** Several periods from ONE read of the widest one (Team Performance shows today, the week and the month). */
export async function getExecutiveWorkloads<K extends string>(
  ranges: Record<K, DateRange>,
  now: Date = new Date(),
): Promise<Record<K, ExecutiveWorkloadRow[]>> {
  const keys = Object.keys(ranges) as K[];
  const timeoutSeconds = await getPresenceTimeoutSeconds();
  const start = new Date(Math.min(...keys.map((k) => ranges[k].start.getTime())));
  const end = new Date(Math.max(...keys.map((k) => ranges[k].end.getTime())));
  const [messages, members] = await Promise.all([
    loadAttributedMessages({ start, end }),
    prisma.internalTeamMember.findMany({ select: { id: true, name: true } }),
  ]);
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const onlineCutoffMs = now.getTime() - timeoutSeconds * 1000;
  const out = {} as Record<K, ExecutiveWorkloadRow[]>;
  for (const key of keys) {
    out[key] = computeMemberWorkloads(messages, ranges[key].start.getTime(), ranges[key].end.getTime(), timeoutSeconds * 1000).map((row) => ({
      teamMemberId: row.memberId,
      name: nameById.get(row.memberId) ?? "(removed team member)",
      groupsHandled: row.groupsHandled,
      messageCount: row.messageCount,
      activeSeconds: row.activeSeconds,
      sessionCount: row.sessionCount,
      firstAt: new Date(row.firstAt),
      lastAt: new Date(row.lastAt),
      // Only meaningful when the range reaches the present — a report on last month says nothing
      // about who is at their desk, and the comparison comes out false there anyway.
      isOnline: row.lastAt >= onlineCutoffMs,
    }));
  }
  return out;
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
  const availableCutoff = now.getTime() - (await getPresenceTimeoutSeconds()) * 1000;

  // From messages, through the one identity rule (attributedMessages.ts) — never Support Activity
  // rows, which exist only while that tracking is on. Availability is about people: the business
  // number, the AI and a colleague nobody could identify never make someone look present.
  const messages = await loadAttributedMessages({
    start: new Date(Math.min(todayRange.start.getTime(), availableCutoff)),
    end: new Date(Math.max(todayRange.end.getTime(), now.getTime() + 1)),
  });
  const workingToday = new Set<string>();
  const availableNow = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "MEMBER" || !message.memberId) continue;
    if (message.ts >= todayRange.start.getTime() && message.ts < todayRange.end.getTime()) workingToday.add(message.memberId);
    if (message.ts >= availableCutoff) availableNow.add(message.memberId);
  }

  return members.map((m) => ({
    teamMemberId: m.id,
    name: m.name,
    workingToday: workingToday.has(m.id),
    availableNow: availableNow.has(m.id),
  }));
}

export interface GroupSessionRow {
  id: string;
  groupId: string;
  groupName: string;
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

/** Session-level (open/closed + duration) view, filtered on startedAt within range and optionally
 *  scoped to one group — same single-timestamp-range convention as getGroupSupportHistory's own
 *  occurredAt filter. Omitting groupId returns sessions across every group, sorted so the most
 *  actionable ones (stale, then other OPEN, then most recently started) surface first — this is
 *  what lets the Reports page answer "what's happening right now" at a glance instead of requiring
 *  a group to be picked first. */
export async function getGroupSessionHistory(range: DateRange, groupId?: string, now: Date = new Date()): Promise<GroupSessionRow[]> {
  const where = { startedAt: { gte: range.start, lt: range.end }, ...(groupId ? { groupId } : {}) };
  const include = {
    group: { select: { name: true } },
    startedByTeamMember: { select: { name: true } },
    completedByTeamMember: { select: { name: true } },
    completedByUser: { select: { name: true } },
  };

  /**
   * Split and bounded, rather than one unbounded read.
   *
   * This accepted an arbitrary date range from the Reports page and fetched every matching row —
   * a month on the `ANY_MESSAGE` rule this deployment runs is every session across 1,848 groups,
   * serialised into HTML.
   *
   * It is two queries rather than one capped query because the ordering carries meaning: the whole
   * point is that stale and open sessions surface first. A single `startedAt desc` with a `take`
   * would keep the newest rows and drop exactly the old, still-open ones the page exists to
   * surface. Open sessions are read oldest-first (the most stale is the most actionable) and are
   * naturally few; the finished ones are the set that grows without bound, so they take the cap.
   */
  const [openSessions, finishedSessions] = await Promise.all([
    prisma.supportSession.findMany({
      where: { ...where, status: "OPEN" },
      orderBy: { startedAt: "asc" },
      take: OPEN_SESSION_LIMIT,
      include,
    }),
    prisma.supportSession.findMany({
      where: { ...where, status: { not: "OPEN" } },
      orderBy: { startedAt: "desc" },
      take: FINISHED_SESSION_LIMIT,
      include,
    }),
  ]);

  const rows = [...openSessions, ...finishedSessions].map((s) => ({
    id: s.id,
    groupId: s.groupId,
    groupName: s.group.name,
    status: s.status,
    startedAt: s.startedAt,
    startedByName: s.startedByTeamMember?.name ?? null,
    completedAt: s.completedAt,
    completedByLabel: s.completedByTeamMember?.name ?? (s.completedByUser ? `Admin (${s.completedByUser.name})` : null),
    durationSeconds: s.durationSeconds,
    isStale: s.status === "OPEN" && now.getTime() - s.startedAt.getTime() > STALE_SESSION_THRESHOLD_MS,
  }));
  // Most-actionable-first: stale sessions, then other OPEN sessions, then completed — all secondary
  // to that, in the order each query returned them.
  const rank = (r: (typeof rows)[number]) => (r.isStale ? 0 : r.status === "OPEN" ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b));
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

/**
 * Group Support History: one group's activity timeline plus the raw-vs-counted distinction.
 *
 * The timeline is capped; the COUNT is not. Those have to be separate reads, because
 * `rawActivityCount` was the length of the fetched array — so capping the fetch alone would have
 * quietly turned a real total into "however many we chose to render", which is the kind of number
 * somebody makes a staffing decision on.
 */
export async function getGroupSupportHistory(groupId: string, range: DateRange) {
  const where = { groupId, occurredAt: { gte: range.start, lt: range.end } };
  const [activities, rawActivityCount] = await Promise.all([
    prisma.supportActivity.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: ACTIVITY_TIMELINE_LIMIT,
      include: { teamMember: { select: { name: true } }, keyword: { select: { value: true } }, message: { select: { body: true } } },
    }),
    prisma.supportActivity.count({ where }),
  ]);
  return {
    activities: activities.map((a) => ({
      id: a.id,
      occurredAt: a.occurredAt,
      actor: a.actor,
      teamMemberName: a.teamMember?.name ?? null,
      keywordValue: a.keyword?.value ?? null,
      messageBody: a.message.body,
    })),
    rawActivityCount,
    /** True when the timeline below is a window onto a longer history — the page says so rather
     *  than letting the list simply stop. */
    timelineTruncated: rawActivityCount > activities.length,
    // Within a single group, UNIQUE_GROUP collapses to "1 if any activity occurred, else 0".
    countedSupport: rawActivityCount > 0 ? 1 : 0,
  };
}

export interface AwaitingReplyRow {
  groupId: string;
  groupName: string;
  /** Who is waiting — their pushname if WhatsApp gave one, otherwise their number. */
  customerName: string;
  lastMessage: string;
  waitingSince: Date;
  waitingSeconds: number;
  assignedTo: string | null;
  priority: string | null;
}

/**
 * Groups whose most recent message is from a customer — nobody has answered yet.
 *
 * This is the question the module could not previously answer at all. Everything else here counts
 * what the team DID, so the one thing it was structurally blind to was the absence of it: a
 * customer nobody replied to produces no SupportActivity row, opens no SupportSession, and
 * therefore appeared nowhere. The busiest-looking week and a week with six people ignored look
 * identical in an activity report.
 *
 * Deliberately reads `Message` rather than `SupportActivity`, so it depends on no rule being
 * configured, no session ever completing, and no counting setting being right. If messages are
 * being stored at all, this works.
 *
 * A reply is an outgoing message (ours, including AI) or an incoming one from a roster member —
 * an executive on the business phone produces the former, an executive in the group as themselves
 * produces the latter, and both mean the customer has been answered.
 */
export async function getGroupsAwaitingReply(now: Date = new Date()): Promise<AwaitingReplyRow[]> {
  const projectId = await activeProjectId();
  const [rows, identity] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        groupId: string;
        wgid: string;
        isPrimary: boolean;
        groupName: string;
        customerName: string | null;
        senderPhone: string;
        senderJid: string | null;
        fromTeam: boolean;
        direction: string;
        lastMessage: string;
        waitingSince: Date;
        assignedTo: string | null;
        priority: string | null;
      }>
    >`
      SELECT
        g."id"                  AS "groupId",
        g."whatsappGroupId"     AS wgid,
        a."isPrimary"           AS "isPrimary",
        g."name"                AS "groupName",
        l.sender_name           AS "customerName",
        l.sender_phone          AS "senderPhone",
        l.sender_jid            AS "senderJid",
        l.from_team             AS "fromTeam",
        l.direction::text       AS direction,
        l.body                  AS "lastMessage",
        l.ts                    AS "waitingSince",
        t."name"                AS "assignedTo",
        g."priority"::text      AS "priority"
      -- Driven from the GROUPS, not from every message ever stored: one backward index probe on
      -- [groupId, timestampWa] per monitored group row. SYSTEM rows (joins, subject changes) are
      -- nobody speaking and never hide a waiting customer.
      FROM "WhatsAppGroup" g
      JOIN "WhatsAppAccount" a ON a."id" = g."accountId"
      LEFT JOIN "InternalTeamMember" t ON t."id" = g."assignedTeamMemberId"
      CROSS JOIN LATERAL (
        SELECT
          m."timestampWa"      AS ts,
          m."direction"        AS direction,
          m."isFromTeamMember" AS from_team,
          m."body"             AS body,
          m."senderName"       AS sender_name,
          m."senderPhone"      AS sender_phone,
          m."senderJid"        AS sender_jid
        FROM "Message" m
        WHERE m."groupId" = g."id" AND m."direction" <> 'SYSTEM'
        ORDER BY m."timestampWa" DESC
        LIMIT 1
      ) l
      WHERE g."isMonitored" = true
        AND g."isActive" = true
        AND g."projectId" = ${projectId}`,
    loadReportIdentity(projectId),
  ]);

  // One WhatsApp group, however many of our numbers are in it: the newest message any copy holds
  // decides, so a reply only our other number stored still counts as the answer. Who sent it is
  // decided at read time by the one identity rule — a colleague added or linked since is not a
  // customer, and our own number's post is the business's.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = newest.get(row.wgid);
    const later = !seen || row.waitingSince.getTime() > seen.waitingSince.getTime() || (row.waitingSince.getTime() === seen.waitingSince.getTime() && row.isPrimary && !seen.isPrimary);
    if (later) newest.set(row.wgid, row);
  }
  const waiting = [...newest.values()].filter(
    (row) =>
      identity.classify(
        { direction: row.direction, sender: row.senderPhone, senderJid: row.senderJid, fromTeam: row.fromTeam, actionType: null, ruleId: null, createdById: null },
        row.waitingSince.getTime(),
      ).kind === "CUSTOMER",
  );

  return waiting
    .sort((a, b) => a.waitingSince.getTime() - b.waitingSince.getTime())
    .slice(0, 100)
    .map((row) => ({
      groupId: row.groupId,
      groupName: row.groupName,
      customerName: row.customerName?.trim() || row.senderPhone,
      lastMessage: row.lastMessage,
      waitingSince: row.waitingSince,
      waitingSeconds: Math.max(0, Math.round((now.getTime() - row.waitingSince.getTime()) / 1000)),
      assignedTo: row.assignedTo,
      priority: row.priority,
    }));
}

export interface FirstResponseStats {
  /** Customer messages in the range that started a wait and were eventually answered. */
  answered: number;
  /** Half of customers waited less than this. Null when nothing was answered in the range. */
  medianSeconds: number | null;
  averageSeconds: number | null;
  /** The worst single wait, which is the one somebody complained about. */
  slowestSeconds: number | null;
}

/**
 * How long customers wait before somebody answers.
 *
 * The metric a support lead is actually judged on, and the module had nothing like it. What it had
 * was `getAverageResolutionTime`, which reads SupportSession.durationSeconds — written only when a
 * session COMPLETES, which needs a completion keyword. A deployment running the "any message
 * counts" rule has none, so that number is permanently empty. This reads message timestamps, so it
 * cannot be empty while conversations are happening.
 *
 * Only messages that START a wait are measured — a customer sending four lines in a row is one
 * person waiting once, not four, and counting each would flatter the figure by dividing one real
 * wait across three near-instant ones.
 *
 * **Median, not average, is the headline.** One conversation answered the next morning drags an
 * average past every honest reading of the day; the median says what a typical customer
 * experienced. The average and the worst case are returned beside it rather than instead of it,
 * because the worst case is usually the one being complained about.
 */
export async function getFirstResponseStats(range: DateRange, now: Date = new Date()): Promise<FirstResponseStats> {
  // The Team Report's wait, over monitored groups: the four hours before the period are context (a
  // customer line continuing a wait begun before it is not a new wait) and replies are looked for up
  // to a day past it — never past now.
  const messages = await loadAttributedMessages({
    start: new Date(range.start.getTime() - 4 * 3_600_000),
    end: new Date(Math.min(range.end.getTime() + 86_400_000, Math.max(range.end.getTime(), now.getTime() + 1))),
    monitoredOnly: true,
  });
  const seconds = computeFirstResponseWaits(messages, range.start.getTime(), range.end.getTime())
    .filter((w) => w.repliedAt !== null)
    .map((w) => (w.repliedAt! - w.askedAt) / 1000);
  if (seconds.length === 0) return { answered: 0, medianSeconds: null, averageSeconds: null, slowestSeconds: null };
  return {
    answered: seconds.length,
    medianSeconds: Math.round(median(seconds)!),
    averageSeconds: Math.round(seconds.reduce((a, b) => a + b, 0) / seconds.length),
    slowestSeconds: Math.round(Math.max(...seconds)),
  };
}
