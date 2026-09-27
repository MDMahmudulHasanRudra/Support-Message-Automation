import { formatDhakaDateKey, getDhakaWeekRange } from "./dhakaDay.js";

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
 *   A Recall belongs to the member whose reply closed the wait (the business number, if it was that).
 *   A Missed wait belongs to the group's ASSIGNED team member — the only record of whose group it
 *   is — and to "Unassigned" when the group has none. So member totals of Missed only add up to the
 *   team total once the Unassigned row is included.
 *
 * Support duration:
 *   A member's messages across ALL groups form one timeline. A new stretch starts at their first
 *   message, after any silence longer than the idle gap (the "offline after" setting Team Performance
 *   uses), and at every Dhaka midnight. Duration = sum of (last message - first message) per stretch.
 *   One timeline rather than one per group, because answering two groups at once is one hour of
 *   work, not two. A stretch holding one message is zero seconds. Team duration = sum of members.
 *   A group row's duration uses the same rule over that group's member messages only, so group rows
 *   can add up to more than the team total when people work groups in parallel.
 *
 * Time: every day, week (Sunday start, as elsewhere in this app) and month is an Asia/Dhaka one.
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
  waitSeconds: number | null;
  thresholdSeconds: number;
  status: WaitStatus;
}

export interface TeamReportOptions {
  rangeStart: number;
  rangeEnd: number;
  now: number;
  idleGapMs: number;
  missedAfterMs: (groupKey: string) => number;
  assignedMemberFor: (groupKey: string) => string | null;
  /** Null for the whole team; a member id for one person's report. */
  memberId: string | null;
  granularity: ReportGranularity;
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
  activeSeconds: number;
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
  activeMembers: number;
  lastActivityAt: number | null;
}

export interface TeamReportResult {
  summary: TeamReportSummary;
  /** Every member with activity or attributed misses, plus UNASSIGNED when it has any. */
  members: MemberReportRow[];
  groups: GroupReportRow[];
  buckets: BucketReportRow[];
  /** Every wait that started in the period, oldest first — the audit trail behind Missed/Recall. */
  waits: ReportWait[];
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

/** Splits one person's (or one group's) sorted timestamps into stretches. See "Support duration". */
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
    const thresholdMs = opts.missedAfterMs(groupKey);
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
        waitSeconds: waitMs === null ? null : Math.round(waitMs / 1000),
        thresholdSeconds: Math.round(thresholdMs / 1000),
        status,
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
  const missOwner = (w: ReportWait) => opts.assignedMemberFor(w.groupKey) ?? UNASSIGNED;

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

  // ---- Scope: the whole team, or one member ----
  const scoped = opts.memberId;
  const scopeGroups = scoped ? (memberAcc.get(scoped)?.groups ?? new Set<string>()) : null;
  const waitInScopeForMissed = (w: ReportWait) => !scoped || opts.assignedMemberFor(w.groupKey) === scoped;
  const waitInScopeForRecall = (w: ReportWait) => !scoped || w.repliedBy === scoped;

