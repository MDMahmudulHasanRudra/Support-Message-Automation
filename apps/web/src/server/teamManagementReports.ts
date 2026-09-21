import { prisma } from "@support-automation/db";
import type { AttendanceOverride, DutyStatus, LeaveStatus, Prisma } from "@prisma/client";
import { computePunctuality, getDhakaDayRange, toDhakaDateOnly, type Punctuality } from "@support-automation/shared";
import type { DerivedDutyState } from "@/lib/dutyState";

// `DerivedDutyState` and its labels live in `lib/dutyState.ts` rather than here, because the badge
// that renders them is reachable from a Client Component and importing a value out of this file
// would pull Prisma into the client bundle. Re-exported as a type only, so existing importers are
// unchanged and nothing can pick up a runtime value by mistake.
export type { DerivedDutyState };

/**
 * Server-component-only read helpers for Team Management. No `"use server"` directive — these are
 * never invoked from a client event handler, matching `supportActivityReports.ts` next door.
 *
 * THE ONE IDEA THIS FILE EXISTS TO EXPRESS: the roster, the attendance evidence and approved leave
 * are three separate records, and every "what actually happened" reading is DERIVED by joining
 * them here rather than stored anywhere. A stored derivation drifts from its own inputs the moment
 * one of them is corrected, and then two screens disagree about the same day with nothing to say
 * which is right.
 *
 * Deliberately does NOT duplicate `/support-activity/team`. That page owns who is online, engaged
 * time, groups covered and first-response stats. This owns SCHEDULE VERSUS REALITY.
 */

export interface RosterRow {
  teamMemberId: string;
  name: string;
  role: string;
  /** Null when nobody has assigned this date yet. */
  status: DutyStatus | null;
  shiftName: string | null;
  shiftStartMinute: number | null;
  shiftEndMinute: number | null;
  shiftTemplateId: string | null;
  /** Evidence, independent of the plan. */
  messageCount: number;
  uniqueGroupCount: number;
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  override: AttendanceOverride | null;
  overrideReason: string | null;
  onApprovedLeave: boolean;
  leaveTypeName: string | null;
  derived: DerivedDutyState;
}

