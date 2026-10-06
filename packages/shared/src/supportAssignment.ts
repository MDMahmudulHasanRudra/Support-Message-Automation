import { DHAKA_OFFSET_MS } from "./dhakaDay.js";

/**
 * Support Assignment (SUPPORT_ASSIGNMENT.md): the pure rules, shared by the worker (which builds and
 * closes cases as messages arrive), the web (which assigns them) and the tests.
 *
 * A case is one customer WAIT — a `SupportResponseEpisode` — so "unanswered" keeps the single
 * definition Messages → Unanswered groups already uses. This module adds only what the assignment
 * layer needs on top: which waits are not support work, and when a reply counts as the assignee's.
 */

export const SUPPORT_ASSIGNMENT_STATUSES = [
  "IGNORED",
  "UNASSIGNED",
  "ASSIGNED",
  "OVERDUE",
  "COMPLETED",
  "ANSWERED_BY_OTHER",
  "CANCELLED",
] as const;
export type SupportAssignmentStatusValue = (typeof SUPPORT_ASSIGNMENT_STATUSES)[number];

/** A customer is still waiting: the Unanswered list. */
export const OPEN_ASSIGNMENT_STATUSES = ["UNASSIGNED", "ASSIGNED", "OVERDUE"] as const satisfies readonly SupportAssignmentStatusValue[];
/** Somebody has been asked and has not answered yet. */
export const PENDING_ASSIGNMENT_STATUSES = ["ASSIGNED", "OVERDUE"] as const satisfies readonly SupportAssignmentStatusValue[];
/** Finished, one way or another: the Completed list. */
export const CLOSED_ASSIGNMENT_STATUSES = ["COMPLETED", "ANSWERED_BY_OTHER", "CANCELLED"] as const satisfies readonly SupportAssignmentStatusValue[];

export const SUPPORT_ASSIGNMENT_STATUS_LABELS: Record<SupportAssignmentStatusValue, string> = {
  IGNORED: "Ignored",
  UNASSIGNED: "Unassigned",
  ASSIGNED: "Assigned",
  OVERDUE: "Overdue",
  COMPLETED: "Completed",
  ANSWERED_BY_OTHER: "Answered by someone else",
  CANCELLED: "Cancelled",
};

