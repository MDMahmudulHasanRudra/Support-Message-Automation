import { prisma } from "@support-automation/db";
import type { SupportActivityActor } from "@prisma/client";
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

function actorWhere(actor: ActorFilter) {
  return actor ? { actor } : {};
}

/** EVERY_ACTIVITY: count every valid activity in the period. */
export async function getEveryActivityCount(range: DateRange, actor?: ActorFilter): Promise<number> {
  return prisma.supportActivity.count({
    where: { occurredAt: { gte: range.start, lt: range.end }, ...actorWhere(actor) },
  });
}

/** UNIQUE_GROUP: each group counted once per period regardless of how many activities it had. */
export async function getUniqueGroupCount(range: DateRange, actor?: ActorFilter): Promise<number> {
  const groups = await prisma.supportActivity.groupBy({
    by: ["groupId"],
    where: { occurredAt: { gte: range.start, lt: range.end }, ...actorWhere(actor) },
  });
  return groups.length;
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
  const window = { occurredAt: { gte: range.start, lt: range.end } };
  const [teamMemberCount, aiCount, humanGroups, aiGroups] = await Promise.all([
    prisma.supportActivity.count({ where: { ...window, actor: "TEAM_MEMBER" } }),
    prisma.supportActivity.count({ where: { ...window, actor: "AI" } }),
    prisma.supportActivity.groupBy({ by: ["groupId"], where: { ...window, actor: "TEAM_MEMBER" } }),
    prisma.supportActivity.groupBy({ by: ["groupId"], where: { ...window, actor: "AI" } }),
  ]);

  const humanGroupIds = new Set(humanGroups.map((g) => g.groupId));
  const aiGroupIds = aiGroups.map((g) => g.groupId);

  return {
    teamMemberCount,
    aiCount,
    uniqueGroups: new Set([...humanGroupIds, ...aiGroupIds]).size,
    aiOnlyGroups: aiGroupIds.filter((id) => !humanGroupIds.has(id)).length,
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
  const grouped = await prisma.supportActivity.groupBy({
    by: ["teamMemberId"],
    // Explicitly TEAM_MEMBER, not merely "has a teamMemberId". AI rows carry a null member so
    // they are already excluded, but stating the intent means this cannot start counting AI
    // work against a person if AI attribution ever changes.
    where: { occurredAt: { gte: range.start, lt: range.end }, teamMemberId: { not: null }, actor: "TEAM_MEMBER" },
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
    WHERE a."occurredAt" >= ${oldest.start} AND a."occurredAt" < ${newest.end}
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
 * Reads the activity rows directly, and must keep doing so. The obvious alternative — summing
 * SupportSession.durationSeconds — is a trap: that column is written only when a session
 * COMPLETES, which requires a rule whose keyword carries marksCompletion. A deployment running the
 * "any team member message counts" rule, which is the configuration this module is most often used
 * in, has no such keyword, so its sessions never complete and any report built on them is
 * permanently empty while looking perfectly healthy. A `getDailyHoursWorked` doing exactly that
 * was deleted rather than left available to be picked up by mistake.
 */
export async function getExecutiveWorkload(
  range: DateRange,
  now: Date = new Date(),
): Promise<ExecutiveWorkloadRow[]> {
  const timeoutSeconds = await getPresenceTimeoutSeconds();

  const rows = await prisma.$queryRaw<
    Array<{
      teamMemberId: string;
      name: string;
      groupsHandled: bigint;
      messageCount: bigint;
      activeSeconds: number | null;
      sessionCount: bigint;
      firstAt: Date;
      lastAt: Date;
    }>
  >`
    WITH events AS (
      SELECT
        a."teamMemberId" AS member_id,
        a."occurredAt"   AS ts,
        a."groupId"      AS group_id
      FROM "SupportActivity" a
      WHERE a."actor" = 'TEAM_MEMBER'
        AND a."teamMemberId" IS NOT NULL
        AND a."occurredAt" >= ${range.start}
        AND a."occurredAt" < ${range.end}
    ),
    gapped AS (
      SELECT
        member_id,
        ts,
        group_id,
        -- A new stretch starts at the first message, and after any silence longer than the
        -- offline threshold. Everything else continues the current one.
        CASE
          WHEN LAG(ts) OVER (PARTITION BY member_id ORDER BY ts) IS NULL
            OR EXTRACT(EPOCH FROM (ts - LAG(ts) OVER (PARTITION BY member_id ORDER BY ts)))
               > ${timeoutSeconds}
          THEN 1 ELSE 0
        END AS starts_stretch
      FROM events
    ),
    numbered AS (
      SELECT
        member_id,
        ts,
        group_id,
        SUM(starts_stretch) OVER (PARTITION BY member_id ORDER BY ts ROWS UNBOUNDED PRECEDING)
          AS stretch_no
      FROM gapped
    ),
    stretches AS (
      SELECT
        member_id,
        stretch_no,
        MIN(ts)  AS started,
        MAX(ts)  AS ended,
        COUNT(*) AS messages
      FROM numbered
      GROUP BY member_id, stretch_no
    ),
    groups_per_member AS (
      SELECT member_id, COUNT(DISTINCT group_id) AS groups_handled
      FROM numbered
      GROUP BY member_id
    )
    SELECT
      s.member_id                                        AS "teamMemberId",
      t."name"                                           AS "name",
      g.groups_handled                                   AS "groupsHandled",
      SUM(s.messages)                                    AS "messageCount",
      SUM(EXTRACT(EPOCH FROM (s.ended - s.started)))::int AS "activeSeconds",
      COUNT(*)                                           AS "sessionCount",
      MIN(s.started)                                     AS "firstAt",
      MAX(s.ended)                                       AS "lastAt"
    FROM stretches s
    JOIN "InternalTeamMember" t ON t."id" = s.member_id
    JOIN groups_per_member g ON g.member_id = s.member_id
    GROUP BY s.member_id, t."name", g.groups_handled
    ORDER BY "messageCount" DESC
  `;

  const onlineCutoffMs = now.getTime() - timeoutSeconds * 1000;

  return rows.map((row) => ({
    teamMemberId: row.teamMemberId,
    name: row.name,
    groupsHandled: Number(row.groupsHandled),
    messageCount: Number(row.messageCount),
    activeSeconds: row.activeSeconds ?? 0,
    sessionCount: Number(row.sessionCount),
    firstAt: row.firstAt,
    lastAt: row.lastAt,
    // Only meaningful when the range reaches the present — a report on last month says nothing
    // about who is at their desk, and the comparison comes out false there anyway.
    isOnline: row.lastAt.getTime() >= onlineCutoffMs,
  }));
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
  const availableCutoff = new Date(now.getTime() - (await getPresenceTimeoutSeconds()) * 1000);

  const [workingTodayRows, availableNowRows] = await Promise.all([
    // Availability is about people; an AI row must never make someone look like they were
    // working or reachable.
    prisma.supportActivity.groupBy({
      by: ["teamMemberId"],
      where: {
        teamMemberId: { not: null },
        actor: "TEAM_MEMBER",
        occurredAt: { gte: todayRange.start, lt: todayRange.end },
      },
    }),
    prisma.supportActivity.groupBy({
      by: ["teamMemberId"],
      where: { teamMemberId: { not: null }, actor: "TEAM_MEMBER", occurredAt: { gte: availableCutoff } },
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
  const rows = sessions.map((s) => ({
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
  // to that, most recently started first (the array is already startedAt-desc from the query).
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
      actor: a.actor,
      teamMemberName: a.teamMember?.name ?? null,
      keywordValue: a.keyword?.value ?? null,
      messageBody: a.message.body,
    })),
    rawActivityCount: activities.length,
    // Within a single group, UNIQUE_GROUP collapses to "1 if any activity occurred, else 0".
    countedSupport: activities.length > 0 ? 1 : 0,
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
  const rows = await prisma.$queryRaw<
    Array<{
      groupId: string;
      groupName: string;
      customerName: string | null;
      senderPhone: string;
      lastMessage: string;
      waitingSince: Date;
      assignedTo: string | null;
      priority: string | null;
    }>
  >`
    SELECT
      g."id"                  AS "groupId",
      g."name"                AS "groupName",
      l.sender_name           AS "customerName",
      l.sender_phone          AS "senderPhone",
      l.body                  AS "lastMessage",
      l.ts                    AS "waitingSince",
      t."name"                AS "assignedTo",
      g."priority"::text      AS "priority"
    -- Driven from the GROUPS, not from every message ever stored.
    --
    -- This was a DISTINCT ON over the whole "Message" table — no time bound, no account bound —
    -- which Postgres answers by sorting every message in the database to pick one row per group,
    -- and only THEN discarding the groups that are not monitored. It runs on Overview and on Team
    -- Performance, and it was the heaviest query on the landing page: heavier than
    -- getResponseTimeSeries, which is at least bounded to fourteen days.
    --
    -- The LATERAL asks the same question the other way round: for each of the ~1,848 monitored
    -- groups, one backward index probe on [groupId, timestampWa] for its newest row. Same rows
    -- out, and the cost now scales with the roster rather than with the message history.
    --
    -- Ties (two messages in the same group sharing a second — WhatsApp timestamps are
    -- second-resolution, so this is not hypothetical) are resolved arbitrarily here, exactly as
    -- DISTINCT ON resolved them before. Which of two simultaneous messages is "newest" is not a
    -- question this report has an opinion about; what matters is that both forms agree on the
    -- direction and sender, which for two messages one second apart they do.
    FROM "WhatsAppGroup" g
    LEFT JOIN "InternalTeamMember" t ON t."id" = g."assignedTeamMemberId"
    CROSS JOIN LATERAL (
      SELECT
        m."timestampWa"      AS ts,
        m."direction"        AS direction,
        m."isFromTeamMember" AS from_team,
        m."body"             AS body,
        m."senderName"       AS sender_name,
        m."senderPhone"      AS sender_phone
      FROM "Message" m
      WHERE m."groupId" = g."id"
      ORDER BY m."timestampWa" DESC
      LIMIT 1
    ) l
    WHERE g."isMonitored" = true
      AND g."isActive" = true
      -- The newest message being an inbound non-team one IS the definition of unanswered: any
      -- reply would be newer and would have taken this row instead.
      AND l.direction = 'INCOMING'
      AND l.from_team = false
    ORDER BY l.ts ASC
    LIMIT 100
  `;

  return rows.map((row) => ({
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
export async function getFirstResponseStats(range: DateRange): Promise<FirstResponseStats> {
  const [row] = await prisma.$queryRaw<
    Array<{ answered: bigint; median: number | null; average: number | null; slowest: number | null }>
  >`
    WITH ordered AS (
      SELECT
        m."groupId" AS group_id,
        m."timestampWa" AS ts,
        (m."direction" = 'OUTGOING' OR m."isFromTeamMember" = true) AS is_reply
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
      WHERE m."groupId" IS NOT NULL
        AND g."isMonitored" = true
        AND m."timestampWa" >= ${range.start}
        AND m."timestampWa" < ${range.end}
    ),
    marked AS (
      SELECT
        ts,
        is_reply,
        LAG(is_reply) OVER (PARTITION BY group_id ORDER BY ts) AS prev_is_reply,
        -- The next reply after this message, if any. Bounded to rows after the current one so a
        -- message never answers itself.
        MIN(ts) FILTER (WHERE is_reply) OVER (
          PARTITION BY group_id ORDER BY ts
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS next_reply_ts
      FROM ordered
    ),
    waits AS (
      SELECT EXTRACT(EPOCH FROM (next_reply_ts - ts)) AS wait_seconds
      FROM marked
      WHERE is_reply = false
        -- Starts a wait: the previous message was a reply, or there was nothing before it.
        AND (prev_is_reply IS TRUE OR prev_is_reply IS NULL)
        AND next_reply_ts IS NOT NULL
    )
    SELECT
      COUNT(*)                                                        AS answered,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY wait_seconds)::float AS median,
      AVG(wait_seconds)::float                                        AS average,
      MAX(wait_seconds)::float                                        AS slowest
    FROM waits
  `;

  const answered = Number(row?.answered ?? 0);
  if (answered === 0) return { answered: 0, medianSeconds: null, averageSeconds: null, slowestSeconds: null };

  return {
    answered,
    medianSeconds: row?.median != null ? Math.round(row.median) : null,
    averageSeconds: row?.average != null ? Math.round(row.average) : null,
    slowestSeconds: row?.slowest != null ? Math.round(row.slowest) : null,
  };
}
