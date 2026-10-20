import { humanWaits, type HumanWait, type IntelActor, type IntelMessage } from "../intelligence/model.js";
import { median, responseStats } from "../supportReports.js";
import { bucketKeyFor, bucketKeysForRange, computeTeamReport, type ReportGranularity, type ReportMessage, type ReportWait } from "../teamReport.js";
import { computeResponseMetrics, type ResponseMetrics } from "../teamReportReliability.js";

/**
 * The personal-chat (one-to-one) side of the unified Team Report (05-group-and-personal-reporting-spec
 * §2, 06-algorithms §4). Pure: the loader classifies each message ONCE through the one identity rule and
 * hands it over; nothing here decides who sent anything.
 *
 * No new wait logic. The wait is the Team Report's own — `computeTeamReport` is called unchanged with
 * the conversation as the "group" — and the human-only wait is Human Response SLA's `humanWaits`. Everything
 * else is counting. A personal conversation is one account's chat with one id (`accountId|chatId`), so the
 * same customer writing to two of our numbers is two conversations.
 *
 * Only the dashboard can be credited with a personal reply: a roster member writing to the business number
 * from their own phone makes the chat INTERNAL (excluded by the loader), so the one verified-employee
 * reply here is an OPERATOR message — a dashboard reply by a login linked to a member.
 */

export interface PersonalReportMessage {
  /** `${accountId}|${chatId}` */
  conversationKey: string;
  accountId: string;
  chatId: string;
  /** `logicalMessageKey(chatId, wamid)` */
  key: string;
  ts: number;
  kind: "CUSTOMER" | "MEMBER" | "BUSINESS";
  actor: IntelActor;
  memberId: string | null;
  operatorUserId: string | null;
  sender: string;
  /** The pre-filtered body (closing-remark detection only), server-side. Never exported. */
  text: string | null;
}

export interface PersonalReportOptions {
  rangeStart: number;
  rangeEnd: number;
  now: number;
  measuredTo: number;
  /** `SupportActivitySettings.missedReplyAfterMinutes` in ms: personal chats have no priority or escalation policy. */
  missedAfterMs: number;
  granularity: ReportGranularity;
  /** Team / member scope, the group report's own predicate shape; null = everyone. */
  scope: ((memberId: string, ts: number) => boolean) | null;
  /** Conversations left out before counting (own number, internal) — decided by the loader. */
  excluded: ReadonlyMap<string, "OWN_NUMBER" | "INTERNAL">;
  /** conversationKey -> time of the newest stored message before the context window. */
  earlierMessageAt: ReadonlyMap<string, number>;
}

export interface PersonalConversationRow {
  conversationKey: string;
  accountId: string;
  chatId: string;
  customerMessages: number;
  businessReplies: number;
  verifiedEmployeeReplies: number;
  automatedReplies: number;
  waits: number;
  missed: number;
  recalled: number;
  unrecovered: number;
  firstObservedMedianSeconds: number | null;
  waiting: boolean;
  isNew: boolean;
  firstAt: number | null;
  lastAt: number | null;
  employeeIds: string[];
}

export interface PersonalReportSummary {
  conversations: number;
  customerConversations: number;
  newConversations: number;
  customerMessages: number;
  /** Every non-customer message: the business number's and a linked login's dashboard replies. */
  businessReplies: number;
  verifiedEmployeeReplies: number;
  unlinkedOperatorReplies: number;
  automatedReplies: { ai: number; rule: number };
  businessPhoneReplies: number;
  broadcastMessages: number;
  waits: number;
  missed: number;
  recalled: number;
  unrecovered: number;
  pending: number;
  waitingConversations: number;
  /** Conversations left out, counted when they had a message in the period. */
  excluded: { ownNumber: number; internal: number };
}

export interface PersonalMemberRow {
  memberId: string;
  verifiedReplies: number;
  conversations: number;
  humanWaitsAnswered: number;
  medianSeconds: number | null;
}

