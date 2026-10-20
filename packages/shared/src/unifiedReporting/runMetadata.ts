import { DATA_HEALTH_LABELS, formatDhakaMoment, type DataHealthStatus } from "../dataHealth.js";
import type { ReliabilityLine, ReportingReliability } from "../teamReportReliability.js";
import type { ReportScope } from "./reportScope.js";
import { COMBINED_CALCULATION_VERSION, GROUP_CALCULATION_VERSION, PERSONAL_CALCULATION_VERSION } from "./versions.js";

/**
 * Run metadata and data-quality detail for the Team Report (06-algorithms §5). Pure: the page and the
 * Excel "Run information" sheet render the same lines, and nothing here is a percentage or a score —
 * counts and plain notes only.
 */

/** A message stored later than this after it was sent was recovered, not seen live (the worker's CATCHUP_AUTOMATION_WINDOW_MINUTES default). */
export const LATE_ARRIVAL_MINUTES = 15;

/** Printed verbatim in every run's metadata (04 §2). */
export const IDENTITY_MODE_STATEMENT =
  "Senders are identified with the team roster as it is now; Team membership and group assignment are taken as they were at the time of each message.";

export interface DataQualityCounts {
  /** Non-SYSTEM rows in the period (the same figure as `ReliabilityCounts.storedCopies` for groups). */
  storedCopies: number;
  /** direction = SYSTEM: joins, leaves, subject changes. */
  excludedSystem: number;
  /** Personal scope only: groupId IS NULL and not a personal chat (status, newsletter, orphaned @g.us). */
  excludedNonConversation: number;
  /** Personal: conversations excluded as our own numbers. */
  excludedOwnNumberChats: number;
  /** Personal: conversations with a roster member in them. */
  excludedInternalChats: number;
  /** createdAt > timestampWa + LATE_ARRIVAL_MINUTES and not loaded from history. */
  lateArriving: number;
  /** loadedFromHistoryAt IS NOT NULL (counted here, never as late). */
  loadedFromHistory: number;
  /** revokedAt IS NOT NULL — kept and counted. */
  revoked: number;
}

export const emptyDataQualityCounts = (): DataQualityCounts => ({
  storedCopies: 0,
  excludedSystem: 0,
  excludedNonConversation: 0,
  excludedOwnNumberChats: 0,
  excludedInternalChats: 0,
  lateArriving: 0,
  loadedFromHistory: 0,
  revoked: 0,
});

/** The "Collection detail" lines, in the shape the reliability section and the "Data quality" sheet already render. */
export function dataQualityLines(counts: DataQualityCounts, scope: "GROUP" | "PERSONAL" = "GROUP", pendingReattributions?: number): ReliabilityLine[] {
  const section = "Collection detail" as const;
  const lines: ReliabilityLine[] = [
    {
      section,
      label: "Stored later than they were sent",
      value: counts.lateArriving,
      note: `Stored more than ${LATE_ARRIVAL_MINUTES} minutes after WhatsApp's own time: recovered after a pause, not seen live. Still counted at the time they were sent.`,
    },
    { section, label: "Loaded from WhatsApp history on request", value: counts.loadedFromHistory, note: "Stored by an operator's request for earlier messages; counted here, not as late." },
    { section, label: "Deleted for everyone", value: counts.revoked, note: "Kept and counted; their text is never shown here." },
    { section, label: "Joins, leaves and subject changes (not counted)", value: counts.excludedSystem, note: "Nobody said anything." },
  ];
  if (scope === "PERSONAL") {
    lines.push(
      { section, label: "Chats that are not conversations (not counted)", value: counts.excludedNonConversation, note: "Status, channels, broadcast lists, or a group whose record is gone." },
      { section, label: "Our own numbers' chats (not counted)", value: counts.excludedOwnNumberChats, note: "One of our numbers writing to another." },
      { section, label: "Chats with a team member (not counted)", value: counts.excludedInternalChats, note: "A colleague writing to the business number is not a customer." },
    );
  }
  if (pendingReattributions !== undefined) {
    lines.push({
      section,
      label: "Roster changes still being applied to history",
      value: pendingReattributions,
      note: "Reports follow the roster as soon as it is saved; the stored staff stamp, Activity Feed and Duty History follow within minutes.",
    });
  }
  return lines;
}