/** Formats minutes-from-midnight as `HH:MM`. The storage format is deliberately not displayable. */
export function formatShiftMinute(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const mins = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/** `10:00 – 19:00`, with a marker when the shift runs past midnight. */
export function formatShiftRange(startMinute: number | null, endMinute: number | null): string | null {
  if (startMinute === null || endMinute === null) return null;
  const crossesMidnight = endMinute <= startMinute;
  return `${formatShiftMinute(startMinute)} – ${formatShiftMinute(endMinute)}${crossesMidnight ? " +1" : ""}`;
}

/**
 * The single place the three records are combined. Everything on every screen goes through this, so
 * the rule cannot be stated two different ways in two places.
 */
function deriveDutyState(input: {
  status: DutyStatus | null;
  hasActivity: boolean;
  onApprovedLeave: boolean;
  override: AttendanceOverride | null;
}): DerivedDutyState {
  // A manager's verdict outranks both the plan and the evidence — that is what an override is for.
  // ABSENT is reachable ONLY from here. Nothing derived from silence may ever produce it — that is
  // the whole reason the override column exists.
  if (input.override === "ABSENT") return "ABSENT";
  if (input.override === "EXCUSED") return "EXCUSED";
  if (input.override === "WORKED") return input.status === "OFF" ? "OFF_DAY_DUTY" : "WORKING";

  // Leave first: an approved absence is a fact about the day, and activity during it is a conflict
  // to be looked at rather than a reason to quietly cancel the leave.
  if (input.onApprovedLeave || input.status === "LEAVE") {
    return input.hasActivity ? "LEAVE_CONFLICT" : "ON_LEAVE";
  }

  if (input.status === "HOLIDAY") return input.hasActivity ? "OFF_DAY_DUTY" : "HOLIDAY";
  if (input.status === "OFF") return input.hasActivity ? "OFF_DAY_DUTY" : "OFF";
  if (input.status === null || input.status === "UNASSIGNED") {
    return input.hasActivity ? "WORKING" : "UNASSIGNED";
  }

  // DUTY, COVERAGE or EXTRA_DUTY — all mean "expected to be working".
  return input.hasActivity ? "WORKING" : "NO_ACTIVITY";
}

/** Approved leave overlapping a date, by member. The set that reduces effective coverage. */
async function getApprovedLeaveOn(date: Date): Promise<Map<string, string>> {
  const rows = await prisma.leaveRequest.findMany({
    where: { status: "APPROVED", startDate: { lte: date }, endDate: { gte: date } },
    select: { teamMemberId: true, leaveType: { select: { name: true } } },
  });
  return new Map(rows.map((row) => [row.teamMemberId, row.leaveType.name]));
}

/**
 * Every active member's day: what was planned, what the messages show, and what that adds up to.
 *
 * Reads three small tables — one row per member per day at most — rather than scanning `Message`,
 * which is what keeps this usable on a deployment with millions of them.
 */
export async function getRosterForDate(date: Date): Promise<RosterRow[]> {
  const dutyDate = toDhakaDateOnly(date);

  const [members, assignments, attendance, leave] = await Promise.all([
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.dutyAssignment.findMany({ where: { dutyDate } }),
    prisma.teamAttendanceDay.findMany({ where: { activityDate: dutyDate } }),
    getApprovedLeaveOn(dutyDate),
  ]);

  const assignmentByMember = new Map(assignments.map((row) => [row.teamMemberId, row]));
  const attendanceByMember = new Map(attendance.map((row) => [row.teamMemberId, row]));

  return members.map((member) => {
    const assignment = assignmentByMember.get(member.id) ?? null;
    const evidence = attendanceByMember.get(member.id) ?? null;
    const leaveTypeName = leave.get(member.id) ?? null;
    const hasActivity = (evidence?.messageCount ?? 0) > 0;

    return {
      teamMemberId: member.id,
      name: member.name,
      role: member.role,
      status: assignment?.status ?? null,
      shiftName: assignment?.shiftName ?? null,
      shiftStartMinute: assignment?.shiftStartMinute ?? null,
      shiftEndMinute: assignment?.shiftEndMinute ?? null,
      shiftTemplateId: assignment?.shiftTemplateId ?? null,
      messageCount: evidence?.messageCount ?? 0,
      uniqueGroupCount: evidence?.uniqueGroupCount ?? 0,
      firstActivityAt: evidence?.firstActivityAt ?? null,
      lastActivityAt: evidence?.lastActivityAt ?? null,
      override: evidence?.override ?? null,
      overrideReason: evidence?.overrideReason ?? null,
      onApprovedLeave: leaveTypeName !== null,
      leaveTypeName,
      derived: deriveDutyState({
        status: assignment?.status ?? null,
        hasActivity,
        onApprovedLeave: leaveTypeName !== null,
        override: evidence?.override ?? null,
      }),
    };
  });
}

export interface CoverageRow {
  shiftTemplateId: string;
  shiftName: string;
  startMinute: number;
  endMinute: number;
  requiredHeadcount: number;
  /** Rows on the roster for this shift, whatever has happened to the people on them. */
  assigned: number;
  /** Assigned people who cannot actually work it — approved leave today. */
  unavailable: number;
  /** What the shift really has. */
  effective: number;
  /** Never negative: being over-staffed is not a gap. */
  gap: number;
}

/**
 * Coverage per shift for one date.
 *
 * Measured against EFFECTIVE availability, never a raw count of assignment rows. Two people on
 * Morning with one of them on approved leave is one person available, and reporting that as
 * covered is exactly how a shift silently runs a man short. The assignment row is deliberately
 * preserved when leave is approved — it is the historical plan — so the subtraction happens here:
 *
 *   effective = assigned - unavailable
 *   gap       = max(0, requiredHeadcount - effective)
 */
export async function getCoverageForDate(date: Date): Promise<CoverageRow[]> {
  const dutyDate = toDhakaDateOnly(date);

  const [shifts, assignments, leave] = await Promise.all([
    prisma.shiftTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ position: "asc" }, { name: "asc" }],
    }),
    prisma.dutyAssignment.findMany({
      where: { dutyDate, shiftTemplateId: { not: null }, status: { in: ["DUTY", "COVERAGE", "EXTRA_DUTY"] } },
      select: { teamMemberId: true, shiftTemplateId: true },
    }),
    getApprovedLeaveOn(dutyDate),
  ]);

  return shifts.map((shift) => {
    const onShift = assignments.filter((row) => row.shiftTemplateId === shift.id);
    const unavailable = onShift.filter((row) => leave.has(row.teamMemberId)).length;
    const effective = onShift.length - unavailable;
    return {
      shiftTemplateId: shift.id,
      shiftName: shift.name,
      startMinute: shift.startMinute,
      endMinute: shift.endMinute,
      requiredHeadcount: shift.requiredHeadcount,
      assigned: onShift.length,
      unavailable,
      effective,
      gap: Math.max(0, shift.requiredHeadcount - effective),
    };
  });
}