export function isSupportAssignmentStatus(value: string): value is SupportAssignmentStatusValue {
  return (SUPPORT_ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------
// Qualification: which customer messages are NOT support work
// ---------------------------------------------------------------------------------------------

/**
 * Words that only address somebody. A message made of ignored words plus these is still only an
 * acknowledgement ("Thank you ভাই", "ok brother"), so nobody has to list every combination. On
 * their own they are NOT ignored: "ভাই?" is somebody asking for attention.
 */
const ADDRESS_WORDS: ReadonlySet<string> = new Set(
  [
    "bhai", "vai", "vaia", "vaiya", "bhaiya", "brother", "bro", "sir", "madam", "maam", "dear", "apu", "apa", "ji", "jee",
    "ভাই", "ভাইয়া", "ভাইয়া", "আপু", "স্যার", "জি", "জ্বি", "ম্যাডাম",
  ].map((w) => w.normalize("NFC")),
);

/**
 * Lower-cased words, Unicode-safe: letters, digits and combining marks stay together (so Bengali
 * vowel signs never split a word), everything else — spaces, punctuation, emoji — separates. Same
 * definition of a word as packages/engine's `tokenizeWords`.
 */
export function tokenizeForMatch(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter(Boolean);
}

export const MAX_IGNORED_KEYWORDS = 200;
export const MAX_IGNORED_KEYWORD_LENGTH = 80;

/** A settings list cleaned for storage: trimmed, lower-cased, de-duplicated, empty lines dropped. */
export function cleanIgnoredKeywords(lines: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const phrase = tokenizeForMatch(raw).join(" ");
    if (!phrase || phrase.length > MAX_IGNORED_KEYWORD_LENGTH || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
    if (out.length >= MAX_IGNORED_KEYWORDS) break;
  }
  return out;
}

/**
 * Whether a message says nothing but ignored words. Every word must be part of an ignored phrase
 * (matched as whole words, never inside another word: "ok" does not touch "okhla" or "book") or an
 * address word, and at least one ignored phrase must be present.
 *
 * Ignored words only EXCLUDE. Any other word makes the message support work, whatever it is about —
 * a customer never has to use a listed word to be heard (SUPPORT_ASSIGNMENT.md, "ignore rules
 * exclude").
 */
export function isOnlyIgnoredWords(body: string, ignoredKeywords: readonly string[]): boolean {
  const words = tokenizeForMatch(body);
  if (words.length === 0) return false;
  const phrases = ignoredKeywords
    .map((k) => tokenizeForMatch(k))
    .filter((p) => p.length > 0)
    // Longest first, so "thanks brother" is consumed whole before "thanks" alone.
    .sort((a, b) => b.length - a.length);
  if (phrases.length === 0) return false;

  let matchedPhrase = false;
  let i = 0;
  outer: while (i < words.length) {
    for (const phrase of phrases) {
      if (phrase.every((w, k) => words[i + k] === w)) {
        matchedPhrase = true;
        i += phrase.length;
        continue outer;
      }
    }
    if (ADDRESS_WORDS.has(words[i]!)) {
      i += 1;
      continue;
    }
    return false;
  }
  return matchedPhrase;
}

/** "8801712345678" for a number in any form; a WhatsApp id (LID) stays as given, minus its suffix. */
export function normalizeSenderKey(input: string): string {
  const bare = input.trim().replace(/@(c\.us|s\.whatsapp\.net|lid)$/i, "");
  const digits = bare.replace(/\D/g, "");
  return digits.length >= 6 ? digits : bare.toLowerCase();
}

/** A settings list of senders cleaned for storage. */
export function cleanIgnoredSenders(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const key = normalizeSenderKey(raw);
    if (key.length < 6 || out.includes(key)) continue;
    out.push(key);
    if (out.length >= MAX_IGNORED_KEYWORDS) break;
  }
  return out;
}

export function isIgnoredSender(senderPhone: string, ignoredSenders: readonly string[]): boolean {
  if (ignoredSenders.length === 0) return false;
  const key = normalizeSenderKey(senderPhone);
  return ignoredSenders.includes(key);
}

export type QualificationReason = "IGNORED_SENDER" | "IGNORED_WORDS" | "NO_TEXT";

export interface Qualification {
  qualifies: boolean;
  reason: QualificationReason | null;
}

/**
 * Whether one customer message is support work. A message with no words at all (an emoji, a
 * sticker) is not — unless it carries an attachment, because a photo of a router's lights IS a
 * support request even without a caption.
 */
export function qualifyCustomerMessage(
  message: { body: string; hasMedia: boolean; senderPhone: string },
  settings: { ignoredKeywords: readonly string[]; ignoredSenders: readonly string[] },
): Qualification {
  if (isIgnoredSender(message.senderPhone, settings.ignoredSenders)) return { qualifies: false, reason: "IGNORED_SENDER" };
  if (tokenizeForMatch(message.body).length === 0) {
    return message.hasMedia ? { qualifies: true, reason: null } : { qualifies: false, reason: "NO_TEXT" };
  }
  if (isOnlyIgnoredWords(message.body, settings.ignoredKeywords)) return { qualifies: false, reason: "IGNORED_WORDS" };
  return { qualifies: true, reason: null };
}

export const QUALIFICATION_REASON_LABELS: Record<QualificationReason, string> = {
  IGNORED_SENDER: "Sender is on the ignored list",
  IGNORED_WORDS: "Only ignored words (thanks, ok…)",
  NO_TEXT: "No text (emoji or sticker)",
};

// ---------------------------------------------------------------------------------------------
// Completion: when a reply counts as the assignee's
// ---------------------------------------------------------------------------------------------

export type ReplyDecision = "COMPLETE" | "ANSWERED_BY_OTHER" | "CLOSE_IGNORED" | "NONE";

/**
 * What one team member's message in the group does to one open case.
 *
 * - The ASSIGNEE completes it, but only with a message sent at or after the assignment (a message
 *   from before they were asked cannot be their answer) and only one that is more than ignored
 *   words ("ok" acknowledges; it does not support).
 * - Anybody else completes nothing. If their message is the Support reply that answered the wait
 *   (`answeredWait`), the customer is no longer waiting, so the case closes as ANSWERED_BY_OTHER —
 *   uncredited to the assignee, and with no overdue alert about a customer who has been answered.
 *   The same applies to an unassigned case, and to the assignee's own reply sent before assignment.
 * - An IGNORED case ("thanks") simply closes when its wait is answered: it was never support work,
 *   so it is neither completed nor answered by anybody.
 *
 * `answeredWait` means this message is the Support reply that answered the group's open wait
 * (SUPPORT_RESPONSE.md) — any wait in the group, because a case stays current across the waits of
 * its group until it is closed.
 */
export function decideReply(input: {
  status: SupportAssignmentStatusValue;
  assignedMemberId: string | null;
  assignedAt: number | null;
  memberId: string;
  at: number;
  onlyIgnoredWords: boolean;
  answeredWait: boolean;
}): ReplyDecision {
  const pending = input.status === "ASSIGNED" || input.status === "OVERDUE";
  if (
    pending &&
    input.memberId === input.assignedMemberId &&
    input.assignedAt !== null &&
    input.at >= input.assignedAt &&
    !input.onlyIgnoredWords
  ) {
    return "COMPLETE";
  }
  if (!input.answeredWait) return "NONE";
  if (input.status === "UNASSIGNED") return "ANSWERED_BY_OTHER";
  if (input.status === "IGNORED") return "CLOSE_IGNORED";
  if (pending) {
    // The assignee's own "ok" answered the wait for the tracker, but it is not support: the case
    // stays theirs and keeps its deadline.
    if (input.memberId === input.assignedMemberId && input.assignedAt !== null && input.at >= input.assignedAt) return "NONE";
    return "ANSWERED_BY_OTHER";
  }
  return "NONE";
}

// ---------------------------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------------------------

export const SUPPORT_ASSIGNMENT_SLA_BOUNDS = { min: 1, max: 24 * 60 } as const;
export const SUPPORT_ASSIGNMENT_ESCALATION_BOUNDS = { min: 1, max: 24 * 60 } as const;

/**
 * How late a case may be before it is marked overdue. A reply sent just before the deadline can
 * reach this server a few seconds after it (a phone on a slow network, a reconnect catching up), and
 * an overdue alert about somebody who had in fact answered is exactly the noise that teaches people
 * to ignore alerts.
 */
export const SUPPORT_ASSIGNMENT_OVERDUE_GRACE_MS = 60_000;

export function clampMinutes(value: number, bounds: { min: number; max: number }, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

/** Whether a case met its SLA: answered by the assignee at or before its deadline. */
export function metSla(row: { status: string; completedAt: number | null; dueAt: number | null }): boolean | null {
  if (row.status !== "COMPLETED" || row.completedAt === null || row.dueAt === null) return null;
  return row.completedAt <= row.dueAt;
}

/**
 * Whether a case counts as overdue in reports: still overdue now, or completed after its deadline.
 * A case marked overdue whose reply turns out to have been sent in time (it arrived late) is NOT —
 * timestamps decide, not the order things reached the server.
 */
export function wasOverdue(row: { status: string; completedAt: number | null; dueAt: number | null; overdueAt: number | null }): boolean {
  if (row.status === "OVERDUE") return true;
  if (row.status === "COMPLETED" && row.completedAt !== null && row.dueAt !== null) return row.completedAt > row.dueAt;
  return row.overdueAt !== null && row.status !== "COMPLETED";
}

// ---------------------------------------------------------------------------------------------
// Notification wording
// ---------------------------------------------------------------------------------------------

export const SUPPORT_ASSIGNMENT_TEMPLATE_KEYS = {
  ASSIGNED: "SUPPORT_ASSIGNMENT_ASSIGNED",
  REASSIGNED: "SUPPORT_ASSIGNMENT_REASSIGNED",
  OVERDUE: "SUPPORT_ASSIGNMENT_OVERDUE",
  ESCALATED: "SUPPORT_ASSIGNMENT_ESCALATED",
  COMPLETED: "SUPPORT_ASSIGNMENT_COMPLETED",
} as const;

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10:25 PM, 6 Oct" on the Dhaka clock — no Intl, so server and tests format identically. */
export function formatDhakaClock(ms: number): string {
  const d = new Date(ms + DHAKA_OFFSET_MS);
  const h = d.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "7m 32s", "1h 05m", "45s" — a response time read at a glance in a WhatsApp message. */
export function formatResponseTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** The customer's message as it goes into a notification: one line, at most 300 characters. */
export function excerptForNotification(body: string | null | undefined, max = 300): string {
  const flat = (body ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "(attachment, no text)";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The template variables for one case, built the same way for every message so a wording edit can
 * move any detail between them. Missing values are null, which the renderer turns into a dropped
 * "Label:" line rather than an empty one.
 */
export function supportAssignmentNoticeVars(input: {
  groupName: string;
  customerName: string | null;
  customerPhone: string | null;
  message: string | null;
  employeeName: string | null;
  employeeId: string | null;
  assignedAt: number | null;
  dueAt: number | null;
  status: SupportAssignmentStatusValue;
  now: number;
  completedAt?: number | null;
  responseSeconds?: number | null;
  previousEmployee?: string | null;
}): Record<string, string | null> {
  const overdueSeconds = input.dueAt !== null ? Math.floor((input.now - input.dueAt) / 1000) : null;
  return {
    employeeName: input.employeeName,
    employeeId: input.employeeId,
    groupName: input.groupName,
    customerName: input.customerName?.trim() || input.customerPhone || null,
    message: excerptForNotification(input.message),
    assignedTime: input.assignedAt !== null ? formatDhakaClock(input.assignedAt) : null,
    dueTime: input.dueAt !== null ? formatDhakaClock(input.dueAt) : null,
    overdueBy: overdueSeconds !== null && overdueSeconds > 0 ? formatResponseTime(overdueSeconds) : null,
    completedTime: input.completedAt != null ? formatDhakaClock(input.completedAt) : null,
    responseTime: input.responseSeconds != null ? formatResponseTime(input.responseSeconds) : null,
    previousEmployee: input.previousEmployee ?? null,
    status: SUPPORT_ASSIGNMENT_STATUS_LABELS[input.status],
  };
}

/** One notification's identity within a case: per assignment round, per kind, per recipient. */
export function supportAssignmentDedupKey(round: number, kind: string, recipient: { memberId: string } | { whatsappGroupId: string }): string {
  return `r${round}:${kind}:${"memberId" in recipient ? `m:${recipient.memberId}` : `g:${recipient.whatsappGroupId}`}`;
}

// ---------------------------------------------------------------------------------------------
// Report (one function for the page, both exports and the tests)
// ---------------------------------------------------------------------------------------------

export interface ReportCaseInput {
  id: string;
  status: SupportAssignmentStatusValue;
  groupId: string;
  groupName: string;
  assignedAt: number | null;
  dueAt: number | null;
  overdueAt: number | null;
  completedAt: number | null;
  closedAt: number | null;
  responseSeconds: number | null;
  /** The current (final) assignee. */
  assignedMemberId: string | null;
  /** Who answered: the assignee for COMPLETED, somebody else for ANSWERED_BY_OTHER. */
  responderMemberId: string | null;
  /** Assignment history: who each round went to, and who was the assignee when it went overdue. */
  events: { type: "ASSIGNED" | "REASSIGNED" | "OVERDUE"; memberId: string | null }[];
}

export interface SlaTally {
  met: number;
  measured: number;
}

export interface SupportAssignmentReport {
  summary: {
    /** Support cases: every case except the IGNORED (filtered) ones. */
    total: number;
    ignored: number;
    unassigned: number;
    /** Cases that were assigned to somebody at least once. */
    assigned: number;
    completed: number;
    answeredByOther: number;
    cancelled: number;
    /** Assigned and not yet answered (ASSIGNED + OVERDUE). */
    pending: number;
    overdue: number;
    avgResponseSeconds: number | null;
    sla: SlaTally;
  };
  employees: {
    memberId: string;
    /** Times a case was given to them (an assignment or a reassignment to them). */
    assigned: number;
    completed: number;
    pending: number;
    /** Times a case went overdue while it was theirs. */
    overdue: number;
    /** Cases still theirs that somebody else answered. */
    answeredByOther: number;
    /** Cases given to them and later moved to somebody else. */
    reassignedAway: number;
    avgResponseSeconds: number | null;
    sla: SlaTally;
  }[];
  groups: {
    groupId: string;
    groupName: string;
    cases: number;
    completed: number;
    answeredByOther: number;
    /** Still waiting: unassigned, assigned or overdue. */
    open: number;
    overdue: number;
    avgResponseSeconds: number | null;
  }[];
}

/**
 * Whether one case counts for SLA compliance, and whether it met it. Measured: completed (on time
 * or late), still overdue, or closed some other way AFTER its deadline. Not measured: not yet due,
 * or closed before the deadline by somebody else / a cancellation — nobody missed anything.
 */
export function slaOutcome(c: Pick<ReportCaseInput, "status" | "assignedAt" | "dueAt" | "completedAt" | "closedAt">): "MET" | "MISSED" | null {
  if (c.assignedAt === null || c.dueAt === null) return null;
  if (c.status === "COMPLETED" && c.completedAt !== null) return c.completedAt <= c.dueAt ? "MET" : "MISSED";
  if (c.status === "OVERDUE") return "MISSED";
  if ((c.status === "ANSWERED_BY_OTHER" || c.status === "CANCELLED") && c.closedAt !== null && c.closedAt > c.dueAt) return "MISSED";
  return null;
}

const average = (values: number[]): number | null => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

export function computeSupportAssignmentReport(cases: readonly ReportCaseInput[]): SupportAssignmentReport {
  const support = cases.filter((c) => c.status !== "IGNORED");
  const count = (status: SupportAssignmentStatusValue) => support.filter((c) => c.status === status).length;
  const completedTimes = support.filter((c) => c.status === "COMPLETED" && c.responseSeconds !== null).map((c) => c.responseSeconds!);
  const tally = (list: readonly ReportCaseInput[]): SlaTally => {
    const outcomes = list.map(slaOutcome).filter((o) => o !== null);
    return { met: outcomes.filter((o) => o === "MET").length, measured: outcomes.length };
  };

  const employees = new Map<string, SupportAssignmentReport["employees"][number] & { times: number[]; owned: ReportCaseInput[] }>();
  const employee = (memberId: string) => {
    let row = employees.get(memberId);
    if (!row) {
      row = { memberId, assigned: 0, completed: 0, pending: 0, overdue: 0, answeredByOther: 0, reassignedAway: 0, avgResponseSeconds: null, sla: { met: 0, measured: 0 }, times: [], owned: [] };
      employees.set(memberId, row);
    }
    return row;
  };

  for (const c of support) {
    const given = c.events.filter((e) => (e.type === "ASSIGNED" || e.type === "REASSIGNED") && e.memberId);
    for (const e of given) employee(e.memberId!).assigned += 1;
    // Everyone this case was given to before its final assignee had it moved away from them.
    for (const e of given.slice(0, -1)) if (e.memberId !== c.assignedMemberId) employee(e.memberId!).reassignedAway += 1;
    for (const e of c.events) if (e.type === "OVERDUE" && e.memberId) employee(e.memberId).overdue += 1;
    if (!c.assignedMemberId) continue;
    const owner = employee(c.assignedMemberId);
    owner.owned.push(c);
    if (c.status === "COMPLETED") {
      owner.completed += 1;
      if (c.responseSeconds !== null) owner.times.push(c.responseSeconds);
    } else if (c.status === "ASSIGNED" || c.status === "OVERDUE") owner.pending += 1;
    else if (c.status === "ANSWERED_BY_OTHER") owner.answeredByOther += 1;
  }

  const groups = new Map<string, SupportAssignmentReport["groups"][number] & { times: number[] }>();
  for (const c of support) {
    let g = groups.get(c.groupId);
    if (!g) {
      g = { groupId: c.groupId, groupName: c.groupName, cases: 0, completed: 0, answeredByOther: 0, open: 0, overdue: 0, avgResponseSeconds: null, times: [] };
      groups.set(c.groupId, g);
    }
    g.cases += 1;
    if (c.status === "COMPLETED") {
      g.completed += 1;
      if (c.responseSeconds !== null) g.times.push(c.responseSeconds);
    } else if (c.status === "ANSWERED_BY_OTHER") g.answeredByOther += 1;
    else if (c.status === "UNASSIGNED" || c.status === "ASSIGNED" || c.status === "OVERDUE") g.open += 1;
    if (wasOverdue({ status: c.status, completedAt: c.completedAt, dueAt: c.dueAt, overdueAt: c.overdueAt })) g.overdue += 1;
  }

  return {
    summary: {
      total: support.length,
      ignored: cases.length - support.length,
      unassigned: count("UNASSIGNED"),
      assigned: support.filter((c) => c.assignedAt !== null).length,
      completed: count("COMPLETED"),
      answeredByOther: count("ANSWERED_BY_OTHER"),
      cancelled: count("CANCELLED"),
      pending: count("ASSIGNED") + count("OVERDUE"),
      overdue: support.filter((c) => wasOverdue({ status: c.status, completedAt: c.completedAt, dueAt: c.dueAt, overdueAt: c.overdueAt })).length,
      avgResponseSeconds: average(completedTimes),
      sla: tally(support),
    },
    employees: [...employees.values()]
      .map(({ times, owned, ...row }) => ({ ...row, avgResponseSeconds: average(times), sla: tally(owned) }))
      .sort((a, b) => b.assigned - a.assigned || a.memberId.localeCompare(b.memberId)),
    groups: [...groups.values()]
      .map(({ times, ...row }) => ({ ...row, avgResponseSeconds: average(times) }))
      .sort((a, b) => b.cases - a.cases || a.groupName.localeCompare(b.groupName)),
  };
}

/** "92%" or "—" when nothing was measured — never a 0% for an empty period. */
export function formatSlaCompliance(sla: SlaTally): string {
  return sla.measured === 0 ? "—" : `${Math.round((sla.met / sla.measured) * 100)}%`;
}