export interface ReportRunMetadata {
  report: "team-report";
  scope: ReportScope;
  calculationVersions: string[];
  timezone: "Asia/Dhaka";
  generatedAt: number;
  dataCutoff: number;
  period: { start: number; end: number; label: string; contextMs: number; lookaheadMs: number };
  filters: Array<{ label: string; value: string }>;
  identityMode: string;
  collection: {
    status: DataHealthStatus;
    gaps: number;
    incompleteGaps: number;
    recoveredMessages: number;
    daysTotal: number;
    daysIncomplete: number;
    daysUnverified: number;
    lastMessageAt: number | null;
    lastProcessedAt: number | null;
  };
  identity: {
    logicalMessages: number;
    strong: number;
    single: number;
    linkedLogin: number;
    unlinkedOperator: number;
    conflicting: number;
    unidentifiedStaffSenders: number;
    pendingReattributions: number;
  };
}

/**
 * Dashboard replies in the period by a login that is / is not linked to a team member, from the report's
 * own classified messages (`TeamReportData.messages`): an OPERATOR message with a member is credited to
 * that member, one without stays the business number's. Counted only inside [rangeStart, rangeEnd): the
 * messages also carry the reply look-ahead, and the personal report's carry its context window and each chat's
 * last earlier message, none of which is part of the period.
 */
export function countOperatorReplies(
  messages: ReadonlyArray<{ ts: number; actor?: string; memberId: string | null }>,
  rangeEnd: number,
  rangeStart: number,
): { linked: number; unlinked: number } {
  let linked = 0;
  let unlinked = 0;
  for (const m of messages) {
    if (m.actor !== "OPERATOR" || m.ts >= rangeEnd || m.ts < rangeStart) continue;
    if (m.memberId) linked += 1;
    else unlinked += 1;
  }
  return { linked, unlinked };
}

const SCOPE_VERSIONS: Record<ReportScope, string[]> = {
  group: [GROUP_CALCULATION_VERSION],
  personal: [PERSONAL_CALCULATION_VERSION],
  combined: [GROUP_CALCULATION_VERSION, PERSONAL_CALCULATION_VERSION, COMBINED_CALCULATION_VERSION],
};

export function buildReportRunMetadata(input: {
  scope: ReportScope;
  generatedAt: number;
  /** The export's stored-by bound (`asof`); absent = the page reads everything stored, so the cutoff is `generatedAt`. */
  storedBy?: number | null;
  period: { start: number; end: number; label: string; contextMs: number; lookaheadMs: number; name: string };
  filters: { team: string | null; member: string | null; groupCount: number; account: string | null; granularity: string };
  health: { status: DataHealthStatus; lastMessageAt: number | null; lastProcessedAt: number | null };
  reliability: Pick<ReportingReliability, "logicalMessages" | "attribution" | "conflicting" | "unattributedSenders" | "gaps" | "days">;
  /** Dashboard replies by a login linked / not linked to a team member. */
  operatorReplies: { linked: number; unlinked: number };
  pendingReattributions: number;
  /** Set only when the customer-specific replies section ran. */
  replyAttributionVersion?: string | null;
}): ReportRunMetadata {
  const { period, filters, health, reliability } = input;
  return {
    report: "team-report",
    scope: input.scope,
    calculationVersions: [...SCOPE_VERSIONS[input.scope], ...(input.replyAttributionVersion ? [input.replyAttributionVersion] : [])],
    timezone: "Asia/Dhaka",
    generatedAt: input.generatedAt,
    dataCutoff: input.storedBy ?? input.generatedAt,
    period: { start: period.start, end: period.end, label: period.label, contextMs: period.contextMs, lookaheadMs: period.lookaheadMs },
    filters: [
      { label: "Period", value: `${period.name} · ${period.label}` },
      { label: "Team", value: filters.team ?? "All teams" },
      { label: "Team member", value: filters.member ?? "All" },
      { label: "Groups", value: filters.groupCount > 0 ? `${filters.groupCount} chosen` : "All" },
      { label: "WhatsApp account", value: filters.account ?? "All" },
      { label: "Scope", value: input.scope === "group" ? "Groups" : input.scope === "personal" ? "Personal chats" : "Groups and personal chats" },
      { label: "Breakdown", value: filters.granularity },
    ],
    identityMode: IDENTITY_MODE_STATEMENT,
    collection: {
      status: health.status,
      gaps: reliability.gaps.total,
      incompleteGaps: reliability.gaps.incomplete,
      recoveredMessages: reliability.gaps.recoveredMessages,
      daysTotal: reliability.days.total,
      daysIncomplete: reliability.days.incomplete,
      daysUnverified: reliability.days.unverified,
      lastMessageAt: health.lastMessageAt,
      lastProcessedAt: health.lastProcessedAt,
    },
    identity: {
      logicalMessages: reliability.logicalMessages,
      strong: reliability.attribution.idAndPhone,
      single: reliability.attribution.idOnly + reliability.attribution.phoneOnly,
      linkedLogin: input.operatorReplies.linked,
      unlinkedOperator: input.operatorReplies.unlinked,
      conflicting: reliability.conflicting,
      unidentifiedStaffSenders: reliability.unattributedSenders,
      pendingReattributions: input.pendingReattributions,
    },
  };
}