export interface TeamOverview {
  date: Date;
  activeMembers: number;
  working: number;
  noActivity: number;
  off: number;
  offDayDuty: number;
  onLeave: number;
  leaveConflicts: number;
  unassigned: number;
  coverageGaps: number;
  pendingLeaveRequests: number;
  changesToday: number;
}

/**
 * The Today figures, each one a question somebody acts on rather than a number for its own sake.
 *
 * `precomputed` exists because the one page that shows these also renders the roster and the
 * coverage table underneath them. Fetching them here as well ran both multi-query readers twice —
 * and `getApprovedLeaveOn` four times — for a single page load. The parameter is optional so the
 * function still stands alone.
 */
export async function getTeamOverview(
  now: Date = new Date(),
  precomputed?: { roster: RosterRow[]; coverage: CoverageRow[] },
): Promise<TeamOverview> {
  const dutyDate = toDhakaDateOnly(now);
  const { start, end } = getDhakaDayRange(now);

  const [roster, coverage, pendingLeaveRequests, changesToday] = await Promise.all([
    precomputed?.roster ?? getRosterForDate(now),
    precomputed?.coverage ?? getCoverageForDate(now),
    prisma.leaveRequest.count({ where: { status: "REQUESTED" } }),
    prisma.dutyAssignmentChange.count({ where: { createdAt: { gte: start, lt: end } } }),
  ]);

  const count = (state: DerivedDutyState) => roster.filter((row) => row.derived === state).length;

  return {
    date: dutyDate,
    activeMembers: roster.length,
    working: count("WORKING"),
    noActivity: count("NO_ACTIVITY"),
    off: count("OFF") + count("HOLIDAY"),
    offDayDuty: count("OFF_DAY_DUTY"),
    onLeave: count("ON_LEAVE"),
    leaveConflicts: count("LEAVE_CONFLICT"),
    unassigned: count("UNASSIGNED"),
    coverageGaps: coverage.filter((row) => row.gap > 0).length,
    pendingLeaveRequests,
    changesToday,
  };
}

export interface WeeklyScheduleCell {
  weekday: number;
  shiftTemplateId: string | null;
  /** No row at all: nobody has decided this day yet, which is not the same as an assigned day off. */
  decided: boolean;
}

export interface WeeklyScheduleRow {
  teamMemberId: string;
  name: string;
  role: string;
  defaultShiftTemplateId: string | null;
  days: WeeklyScheduleCell[];
}

/** The recurring pattern grid. Sunday-first, matching the regional week the rest of the app uses. */
export async function getWeeklySchedule(): Promise<WeeklyScheduleRow[]> {
  const [members, entries] = await Promise.all([
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, role: true, defaultShiftTemplateId: true },
      orderBy: { name: "asc" },
    }),
    prisma.weeklyScheduleEntry.findMany(),
  ]);

  const byMember = new Map<string, Map<number, { shiftTemplateId: string | null }>>();
  for (const entry of entries) {
    if (!byMember.has(entry.teamMemberId)) byMember.set(entry.teamMemberId, new Map());
    byMember.get(entry.teamMemberId)!.set(entry.weekday, { shiftTemplateId: entry.shiftTemplateId });
  }

  return members.map((member) => {
    const days = byMember.get(member.id) ?? new Map();
    return {
      teamMemberId: member.id,
      name: member.name,
      role: member.role,
      defaultShiftTemplateId: member.defaultShiftTemplateId,
      days: Array.from({ length: 7 }, (_, weekday) => {
        const cell = days.get(weekday);
        return {
          weekday,
          shiftTemplateId: cell?.shiftTemplateId ?? null,
          decided: cell !== undefined,
        };
      }),
    };
  });
}

export type CandidateAvailability = "AVAILABLE" | "ON_LEAVE" | "ALREADY_ASSIGNED" | "OFF";

