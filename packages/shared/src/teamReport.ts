import { formatDhakaDateKey, getDhakaWeekRange } from "./dhakaDay.js";
import type { IntelActor } from "./intelligence/model.js";
import {
  computeOvertimeWork,
  DEFAULT_OVERTIME_FALLBACK_DUTY_MINUTES,
  resolveRegularDuty,
  type OvertimeDay,
  type ResolvedDuty,
} from "./overtime.js";

/**
 * Team Report calculations — every figure on the Team Report page and in its exports comes from
 * `computeTeamReport`, and nowhere else. One pure function, so the page, the CSV and the Excel file
 * cannot disagree, and so each rule below is unit-tested rather than buried in SQL.
 *
 * THE RULES (also shown on the page's "How these numbers are calculated" help):
 *
 * Message kinds — decided by the caller from stored `Message` rows:
 *   CUSTOMER  an incoming group message from someone who is not a team member.
 *   MEMBER    an incoming group message from a team member (matched on WhatsApp id or digits-only
 *             phone, the same rule message processing uses). Carries `memberId`.
 *   BUSINESS  an outgoing message from our own number — an operator on the business phone or the
 *             inbox, a rule, or the AI. A reply, but not attributable to one person.
 *
 * Waits — the same definition as First Response on Team Performance:
 *   A customer message STARTS a wait when the message before it in that group was a reply (MEMBER or
 *   BUSINESS) or there was none. Four customer lines in a row are one wait, not four. The wait ends at
 *   the next reply in that group. Only waits that START inside the report period are counted.
 *   The reply that ends a wait may be AUTOMATED (AI, a rule): this is the "first observed response".
 *   Who sent it, and the separate human-only measure, are teamReportReliability.ts — beside these
 *   figures, never changing them.
 *   Messages before the period may be passed in as CONTEXT: they are never counted, but a customer
 *   line just after midnight that continues a wait begun before it is then not a second wait — so a
 *   month's waits are the sum of its days' (the loader passes the 4 hours before the period, plus
 *   each group's last message before that).
 *
 * Missed and Recall — never double-counted:
 *   threshold = the group's escalation-policy first alert if it has a priority, else the "missed
 *   after" setting. A wait answered within the threshold is ON_TIME. One answered after it is
 *   RECALLED: it was missed, then somebody came back to it. One never answered, and already older
 *   than the threshold, is MISSED (still unrecovered). One never answered but still inside the
 *   threshold is PENDING and counts as neither.
 *   Missed = RECALLED + MISSED. Recall is the part of Missed that was later answered.
 *
 * Attribution to a person:
 *   Replies, groups supported and duration belong to the member who sent the messages.
 *   A Recall belongs to the member whose reply closed the wait. A late reply from the business number
 *   or from a colleague the roster cannot name is counted in the total but belongs to no member row.
 *   In a Team or member report the two are independent: Missed counts the waits charged to someone
 *   in scope, Recall the late answers given by someone in scope — so Recall is not always a part of
 *   that report's Missed, though it always is in the whole-team report.
 *   A Missed wait belongs to the group's ASSIGNED team member AT THE MOMENT THE CUSTOMER ASKED — the
 *   only record of whose group it was — and to "Unassigned" when the group had none. Reassigning a
 *   group never moves misses that happened before (the threshold works the same way for a priority). So member totals of Missed only add up to the
 *   team total once the Unassigned row is included.
 *
 * Support Overtime (overtime.ts, TEAM_OVERTIME.md):
 *   Per member per Dhaka day, the support time below MINUS that day's regular duty (roster, weekly
 *   pattern, default shift, or the project's default duty length), never below zero; a period's
 *   overtime is the sum of its days. A day off, leave, a holiday or extra duty has no regular duty,
 *   so all of that day's support time is overtime. Duty is internal: no figure here states it.
 *
 * Support time (the duration overtime is measured from; shown only for groups):
 *   A member's messages across ALL groups form one timeline. A new stretch starts at their first
 *   message, after any silence longer than the idle gap (the "offline after" setting Team Performance
 *   uses), and at every Dhaka midnight. Duration = sum of (last message - first message) per stretch.
 *   One timeline rather than one per group, because answering two groups at once is one hour of
 *   work, not two. A stretch holding one message is zero seconds. Team duration = sum of members.
 *   A group row's duration uses the same rule over that group's member messages only, so group rows
 *   can add up to more than the team total when people work groups in parallel.
 *
 * Time: every day, week (Sunday start, as elsewhere in this app) and month is an Asia/Dhaka one.
 *
 * Scope — the whole team, one member, one Team (organisational group), or a member inside a Team:
 *   A scoped report asks "is this member in scope AT THIS MOMENT" for every message, so a person who
 *   moved from Support to Billing mid-month counts for Support up to the move and for Billing after
 *   it. In scope, a member's replies, groups and duration count; a Missed wait counts when the
 *   group's assigned member was in scope when the customer asked; a Recall counts when whoever
 *   answered late was in scope when they answered. Business-number replies belong to no person and
 *   are left out of every scoped report. Groups supported are the groups an in-scope member replied
 *   in. Customer messages, waits and the group rows cover those groups AND the groups whose assigned
 *   member was in scope when a customer asked there — the groups the scope is answerable for — so a
 *   member assigned to a group they never replied in sees that group and its waits beside the Missed
 *   charged to them, never "12 missed of 5 waits". Counted once per group, so two colleagues in one
 *   group do not double it. The unscoped (whole-team) report is unchanged by any of this.
 *
 * Staff replies credited to nobody (a colleague whose WhatsApp id and number point at two members, or
 *   a former member no longer on the roster) are counted in `unattributedStaffReplies`, so member rows
 *   adding up to less than the team total is explained rather than silent.
 */

