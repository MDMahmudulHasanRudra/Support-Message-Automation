import { DHAKA_OFFSET_MS, formatDhakaDateKey } from "./dhakaDay.js";
import {
  bucketKeyFor,
  bucketKeysForRange,
  splitIntoStretches,
  type ReportGranularity,
  type ReportMessage,
  type ReportWait,
} from "./teamReport.js";

/**
 * The calculations behind the reports at `/reports/<id>` (REPORTS.md §4). Pure functions over the
 * SAME classified messages and waits the Team Report computes from (`computeTeamReport`), so a wait,
 * a missed threshold and a support time mean exactly what they mean there. Nothing here re-decides
 * who is a customer or when a wait starts; it only cuts those facts another way.
 *
 * Inputs follow the Team Report's conventions: times are milliseconds since epoch, a period is
 * [rangeStart, rangeEnd), days and hours are Asia/Dhaka, and `inScope(memberId, ts)` is the Team
 * Report's scope predicate (null = everybody).
 */

export type InScope = ((memberId: string, ts: number) => boolean) | null;

// ---------------------------------------------------------------------------------------------
// Wait outcomes and response statistics
// ---------------------------------------------------------------------------------------------

export type SupportOutcome = "WAITING" | "ANSWERED" | "ANSWERED_LATE" | "NEVER_ANSWERED";

export const SUPPORT_OUTCOME_LABELS: Record<SupportOutcome, string> = {
  WAITING: "Waiting",
  ANSWERED: "Answered",
  ANSWERED_LATE: "Answered late",
  NEVER_ANSWERED: "Never answered",
};

/** A wait's status in the words the Missed Support report uses. One-to-one with WaitStatus. */
export function outcomeOf(wait: ReportWait): SupportOutcome {
  switch (wait.status) {
    case "ON_TIME":
      return "ANSWERED";
    case "RECALLED":
      return "ANSWERED_LATE";
    case "MISSED":
      return "NEVER_ANSWERED";
    case "PENDING":
      return "WAITING";
  }
}

export interface ResponseStats {
  waits: number;
  /** Answered within the target. */
  within: number;
  /** Answered after the target (Recall). */
  late: number;
  /** Not answered, past the target. */
  never: number;
  /** Not answered, still inside the target — left out of every percentage. */
  pending: number;
  answered: number;
  /** within ÷ (within + late + never); null when nothing is decided yet. */
  slaRatio: number | null;
  /** (within + late) ÷ (within + late + never); null when nothing is decided yet. */
  coverageRatio: number | null;
  medianSeconds: number | null;
  averageSeconds: number | null;
  p90Seconds: number | null;
  maxSeconds: number | null;
}

/** The middle value; for an even count, the mean of the two middle values, rounded. */
export function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Nearest-rank percentile: the smallest value at or above `p` of the values. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

export function responseStats(waits: readonly ReportWait[]): ResponseStats {
  let within = 0;
  let late = 0;
  let never = 0;
  let pending = 0;
  const times: number[] = [];
  for (const wait of waits) {
    if (wait.status === "ON_TIME") within += 1;
    else if (wait.status === "RECALLED") late += 1;
    else if (wait.status === "MISSED") never += 1;
    else pending += 1;
    if (wait.waitSeconds !== null) times.push(wait.waitSeconds);
  }
  times.sort((a, b) => a - b);
  const decided = within + late + never;
  return {
    waits: waits.length,
    within,
    late,
    never,
    pending,
    answered: within + late,
    slaRatio: decided ? within / decided : null,
    coverageRatio: decided ? (within + late) / decided : null,
    medianSeconds: median(times),
    averageSeconds: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    p90Seconds: percentile(times, 0.9),
    maxSeconds: times.length ? times[times.length - 1]! : null,
  };
}