export interface ReplacementCandidate {
  teamMemberId: string;
  name: string;
  role: string;
  availability: CandidateAvailability;
  /** Why they cannot take it, in the manager's terms. Null when they can. */
  blockedReason: string | null;
  /** Duties in the last 30 days — the fairness signal. */
  recentDuties: number;
  /** Off-day duties in the last 30 days, so the same person is not volunteered every time. */
  recentOffDayDuties: number;
}

/**
 * Who could take a shift on a date, and who could not, with the reason.
 *
 * Somebody on approved leave is listed as blocked rather than hidden: a manager who cannot find a
 * colleague they expected to see will assume the list is broken, and the useful answer is "she is
 * on leave until Thursday" rather than silence.
 *
 * Anyone already holding that date is blocked too, and that is not a UI nicety — one assignment per
 * member per date is a database constraint, so assigning them anyway would fail. The workflow has
 * to surface the clash and let the manager choose, never silently overwrite the shift they already
 * have or move a third person to make room.
 */
export async function getReplacementCandidates(date: Date): Promise<ReplacementCandidate[]> {
  const dutyDate = toDhakaDateOnly(date);
  const windowStart = new Date(dutyDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [members, assignments, leave, recent] = await Promise.all([
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.dutyAssignment.findMany({ where: { dutyDate }, select: { teamMemberId: true, status: true, shiftName: true } }),
    getApprovedLeaveOn(dutyDate),
    prisma.dutyAssignment.groupBy({
      by: ["teamMemberId", "status"],
      where: { dutyDate: { gte: windowStart, lt: dutyDate } },
      _count: { _all: true },
    }),
  ]);

  const assignmentByMember = new Map(assignments.map((row) => [row.teamMemberId, row]));
  const dutyCounts = new Map<string, number>();
  const offDayCounts = new Map<string, number>();
  for (const row of recent) {
    const add = (map: Map<string, number>) =>
      map.set(row.teamMemberId, (map.get(row.teamMemberId) ?? 0) + row._count._all);
    if (row.status === "DUTY" || row.status === "COVERAGE" || row.status === "EXTRA_DUTY") add(dutyCounts);
    if (row.status === "COVERAGE" || row.status === "EXTRA_DUTY") add(offDayCounts);
  }

  const candidates = members.map((member) => {
    const leaveType = leave.get(member.id);
    const assignment = assignmentByMember.get(member.id);

    let availability: CandidateAvailability = "AVAILABLE";
    let blockedReason: string | null = null;

    if (leaveType) {
      availability = "ON_LEAVE";
      blockedReason = `On approved ${leaveType.toLowerCase()} leave this day.`;
    } else if (assignment && assignment.status !== "OFF" && assignment.status !== "UNASSIGNED") {
      availability = "ALREADY_ASSIGNED";
      blockedReason = assignment.shiftName
        ? `Already on ${assignment.shiftName} this day.`
        : "Already assigned this day.";
    } else if (assignment?.status === "OFF") {
      availability = "OFF";
      blockedReason = null; // a day off can be given up, but the manager should see that it is one
    }

    return {
      teamMemberId: member.id,
      name: member.name,
      role: member.role,
      availability,
      blockedReason,
      recentDuties: dutyCounts.get(member.id) ?? 0,
      recentOffDayDuties: offDayCounts.get(member.id) ?? 0,
    };
  });

  // Available first, then whoever has carried the least extra duty recently — the list is a
  // suggestion about fairness, not just a filter.
  const rank = (c: ReplacementCandidate) =>
    c.availability === "AVAILABLE" ? 0 : c.availability === "OFF" ? 1 : 2;
  return candidates.sort(
    (a, b) => rank(a) - rank(b) || a.recentOffDayDuties - b.recentOffDayDuties || a.name.localeCompare(b.name),
  );
}

export interface DutyHistoryRow {
  id: string;
  dutyDate: Date;
  teamMemberId: string;
  memberName: string;
  status: DutyStatus | null;
  shiftName: string | null;
  shiftStartMinute: number | null;
  shiftEndMinute: number | null;
  messageCount: number;
  uniqueGroupCount: number;
  /** When the first and last stored message of that day landed. The observed half of this page. */
  firstActivityAt: Date | null;
  lastActivityAt: Date | null;
  /** Scheduled against observed, worked out by `packages/shared`'s pure, unit-tested arithmetic. */
  punctuality: Punctuality;
  override: AttendanceOverride | null;
  overrideReason: string | null;
  /** Who made the correction and when — a verdict about a person should say whose verdict it is. */
  overriddenByName: string | null;
  overriddenAt: Date | null;
  derived: DerivedDutyState;
}

/**
 * The grace periods, with the schema defaults standing in when nobody has opened the settings page.
 *
 * Upserted rather than read-or-null, matching every other settings row in this app: the row is
 * created on first read so the form has something to edit, and a fresh install behaves identically
 * to a configured one until somebody decides otherwise.
 */
export async function getTeamManagementSettings(): Promise<{
  latenessGraceMinutes: number;
  earlyDepartureGraceMinutes: number;
}> {
  const row = await prisma.teamManagementSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
    select: { latenessGraceMinutes: true, earlyDepartureGraceMinutes: true },
  });
  return row;
}