export type ReportMessageKind = "CUSTOMER" | "MEMBER" | "BUSINESS";

export interface ReportMessage {
  /** The WhatsApp group this belongs to — one key per real group, whichever account stored it. */
  groupKey: string;
  /** Milliseconds since epoch. */
  ts: number;
  kind: ReportMessageKind;
  /** Set for MEMBER messages the roster could attribute; null otherwise. */
  memberId: string | null;
  /**
   * Who sent it, more finely than `kind` (Phase 2 reply provenance, teamReportReliability.ts): a
   * BUSINESS message as AI, RULE, BROADCAST, OPERATOR or BUSINESS_PHONE from the send it echoes.
   * Optional and never used for counting — every figure above is decided by `kind` alone.
   */
  actor?: IntelActor;
}

export type ReportGranularity = "day" | "week" | "month";
export type WaitStatus = "ON_TIME" | "RECALLED" | "MISSED" | "PENDING";
/** Who closed a wait: a member id, the business number, or nobody yet. */
export type WaitReplier = string | "BUSINESS" | null;

export interface ReportWait {
  groupKey: string;
  askedAt: number;
  repliedAt: number | null;
  repliedBy: WaitReplier;
  /** The closing reply's `actor`, when the caller classified it (present only then). */
  repliedByActor?: IntelActor;
  waitSeconds: number | null;
  thresholdSeconds: number;
  status: WaitStatus;
  /**
   * Who a Missed wait is charged to: the group's assignee when the customer asked (null = nobody was
   * assigned). Every report and export that names the owner of a wait reads it from here, so a group
   * reassigned later never moves it.
   */
  chargedTo: string | null;
}

export interface TeamReportOptions {
  rangeStart: number;
  rangeEnd: number;
  now: number;
  idleGapMs: number;
  /** The group's "missed" threshold when the customer asked (`at`); a priority set later does not reach back. */
  missedAfterMs: (groupKey: string, at?: number) => number;
  /** The group's assignee when the customer asked (`at`) — who a Missed wait is charged to. */
  assignedMemberFor: (groupKey: string, at?: number) => string | null;
  /** Null for the whole team; a member id for one person's report. */
  memberId: string | null;
  /**
   * Who is in scope at a given moment. Overrides `memberId` when given — the caller composes a Team
   * filter and a member filter into one predicate (see `inTeamAt`). Null or absent: `memberId` decides.
   */
  scope?: ((memberId: string, ts: number) => boolean) | null;
  granularity: ReportGranularity;
  /**
   * The member's regular duty on a Dhaka day (`resolveRegularDuty` over the roster, holidays, weekly
   * pattern and default shift). Absent: every day uses the default duty length.
   */
  dutyFor?: ((memberId: string, day: string) => ResolvedDuty) | null;
}

export interface MemberReportRow {
  /** A member id, or "UNASSIGNED" for missed waits in groups nobody is assigned to. */
  memberId: string;
  messages: number;
  groups: number;
  customerMessages: number;
  missed: number;
  recalled: number;
  unrecovered: number;
  /** Support time — what overtime is measured from. Internal to the overtime figure on this row. */
  activeSeconds: number;
  /** Support time beyond regular duty, summed per day. The figure the report shows. */
  overtimeSeconds: number;
  /** Days with work and no schedule at all, where the default duty length was used. */
  unscheduledDays: number;
  stretches: number;
  firstAt: number | null;
  lastAt: number | null;
}

export interface GroupReportRow {
  groupKey: string;
  memberIds: string[];
  totalMessages: number;
  customerMessages: number;
  memberReplies: number;
  businessReplies: number;
  waits: number;
  missed: number;
  recalled: number;
  unrecovered: number;
  activeSeconds: number;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
}

