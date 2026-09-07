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
const AVAILABLE_WINDOW_MS = 30 * 60 * 1000;

export interface ExecutiveWorkloadRow {
  teamMemberId: string;
  name: string;
  /** Distinct groups this person handled in the period. */
  groupsHandled: number;
  messageCount: number;
  /**
   * Time on support, measured as the span from a person's first message to their last, within one
   * group on one day, summed across every such span.
   *
   * Per group AND per day on purpose. Summing one span across a whole week would count the nights
   * in between as work; summing one span across every group at once would count the gap while
   * they were busy elsewhere. A day in a single group is the largest window where "first to last"
   * genuinely means "engaged with this".
   *
   * A day where somebody sent one message is zero seconds, which is honest rather than flattering
   * — a single reply has no duration to measure. The message count beside it is what stops that
   * reading as "did nothing".
   */
  activeSeconds: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * What each executive actually handled in a period: how many groups, how many messages, and how
 * long they were engaged.
 *
 * Reads the activity rows directly, and must keep doing so. The obvious alternative — summing
 * SupportSession.durationSeconds — is a trap: that column is written only when a session
 * COMPLETES, which requires a rule whose keyword carries marksCompletion. A deployment running the
 * "any team member message counts" rule, which is the configuration this module is most often used
 * in, has no such keyword, so its sessions never complete and any report built on them is
 * permanently empty while looking perfectly healthy. A `getDailyHoursWorked` doing exactly that
 * was deleted rather than left available to be picked up by mistake.
 *
 * One query rather than one per member: the previous per-member breakdown issued a groupBy and
 * then a second lookup, and anything wanting durations on top would have added a third per row.
 */
export async function getExecutiveWorkload(range: DateRange): Promise<ExecutiveWorkloadRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      teamMemberId: string;
      name: string;
      groupsHandled: bigint;
      messageCount: bigint;
      activeSeconds: number | null;
      firstAt: Date;
      lastAt: Date;
    }>
  >`
    WITH spans AS (
      SELECT
        a."teamMemberId",
        a."groupId",
        -- Dhaka calendar day, so a shift is bounded the way the person lived it rather than by
        -- UTC midnight, which falls at 06:00 local and would split every morning in two.
        date_trunc('day', a."occurredAt" AT TIME ZONE 'Asia/Dhaka') AS local_day,
        MIN(a."occurredAt") AS first_at,
        MAX(a."occurredAt") AS last_at,
        COUNT(*) AS messages
      FROM "SupportActivity" a
      WHERE a."actor" = 'TEAM_MEMBER'
        AND a."teamMemberId" IS NOT NULL
        AND a."occurredAt" >= ${range.start}
        AND a."occurredAt" < ${range.end}
      GROUP BY a."teamMemberId", a."groupId", local_day
    )
    SELECT
      s."teamMemberId"                                        AS "teamMemberId",
      t."name"                                                AS "name",
      COUNT(DISTINCT s."groupId")                             AS "groupsHandled",
      SUM(s.messages)                                         AS "messageCount",
      SUM(EXTRACT(EPOCH FROM (s.last_at - s.first_at)))::int  AS "activeSeconds",
      MIN(s.first_at)                                         AS "firstAt",
      MAX(s.last_at)                                          AS "lastAt"
    FROM spans s
    JOIN "InternalTeamMember" t ON t."id" = s."teamMemberId"
    GROUP BY s."teamMemberId", t."name"
    ORDER BY "messageCount" DESC
  `;

  return rows.map((row) => ({
    teamMemberId: row.teamMemberId,
    name: row.name,
    groupsHandled: Number(row.groupsHandled),
    messageCount: Number(row.messageCount),
    activeSeconds: row.activeSeconds ?? 0,
    firstAt: row.firstAt,
    lastAt: row.lastAt,
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
  const availableCutoff = new Date(now.getTime() - AVAILABLE_WINDOW_MS);

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
    WITH latest AS (
      -- One row per group: its newest message, whoever sent it.
      SELECT DISTINCT ON (m."groupId")
        m."groupId"        AS group_id,
        m."timestampWa"    AS ts,
        m."direction"      AS direction,
        m."isFromTeamMember" AS from_team,
        m."body"           AS body,
        m."senderName"     AS sender_name,
        m."senderPhone"    AS sender_phone
      FROM "Message" m
      WHERE m."groupId" IS NOT NULL
      ORDER BY m."groupId", m."timestampWa" DESC
    )
    SELECT
      g."id"                  AS "groupId",
      g."name"                AS "groupName",
      l.sender_name           AS "customerName",
      l.sender_phone          AS "senderPhone",
      l.body                  AS "lastMessage",
      l.ts                    AS "waitingSince",
      t."name"                AS "assignedTo",
      g."priority"::text      AS "priority"
    FROM latest l
    JOIN "WhatsAppGroup" g ON g."id" = l.group_id
    LEFT JOIN "InternalTeamMember" t ON t."id" = g."assignedTeamMemberId"
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