const hoursText = (ms: number) => `${Math.round((ms / 3_600_000) * 100) / 100} h`;
const momentOrNone = (ms: number | null) => (ms === null ? "None stored" : formatDhakaMoment(ms));

/** The metadata as label / value / note rows — what the page's panel and the Excel sheet both print. */
export function runMetadataLines(meta: ReportRunMetadata): Array<{ label: string; value: string; note: string }> {
  const { collection: c, identity: i, period } = meta;
  return [
    { label: "Report", value: "Team Report", note: "" },
    { label: "Calculation version", value: meta.calculationVersions.join(", "), note: "Changes only when a figure's meaning changes." },
    { label: "Time zone", value: meta.timezone, note: "Days, weeks (Sunday start) and months." },
    { label: "Generated at", value: formatDhakaMoment(meta.generatedAt), note: "" },
    {
      label: "Data cutoff",
      value: formatDhakaMoment(meta.dataCutoff),
      note: meta.dataCutoff === meta.generatedAt ? "Everything stored at that moment." : "Only messages stored by this moment (the page's own moment).",
    },
    { label: "Period", value: period.label, note: `${formatDhakaMoment(period.start)} to ${formatDhakaMoment(period.end)}, end excluded.` },
    { label: "Context read before the period", value: hoursText(period.contextMs), note: "Read to see whether a wait was already open; never counted." },
    { label: "Replies looked for after the period", value: hoursText(period.lookaheadMs), note: "Only for waits that started inside the period." },
    ...meta.filters.map((f) => ({ label: f.label, value: f.value, note: "" })),
    { label: "How senders are identified", value: meta.identityMode, note: "" },
    { label: "Collection status", value: DATA_HEALTH_LABELS[c.status], note: "" },
    { label: "Collection gaps", value: String(c.gaps), note: `${c.incompleteGaps} may have lost messages; ${c.recoveredMessages} message(s) recovered.` },
    { label: "Days that may be missing messages", value: `${c.daysIncomplete} of ${c.daysTotal}`, note: `${c.daysUnverified} of ${c.daysTotal} before the verified-from date.` },
    { label: "Last message stored", value: momentOrNone(c.lastMessageAt), note: "" },
    { label: "Last processed by the worker", value: momentOrNone(c.lastProcessedAt), note: "" },
    { label: "Logical messages", value: String(i.logicalMessages), note: "" },
    { label: "Senders matched on WhatsApp id and phone", value: String(i.strong), note: "" },
    { label: "Senders matched on one identifier", value: String(i.single), note: "" },
    { label: "Dashboard replies credited to a linked member", value: String(i.linkedLogin), note: "" },
    { label: "Dashboard replies from an unlinked login", value: String(i.unlinkedOperator), note: "A verified person, credited to no member." },
    { label: "Conflicting identities", value: String(i.conflicting), note: "Counted as staff, credited to nobody." },
    { label: "Unidentified staff senders", value: String(i.unidentifiedStaffSenders), note: "" },
    { label: "Roster changes still being applied", value: String(i.pendingReattributions), note: "Reports already follow the saved roster." },
  ];
}
