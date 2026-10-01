import {
  bucketKeyFor,
  bucketKeysForRange,
  DISTRIBUTION_METRICS,
  distributionValue,
  dutyWorkload,
  formatDhakaDateKey,
  memberGroupBreakdown,
  memberTimelines,
  sharesOf,
  splitIntoStretches,
  teamWorkload,
  toDhakaDateOnly,
  type DistributionMetric,
  type DutyDayInput,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { bucketLabel } from "@/server/teamReport";
import { bucketColumnLabel } from "@/server/teamReportTables";
import type { ReportContext } from "./context";
import { clock, count, dayLabel, duration, percent, when } from "./format";
import type { BuiltReport, ReportTable } from "./types";

/**
 * Member-oriented reports: Team Workload, Workload Distribution, Employee Support Breakdown and Duty &
 * Workload. All use the Team Report's own member scope — a person's work counts while they were in
 * the chosen Team — and its own support-time rule, so a person's support time is the same number on
 * every one of these pages and on the Team Report.
 */

const opts = (ctx: ReportContext) => ({ rangeStart: ctx.rangeStart, rangeEnd: ctx.rangeEnd, idleGapMs: ctx.idleGapMs, inScope: ctx.data.scope });

const span = (first: number | null, last: number | null) => (first === null ? "—" : `${when(first)} – ${when(last)}`);

const nounFor = (granularity: string) =>
  granularity === "day" ? { singular: "day", plural: "days" } : granularity === "week" ? { singular: "week", plural: "weeks" } : { singular: "month", plural: "months" };

export function buildWorkload(ctx: ReportContext): BuiltReport {
  const granularity = ctx.filters.granularity;
  const rows = teamWorkload(ctx.data.messages, ctx.data.result.waits, opts(ctx));
  const totals = rows.reduce(
    (acc, r) => ({ seconds: acc.seconds + r.activeSeconds, replies: acc.replies + r.replies, waits: acc.waits + r.waitsAnswered, days: acc.days + r.activeDays }),
    { seconds: 0, replies: 0, waits: 0, days: 0 },
  );

  // Per bucket: the team's support time (stretches counted where they start, as the Team Report does)
  // and how many members sent anything.
  const timelines = memberTimelines(ctx.data.messages, opts(ctx));
  const buckets = new Map(bucketKeysForRange(ctx.rangeStart, ctx.rangeEnd, granularity).map((k) => [k, { seconds: 0, replies: 0, members: new Set<string>() }]));
  for (const [memberId, ts] of timelines) {
    for (const t of ts) {
      const b = buckets.get(bucketKeyFor(t, granularity));
      if (!b) continue;
      b.replies += 1;
      b.members.add(memberId);
    }
    for (const s of splitIntoStretches(ts, ctx.idleGapMs)) {
      const b = buckets.get(bucketKeyFor(s.start, granularity));
      if (b) b.seconds += Math.round((s.end - s.start) / 1000);
    }
  }

  const memberTable: ReportTable = {
    id: "members",
    sheet: "Detailed",
    title: `Team members (${count(rows.length)})`,
    description: "Everyone who sent a message in the period, most support time first. Select a name for their Team Report.",
    noun: { singular: "team member", plural: "team members" },
    columns: [
      { label: "Team member" },
      { label: "Groups", numeric: true },
      { label: "Replies", numeric: true },
      { label: "Waits answered", numeric: true },
      { label: "Support time" },
      { label: "Work stretches", numeric: true },
      { label: "Active days", numeric: true },
      { label: "Per active day" },
      { label: "First – last", muted: true },
    ],
    rows: rows.map((r) => ({
      key: r.memberId,
      cells: [ctx.memberName(r.memberId), r.groups, r.replies, r.waitsAnswered, duration(r.activeSeconds), r.stretches, r.activeDays, duration(r.secondsPerActiveDay), span(r.firstAt, r.lastAt)],
      sort: [ctx.memberName(r.memberId).toLowerCase(), r.groups, r.replies, r.waitsAnswered, r.activeSeconds, r.stretches, r.activeDays, r.secondsPerActiveDay, r.firstAt ?? 0],
      href: `/team-report?${new URLSearchParams({ ...stripEmpty(ctx.params), member: r.memberId }).toString()}`,
    })),
  };
  const bucketTable: ReportTable = {
    id: "buckets",
    sheet: "Breakdown",
    title: `By ${granularity}`,
    description: "The team's figures over the period.",
    noun: nounFor(granularity),
    columns: [{ label: bucketColumnLabel(granularity) }, { label: "Members active", numeric: true }, { label: "Replies", numeric: true }, { label: "Support time" }],
    rows: [...buckets.entries()].map(([key, b]) => ({
      key,
      cells: [bucketLabel(key, granularity), b.members.size, b.replies, duration(b.seconds)],
      sort: [key, b.members.size, b.replies, b.seconds],
    })),
  };

  return {
    id: "workload",
    title: "Team Workload",
    question: "How much support work did each person record?",
    tiles: [
      { label: "Support time", value: duration(totals.seconds), hint: `${count(rows.length)} member(s), summed` },
      { label: "Active members", value: count(rows.length), hint: "sent at least one message" },
      { label: "Replies", value: count(totals.replies), hint: "by team members" },
      { label: "Waits answered", value: count(totals.waits), hint: "closed by a member's reply" },
      { label: "Per active member", value: duration(rows.length ? Math.round(totals.seconds / rows.length) : null), hint: "support time ÷ active members" },
      { label: "Per active day", value: duration(totals.days ? Math.round(totals.seconds / totals.days) : null), hint: "support time ÷ member-days worked" },
    ],
    visuals: [
      {
        kind: "columns",
        title: "Support time",
        description: `Hours per ${granularity}, team total.`,
        unit: "h",
        data: [...buckets.entries()].map(([key, b]) => ({ label: bucketLabel(key, granularity), value: Math.round((b.seconds / 3600) * 10) / 10 })),
      },
    ],
    tables: [memberTable, bucketTable],
    notes: [
      {
        tone: "info",
        text: "Recorded support activity, from the messages each person sent in WhatsApp groups. Time on the phone, in a meeting or in a group this system does not store does not appear here.",
      },
    ],
    formulas: [
      {
        title: "Support time",
        text: `The Team Report's: each member's messages across all groups form one timeline, split after ${ctx.data.rules.idleGapMinutes} minutes without a message and at every midnight; time is first-to-last message of each stretch. Two groups answered at once count once.`,
      },
      { title: "Waits answered", text: "Customer waits whose closing reply was this member's." },
      { title: "Active days", text: "Days (Asia/Dhaka) with at least one message from the member." },
    ],
    selects: [],
    usesGranularity: true,
    emptyMessage: rows.length === 0 ? `No team member sent a message in ${ctx.data.range.label} for these filters.` : null,
  };
}

/** The URL's own params minus the ones that are empty, for links that change one filter. */
function stripEmpty(params: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
}

// ---------------------------------------------------------------------------------------------

export function buildDistribution(ctx: ReportContext): BuiltReport {
  const metric: DistributionMetric = ctx.params.metric && ctx.params.metric in DISTRIBUTION_METRICS ? (ctx.params.metric as DistributionMetric) : "time";
  const meta = DISTRIBUTION_METRICS[metric];
  const rows = teamWorkload(ctx.data.messages, ctx.data.result.waits, opts(ctx));
  const { rows: shares, total } = sharesOf(rows, (r) => distributionValue(r, metric));
  const show = (value: number) => (metric === "time" ? duration(value) : count(value));
  const largest = shares[0];

  return {
    id: "distribution",
    title: "Workload Distribution",
    question: "How is the work shared across the team?",
    tiles: [
      { label: `Total ${meta.label.toLowerCase()}`, value: show(total), hint: meta.denominator },
      { label: "Members listed", value: count(rows.length) },
      {
        label: "Largest share",
        value: largest && largest.share !== null ? percent(largest.share) : "—",
        hint: largest && largest.share !== null ? ctx.memberName(largest.item.memberId) : undefined,
      },
      { label: "Even share would be", value: rows.length ? percent(1 / rows.length) : "—", hint: "100% ÷ members listed" },
    ],
    visuals: [
      {
        kind: "bars",
        title: meta.label,
        description: "Per team member.",
        unit: metric === "time" ? "h" : metric === "groups" ? "groups" : metric === "waits" ? "waits" : "replies",
        items: shares.map((s) => ({
          id: s.item.memberId,
          label: ctx.memberName(s.item.memberId),
          value: metric === "time" ? Math.round((s.value / 3600) * 10) / 10 : s.value,
        })),
      },
    ],
    tables: [
      {
        id: "shares",
        sheet: "Detailed",
        title: `${meta.label} by team member`,
        description: `Share = the member's ${meta.label.toLowerCase()} ÷ ${show(total)}, the total ${meta.denominator}.`,
        noun: { singular: "team member", plural: "team members" },
        columns: [{ label: "Team member" }, { label: meta.label }, { label: "Share" }, { label: "Replies", numeric: true }, { label: "Support time" }, { label: "Groups", numeric: true }, { label: "Waits answered", numeric: true }],
        rows: shares.map((s) => ({
          key: s.item.memberId,
          cells: [ctx.memberName(s.item.memberId), show(s.value), percent(s.share), s.item.replies, duration(s.item.activeSeconds), s.item.groups, s.item.waitsAnswered],
          sort: [ctx.memberName(s.item.memberId).toLowerCase(), s.value, s.share ?? -1, s.item.replies, s.item.activeSeconds, s.item.groups, s.item.waitsAnswered],
        })),
      },
    ],
    notes: [
      { tone: "info", text: "A share is not a score: it says who did how much of what was recorded, not how well. Recorded support activity only." },
    ],
    formulas: [
      { title: "Share", text: `The member's value ÷ the sum of the values of every member listed. The denominator here is the ${meta.denominator}.` },
      {
        title: "Groups",
        text: "A group two people supported counts once for each of them, so the total of the Groups metric is group-member pairs, not distinct groups.",
      },
    ],
    selects: [
      {
        name: "metric",
        label: "Share of",
        value: metric,
        options: (Object.keys(DISTRIBUTION_METRICS) as DistributionMetric[]).map((m) => ({ value: m, label: DISTRIBUTION_METRICS[m].label })),
      },
    ],
    usesGranularity: false,
    emptyMessage: rows.length === 0 ? `No team member sent a message in ${ctx.data.range.label} for these filters.` : null,
  };
}

// ---------------------------------------------------------------------------------------------

export function buildEmployeeGroups(ctx: ReportContext): BuiltReport {
  const pairs = memberGroupBreakdown(ctx.data.messages, ctx.data.result.waits, opts(ctx));
  const members = teamWorkload(ctx.data.messages, ctx.data.result.waits, opts(ctx));

  return {
    id: "employee-groups",
    title: "Employee Support Breakdown",
    question: "Which groups did each person support, and how?",
    tiles: [
      { label: "Team members", value: count(members.length), hint: "who sent a message" },
      { label: "Member × group pairs", value: count(pairs.length) },
      { label: "Groups supported", value: count(new Set(pairs.map((p) => p.groupKey)).size) },
      { label: "Replies", value: count(pairs.reduce((s, p) => s + p.replies, 0)) },
    ],
    visuals: [],
    tables: [
      {
        id: "pairs",
        sheet: "Detailed",
        title: `Member × group (${count(pairs.length)})`,
        description: "One row per person per group they replied in.",
        noun: { singular: "row", plural: "rows" },
        columns: [
          { label: "Team member" },
          { label: "Group" },
          { label: "Replies", numeric: true },
          { label: "Group's customer msgs", numeric: true },
          { label: "Waits answered", numeric: true },
          { label: "Median response" },
          { label: "Recall", numeric: true },
          { label: "Support time in group" },
          { label: "First – last", muted: true },
        ],
        rows: pairs.map((p) => ({
          key: `${p.memberId}|${p.groupKey}`,
          cells: [
            ctx.memberName(p.memberId),
            ctx.groupName(p.groupKey),
            p.replies,
            p.customerMessages,
            p.waitsAnswered,
            duration(p.medianResponseSeconds),
            p.recalled,
            duration(p.activeSeconds),
            span(p.firstAt, p.lastAt),
          ],
          sort: [
            `${ctx.memberName(p.memberId).toLowerCase()} ${ctx.groupName(p.groupKey).toLowerCase()}`,
            ctx.groupName(p.groupKey).toLowerCase(),
            p.replies,
            p.customerMessages,
            p.waitsAnswered,
            p.medianResponseSeconds ?? Number.MAX_SAFE_INTEGER,
            p.recalled,
            p.activeSeconds,
            p.firstAt ?? 0,
          ],
          sub: [null, p.groupKey],
        })),
      },
      {
        id: "members",
        sheet: "Breakdown",
        title: "Per team member",
        description: "Support time here is the person's own single timeline — the Team Report's figure.",
        noun: { singular: "team member", plural: "team members" },
        columns: [{ label: "Team member" }, { label: "Groups", numeric: true }, { label: "Replies", numeric: true }, { label: "Waits answered", numeric: true }, { label: "Support time" }],
        rows: members.map((m) => ({
          key: m.memberId,
          cells: [ctx.memberName(m.memberId), m.groups, m.replies, m.waitsAnswered, duration(m.activeSeconds)],
          sort: [ctx.memberName(m.memberId).toLowerCase(), m.groups, m.replies, m.waitsAnswered, m.activeSeconds],
        })),
      },
    ],
    notes: [
      {
        tone: "info",
        text: "Support time in a group is measured over the person's messages in that group alone, so one person's group rows can add up to more than their own total when they worked groups in parallel. Their own total is in the per-member table.",
      },
    ],
    formulas: [
      { title: "Waits answered", text: "Customer waits in that group whose closing reply was this person's; the median is over those waits." },
      { title: "Recall", text: "Of those, the ones answered after the group's Missed threshold." },
      { title: "Group's customer msgs", text: "Every customer message in the group in the period — the group's, not the person's." },
    ],
    selects: [],
    usesGranularity: false,
    emptyMessage: pairs.length === 0 ? `No team member sent a message in ${ctx.data.range.label} for these filters.` : null,
  };
}

// ---------------------------------------------------------------------------------------------

const DUTY_STATUS_LABELS: Record<string, string> = {
  DUTY: "On duty",
  OFF: "Off",
  LEAVE: "Leave",
  HOLIDAY: "Holiday",
  COVERAGE: "Coverage",
  EXTRA_DUTY: "Extra duty",
  UNASSIGNED: "Unassigned",
};

export async function buildDutyWorkload(ctx: ReportContext): Promise<BuiltReport> {
  const timelines = memberTimelines(ctx.data.messages, opts(ctx));
  const { filters, teamMemberIds } = ctx.data;
  // Whose duty rows to read: the chosen member, the members of the chosen Team during the period,
  // or everyone.
  const memberScope = filters.memberId ? [filters.memberId] : filters.teamId ? (teamMemberIds[filters.teamId] ?? []) : null;
  // From the day before the period, so a shift that started the evening before still owns its hours.
  const firstDay = toDhakaDateOnly(new Date(ctx.rangeStart - 86_400_000));
  const lastDay = toDhakaDateOnly(new Date(ctx.rangeEnd - 1));
  const assignments = await prisma.dutyAssignment.findMany({
    where: { dutyDate: { gte: firstDay, lte: lastDay }, ...(memberScope ? { teamMemberId: { in: memberScope } } : {}) },
    select: { teamMemberId: true, dutyDate: true, status: true, shiftName: true, shiftStartMinute: true, shiftEndMinute: true },
  });
  const duties: DutyDayInput[] = assignments.map((a) => ({
    memberId: a.teamMemberId,
    dutyDate: a.dutyDate.toISOString().slice(0, 10),
    status: a.status,
    shiftName: a.shiftName,
    startMinute: a.shiftStartMinute,
    endMinute: a.shiftEndMinute,
  }));
  const startKey = formatDhakaDateKey(new Date(ctx.rangeStart));
  // The carried-in evening shows only when it actually holds time inside the period.
  const rows = dutyWorkload(timelines, duties, { idleGapMs: ctx.idleGapMs }).filter((r) => r.day >= startKey || r.inShiftSeconds > 0);

  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const scheduled = sum((r) => r.scheduledSeconds);
  const inShift = sum((r) => r.inShiftSeconds);
  const beyond = sum((r) => r.beyondScheduleSeconds);
  const offDay = sum((r) => r.offDaySeconds);
  const unrecorded = sum((r) => r.unrecordedScheduledSeconds);

  const perMember = new Map<string, { scheduled: number; inShift: number; beyond: number; offDay: number; unrecorded: number; shifts: number; overnight: number }>();
  for (const r of rows) {
    let acc = perMember.get(r.memberId);
    if (!acc) perMember.set(r.memberId, (acc = { scheduled: 0, inShift: 0, beyond: 0, offDay: 0, unrecorded: 0, shifts: 0, overnight: 0 }));
    acc.scheduled += r.scheduledSeconds;
    acc.inShift += r.inShiftSeconds;
    acc.beyond += r.beyondScheduleSeconds;
    acc.offDay += r.offDaySeconds;
    acc.unrecorded += r.unrecordedScheduledSeconds;
    if (r.shiftStart !== null) acc.shifts += 1;
    if (r.shiftStart !== null && r.shiftEnd !== null && formatDhakaDateKey(new Date(r.shiftEnd - 1)) !== r.day) acc.overnight += 1;
  }

  const shiftText = (r: (typeof rows)[number]) => {
    if (r.shiftStart === null || r.shiftEnd === null) return r.shiftName ?? "—";
    const startMin = Math.round((r.shiftStart - (Date.parse(`${r.day}T00:00:00Z`) - 6 * 3_600_000)) / 60_000);
    const endMin = startMin + Math.round((r.shiftEnd - r.shiftStart) / 60_000);
    const overnight = endMin > 24 * 60;
    return `${r.shiftName ? `${r.shiftName} ` : ""}${clock(startMin)}–${clock(endMin)}${overnight ? " (next day)" : ""}`;
  };

  return {
    id: "duty-workload",
    title: "Duty & Workload",
    question: "How does recorded support time compare with the scheduled shift?",
    tiles: [
      { label: "Scheduled", value: duration(scheduled), hint: `${count(rows.filter((r) => r.shiftStart !== null).length)} shift(s)` },
      { label: "Recorded in shift", value: duration(inShift), hint: "support time inside the shift" },
      { label: "Beyond schedule", value: duration(beyond), hint: "on a shift day, outside the shift" },
      { label: "On off days", value: duration(offDay), hint: "on a day with no shift" },
      { label: "Scheduled, no recorded activity", value: duration(unrecorded), hint: "not idle — nothing was recorded" },
    ],
    visuals: [],
    tables: [
      {
        id: "days",
        sheet: "Detailed",
        title: `Member days (${count(rows.length)})`,
        description: "One row per person per day with a duty or a message.",
        noun: { singular: "day", plural: "days" },
        columns: [
          { label: "Team member" },
          { label: "Date" },
          { label: "Duty" },
          { label: "Shift" },
          { label: "Scheduled" },
          { label: "Recorded in shift" },
          { label: "Beyond schedule" },
          { label: "On off day" },
          { label: "Scheduled, no recorded activity" },
          { label: "Messages", numeric: true },
        ],
        rows: rows.map((r) => ({
          key: `${r.memberId}|${r.day}`,
          cells: [
            ctx.memberName(r.memberId),
            dayLabel(r.day),
            r.status ? (DUTY_STATUS_LABELS[r.status] ?? r.status) : "No duty recorded",
            shiftText(r),
            duration(r.scheduledSeconds),
            duration(r.inShiftSeconds),
            duration(r.beyondScheduleSeconds),
            duration(r.offDaySeconds),
            duration(r.unrecordedScheduledSeconds),
            r.messages,
          ],
          sort: [
            `${ctx.memberName(r.memberId).toLowerCase()} ${r.day}`,
            r.day,
            r.status ?? "~",
            r.shiftStart ?? 0,
            r.scheduledSeconds,
            r.inShiftSeconds,
            r.beyondScheduleSeconds,
            r.offDaySeconds,
            r.unrecordedScheduledSeconds,
            r.messages,
          ],
          muted: r.status === null || r.status === "OFF" || r.status === "LEAVE" || r.status === "HOLIDAY",
        })),
      },
      {
        id: "members",
        sheet: "Breakdown",
        title: "Per team member",
        description: "Recorded in shift + beyond schedule + on off days = the person's support time on the Team Report.",
        noun: { singular: "team member", plural: "team members" },
        columns: [
          { label: "Team member" },
          { label: "Shifts", numeric: true },
          { label: "Overnight shifts", numeric: true },
          { label: "Scheduled" },
          { label: "Recorded in shift" },
          { label: "Beyond schedule" },
          { label: "On off days" },
          { label: "Recorded in total" },
          { label: "Scheduled, no recorded activity" },
        ],
        rows: [...perMember.entries()]
          .sort((a, b) => ctx.memberName(a[0]).localeCompare(ctx.memberName(b[0])))
          .map(([memberId, a]) => ({
            key: memberId,
            cells: [ctx.memberName(memberId), a.shifts, a.overnight, duration(a.scheduled), duration(a.inShift), duration(a.beyond), duration(a.offDay), duration(a.inShift + a.beyond + a.offDay), duration(a.unrecorded)],
            sort: [ctx.memberName(memberId).toLowerCase(), a.shifts, a.overnight, a.scheduled, a.inShift, a.beyond, a.offDay, a.inShift + a.beyond + a.offDay, a.unrecorded],
          })),
      },
    ],
    notes: [
      {
        tone: "info",
        text: "Recorded support activity is measured from WhatsApp messages, not office attendance. Work on the phone, in a meeting or in a group this system does not store is not recorded, so \"Scheduled, no recorded activity\" is not absence and not idle time.",
      },
    ],
    formulas: [
      {
        title: "Scheduled",
        text: "The shift's length for an On duty, Coverage or Extra duty day with shift times. A shift whose end is at or before its start runs past midnight and belongs to the day it starts.",
      },
      {
        title: "Recorded in shift",
        text: "The Team Report's support time, cut against the shift: time inside the shift window counts for the shift's day, even after midnight.",
      },
      {
        title: "Beyond schedule / On off days",
        text: "Support time outside every shift window, on its own calendar day: Beyond schedule on a day with a shift, On off days on a day without one.",
      },
      { title: "Scheduled, no recorded activity", text: "Scheduled − recorded in shift, never below zero." },
    ],
    selects: [],
    usesGranularity: false,
    emptyMessage: rows.length === 0 ? `No duty was scheduled and no team member sent a message in ${ctx.data.range.label} for these filters.` : null,
  };
}