/** Waits grouped by a key, each list keeping the input order. */
export function groupWaitsBy<K>(waits: readonly ReportWait[], keyOf: (w: ReportWait) => K | null): Map<K, ReportWait[]> {
  const out = new Map<K, ReportWait[]>();
  for (const wait of waits) {
    const key = keyOf(wait);
    if (key === null) continue;
    const list = out.get(key);
    if (list) list.push(wait);
    else out.set(key, [wait]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Group activity (Inactive Groups)
// ---------------------------------------------------------------------------------------------

export interface GroupMessageCounts {
  customer: number;
  member: number;
  business: number;
  total: number;
  lastAt: number | null;
}

/** Per group, the messages of each kind inside the period. */
export function groupMessageCounts(
  messages: readonly ReportMessage[],
  rangeStart: number,
  rangeEnd: number,
): Map<string, GroupMessageCounts> {
  const out = new Map<string, GroupMessageCounts>();
  for (const m of messages) {
    if (m.ts < rangeStart || m.ts >= rangeEnd) continue;
    let row = out.get(m.groupKey);
    if (!row) {
      row = { customer: 0, member: 0, business: 0, total: 0, lastAt: null };
      out.set(m.groupKey, row);
    }
    if (m.kind === "CUSTOMER") row.customer += 1;
    else if (m.kind === "MEMBER") row.member += 1;
    else row.business += 1;
    row.total += 1;
    if (row.lastAt === null || m.ts > row.lastAt) row.lastAt = m.ts;
  }
  return out;
}

export type GroupActivityStatus = "NO_COMMUNICATION" | "NO_CUSTOMER_ACTIVITY" | "CUSTOMER_NO_REPLY" | "LOW_ACTIVITY" | "ACTIVE";

export const GROUP_ACTIVITY_LABELS: Record<GroupActivityStatus, string> = {
  NO_COMMUNICATION: "No communication",
  NO_CUSTOMER_ACTIVITY: "No customer activity",
  CUSTOMER_NO_REPLY: "Customer activity, no reply",
  LOW_ACTIVITY: "Low activity",
  ACTIVE: "Active",
};

export const DEFAULT_LOW_ACTIVITY_THRESHOLD = 5;

/**
 * One status per group for the period, checked in this order:
 *   no stored message of any kind                → NO_COMMUNICATION
 *   messages, but none from a customer           → NO_CUSTOMER_ACTIVITY
 *   customer messages, no member/business reply  → CUSTOMER_NO_REPLY
 *   fewer than `lowActivityThreshold` messages   → LOW_ACTIVITY
 *   otherwise                                    → ACTIVE
 * Kept as separate answers on purpose: "nobody wrote" and "somebody wrote and nobody answered"
 * call for opposite responses, and merging them would hide the second inside the first. Likewise
 * "no message at all" is not "no customer message": a group where only the team posted had
 * communication, and saying it had none would be false.
 */
export function classifyGroupActivity(
  counts: Pick<GroupMessageCounts, "customer" | "member" | "business" | "total"> | undefined,
  lowActivityThreshold: number,
): GroupActivityStatus {
  if (!counts || counts.total === 0) return "NO_COMMUNICATION";
  if (counts.customer === 0) return "NO_CUSTOMER_ACTIVITY";
  if (counts.member + counts.business === 0) return "CUSTOMER_NO_REPLY";
  if (counts.total < lowActivityThreshold) return "LOW_ACTIVITY";
  return "ACTIVE";
}

/** Whole days between two instants, rounded down; null when there is no instant to measure from. */
export function daysBetween(fromMs: number | null, toMs: number): number | null {
  if (fromMs === null) return null;
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

// ---------------------------------------------------------------------------------------------
// Members: timelines, workload and the member × group breakdown
// ---------------------------------------------------------------------------------------------

/**
 * Each member's in-scope message times inside the period, sorted — the exact timeline the Team
 * Report measures support time over, so a stretch here is a stretch there.
 */
export function memberTimelines(
  messages: readonly ReportMessage[],
  opts: { rangeStart: number; rangeEnd: number; inScope: InScope },
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of messages) {
    if (m.kind !== "MEMBER" || !m.memberId || m.ts < opts.rangeStart || m.ts >= opts.rangeEnd) continue;
    if (opts.inScope && !opts.inScope(m.memberId, m.ts)) continue;
    const list = out.get(m.memberId);
    if (list) list.push(m.ts);
    else out.set(m.memberId, [m.ts]);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

const stretchSeconds = (sortedTs: readonly number[], idleGapMs: number) =>
  splitIntoStretches(sortedTs, idleGapMs).reduce((sum, s) => sum + Math.round((s.end - s.start) / 1000), 0);

/** Whether the member's reply that closed a wait counts in this scope. */
const answeredInScope = (w: ReportWait, memberId: string, inScope: InScope) =>
  w.repliedBy === memberId && w.repliedAt !== null && (!inScope || inScope(memberId, w.repliedAt));

export interface WorkloadRow {
  memberId: string;
  replies: number;
  groups: number;
  waitsAnswered: number;
  activeSeconds: number;
  stretches: number;
  activeDays: number;
  /** activeSeconds ÷ activeDays, rounded; 0 when there were none. */
  secondsPerActiveDay: number;
  firstAt: number | null;
  lastAt: number | null;
}

export function teamWorkload(
  messages: readonly ReportMessage[],
  waits: readonly ReportWait[],
  opts: { rangeStart: number; rangeEnd: number; idleGapMs: number; inScope: InScope },
): WorkloadRow[] {
  const timelines = memberTimelines(messages, opts);
  const groupsOf = new Map<string, Set<string>>();
  for (const m of messages) {
    if (m.kind !== "MEMBER" || !m.memberId || m.ts < opts.rangeStart || m.ts >= opts.rangeEnd) continue;
    if (opts.inScope && !opts.inScope(m.memberId, m.ts)) continue;
    let set = groupsOf.get(m.memberId);
    if (!set) groupsOf.set(m.memberId, (set = new Set()));
    set.add(m.groupKey);
  }
  const rows: WorkloadRow[] = [];
  for (const [memberId, ts] of timelines) {
    const stretches = splitIntoStretches(ts, opts.idleGapMs);
    const activeSeconds = stretches.reduce((sum, s) => sum + Math.round((s.end - s.start) / 1000), 0);
    const activeDays = new Set(ts.map((t) => formatDhakaDateKey(new Date(t)))).size;
    rows.push({
      memberId,
      replies: ts.length,
      groups: groupsOf.get(memberId)?.size ?? 0,
      waitsAnswered: waits.filter((w) => answeredInScope(w, memberId, opts.inScope)).length,
      activeSeconds,
      stretches: stretches.length,
      activeDays,
      secondsPerActiveDay: activeDays ? Math.round(activeSeconds / activeDays) : 0,
      firstAt: ts[0] ?? null,
      lastAt: ts[ts.length - 1] ?? null,
    });
  }
  // A wait asked in the period can be answered in the 24h look-ahead after it, by somebody who sent
  // nothing inside the period. Their reply still answered it — the Team Report credits a Recall that
  // way too — so they get a row of their own rather than vanishing from the total.
  const listed = new Set(rows.map((r) => r.memberId));
  const lateOnly = new Map<string, number>();
  for (const w of waits) {
    const replier = w.repliedBy;
    if (!replier || replier === "BUSINESS" || listed.has(replier) || !answeredInScope(w, replier, opts.inScope)) continue;
    lateOnly.set(replier, (lateOnly.get(replier) ?? 0) + 1);
  }
  for (const [memberId, waitsAnswered] of lateOnly) {
    rows.push({ memberId, replies: 0, groups: 0, waitsAnswered, activeSeconds: 0, stretches: 0, activeDays: 0, secondsPerActiveDay: 0, firstAt: null, lastAt: null });
  }
  return rows.sort((a, b) => b.activeSeconds - a.activeSeconds || b.replies - a.replies || a.memberId.localeCompare(b.memberId));
}

export interface MemberGroupRow {
  memberId: string;
  groupKey: string;
  replies: number;
  /** The group's customer messages in the period — the group's, not the member's. */
  customerMessages: number;
  waitsAnswered: number;
  medianResponseSeconds: number | null;
  recalled: number;
  /** Support time over this member's messages in this group alone. */
  activeSeconds: number;
  firstAt: number | null;
  lastAt: number | null;
}

export function memberGroupBreakdown(
  messages: readonly ReportMessage[],
  waits: readonly ReportWait[],
  opts: { rangeStart: number; rangeEnd: number; idleGapMs: number; inScope: InScope },
): MemberGroupRow[] {
  const inRange = (ts: number) => ts >= opts.rangeStart && ts < opts.rangeEnd;
  const customers = new Map<string, number>();
  const pairs = new Map<string, { memberId: string; groupKey: string; ts: number[] }>();
  for (const m of messages) {
    if (!inRange(m.ts)) continue;
    if (m.kind === "CUSTOMER") {
      customers.set(m.groupKey, (customers.get(m.groupKey) ?? 0) + 1);
      continue;
    }
    if (m.kind !== "MEMBER" || !m.memberId) continue;
    if (opts.inScope && !opts.inScope(m.memberId, m.ts)) continue;
    const key = `${m.memberId}\u0000${m.groupKey}`;
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { memberId: m.memberId, groupKey: m.groupKey, ts: [] }));
    pair.ts.push(m.ts);
  }
  const closed = groupWaitsBy(waits, (w) =>
    w.repliedBy && w.repliedBy !== "BUSINESS" && answeredInScope(w, w.repliedBy, opts.inScope)
      ? `${w.repliedBy}\u0000${w.groupKey}`
      : null,
  );
  const rows: MemberGroupRow[] = [];
  for (const [key, pair] of pairs) {
    pair.ts.sort((a, b) => a - b);
    const theirs = closed.get(key) ?? [];
    const times = theirs.map((w) => w.waitSeconds!).sort((a, b) => a - b);
    rows.push({
      memberId: pair.memberId,
      groupKey: pair.groupKey,
      replies: pair.ts.length,
      customerMessages: customers.get(pair.groupKey) ?? 0,
      waitsAnswered: theirs.length,
      medianResponseSeconds: median(times),
      recalled: theirs.filter((w) => w.status === "RECALLED").length,
      activeSeconds: stretchSeconds(pair.ts, opts.idleGapMs),
      firstAt: pair.ts[0] ?? null,
      lastAt: pair.ts[pair.ts.length - 1] ?? null,
    });
  }
  return rows.sort(
    (a, b) => a.memberId.localeCompare(b.memberId) || b.replies - a.replies || a.groupKey.localeCompare(b.groupKey),
  );
}

// ---------------------------------------------------------------------------------------------
// Workload distribution
// ---------------------------------------------------------------------------------------------

export type DistributionMetric = "replies" | "time" | "groups" | "waits";

export const DISTRIBUTION_METRICS: Record<DistributionMetric, { label: string; denominator: string }> = {
  replies: { label: "Replies", denominator: "replies sent by the members listed" },
  time: { label: "Support time", denominator: "support time recorded by the members listed" },
  groups: {
    label: "Groups supported",
    denominator: "group-member pairs (a group two people supported counts once for each)",
  },
  waits: { label: "Waits answered", denominator: "customer waits answered by the members listed" },
};

export interface ShareRow<T> {
  item: T;
  value: number;
  /** value ÷ total, or null when the total is zero (no share of nothing). */
  share: number | null;
}

/** Each value's share of the sum of all of them. The total is returned so a page can print it. */
export function sharesOf<T>(items: readonly T[], valueOf: (item: T) => number): { rows: Array<ShareRow<T>>; total: number } {
  const total = items.reduce((sum, item) => sum + valueOf(item), 0);
  return {
    total,
    rows: items
      .map((item) => ({ item, value: valueOf(item), share: total > 0 ? valueOf(item) / total : null }))
      .sort((a, b) => b.value - a.value),
  };
}

export function distributionValue(row: WorkloadRow, metric: DistributionMetric): number {
  if (metric === "replies") return row.replies;
  if (metric === "time") return row.activeSeconds;
  if (metric === "groups") return row.groups;
  return row.waitsAnswered;
}

// ---------------------------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------------------------

export type HeatmapMetric = "customer" | "replies" | "waits";

export const HEATMAP_METRICS: Record<HeatmapMetric, string> = {
  customer: "Customer messages",
  replies: "Team replies",
  waits: "Customer waits started",
};

/** Dhaka weekday (0 = Sunday) and hour (0–23) of an instant. */
export function dhakaWeekdayHour(ts: number): { weekday: number; hour: number } {
  const shifted = new Date(ts + DHAKA_OFFSET_MS);
  return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

/** A 7 × 24 grid of counts, `[weekday][hour]`, Sunday first. */
export function activityHeatmap(
  messages: readonly ReportMessage[],
  waits: readonly ReportWait[],
  metric: HeatmapMetric,
  opts: { rangeStart: number; rangeEnd: number; includeMessage?: (m: ReportMessage) => boolean },
): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const add = (ts: number) => {
    const { weekday, hour } = dhakaWeekdayHour(ts);
    grid[weekday]![hour]! += 1;
  };
  if (metric === "waits") {
    for (const wait of waits) if (wait.askedAt >= opts.rangeStart && wait.askedAt < opts.rangeEnd) add(wait.askedAt);
    return grid;
  }
  for (const m of messages) {
    if (m.ts < opts.rangeStart || m.ts >= opts.rangeEnd) continue;
    if (metric === "customer" ? m.kind !== "CUSTOMER" : m.kind === "CUSTOMER") continue;
    if (opts.includeMessage && !opts.includeMessage(m)) continue;
    add(m.ts);
  }
  return grid;
}

// ---------------------------------------------------------------------------------------------
// Group activity trend
// ---------------------------------------------------------------------------------------------

export interface TrendBucketRow {
  key: string;
  customerMessages: number;
  replies: number;
  /** Groups with any message in the bucket. */
  activeGroups: number;
  /** Groups whose customers wrote in the bucket and got no reply in it. */
  unansweredGroups: number;
  waits: number;
  missed: number;
}

export function groupActivityTrend(
  messages: readonly ReportMessage[],
  waits: readonly ReportWait[],
  opts: { rangeStart: number; rangeEnd: number; granularity: ReportGranularity },
): TrendBucketRow[] {
  interface Acc extends TrendBucketRow {
    customerGroups: Set<string>;
    replyGroups: Set<string>;
    anyGroups: Set<string>;
  }
  const buckets = new Map<string, Acc>();
  for (const key of bucketKeysForRange(opts.rangeStart, opts.rangeEnd, opts.granularity)) {
    buckets.set(key, {
      key,
      customerMessages: 0,
      replies: 0,
      activeGroups: 0,
      unansweredGroups: 0,
      waits: 0,
      missed: 0,
      customerGroups: new Set(),
      replyGroups: new Set(),
      anyGroups: new Set(),
    });
  }
  for (const m of messages) {
    if (m.ts < opts.rangeStart || m.ts >= opts.rangeEnd) continue;
    const b = buckets.get(bucketKeyFor(m.ts, opts.granularity));
    if (!b) continue;
    b.anyGroups.add(m.groupKey);
    if (m.kind === "CUSTOMER") {
      b.customerMessages += 1;
      b.customerGroups.add(m.groupKey);
    } else {
      b.replies += 1;
      b.replyGroups.add(m.groupKey);
    }
  }
  for (const w of waits) {
    if (w.askedAt < opts.rangeStart || w.askedAt >= opts.rangeEnd) continue;
    const b = buckets.get(bucketKeyFor(w.askedAt, opts.granularity));
    if (!b) continue;
    b.waits += 1;
    if (w.status === "RECALLED" || w.status === "MISSED") b.missed += 1;
  }
  return [...buckets.values()].map(({ customerGroups, replyGroups, anyGroups, ...row }) => ({
    ...row,
    activeGroups: anyGroups.size,
    unansweredGroups: [...customerGroups].filter((g) => !replyGroups.has(g)).length,
  }));
}

// ---------------------------------------------------------------------------------------------
// Duty & Workload
// ---------------------------------------------------------------------------------------------

/** Statuses whose shift times are a schedule somebody was meant to work. */
export const SCHEDULED_DUTY_STATUSES: readonly string[] = ["DUTY", "COVERAGE", "EXTRA_DUTY"];

export interface DutyDayInput {
  memberId: string;
  /** YYYY-MM-DD, the Dhaka day the shift STARTS (DutyAssignment.dutyDate). */
  dutyDate: string;
  status: string;
  shiftName: string | null;
  startMinute: number | null;
  endMinute: number | null;
}

export interface DutyWorkloadRow {
  memberId: string;
  /** YYYY-MM-DD. */
  day: string;
  status: string | null;
  shiftName: string | null;
  /** The shift window, ms; null on a day without a scheduled shift. */
  shiftStart: number | null;
  shiftEnd: number | null;
  scheduledSeconds: number;
  /** Recorded support time inside this day's shift window (which may run past midnight). */
  inShiftSeconds: number;
  /** Recorded support time on this calendar day outside every shift window. */
  outsideShiftSeconds: number;
  /** outsideShiftSeconds on a day that has a scheduled shift. */
  beyondScheduleSeconds: number;
  /** outsideShiftSeconds on a day without one. */
  offDaySeconds: number;
  /** max(0, scheduled − in shift): scheduled time with no recorded activity. Not "idle". */
  unrecordedScheduledSeconds: number;
  /** Messages sent on this calendar day. */
  messages: number;
}

const dayStartMs = (dateKey: string) => {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) - DHAKA_OFFSET_MS;
};

/** A shift's [start, end) instants. An end at or before the start runs into the next day. */
export function shiftWindow(dutyDate: string, startMinute: number, endMinute: number): { start: number; end: number } {
  const base = dayStartMs(dutyDate);
  const endMinutes = endMinute <= startMinute ? endMinute + 24 * 60 : endMinute;
  return { start: base + startMinute * 60_000, end: base + endMinutes * 60_000 };
}

/**
 * Scheduled shift time against recorded support time, per member per day.
 *
 * Recorded time is the Team Report's: the member's in-scope messages split into stretches at the idle
 * gap and at Dhaka midnight. Each stretch is cut against the member's shift windows — the part inside
 * a window is "in shift" on the day that shift STARTS (so 01:00 inside a 22:00–06:00 shift counts for
 * the evening it began), and the rest is "outside shift" on its own calendar day. A stretch's seconds
 * are rounded exactly as the Team Report rounds them, so in-shift plus outside-shift over a member's
 * rows equals their Team Report support time.
 */
export function dutyWorkload(
  timelines: ReadonlyMap<string, readonly number[]>,
  duties: readonly DutyDayInput[],
  opts: {
    idleGapMs: number;
    /**
     * The report's period. When given, "scheduled" counts only the part of each shift inside it — a
     * 22:00–06:00 shift is 2h of Tuesday's report and 6h of Wednesday's, never 8h of both. Recorded
     * time is already confined to the period (the timelines are), so without this the
     * unrecorded-scheduled figure charged hours nobody could have recorded inside the period.
     */
    periodStart?: number;
    periodEnd?: number;
  },
): DutyWorkloadRow[] {
  const rows = new Map<string, DutyWorkloadRow>();
  const rowFor = (memberId: string, day: string): DutyWorkloadRow => {
    const key = `${memberId}\u0000${day}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        memberId,
        day,
        status: null,
        shiftName: null,
        shiftStart: null,
        shiftEnd: null,
        scheduledSeconds: 0,
        inShiftSeconds: 0,
        outsideShiftSeconds: 0,
        beyondScheduleSeconds: 0,
        offDaySeconds: 0,
        unrecordedScheduledSeconds: 0,
        messages: 0,
      };
      rows.set(key, row);
    }
    return row;
  };

  const windowsByMember = new Map<string, Array<{ day: string; start: number; end: number }>>();
  for (const duty of duties) {
    const row = rowFor(duty.memberId, duty.dutyDate);
    row.status = duty.status;
    row.shiftName = duty.shiftName;
    if (!SCHEDULED_DUTY_STATUSES.includes(duty.status) || duty.startMinute === null || duty.endMinute === null) continue;
    const window = shiftWindow(duty.dutyDate, duty.startMinute, duty.endMinute);
    row.shiftStart = window.start;
    row.shiftEnd = window.end;
    const from = Math.max(window.start, opts.periodStart ?? -Infinity);
    const to = Math.min(window.end, opts.periodEnd ?? Infinity);
    row.scheduledSeconds = Math.max(0, Math.round((to - from) / 1000));
    let list = windowsByMember.get(duty.memberId);
    if (!list) windowsByMember.set(duty.memberId, (list = []));
    list.push({ day: duty.dutyDate, ...window });
  }
  // Windows of one member never credit the same instant twice: an overlapping later window starts
  // where the earlier one ended.
  for (const list of windowsByMember.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) list[i]!.start = Math.max(list[i]!.start, list[i - 1]!.end);
  }

  for (const [memberId, ts] of timelines) {
    const windows = windowsByMember.get(memberId) ?? [];
    for (const t of ts) rowFor(memberId, formatDhakaDateKey(new Date(t))).messages += 1;
    for (const stretch of splitIntoStretches(ts, opts.idleGapMs)) {
      const total = Math.round((stretch.end - stretch.start) / 1000);
      let inside = 0;
      for (const w of windows) {
        const overlapMs = Math.min(stretch.end, w.end) - Math.max(stretch.start, w.start);
        if (overlapMs <= 0) continue;
        const seconds = Math.min(total - inside, Math.round(overlapMs / 1000));
        if (seconds <= 0) continue;
        rowFor(memberId, w.day).inShiftSeconds += seconds;
        inside += seconds;
      }
      if (total - inside > 0) rowFor(memberId, formatDhakaDateKey(new Date(stretch.start))).outsideShiftSeconds += total - inside;
    }
  }

  for (const row of rows.values()) {
    if (row.shiftStart !== null) row.beyondScheduleSeconds = row.outsideShiftSeconds;
    else row.offDaySeconds = row.outsideShiftSeconds;
    row.unrecordedScheduledSeconds = Math.max(0, row.scheduledSeconds - row.inShiftSeconds);
  }
  return [...rows.values()].sort((a, b) => a.memberId.localeCompare(b.memberId) || a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------------------------------------
// WhatsApp call activity — inferred from text, never from call records (none are stored)
// ---------------------------------------------------------------------------------------------

export type CallKind = "CALL_REQUESTED" | "MISSED_CALL" | "CALL_MENTIONED";

export const CALL_KIND_LABELS: Record<CallKind, string> = {
  CALL_REQUESTED: "Call requested",
  MISSED_CALL: "Missed call mentioned",
  CALL_MENTIONED: "Call mentioned",
};

/**
 * The phrases a message must contain to count, checked in this order (the first kind that matches
 * wins). English, Banglish and Bangla, because that is how this product's customers write. A code
 * catalogue rather than a setting: making it editable would need a new settings column (REPORTS.md §1).
 * Bangla is matched as text, not with \b, because JavaScript's word boundary treats every Bengali
 * letter as a non-word character — so each Bangla pattern refuses a Bengali letter right before it
 * instead: without that "সকল" ("all") read as "কল" ("call"), and "সকল দিন" as a call request.
 */
export const CALL_PHRASES: ReadonlyArray<{ kind: CallKind; patterns: readonly RegExp[] }> = [
  {
    kind: "MISSED_CALL",
    patterns: [
      /\bmiss(?:ed)?\s*call/i,
      /\bcall\s*(?:dhor|dhoren|dhorlen|dhorle|dhoren\s*ni|receive|recieve|pick)/i,
      /(?<![\u0980-\u09FF])(?:মিসড|মিস)\s*কল/,
      /(?<![\u0980-\u09FF])(?:কল|ফোন)\s*ধর/,
    ],
  },
  {
    kind: "CALL_REQUESTED",
    patterns: [
      // Not "pls phone number din": that asks for a number, not a call.
      /\b(?:please|pls|plz|kindly)\s+(?:give\s+(?:me\s+)?a\s+)?(?:call|phone)\b(?!\s*(?:number|no\b|nmbr|nambar))/i,
      /\bcall\s+(?:me|koren|korun|den|din|diben|dien|dao|diyen|korben|dite\s+paren)\b/i,
      /\bgive\s+(?:me\s+)?a\s+call\b/i,
      /\bcan\s+(?:you|u)\s+(?:please\s+)?call\b/i,
      /\bphone\s+(?:den|din|diben|koren|korun|dao|korben)\b/i,
      /(?<![\u0980-\u09FF])(?:কল|ফোন)\s*(?:দিন|দেন|দিবেন|দিয়েন|করুন|করেন|করবেন)/,
    ],
  },
  {
    kind: "CALL_MENTIONED",
    patterns: [
      /\b(?:i|we|i've|we've|have|already)\s+called\b/i,
      /\bcalled\s+(?:you|u)\b/i,
      /\bcalling\s+(?:you|u|now)\b/i,
      /\bcall\s*(?:disi|dici|dichi|dicchi|dilam|korsi|korchi|korechi|korlam|korbo|dibo|dei|dile)\b/i,
      /\b(?:will|i'll|ill|gonna|i\s+will)\s+call\b/i,
      /\b(?:on|in)\s+(?:a\s+)?call\b/i,
      /\b(?:voice|video|phone)\s*call\b/i,
      /(?<![\u0980-\u09FF])(?:কল|ফোন)\s*(?:দিয়েছি|দিচ্ছি|দিলাম|দিবো|দেব|করেছি|করছি|করলাম|করব|করবো)/,
      /(?<![\u0980-\u09FF])(?:ভয়েস|ভিডিও|ফোন)\s*কল/,
    ],
  },
];

const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";
const toAsciiDigits = (text: string) => text.replace(/[০-৯]/g, (d) => String(BENGALI_DIGITS.indexOf(d)));

/**
 * A duration only where the message ties a number to the call itself — "12 min call", "call lasted
 * 5 minutes", "১০ মিনিট কথা হয়েছে". Deliberately narrow: "call me in 10 minutes" names a time to
 * call, not how long a call took, and a report that turned it into a ten-minute call would be
 * inventing one.
 */
const DURATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; group: number; unit: "min" | "sec" }> = [
  { pattern: /(\d{1,3})\s*(?:min|mins|minute|minutes)\s*(?:long\s*)?(?:voice\s*|video\s*|phone\s*)?call/i, group: 1, unit: "min" },
  { pattern: /call\s*(?:lasted|duration[:\s]*|for|chilo|hoise|hoyeche|holo)\s*(\d{1,3})\s*(?:min|mins|minute|minutes|minit)/i, group: 1, unit: "min" },
  { pattern: /(\d{1,4})\s*(?:sec|secs|second|seconds)\s*(?:voice\s*|video\s*|phone\s*)?call/i, group: 1, unit: "sec" },
  { pattern: /(\d{1,3})\s*মিনিট\s*(?:কথা|কল)/, group: 1, unit: "min" },
  { pattern: /(?:কথা|কল)\s*(?:হয়েছে|হলো|হল)?\s*(\d{1,3})\s*মিনিট/, group: 1, unit: "min" },
];

export interface CallMention {
  kind: CallKind;
  /** Only when the message itself states how long the call was. */
  statedDurationSeconds: number | null;
}

/**
 * Bangla "য়" has two encodings (one code point, or য + nukta) and keyboards produce both, so text and
 * patterns are compared in one normal form.
 */
const nfc = (p: RegExp) => new RegExp(p.source.normalize("NFC"), p.flags);
const PHRASES_NFC = CALL_PHRASES.map(({ kind, patterns }) => ({ kind, patterns: patterns.map(nfc) }));
const DURATIONS_NFC = DURATION_PATTERNS.map((d) => ({ ...d, pattern: nfc(d.pattern) }));

export function detectCallMention(body: string): CallMention | null {
  const text = toAsciiDigits(body.normalize("NFC"));
  const hit = PHRASES_NFC.find(({ patterns }) => patterns.some((p) => p.test(text)));
  const durationHit = DURATIONS_NFC.map(({ pattern, group, unit }) => {
    const match = pattern.exec(text);
    return match ? Number(match[group]) * (unit === "min" ? 60 : 1) : null;
  }).find((v) => v !== null && v > 0);
  // A stated call duration is itself a mention of a call ("15 min call hoise"), even without a verb.
  if (!hit && durationHit === undefined) return null;
  return { kind: hit?.kind ?? "CALL_MENTIONED", statedDurationSeconds: durationHit ?? null };
}

/** A broad pre-filter for SQL (`~*`), so only candidate rows cross to the server process. */
export const CALL_SQL_PREFILTER = "(call|phone|কল|ফোন)";