  // ---- Per-group rows ----
  const waitsByGroup = new Map<string, ReportWait[]>();
  for (const wait of waits) {
    const list = waitsByGroup.get(wait.groupKey);
    if (list) list.push(wait);
    else waitsByGroup.set(wait.groupKey, [wait]);
  }
  const groupRows: GroupReportRow[] = [];
  for (const [groupKey, list] of byGroup) {
    if (scopeGroups && !scopeGroups.has(groupKey)) continue;
    const ranged = list.filter((m) => inRange(m.ts));
    if (ranged.length === 0) continue;
    const memberMsgs = ranged.filter((m) => m.kind === "MEMBER" && (!scoped || m.memberId === scoped));
    const groupWaits = waitsByGroup.get(groupKey) ?? [];
    const activityTs = (scoped ? memberMsgs : ranged.filter(isReply)).map((m) => m.ts);
    groupRows.push({
      groupKey,
      memberIds: [...new Set(ranged.filter((m) => m.kind === "MEMBER" && m.memberId).map((m) => m.memberId!))],
      totalMessages: ranged.length,
      customerMessages: ranged.filter((m) => m.kind === "CUSTOMER").length,
      memberReplies: memberMsgs.length,
      businessReplies: scoped ? 0 : ranged.filter((m) => m.kind === "BUSINESS").length,
      waits: groupWaits.length,
      missed: groupWaits.filter(isMissed).length,
      recalled: groupWaits.filter((w) => w.status === "RECALLED").length,
      unrecovered: groupWaits.filter((w) => w.status === "MISSED").length,
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
      groupSet: new Set(),
    });
  }
  const bucket = (ts: number) => buckets.get(bucketKeyFor(ts, opts.granularity));
  for (const message of messages) {
    if (!inRange(message.ts)) continue;
    const b = bucket(message.ts);
    if (!b) continue;
    if (message.kind === "CUSTOMER") {
      if (!scopeGroups || scopeGroups.has(message.groupKey)) b.customerMessages += 1;
    } else if (message.kind === "MEMBER") {
      if (!scoped || message.memberId === scoped) {
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
  const scopedMembers = scoped ? [scoped] : [...memberAcc.keys()];
  for (const memberId of scopedMembers) {
    const acc = memberAcc.get(memberId);
    if (!acc) continue;
    for (const stretch of splitIntoStretches(acc.ts, opts.idleGapMs)) {
      const b = bucket(stretch.start);
      if (b) b.activeSeconds += Math.round((stretch.end - stretch.start) / 1000);
    }
  }
  const bucketRows: BucketReportRow[] = [...buckets.values()].map(({ groupSet, ...row }) => ({
    ...row,
    groups: groupSet.size,
  }));

  // ---- Summary ----
  const scopedMemberRows = scoped ? [memberRows.get(scoped)].filter(Boolean) as MemberReportRow[] : [...memberRows.values()];
  // One member's "waits" are the waits in the groups they supported — the conversations they were in.
  const inScopeWaits = scoped ? waits.filter((w) => scopeGroups!.has(w.groupKey)) : waits;
  const lastActivity = scopedMemberRows
    .filter((r) => r.memberId !== UNASSIGNED)
    .reduce<number | null>((latest, r) => (r.lastAt !== null && (latest === null || r.lastAt > latest) ? r.lastAt : latest), null);
  const allReplyGroups = new Set(
    messages.filter((m) => inRange(m.ts) && isReply(m)).map((m) => m.groupKey),
  );

  const summary: TeamReportSummary = scoped
    ? {
        groupsSupported: scopeGroups!.size,
        customerMessages: memberRows.get(scoped)?.customerMessages ?? 0,
        memberReplies: memberRows.get(scoped)?.messages ?? 0,
        businessReplies: 0,
        waits: inScopeWaits.length,
        missed: waits.filter((w) => isMissed(w) && waitInScopeForMissed(w)).length,
        recalled: waits.filter((w) => w.status === "RECALLED" && waitInScopeForRecall(w)).length,
        unrecovered: waits.filter((w) => w.status === "MISSED" && waitInScopeForMissed(w)).length,
        activeSeconds: memberRows.get(scoped)?.activeSeconds ?? 0,
        activeMembers: memberAcc.has(scoped) ? 1 : 0,
        lastActivityAt: memberRows.get(scoped)?.lastAt ?? null,
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
        activeMembers: memberAcc.size,
        lastActivityAt: lastActivity,
      };

  const members = (scoped ? scopedMemberRows : [...memberRows.values()]).sort(
    (a, b) =>
      Number(a.memberId === UNASSIGNED) - Number(b.memberId === UNASSIGNED) ||
      b.messages - a.messages ||
      a.memberId.localeCompare(b.memberId),
  );

  return { summary, members, groups: groupRows, buckets: bucketRows, waits };
}