/**
 * Duty history over a range: plan, evidence and the reading, per member per day.
 *
 * Paginated rather than a hard 500 with no page two. A twenty-person roster over a month is 600
 * rows, so the ordinary monthly review truncated — and the page's own notice told the reader to
 * narrow the dates because there was genuinely no other way through.
 */
export async function getDutyHistory(
  range: { start: Date; end: Date },
  teamMemberId?: string,
  page = 1,
  pageSize = 500,
): Promise<{ rows: DutyHistoryRow[]; total: number }> {
  const startDate = toDhakaDateOnly(range.start);
  const endDate = toDhakaDateOnly(new Date(range.end.getTime() - 1));
  const where: Prisma.DutyAssignmentWhereInput = {
    dutyDate: { gte: startDate, lte: endDate },
    ...(teamMemberId ? { teamMemberId } : {}),
  };

  const [assignments, total, attendance, leave, settings] = await Promise.all([
    prisma.dutyAssignment.findMany({
      where,
      include: { teamMember: { select: { name: true } } },
      orderBy: [{ dutyDate: "desc" }, { teamMember: { name: "asc" } }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.dutyAssignment.count({ where }),
    prisma.teamAttendanceDay.findMany({
      where: { activityDate: { gte: startDate, lte: endDate }, ...(teamMemberId ? { teamMemberId } : {}) },
      include: { overriddenBy: { select: { name: true, username: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: {
        status: "APPROVED",
        startDate: { lte: endDate },
        endDate: { gte: startDate },
        ...(teamMemberId ? { teamMemberId } : {}),
      },
      select: { teamMemberId: true, startDate: true, endDate: true },
    }),
    getTeamManagementSettings(),
  ]);

  const key = (memberId: string, date: Date) => `${memberId}:${date.toISOString().slice(0, 10)}`;
  const evidenceByKey = new Map(attendance.map((row) => [key(row.teamMemberId, row.activityDate), row]));

  const onLeave = (memberId: string, date: Date) =>
    leave.some((row) => row.teamMemberId === memberId && row.startDate <= date && row.endDate >= date);

  const rows = assignments.map((assignment) => {
    const evidence = evidenceByKey.get(key(assignment.teamMemberId, assignment.dutyDate)) ?? null;
    return {
      id: assignment.id,
      dutyDate: assignment.dutyDate,
      teamMemberId: assignment.teamMemberId,
      memberName: assignment.teamMember.name,
      status: assignment.status,
      shiftName: assignment.shiftName,
      shiftStartMinute: assignment.shiftStartMinute,
      shiftEndMinute: assignment.shiftEndMinute,
      messageCount: evidence?.messageCount ?? 0,
      uniqueGroupCount: evidence?.uniqueGroupCount ?? 0,
      firstActivityAt: evidence?.firstActivityAt ?? null,
      lastActivityAt: evidence?.lastActivityAt ?? null,
      punctuality: computePunctuality({
        dutyDate: assignment.dutyDate,
        shiftStartMinute: assignment.shiftStartMinute,
        shiftEndMinute: assignment.shiftEndMinute,
        firstActivityAt: evidence?.firstActivityAt ?? null,
        lastActivityAt: evidence?.lastActivityAt ?? null,
        latenessGraceMinutes: settings.latenessGraceMinutes,
        earlyDepartureGraceMinutes: settings.earlyDepartureGraceMinutes,
      }),
      override: evidence?.override ?? null,
      overrideReason: evidence?.overrideReason ?? null,
      overriddenByName: evidence?.overriddenBy?.name ?? evidence?.overriddenBy?.username ?? null,
      overriddenAt: evidence?.overriddenAt ?? null,
      derived: deriveDutyState({
        status: assignment.status,
        hasActivity: (evidence?.messageCount ?? 0) > 0,
        onApprovedLeave: onLeave(assignment.teamMemberId, assignment.dutyDate),
        override: evidence?.override ?? null,
      }),
    };
  });

  return { rows, total };
}

export interface DutyHistorySummary {
  daysScheduled: number;
  daysWorked: number;
  noActivityDays: number;
  offDayDuties: number;
  leaveDays: number;
  lateStarts: number;
  earlyFinishes: number;
  totalMessages: number;
  /** Null when no day in the range had both a first and a last message to measure between. */
  medianEngagedMinutes: number | null;
}

/**
 * The filtered range in one line, so the table does not have to be counted by eye.
 *
 * Derived from the SAME rows the table renders, deliberately — not a second set of queries. Two
 * independent paths to the same figure is how a summary comes to disagree with the list beneath it,
 * and a page that contradicts itself is worse than one with no summary at all.
 *
 * The MEDIAN engaged span, not the mean: one day somebody answered a single message at 9am and
 * another at 8pm drags a mean past every honest reading of the fortnight. Same reasoning as
 * `getFirstResponseStats` choosing a median for response time.
 */
export function summariseDutyHistory(rows: DutyHistoryRow[]): DutyHistorySummary {
  const spans = rows
    .map((row) => row.punctuality.engagedMinutes)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  const median =
    spans.length === 0
      ? null
      : spans.length % 2 === 1
        ? spans[(spans.length - 1) / 2]!
        : Math.round((spans[spans.length / 2 - 1]! + spans[spans.length / 2]!) / 2);

  return {
    daysScheduled: rows.length,
    daysWorked: rows.filter((row) => row.messageCount > 0).length,
    // NO_ACTIVITY only — never "absent". The badge and this count mean the same careful thing.
    noActivityDays: rows.filter((row) => row.derived === "NO_ACTIVITY").length,
    offDayDuties: rows.filter((row) => row.derived === "OFF_DAY_DUTY").length,
    leaveDays: rows.filter((row) => row.derived === "ON_LEAVE" || row.derived === "LEAVE_CONFLICT").length,
    lateStarts: rows.filter((row) => row.punctuality.isLate).length,
    earlyFinishes: rows.filter((row) => row.punctuality.isEarlyFinish).length,
    totalMessages: rows.reduce((sum, row) => sum + row.messageCount, 0),
    medianEngagedMinutes: median,
  };
}

export interface DutyHistoryMemberRow {
  teamMemberId: string;
  memberName: string;
  daysScheduled: number;
  daysWorked: number;
  noActivityDays: number;
  offDayDuties: number;
  lateStarts: number;
  earlyFinishes: number;
  totalMessages: number;
  totalGroups: number;
  medianEngagedMinutes: number | null;
}

/**
 * The same range folded by person instead of by day — "who was late most often this fortnight",
 * which the per-day list can only answer by scrolling and counting.
 *
 * Folded from the rows already fetched, for the reason above. Ordered by late starts, then by
 * days with no activity recorded: the two things somebody opens this view to find. Never ordered
 * by message count, which would read as a productivity league table this module does not claim to
 * be — `/support-activity/team` owns volume, this owns schedule versus reality.
 */
export function groupDutyHistoryByMember(rows: DutyHistoryRow[]): DutyHistoryMemberRow[] {
  const byMember = new Map<string, DutyHistoryRow[]>();
  for (const row of rows) {
    const existing = byMember.get(row.teamMemberId);
    if (existing) existing.push(row);
    else byMember.set(row.teamMemberId, [row]);
  }

  return [...byMember.entries()]
    .map(([teamMemberId, memberRows]) => {
      const summary = summariseDutyHistory(memberRows);
      return {
        teamMemberId,
        memberName: memberRows[0]!.memberName,
        daysScheduled: summary.daysScheduled,
        daysWorked: summary.daysWorked,
        noActivityDays: summary.noActivityDays,
        offDayDuties: summary.offDayDuties,
        lateStarts: summary.lateStarts,
        earlyFinishes: summary.earlyFinishes,
        totalMessages: summary.totalMessages,
        totalGroups: memberRows.reduce((sum, row) => sum + row.uniqueGroupCount, 0),
        medianEngagedMinutes: summary.medianEngagedMinutes,
      };
    })
    .sort(
      (a, b) =>
        b.lateStarts - a.lateStarts ||
        b.noActivityDays - a.noActivityDays ||
        a.memberName.localeCompare(b.memberName),
    );
}

export interface DutyGroupEvidenceRow {
  groupId: string;
  groupName: string;
  messageCount: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * Which groups one person worked in on one day, and when.
 *
 * `TeamAttendanceGroup` has been written on every message since the attendance hook shipped and
 * read by NOTHING — the whole per-group half of the evidence existed only in the database. It is
 * the answer to the question the day-level row always raises next: 93 messages across 23 groups
 * says somebody was busy; this says what they were busy WITH.
 *
 * Loaded per row on demand rather than joined into the list. One day for one person is a handful
 * of rows, while every day for everybody is the same fan-out the list deliberately avoids.
 */
export async function getDutyGroupEvidence(
  teamMemberId: string,
  dutyDate: Date,
): Promise<DutyGroupEvidenceRow[]> {
  const day = await prisma.teamAttendanceDay.findUnique({
    where: { teamMemberId_activityDate: { teamMemberId, activityDate: toDhakaDateOnly(dutyDate) } },
    select: {
      groups: {
        select: {
          groupId: true,
          messageCount: true,
          firstAt: true,
          lastAt: true,
          group: { select: { name: true } },
        },
        orderBy: { messageCount: "desc" },
      },
    },
  });

  return (day?.groups ?? []).map((row) => ({
    groupId: row.groupId,
    groupName: row.group.name,
    messageCount: row.messageCount,
    firstAt: row.firstAt,
    lastAt: row.lastAt,
  }));
}

export interface LeaveRequestRow {
  id: string;
  teamMemberId: string;
  memberName: string;
  leaveTypeName: string;
  startDate: Date;
  endDate: Date;
  dayCount: number;
  reason: string | null;
  status: LeaveStatus;
  managerNote: string | null;
  decidedAt: Date | null;
}

export async function getLeaveRequests(status?: LeaveStatus): Promise<LeaveRequestRow[]> {
  const rows = await prisma.leaveRequest.findMany({
    where: status ? { status } : {},
    include: { teamMember: { select: { name: true } }, leaveType: { select: { name: true } } },
    orderBy: [{ status: "asc" }, { startDate: "desc" }],
    take: 200,
  });

  return rows.map((row) => ({
    id: row.id,
    teamMemberId: row.teamMemberId,
    memberName: row.teamMember.name,
    leaveTypeName: row.leaveType.name,
    startDate: row.startDate,
    endDate: row.endDate,
    dayCount: row.dayCount,
    reason: row.reason,
    status: row.status,
    managerNote: row.managerNote,
    decidedAt: row.decidedAt,
  }));
}

export interface ChangeHistoryRow {
  id: string;
  dutyDate: Date;
  memberName: string;
  previousStatus: DutyStatus | null;
  previousShiftName: string | null;
  newStatus: DutyStatus;
  newShiftName: string | null;
  reason: string | null;
  changedBy: string | null;
  changeGroupId: string | null;
  createdAt: Date;
}

/** The audit trail, newest first. Immutable rows — nothing here is ever edited. */
export async function getRecentChanges(take = 50): Promise<ChangeHistoryRow[]> {
  const rows = await prisma.dutyAssignmentChange.findMany({
    include: { teamMember: { select: { name: true } }, changedBy: { select: { name: true, username: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });

  return rows.map((row) => ({
    id: row.id,
    dutyDate: row.dutyDate,
    memberName: row.teamMember.name,
    previousStatus: row.previousStatus,
    previousShiftName: row.previousShiftName,
    newStatus: row.newStatus,
    newShiftName: row.newShiftName,
    reason: row.reason,
    changedBy: row.changedBy?.name ?? row.changedBy?.username ?? null,
    changeGroupId: row.changeGroupId,
    createdAt: row.createdAt,
  }));
}