export interface BucketReportRow {
  key: string;
  groups: number;
  memberMessages: number;
  businessReplies: number;
  customerMessages: number;
  missed: number;
  recalled: number;
  activeSeconds: number;
  /** Overtime of the member-days in this bucket. */
  overtimeSeconds: number;
  /** Member-days in this bucket that had work and no schedule. */
  unscheduledMemberDays: number;
}

export interface TeamReportSummary {
  groupsSupported: number;
  customerMessages: number;
  memberReplies: number;
  businessReplies: number;
  waits: number;
  missed: number;
  recalled: number;
  unrecovered: number;
  activeSeconds: number;
  overtimeSeconds: number;
  /** Member-days with work and no schedule, where the default duty length was used. */
  unscheduledMemberDays: number;
  activeMembers: number;
  lastActivityAt: number | null;
  /**
   * Team-member replies in the period credited to no member (identifiers that conflict, or a sender
   * stamped staff who is no longer on the roster). Included in `memberReplies`; 0 in a scoped report.
   */
  unattributedStaffReplies: number;
}

export interface TeamReportResult {
  summary: TeamReportSummary;
  /** Every member with activity or attributed misses, plus UNASSIGNED when it has any. */
  members: MemberReportRow[];
  groups: GroupReportRow[];
  buckets: BucketReportRow[];
  /** Every wait that started in the period, oldest first — the audit trail behind Missed/Recall. */
  waits: ReportWait[];
  /** The waits behind the summary's Missed and Recall figures, in this report's scope. */
  countedMissedWaits: ReportWait[];
  /** Daily overtime per member in the period (in scope) — the breakdown behind every overtime figure. */
  overtimeDays: OvertimeDay[];
}

/** One stretch of a member belonging to a Team. Null start = since before Teams were recorded. */
export interface TeamMembershipInterval {
  memberId: string;
  teamId: string;
  startedAt: number | null;
  endedAt: number | null;
}

/** The Team filter value meaning "members who belong to no Team". */
export const NO_TEAM = "none";

const covers = (i: TeamMembershipInterval, ts: number) =>
  (i.startedAt === null || i.startedAt <= ts) && (i.endedAt === null || ts < i.endedAt);

/** Whether a member belonged to a Team (or, for NO_TEAM, to none) at a moment. */
export function inTeamAt(
  intervals: readonly TeamMembershipInterval[],
  memberId: string,
  teamId: string,
  ts: number,
): boolean {
  if (teamId === NO_TEAM) return !intervals.some((i) => i.memberId === memberId && covers(i, ts));
  return intervals.some((i) => i.memberId === memberId && i.teamId === teamId && covers(i, ts));
}

/**
 * The members who belonged to a Team at any moment in [start, end) — the Team Member dropdown for
 * that Team. For NO_TEAM: the members who were outside every Team at some moment in it.
 */
export function membersOfTeamDuring(
  intervals: readonly TeamMembershipInterval[],
  memberIds: readonly string[],
  teamId: string,
  start: number,
  end: number,
): string[] {
  const overlaps = (i: TeamMembershipInterval) =>
    (i.startedAt === null || i.startedAt < end) && (i.endedAt === null || i.endedAt > start);
  if (teamId !== NO_TEAM) {
    const inTeam = new Set(intervals.filter((i) => i.teamId === teamId && overlaps(i)).map((i) => i.memberId));
    return memberIds.filter((id) => inTeam.has(id));
  }
  return memberIds.filter((id) => {
    const own = intervals
      .filter((i) => i.memberId === id && overlaps(i))
      .sort((a, b) => (a.startedAt ?? -Infinity) - (b.startedAt ?? -Infinity));
    // Walk forward from the period start; any gap before the end is time outside every Team.
    let cursor = start;
    for (const interval of own) {
      if ((interval.startedAt ?? -Infinity) > cursor) return true;
      cursor = Math.max(cursor, interval.endedAt ?? Infinity);
      if (cursor >= end) return false;
    }
    return cursor < end;
  });
}

export const UNASSIGNED = "UNASSIGNED";
const DAY_MS = 86_400_000;

/** The bucket a moment falls in, as a stable sortable key. */
export function bucketKeyFor(ts: number, granularity: ReportGranularity): string {
  const when = new Date(ts);
  if (granularity === "day") return formatDhakaDateKey(when);
  if (granularity === "week") return formatDhakaDateKey(getDhakaWeekRange(when).start);
  return formatDhakaDateKey(when).slice(0, 7);
}