export interface PersonalBucketRow {
  key: string;
  customerMessages: number;
  businessReplies: number;
  verifiedEmployeeReplies: number;
  waits: number;
  missed: number;
  recalled: number;
}

export interface PersonalReportResult {
  summary: PersonalReportSummary;
  /** `computeResponseMetrics(waits, humanWaits)` — reused as is. */
  response: ResponseMetrics;
  /** Human waits ended by a dashboard reply from a login linked to a (in-scope) member. */
  employeeAnsweredHumanWaits: number;
  conversations: PersonalConversationRow[];
  buckets: PersonalBucketRow[];
  members: PersonalMemberRow[];
  /** `groupKey` is the conversation key. */
  waits: ReportWait[];
  humanWaits: HumanWait[];
}

/** `computeTeamReport` needs an idle gap; none of what personal reads from it (waits) depends on it. */
const UNUSED_IDLE_GAP_MS = 120 * 60_000;

const isEmployeeReply = (m: { actor: IntelActor; memberId: string | null }) => m.actor === "OPERATOR" && m.memberId !== null;

export function computePersonalReport(messages: readonly PersonalReportMessage[], opts: PersonalReportOptions): PersonalReportResult {
  const inRange = (ts: number) => ts >= opts.rangeStart && ts < opts.rangeEnd;

  // ---- Exclusions: own numbers' chats and chats with a colleague are not customer conversations ----
  const kept = messages.filter((m) => !opts.excluded.has(m.conversationKey));
  const excludedSeen = new Map<string, "OWN_NUMBER" | "INTERNAL">();
  for (const m of messages) {
    const reason = opts.excluded.get(m.conversationKey);
    if (reason && inRange(m.ts)) excludedSeen.set(m.conversationKey, reason);
  }
  const excluded = {
    ownNumber: [...excludedSeen.values()].filter((r) => r === "OWN_NUMBER").length,
    internal: [...excludedSeen.values()].filter((r) => r === "INTERNAL").length,
  };

  // ---- Scope: a Team or member narrows to the conversations they answered ----
  let universe = kept;
  if (opts.scope) {
    const answered = new Set<string>();
    for (const m of kept) {
      if (isEmployeeReply(m) && inRange(m.ts) && opts.scope(m.memberId!, m.ts)) answered.add(m.conversationKey);
    }
    universe = kept.filter((m) => answered.has(m.conversationKey));
  }
  const creditedInScope = (m: PersonalReportMessage) => isEmployeeReply(m) && (!opts.scope || opts.scope(m.memberId!, m.ts));

  // ---- The waits: the Team Report's own, called unchanged with the conversation as the group ----
  const team = computeTeamReport(
    universe.map((m): ReportMessage => ({ groupKey: m.conversationKey, ts: m.ts, kind: m.kind, memberId: m.memberId, actor: m.actor })),
    {
      rangeStart: opts.rangeStart,
      rangeEnd: opts.rangeEnd,
      now: opts.now,
      idleGapMs: UNUSED_IDLE_GAP_MS,
      missedAfterMs: () => opts.missedAfterMs,
      assignedMemberFor: () => null,
      memberId: null,
      scope: null,
      granularity: opts.granularity,
      dutyFor: null,
    },
  );
  const human = humanWaits(
    universe.map(
      (m): IntelMessage => ({
        key: m.key,
        groupKey: m.conversationKey,
        ts: m.ts,
        actor: m.actor,
        memberId: m.memberId,
        operatorUserId: m.actor === "OPERATOR" ? m.operatorUserId : null,
        sender: m.sender,
        senderName: null,
        text: m.text,
        quotedKey: null,
        quotedMemberId: null,
        mentionedMemberIds: [],
      }),
    ),
    { rangeStart: opts.rangeStart, rangeEnd: opts.rangeEnd, measuredTo: opts.measuredTo, thresholdMs: () => opts.missedAfterMs },
  );
  const response = computeResponseMetrics({ waits: team.waits, humanWaits: human });

  // ---- Per-conversation counting (period messages only; context and look-ahead are read, never counted) ----
  interface Acc {
    row: PersonalConversationRow;
    employees: Set<string>;
    hasCustomer: boolean;
    latestAtMeasure: PersonalReportMessage | null;
    hasEarlier: boolean;
  }
  const acc = new Map<string, Acc>();
  const accFor = (m: PersonalReportMessage): Acc => {
    let entry = acc.get(m.conversationKey);
    if (!entry) {
      entry = {
        row: {
          conversationKey: m.conversationKey,
          accountId: m.accountId,
          chatId: m.chatId,
          customerMessages: 0,
          businessReplies: 0,
          verifiedEmployeeReplies: 0,
          automatedReplies: 0,
          waits: 0,
          missed: 0,
          recalled: 0,
          unrecovered: 0,
          firstObservedMedianSeconds: null,
          waiting: false,
          isNew: false,
          firstAt: null,
          lastAt: null,
          employeeIds: [],
        },
        employees: new Set(),
        hasCustomer: false,
        latestAtMeasure: null,
        hasEarlier: opts.earlierMessageAt.has(m.conversationKey),
      };
      acc.set(m.conversationKey, entry);
    }
    return entry;
  };

  const summary: PersonalReportSummary = {
    conversations: 0,
    customerConversations: 0,
    newConversations: 0,
    customerMessages: 0,
    businessReplies: 0,
    verifiedEmployeeReplies: 0,
    unlinkedOperatorReplies: 0,
    automatedReplies: { ai: 0, rule: 0 },
    businessPhoneReplies: 0,
    broadcastMessages: 0,
    waits: 0,
    missed: 0,
    recalled: 0,
    unrecovered: 0,
    pending: 0,
    waitingConversations: 0,
    excluded,
  };
  const bucketKeys = bucketKeysForRange(opts.rangeStart, opts.rangeEnd, opts.granularity);
  const buckets = new Map<string, PersonalBucketRow>(
    bucketKeys.map((key) => [key, { key, customerMessages: 0, businessReplies: 0, verifiedEmployeeReplies: 0, waits: 0, missed: 0, recalled: 0 }]),
  );
  const memberAcc = new Map<string, { verified: number; conversations: Set<string>; times: number[]; answered: number }>();
  const memberFor = (memberId: string) => {
    let entry = memberAcc.get(memberId);
    if (!entry) {
      entry = { verified: 0, conversations: new Set(), times: [], answered: 0 };
      memberAcc.set(memberId, entry);
    }
    return entry;
  };

  for (const m of universe) {
    const entry = accFor(m);
    if (m.ts < opts.rangeStart) entry.hasEarlier = true;
    // The newest message at the moment of measuring (input order breaks a tie in time).
    if (m.ts <= opts.measuredTo && (!entry.latestAtMeasure || m.ts >= entry.latestAtMeasure.ts)) entry.latestAtMeasure = m;
    if (!inRange(m.ts)) continue;
    const row = entry.row;
    row.firstAt = row.firstAt === null ? m.ts : Math.min(row.firstAt, m.ts);
    row.lastAt = row.lastAt === null ? m.ts : Math.max(row.lastAt, m.ts);
    const bucket = buckets.get(bucketKeyFor(m.ts, opts.granularity));
    if (m.kind === "CUSTOMER") {
      entry.hasCustomer = true;
      row.customerMessages += 1;
      summary.customerMessages += 1;
      if (bucket) bucket.customerMessages += 1;
      continue;
    }
    row.businessReplies += 1;
    summary.businessReplies += 1;
    if (bucket) bucket.businessReplies += 1;
    if (m.actor === "AI" || m.actor === "RULE") {
      row.automatedReplies += 1;
      if (m.actor === "AI") summary.automatedReplies.ai += 1;
      else summary.automatedReplies.rule += 1;
    } else if (m.actor === "BUSINESS_PHONE") summary.businessPhoneReplies += 1;
    else if (m.actor === "BROADCAST") summary.broadcastMessages += 1;
    else if (m.actor === "OPERATOR" && m.memberId === null) summary.unlinkedOperatorReplies += 1;
    if (creditedInScope(m)) {
      row.verifiedEmployeeReplies += 1;
      summary.verifiedEmployeeReplies += 1;
      if (bucket) bucket.verifiedEmployeeReplies += 1;
      entry.employees.add(m.memberId!);
      const member = memberFor(m.memberId!);
      member.verified += 1;
      member.conversations.add(m.conversationKey);
    }
  }

  const waitsByConversation = new Map<string, ReportWait[]>();
  for (const wait of team.waits) {
    const list = waitsByConversation.get(wait.groupKey) ?? [];
    list.push(wait);
    waitsByConversation.set(wait.groupKey, list);
    const bucket = buckets.get(bucketKeyFor(wait.askedAt, opts.granularity));
    summary.waits += 1;
    if (bucket) bucket.waits += 1;
    if (wait.status === "RECALLED" || wait.status === "MISSED") {
      summary.missed += 1;
      if (bucket) bucket.missed += 1;
    }
    if (wait.status === "RECALLED") {
      summary.recalled += 1;
      if (bucket) bucket.recalled += 1;
    }
    if (wait.status === "MISSED") summary.unrecovered += 1;
    if (wait.status === "PENDING") summary.pending += 1;
  }

  let employeeAnsweredHumanWaits = 0;
  for (const wait of human) {
    const by = wait.repliedBy;
    if (!by || by.actor !== "OPERATOR" || !by.memberId) continue;
    if (opts.scope && !opts.scope(by.memberId, wait.repliedAt ?? wait.askedAt)) continue;
    employeeAnsweredHumanWaits += 1;
    const member = memberFor(by.memberId);
    member.answered += 1;
    if (wait.waitSeconds !== null) member.times.push(wait.waitSeconds);
  }

  const conversations: PersonalConversationRow[] = [];
  for (const entry of acc.values()) {
    const row = entry.row;
    if (row.firstAt === null) continue; // read as context or look-ahead only: not a conversation of this period
    const waits = waitsByConversation.get(row.conversationKey) ?? [];
    row.waits = waits.length;
    row.missed = waits.filter((w) => w.status === "RECALLED" || w.status === "MISSED").length;
    row.recalled = waits.filter((w) => w.status === "RECALLED").length;
    row.unrecovered = waits.filter((w) => w.status === "MISSED").length;
    row.firstObservedMedianSeconds = responseStats(waits).medianSeconds;
    row.waiting = entry.latestAtMeasure?.kind === "CUSTOMER";
    row.isNew = !entry.hasEarlier;
    row.employeeIds = [...entry.employees].sort();
    summary.conversations += 1;
    if (entry.hasCustomer) summary.customerConversations += 1;
    if (row.isNew) summary.newConversations += 1;
    if (row.waiting) summary.waitingConversations += 1;
    conversations.push(row);
  }
  conversations.sort((a, b) => b.customerMessages - a.customerMessages || a.conversationKey.localeCompare(b.conversationKey));

  const members: PersonalMemberRow[] = [...memberAcc]
    .map(([memberId, m]) => {
      const times = [...m.times].sort((a, b) => a - b);
      return { memberId, verifiedReplies: m.verified, conversations: m.conversations.size, humanWaitsAnswered: m.answered, medianSeconds: median(times) };
    })
    .sort((a, b) => b.verifiedReplies - a.verifiedReplies || a.memberId.localeCompare(b.memberId));

  return {
    summary,
    response,
    employeeAnsweredHumanWaits,
    conversations,
    buckets: [...buckets.values()],
    members,
    waits: team.waits,
    humanWaits: human,
  };
}