/** Every bucket key the period touches, so empty days still appear (a gap is information). */
export function bucketKeysForRange(rangeStart: number, rangeEnd: number, granularity: ReportGranularity): string[] {
  const keys: string[] = [];
  for (let ts = rangeStart; ts < rangeEnd; ts += DAY_MS) {
    const key = bucketKeyFor(ts, granularity);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

interface Stretch {
  start: number;
  end: number;
}

/** Splits one person's (or one group's) sorted timestamps into stretches. The support time overtime is measured from (TEAM_OVERTIME.md §3). */
export function splitIntoStretches(sortedTs: readonly number[], idleGapMs: number): Stretch[] {
  const stretches: Stretch[] = [];
  let current: Stretch | null = null;
  let currentDay = "";
  for (const ts of sortedTs) {
    const day = formatDhakaDateKey(new Date(ts));
    if (!current || ts - current.end > idleGapMs || day !== currentDay) {
      current = { start: ts, end: ts };
      currentDay = day;
      stretches.push(current);
    } else {
      current.end = ts;
    }
  }
  return stretches;
}

const stretchSeconds = (stretches: readonly Stretch[]) =>
  stretches.reduce((sum, s) => sum + Math.round((s.end - s.start) / 1000), 0);

export function computeTeamReport(messages: readonly ReportMessage[], opts: TeamReportOptions): TeamReportResult {
  const inRange = (ts: number) => ts >= opts.rangeStart && ts < opts.rangeEnd;
  const isReply = (m: ReportMessage) => m.kind !== "CUSTOMER";

  // Group by WhatsApp group, each oldest first. The sort is stable, so same-second messages keep
  // the order the caller supplied — which is the stored order.
  const byGroup = new Map<string, ReportMessage[]>();
  for (const message of messages) {
    const list = byGroup.get(message.groupKey);
    if (list) list.push(message);
    else byGroup.set(message.groupKey, [message]);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.ts - b.ts);

  // ---- Waits ----
  const waits: ReportWait[] = [];
  for (const [groupKey, list] of byGroup) {
    // Next reply index for every position, from a single backward pass.
    const nextReply: number[] = new Array(list.length).fill(-1);
    let seen = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      nextReply[i] = seen;
      if (isReply(list[i]!)) seen = i;
    }
    for (let i = 0; i < list.length; i++) {
      const message = list[i]!;
      if (message.kind !== "CUSTOMER" || !inRange(message.ts)) continue;
      const previous = list[i - 1];
      if (previous && previous.kind === "CUSTOMER") continue; // continues a wait already open
      const replyIndex = nextReply[i]!;
      const reply = replyIndex >= 0 ? list[replyIndex]! : null;
      const thresholdMs = opts.missedAfterMs(groupKey, message.ts);
      const waitMs = reply ? reply.ts - message.ts : null;
      const status: WaitStatus = reply
        ? waitMs! <= thresholdMs
          ? "ON_TIME"
          : "RECALLED"
        : opts.now - message.ts > thresholdMs
          ? "MISSED"
          : "PENDING";
      waits.push({
        groupKey,
        askedAt: message.ts,
        repliedAt: reply?.ts ?? null,
        repliedBy: reply ? (reply.kind === "BUSINESS" ? "BUSINESS" : reply.memberId) : null,
        ...(reply?.actor ? { repliedByActor: reply.actor } : {}),
        waitSeconds: waitMs === null ? null : Math.round(waitMs / 1000),
        thresholdSeconds: Math.round(thresholdMs / 1000),
        status,
        chargedTo: opts.assignedMemberFor(groupKey, message.ts),
      });
    }
  }
  waits.sort((a, b) => a.askedAt - b.askedAt);

  // ---- Per-member activity ----
  interface MemberAcc {
    ts: number[];
    groups: Set<string>;
    byGroup: Map<string, number[]>;
  }
  const memberAcc = new Map<string, MemberAcc>();
  for (const message of messages) {
    if (message.kind !== "MEMBER" || !message.memberId || !inRange(message.ts)) continue;
    let acc = memberAcc.get(message.memberId);
    if (!acc) {
      acc = { ts: [], groups: new Set(), byGroup: new Map() };
      memberAcc.set(message.memberId, acc);
    }
    acc.ts.push(message.ts);
    acc.groups.add(message.groupKey);
    const perGroup = acc.byGroup.get(message.groupKey);
    if (perGroup) perGroup.push(message.ts);
    else acc.byGroup.set(message.groupKey, [message.ts]);
  }
  for (const acc of memberAcc.values()) {
    acc.ts.sort((a, b) => a - b);
    for (const list of acc.byGroup.values()) list.sort((a, b) => a - b);
  }

  const customerInRangeByGroup = new Map<string, number>();
  for (const message of messages) {
    if (message.kind === "CUSTOMER" && inRange(message.ts)) {
      customerInRangeByGroup.set(message.groupKey, (customerInRangeByGroup.get(message.groupKey) ?? 0) + 1);
    }
  }

  const isMissed = (w: ReportWait) => w.status === "RECALLED" || w.status === "MISSED";
  const missOwner = (w: ReportWait) => w.chargedTo ?? UNASSIGNED;

  const memberRows = new Map<string, MemberReportRow>();
  const rowFor = (memberId: string): MemberReportRow => {
    let row = memberRows.get(memberId);
    if (!row) {
      row = {
        memberId,
        messages: 0,
        groups: 0,
        customerMessages: 0,
        missed: 0,
        recalled: 0,
        unrecovered: 0,
        activeSeconds: 0,
        overtimeSeconds: 0,
        unscheduledDays: 0,
        stretches: 0,
        firstAt: null,
        lastAt: null,
      };
      memberRows.set(memberId, row);
    }
    return row;
  };
  for (const [memberId, acc] of memberAcc) {
    const row = rowFor(memberId);
    const stretches = splitIntoStretches(acc.ts, opts.idleGapMs);
    row.messages = acc.ts.length;
    row.groups = acc.groups.size;
    row.customerMessages = [...acc.groups].reduce((sum, g) => sum + (customerInRangeByGroup.get(g) ?? 0), 0);
    row.activeSeconds = stretchSeconds(stretches);
    row.stretches = stretches.length;
    row.firstAt = acc.ts[0] ?? null;
    row.lastAt = acc.ts[acc.ts.length - 1] ?? null;
  }
  for (const wait of waits) {
    if (isMissed(wait)) {
      const owner = rowFor(missOwner(wait));
      owner.missed += 1;
      if (wait.status === "MISSED") owner.unrecovered += 1;
    }
    if (wait.status === "RECALLED" && wait.repliedBy && wait.repliedBy !== "BUSINESS") {
      rowFor(wait.repliedBy).recalled += 1;
    }
  }

  // ---- Scope: the whole team, one member, a Team, or a member within a Team ----
  const inScope: ((memberId: string, ts: number) => boolean) | null =
    opts.scope ?? (opts.memberId ? (memberId: string) => memberId === opts.memberId : null);
  const scoped = inScope !== null;
  const memberInScope = (m: ReportMessage) => m.kind === "MEMBER" && m.memberId !== null && inScope!(m.memberId, m.ts);
  // The in-scope part of each member's activity. For one member this is exactly their own.
  const scopedAcc = new Map<string, { ts: number[]; groups: Set<string> }>();
  if (inScope) {
    for (const [memberId, acc] of memberAcc) {
      const ts = acc.ts.filter((t) => inScope(memberId, t));
      if (ts.length === 0) continue;
      const groups = new Set<string>();
      for (const [groupKey, list] of acc.byGroup) if (list.some((t) => inScope(memberId, t))) groups.add(groupKey);
      scopedAcc.set(memberId, { ts, groups });
    }
  }
  const scopeGroups = scoped ? new Set([...scopedAcc.values()].flatMap((a) => [...a.groups])) : null;
  const waitInScopeForMissed = (w: ReportWait) => {
    if (!inScope) return true;
    return w.chargedTo !== null && inScope(w.chargedTo, w.askedAt);
  };
  const waitInScopeForRecall = (w: ReportWait) =>
    !inScope ||
    (w.repliedBy !== null && w.repliedBy !== "BUSINESS" && w.repliedAt !== null && inScope(w.repliedBy, w.repliedAt));
  // The groups a scoped report is answerable for: where its members replied, where its member was the
  // assignee when a customer asked, and where its member gave a late answer (a Recall it is credited
  // with, even if that reply fell in the look-ahead). Waits, customer messages and group rows use these.
  const responsibleGroups = scopeGroups
    ? new Set([
        ...scopeGroups,
        ...waits.filter(waitInScopeForMissed).map((w) => w.groupKey),
        ...waits.filter((w) => w.status === "RECALLED" && waitInScopeForRecall(w)).map((w) => w.groupKey),
      ])
    : null;

  // Member rows as the scope sees them: in-scope activity, misses charged while in scope.
  const scopedRows = new Map<string, MemberReportRow>();
  const scopedRowFor = (memberId: string): MemberReportRow => {
    let row = scopedRows.get(memberId);
    if (!row) {
      row = {
        memberId,
        messages: 0,
        groups: 0,
        customerMessages: 0,
        missed: 0,
        recalled: 0,
        unrecovered: 0,
        activeSeconds: 0,
        overtimeSeconds: 0,
        unscheduledDays: 0,
        stretches: 0,
        firstAt: null,
        lastAt: null,
      };
      scopedRows.set(memberId, row);
    }
    return row;
  };
  if (scoped) {
    // The groups each member is answerable for in scope: replied in, or charged a wait in.
    const chargedGroups = new Map<string, Set<string>>();
    for (const wait of waits) {
      if (!wait.chargedTo || !waitInScopeForMissed(wait)) continue;
      const set = chargedGroups.get(wait.chargedTo) ?? new Set<string>();
      set.add(wait.groupKey);
      chargedGroups.set(wait.chargedTo, set);
    }
    for (const [memberId, acc] of scopedAcc) {
      const row = scopedRowFor(memberId);
      const stretches = splitIntoStretches(acc.ts, opts.idleGapMs);
      row.messages = acc.ts.length;
      row.groups = acc.groups.size;
      const answerable = new Set([...acc.groups, ...(chargedGroups.get(memberId) ?? [])]);
      row.customerMessages = [...answerable].reduce((sum, g) => sum + (customerInRangeByGroup.get(g) ?? 0), 0);
      row.activeSeconds = stretchSeconds(stretches);
      row.stretches = stretches.length;
      row.firstAt = acc.ts[0] ?? null;
      row.lastAt = acc.ts[acc.ts.length - 1] ?? null;
    }
    for (const wait of waits) {
      if (isMissed(wait) && waitInScopeForMissed(wait)) {
        const owner = scopedRowFor(wait.chargedTo!);
        owner.missed += 1;
        if (wait.status === "MISSED") owner.unrecovered += 1;
      }
      if (wait.status === "RECALLED" && waitInScopeForRecall(wait)) scopedRowFor(wait.repliedBy!).recalled += 1;
    }
  }

  // ---- Per-group rows ----
  const waitsByGroup = new Map<string, ReportWait[]>();
  for (const wait of waits) {
    const list = waitsByGroup.get(wait.groupKey);
    if (list) list.push(wait);
    else waitsByGroup.set(wait.groupKey, [wait]);
  }
  const groupRows: GroupReportRow[] = [];
  for (const [groupKey, list] of byGroup) {
    if (responsibleGroups && !responsibleGroups.has(groupKey)) continue;
    const ranged = list.filter((m) => inRange(m.ts));
    if (ranged.length === 0) continue;
    const memberMsgs = ranged.filter((m) => m.kind === "MEMBER" && (!scoped || memberInScope(m)));
    const groupWaits = waitsByGroup.get(groupKey) ?? [];
    const activityTs = (scoped ? memberMsgs : ranged.filter(isReply)).map((m) => m.ts);
    groupRows.push({
      groupKey,
      // In a scoped report, only the people in scope (the others' replies are not this report's).
      memberIds: [...new Set((scoped ? memberMsgs : ranged.filter((m) => m.kind === "MEMBER")).filter((m) => m.memberId).map((m) => m.memberId!))],
      totalMessages: ranged.length,
      customerMessages: ranged.filter((m) => m.kind === "CUSTOMER").length,
      memberReplies: memberMsgs.length,
      businessReplies: scoped ? 0 : ranged.filter((m) => m.kind === "BUSINESS").length,
      waits: groupWaits.length,
      // The same predicates as the summary, so a scoped report's group rows add up to its headline:
      // Missed charged to whoever owned the group then, Recall credited to whoever answered late.
      missed: groupWaits.filter((w) => isMissed(w) && waitInScopeForMissed(w)).length,
      recalled: groupWaits.filter((w) => w.status === "RECALLED" && waitInScopeForRecall(w)).length,
      unrecovered: groupWaits.filter((w) => w.status === "MISSED" && waitInScopeForMissed(w)).length,
      activeSeconds: stretchSeconds(splitIntoStretches(memberMsgs.map((m) => m.ts), opts.idleGapMs)),
      firstActivityAt: activityTs[0] ?? null,
      lastActivityAt: activityTs[activityTs.length - 1] ?? null,
    });
  }
  groupRows.sort((a, b) => b.totalMessages - a.totalMessages || a.groupKey.localeCompare(b.groupKey));

  // ---- Buckets (day / week / month) ----
  const buckets = new Map<string, BucketReportRow & { groupSet: Set<string> }>();
  for (const key of bucketKeysForRange(opts.rangeStart, opts.rangeEnd, opts.granularity)) {
    buckets.set(key, {
      key,
      groups: 0,
      memberMessages: 0,
      businessReplies: 0,
      customerMessages: 0,
      missed: 0,
      recalled: 0,
      activeSeconds: 0,
      overtimeSeconds: 0,
      unscheduledMemberDays: 0,
      groupSet: new Set(),
    });
  }
  const bucket = (ts: number) => buckets.get(bucketKeyFor(ts, opts.granularity));
  for (const message of messages) {
    if (!inRange(message.ts)) continue;
    const b = bucket(message.ts);
    if (!b) continue;
    if (message.kind === "CUSTOMER") {
      if (!responsibleGroups || responsibleGroups.has(message.groupKey)) b.customerMessages += 1;
    } else if (message.kind === "MEMBER") {
      if (!scoped || memberInScope(message)) {
        b.memberMessages += 1;
        b.groupSet.add(message.groupKey);
      }
    } else if (!scoped) {
      b.businessReplies += 1;
      b.groupSet.add(message.groupKey);
    }
  }
  for (const wait of waits) {
    const b = bucket(wait.askedAt);
    if (!b) continue;
    if (isMissed(wait) && waitInScopeForMissed(wait)) b.missed += 1;
    if (wait.status === "RECALLED" && waitInScopeForRecall(wait)) b.recalled += 1;
  }
  const timelines = scoped ? scopedAcc : memberAcc;
  for (const acc of timelines.values()) {
    for (const stretch of splitIntoStretches(acc.ts, opts.idleGapMs)) {
      const b = bucket(stretch.start);
      if (b) b.activeSeconds += Math.round((stretch.end - stretch.start) / 1000);
    }
  }

  // ---- Overtime: per member per day, then summed (overtime.ts) ----
  const fallbackDuty = resolveRegularDuty({
    assignment: null,
    isHoliday: false,
    pattern: null,
    defaultShift: null,
    fallbackMinutes: DEFAULT_OVERTIME_FALLBACK_DUTY_MINUTES,
  });
  const dutyFor = opts.dutyFor ?? (() => fallbackDuty);
  const firstDay = formatDhakaDateKey(new Date(opts.rangeStart));
  const lastDay = formatDhakaDateKey(new Date(opts.rangeEnd - 1));
  // Overtime is a fact about a member's WHOLE day: their day's work beyond their day's duty. A scoped
  // report takes its share — the day's overtime times the part of the day's work done in scope — so
  // somebody who moved Team at 14:00 keeps their overtime, split between the two Teams, instead of
  // each half being measured against a full day's duty and the overtime disappearing.
  const stretchesOf = (accs: Map<string, { ts: number[] }>) =>
    new Map([...accs].map(([memberId, acc]) => [memberId, splitIntoStretches(acc.ts, opts.idleGapMs)]));
  // Only the period's own days: work after midnight inside a shift that began the day before the
  // period belongs to that earlier day, which this report does not cover.
  const inPeriodDays = (d: OvertimeDay) => d.day >= firstDay && d.day <= lastDay;
  const fullDays = computeOvertimeWork(stretchesOf(memberAcc), dutyFor).filter(inPeriodDays);
  let overtimeDays: Array<OvertimeDay & { workedSeconds: number }> = fullDays;
  if (scoped) {
    // The scope's part of each member-day: every interval between two of their messages inside one
    // work stretch belongs to whoever they were (in scope or not) at its start, so the parts of one
    // day over complementary scopes add up to the whole day and the overtime is never lost. (A
    // one-message stretch is zero seconds, so it carries no overtime either way.)
    const part = new Map<string, { inScope: number; total: number }>();
    for (const [memberId, acc] of memberAcc) {
      for (const stretch of splitIntoStretches(acc.ts, opts.idleGapMs)) {
        const points = acc.ts.filter((t) => t >= stretch.start && t <= stretch.end);
        const k = `${memberId}|${formatDhakaDateKey(new Date(stretch.start))}`;
        const entry = part.get(k) ?? { inScope: 0, total: 0 };
        for (let i = 0; i + 1 < points.length; i++) {
          const seconds = (points[i + 1]! - points[i]!) / 1000;
          entry.total += seconds;
          if (inScope!(memberId, points[i]!)) entry.inScope += seconds;
        }
        part.set(k, entry);
      }
    }
    const scopedWorked = new Map(
      computeOvertimeWork(stretchesOf(scopedAcc), dutyFor).map((d) => [`${d.memberId}|${d.day}`, d.workedSeconds]),
    );
    overtimeDays = fullDays
      .filter((d) => scopedAcc.has(d.memberId) && (scopedWorked.has(`${d.memberId}|${d.day}`) || (part.get(`${d.memberId}|${d.day}`)?.inScope ?? 0) > 0))
      .map((d) => {
        const p = part.get(`${d.memberId}|${d.day}`);
        const share = p && p.total > 0 ? Math.min(1, p.inScope / p.total) : 0;
        return { ...d, overtimeSeconds: Math.round(d.overtimeSeconds * share), workedSeconds: scopedWorked.get(`${d.memberId}|${d.day}`) ?? 0 };
      });
  }
  const overtimeRows = scoped ? scopedRows : memberRows;
  for (const d of overtimeDays) {
    const row = overtimeRows.get(d.memberId);
    if (row) {
      row.overtimeSeconds += d.overtimeSeconds;
      if (d.source === "FALLBACK") row.unscheduledDays += 1;
    }
    const b = buckets.get(bucketKeyFor(Date.parse(`${d.day}T06:00:00Z`), opts.granularity));
    if (b) {
      b.overtimeSeconds += d.overtimeSeconds;
      if (d.source === "FALLBACK") b.unscheduledMemberDays += 1;
    }
  }
  const overtimeTotal = overtimeDays.reduce((sum, d) => sum + d.overtimeSeconds, 0);
  const unscheduledTotal = overtimeDays.filter((d) => d.source === "FALLBACK").length;
  const bucketRows: BucketReportRow[] = [...buckets.values()].map(({ groupSet, ...row }) => ({
    ...row,
    groups: groupSet.size,
  }));

  // ---- Summary ----
  const scopedMemberRows = [...scopedRows.values()];
  // A scoped report's "waits" are the waits in the groups it is answerable for.
  const inScopeWaits = responsibleGroups ? waits.filter((w) => responsibleGroups.has(w.groupKey)) : waits;
  const latest = (rows: readonly MemberReportRow[]) =>
    rows
      .filter((r) => r.memberId !== UNASSIGNED)
      .reduce<number | null>((max, r) => (r.lastAt !== null && (max === null || r.lastAt > max) ? r.lastAt : max), null);
  const allReplyGroups = new Set(
    messages.filter((m) => inRange(m.ts) && isReply(m)).map((m) => m.groupKey),
  );

  const summary: TeamReportSummary = scopeGroups && responsibleGroups
    ? {
        groupsSupported: scopeGroups.size,
        customerMessages: [...responsibleGroups].reduce((sum, g) => sum + (customerInRangeByGroup.get(g) ?? 0), 0),
        memberReplies: [...scopedAcc.values()].reduce((sum, a) => sum + a.ts.length, 0),
        businessReplies: 0,
        waits: inScopeWaits.length,
        missed: waits.filter((w) => isMissed(w) && waitInScopeForMissed(w)).length,
        recalled: waits.filter((w) => w.status === "RECALLED" && waitInScopeForRecall(w)).length,
        unrecovered: waits.filter((w) => w.status === "MISSED" && waitInScopeForMissed(w)).length,
        activeSeconds: scopedMemberRows.reduce((sum, r) => sum + r.activeSeconds, 0),
        overtimeSeconds: overtimeTotal,
        unscheduledMemberDays: unscheduledTotal,
        activeMembers: scopedAcc.size,
        lastActivityAt: latest(scopedMemberRows),
        unattributedStaffReplies: 0,
      }
    : {
        groupsSupported: allReplyGroups.size,
        customerMessages: [...customerInRangeByGroup.values()].reduce((a, b) => a + b, 0),
        memberReplies: messages.filter((m) => m.kind === "MEMBER" && inRange(m.ts)).length,
        businessReplies: messages.filter((m) => m.kind === "BUSINESS" && inRange(m.ts)).length,
        waits: waits.length,
        missed: waits.filter(isMissed).length,
        recalled: waits.filter((w) => w.status === "RECALLED").length,
        unrecovered: waits.filter((w) => w.status === "MISSED").length,
        activeSeconds: [...memberRows.values()].reduce((sum, r) => sum + r.activeSeconds, 0),
        overtimeSeconds: overtimeTotal,
        unscheduledMemberDays: unscheduledTotal,
        activeMembers: memberAcc.size,
        lastActivityAt: latest([...memberRows.values()]),
        unattributedStaffReplies: messages.filter((m) => m.kind === "MEMBER" && m.memberId === null && inRange(m.ts)).length,
      };

  const members = (scoped ? scopedMemberRows : [...memberRows.values()]).sort(
    (a, b) =>
      Number(a.memberId === UNASSIGNED) - Number(b.memberId === UNASSIGNED) ||
      b.messages - a.messages ||
      a.memberId.localeCompare(b.memberId),
  );

  const countedMissedWaits = waits.filter(
    (w) => (isMissed(w) && waitInScopeForMissed(w)) || (w.status === "RECALLED" && waitInScopeForRecall(w)),
  );

  return {
    summary,
    members,
    groups: groupRows,
    buckets: bucketRows,
    waits,
    countedMissedWaits,
    overtimeDays: overtimeDays.map(({ workedSeconds: _worked, ...day }) => day),
  };
}
