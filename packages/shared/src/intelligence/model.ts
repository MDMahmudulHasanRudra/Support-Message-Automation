import { isAcknowledgementOnly } from "../unableToUnderstand.js";
import {
  detectCustomerConfirmation,
  detectCustomerSignals,
  detectEmployeeResolution,
  detectHandoff,
  detectStillBroken,
  type SignalConfidence,
} from "./textSignals.js";

/**
 * Support Intelligence — the derived model (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md stages 2–5).
 *
 * Messages → who sent each one (actor) → Support Sessions (one employee's interaction with one group)
 * → Support Cases (one customer problem, opened by a customer and carried until it is resolved, goes
 * quiet or is missed) → ownership, internal hand-off, resolution and complexity → human waits.
 *
 * Pure and deterministic: the same messages always give the same sessions and cases, so the report,
 * its export and the read-only validation script cannot disagree. Every inferred conclusion carries
 * its confidence and the message it rests on.
 *
 * None of this replaces an existing figure. "Support Time" stays the Team Report's; this model adds
 * "Observed Support Session Time" beside it, and Human Response SLA beside Response SLA.
 */

// ---------------------------------------------------------------------------------------------
// Messages and actors

/**
 * Who sent a message.
 *
 * CUSTOMER         an incoming message from someone not on the roster.
 * MEMBER           an incoming message from a roster member, on their own WhatsApp.
 * MEMBER_UNMAPPED  stamped as a team member when it arrived, but nobody on today's roster matches.
 * OPERATOR         a reply typed in this dashboard's chat inbox (OutboundMessage MANUAL_REPLY).
 * AI               a reply the AI fallback sent.
 * RULE             an automation-rule reply.
 * BROADCAST        a Group Message Sender broadcast.
 * BUSINESS_PHONE   sent from our number but not by this system — somebody on the business phone.
 */
export type IntelActor = "CUSTOMER" | "MEMBER" | "MEMBER_UNMAPPED" | "OPERATOR" | "AI" | "RULE" | "BROADCAST" | "BUSINESS_PHONE";

export const INTEL_ACTOR_LABELS: Record<IntelActor, string> = {
  CUSTOMER: "Customer",
  MEMBER: "Team member",
  MEMBER_UNMAPPED: "Team member (not on the roster)",
  OPERATOR: "Dashboard operator",
  AI: "AI",
  RULE: "Automation rule",
  BROADCAST: "Broadcast",
  BUSINESS_PHONE: "Business phone (person unknown)",
};

/** A reply a human wrote. AI, rules and broadcasts are not. */
export const HUMAN_REPLY_ACTORS: ReadonlySet<IntelActor> = new Set(["MEMBER", "MEMBER_UNMAPPED", "OPERATOR", "BUSINESS_PHONE"]);
export const isHumanReply = (actor: IntelActor) => HUMAN_REPLY_ACTORS.has(actor);
export const isTeamActor = (actor: IntelActor) => actor !== "CUSTOMER";

export interface IntelMessage {
  /** The WhatsApp message id — the evidence key a drill-down opens. */
  key: string;
  groupKey: string;
  ts: number;
  actor: IntelActor;
  /** Set for MEMBER only. */
  memberId: string | null;
  /** Set for OPERATOR when the dashboard user is known. */
  operatorUserId: string | null;
  /** The sender's phone or LID — a customer's identity within a group. */
  sender: string;
  senderName: string | null;
  /**
   * The text, only when the database pre-filter thought a catalogue might match or the message is
   * short enough to be an acknowledgement; null otherwise.
   */
  text: string | null;
  /** The WhatsApp id of the message this one quotes, and who wrote it. */
  quotedKey: string | null;
  quotedMemberId: string | null;
  /** Roster members @-mentioned. */
  mentionedMemberIds: string[];
}

export interface IntelSettings {
  /** A case closes after this much silence. Default 4 hours. */
  caseGapMs: number;
  /** A customer coming back within this long after a resolution may reopen it. Default 24 hours. */
  reopenWindowMs: number;
  /** One employee's session in a group ends after this much silence from them — the Team Report's idle gap. */
  sessionGapMs: number;
  /** The Missed threshold of a wait in a group — the Team Report's. */
  thresholdMs: (groupKey: string) => number;
}

export const DEFAULT_CASE_GAP_MS = 4 * 3_600_000;
export const DEFAULT_REOPEN_WINDOW_MS = 24 * 3_600_000;

/** Facts recorded elsewhere that settle a case, stronger than any text. */
export interface CaseFacts {
  /** SLA escalation cases (SupportEscalationCase): opened, and resolved by an admin when resolvedAt is set. */
  escalations: Array<{ groupKey: string; openedAt: number; closedAt: number | null; resolvedByAdminAt: number | null }>;
  /** SupportSession completions by a completion keyword. */
  keywordCompletions: Array<{ groupKey: string; at: number; memberId: string | null }>;
}

const NO_FACTS: CaseFacts = { escalations: [], keywordCompletions: [] };

// ---------------------------------------------------------------------------------------------
// Signals per message

export interface MessageSignals {
  handoff: SignalConfidence | null;
  employeeResolved: boolean;
  customerConfirm: boolean;
  stillBroken: boolean;
  thanks: boolean;
  praise: boolean;
  preference: boolean;
  genericTeam: boolean;
  /** A plain acknowledgement ("ok", "ji vai", "thanks", an emoji): carries on a case, never opens one. */
  acknowledgement: boolean;
}

const EMPTY_SIGNALS: MessageSignals = {
  handoff: null,
  employeeResolved: false,
  customerConfirm: false,
  stillBroken: false,
  thanks: false,
  praise: false,
  preference: false,
  genericTeam: false,
  acknowledgement: false,
};

export function signalsOf(m: IntelMessage): MessageSignals {
  if (!m.text) return EMPTY_SIGNALS;
  if (m.actor === "CUSTOMER") {
    const c = detectCustomerSignals(m.text);
    return {
      ...EMPTY_SIGNALS,
      customerConfirm: detectCustomerConfirmation(m.text),
      stillBroken: detectStillBroken(m.text),
      ...c,
      acknowledgement: isAcknowledgementOnly(m.text),
    };
  }
  if (!isHumanReply(m.actor)) return EMPTY_SIGNALS;
  return { ...EMPTY_SIGNALS, handoff: detectHandoff(m.text), employeeResolved: detectEmployeeResolution(m.text) };
}

/**
 * A customer message that closes rather than asks: "ok", "thanks", "yes it is working now", a
 * thumbs-up — with no question mark and nothing saying it is still broken. It never opens a case or a
 * human wait: nothing is waiting for an answer. (The existing Team Report wait does start on it; the
 * Human Response SLA deliberately does not — see REPORTS.md.)
 */
export function isClosingRemark(m: IntelMessage, s: MessageSignals = signalsOf(m)): boolean {
  if (m.actor !== "CUSTOMER" || !m.text || s.stillBroken || m.text.includes("?")) return false;
  return s.acknowledgement || s.customerConfirm || s.thanks || s.praise;
}

// ---------------------------------------------------------------------------------------------
// Cases

export type CaseState = "ACTIVE" | "WAITING_CUSTOMER" | "WAITING_INTERNAL" | "ESCALATED" | "RESOLVED" | "REOPENED" | "ABANDONED" | "MISSED";

export const CASE_STATE_LABELS: Record<CaseState, string> = {
  ACTIVE: "Active — customer waiting for a reply",
  WAITING_CUSTOMER: "Waiting for the customer",
  WAITING_INTERNAL: "Waiting internally (hand-off)",
  ESCALATED: "SLA escalation open",
  RESOLVED: "Resolved",
  REOPENED: "Reopened",
  ABANDONED: "No further contact",
  MISSED: "Missed — never answered",
};

export const CLOSED_CASE_STATES: ReadonlySet<CaseState> = new Set(["RESOLVED", "ABANDONED", "MISSED"]);

export interface Evidence {
  /** The WhatsApp message id, or null for a fact recorded elsewhere (an admin action). */
  messageKey: string | null;
  at: number;
  text: string;
}

export interface CaseResolution {
  confidence: SignalConfidence;
  /** What settled it, in words. */
  basis: string;
  evidence: Evidence;
}

export interface CaseHandoff {
  memberId: string | null;
  actor: IntelActor;
  at: number;
  confidence: SignalConfidence;
  messageKey: string;
  /** The same person posted in the case again afterwards. */
  returned: boolean;
}

export interface CaseOwnership {
  memberId: string;
  confidence: SignalConfidence;
  /** Why this person, in words, strongest first. */
  reasons: string[];
}

export type Complexity = "SIMPLE" | "MODERATE" | "COMPLEX";

export interface SupportCase {
  /** groupKey|openedAt — stable for links and exports. */
  id: string;
  groupKey: string;
  /** The customer whose message opened it. */
  customer: string;
  customerName: string | null;
  openedAt: number;
  openingMessageKey: string;
  lastAt: number;
  /** Closed when silent for the case gap before the measuring moment. */
  closed: boolean;
  closedAt: number | null;
  state: CaseState;
  messageKeys: string[];
  customerMessages: number;
  teamMessages: number;
  humanReplies: number;
  aiReplies: number;
  ruleReplies: number;
  /** Customer ⇄ team alternations. */
  turns: number;
  /** Employees (roster ids) who wrote in it, in order of first message. */
  memberIds: string[];
  firstHumanReplyAt: number | null;
  firstHumanReplyBy: { actor: IntelActor; memberId: string | null } | null;
  firstReplyAt: number | null;
  firstReplyActor: IntelActor | null;
  handoffs: CaseHandoff[];
  escalated: boolean;
  resolution: CaseResolution | null;
  /** A resolution signal that a later customer message undid. */
  supersededResolutions: CaseResolution[];
  reopened: boolean;
  reopenedAt: number | null;
  owner: CaseOwnership | null;
  complexity: Complexity;
  complexityReasons: string[];
  /** The last customer message has no reply after it. */
  awaitingReply: boolean;
}

interface WorkingCase {
  groupKey: string;
  messages: Array<{ m: IntelMessage; s: MessageSignals }>;
  reopenedAt: number | null;
  superseded: CaseResolution[];
}

function caseId(groupKey: string, openedAt: number) {
  return `${groupKey}|${openedAt}`;
}

/** Does this customer message carry on the case's problem, rather than raise a new one? */
function continues(m: IntelMessage, s: MessageSignals, keys: ReadonlySet<string>): boolean {
  return (m.quotedKey !== null && keys.has(m.quotedKey)) || s.stillBroken;
}

function evaluateResolution(
  wc: WorkingCase,
  facts: CaseFacts,
  closeBound: number,
): CaseResolution | null {
  const msgs = wc.messages;
  const start = msgs[0]!.m.ts;
  const firstHuman = msgs.findIndex(({ m }) => isHumanReply(m.actor));

  // A fact outranks any reading of words: an admin resolving the SLA escalation for this group.
  const adminResolve = facts.escalations.find(
    (e) => e.groupKey === wc.groupKey && e.resolvedByAdminAt !== null && e.resolvedByAdminAt >= start && e.resolvedByAdminAt <= closeBound,
  );

  // Look only after the latest reopen: what came before it was undone.
  const fromIndex = wc.reopenedAt === null ? 0 : Math.max(0, msgs.findIndex(({ m }) => m.ts >= wc.reopenedAt!));
  const after = msgs.slice(fromIndex);

  let customerConfirm: CaseResolution | null = null;
  let employeeStated: CaseResolution | null = null;
  let thanked: CaseResolution | null = null;
  for (let i = 0; i < after.length; i++) {
    const { m, s } = after[i]!;
    const answeredBefore = firstHuman !== -1 && msgs.indexOf(after[i]!) > firstHuman;
    if (m.actor === "CUSTOMER") {
      if (s.stillBroken) {
        customerConfirm = null;
        employeeStated = null;
        thanked = null;
        continue;
      }
      if (answeredBefore && s.customerConfirm) {
        customerConfirm = { confidence: "HIGH", basis: "The customer confirmed the problem is solved.", evidence: { messageKey: m.key, at: m.ts, text: m.text ?? "" } };
      } else if (answeredBefore && s.thanks && !s.genericTeam) {
        thanked = { confidence: "MEDIUM", basis: "The customer thanked the team after the reply and raised nothing further.", evidence: { messageKey: m.key, at: m.ts, text: m.text ?? "" } };
      }
    } else if (isHumanReply(m.actor) && s.employeeResolved) {
      employeeStated = { confidence: "MEDIUM", basis: "The employee told the customer it was fixed, and the customer did not come back with the same problem.", evidence: { messageKey: m.key, at: m.ts, text: m.text ?? "" } };
    }
  }

  if (adminResolve) {
    return { confidence: "HIGH", basis: "An admin resolved the SLA escalation case for this group.", evidence: { messageKey: null, at: adminResolve.resolvedByAdminAt!, text: "Escalation case resolved by an admin" } };
  }
  if (customerConfirm) return customerConfirm;
  const keyword = facts.keywordCompletions.find((k) => k.groupKey === wc.groupKey && k.at >= (after[0]?.m.ts ?? start) && k.at <= closeBound);
  if (employeeStated) return employeeStated;
  if (keyword) {
    return { confidence: "MEDIUM", basis: "A completion keyword closed the support session.", evidence: { messageKey: null, at: keyword.at, text: "Support session completed by a completion keyword" } };
  }
  if (thanked) return thanked;
  return null;
}

function ownershipOf(wc: WorkingCase, resolution: CaseResolution | null): CaseOwnership | null {
  const human = wc.messages.filter(({ m }) => m.actor === "MEMBER" && m.memberId);
  if (human.length === 0) return null;
  const members = [...new Set(human.map(({ m }) => m.memberId!))];
  const firstHumanAny = wc.messages.find(({ m }) => isHumanReply(m.actor));
  const lastBeforeResolution = resolution
    ? [...human].reverse().find(({ m }) => m.ts <= resolution.evidence.at)
    : undefined;

  const scored = members.map((id) => {
    const mine = human.filter(({ m }) => m.memberId === id);
    const reasons: Array<{ points: number; text: string }> = [];
    if (firstHumanAny?.m.memberId === id) reasons.push({ points: 1, text: "First to respond" });
    const handoff = mine.find(({ s }) => s.handoff === "HIGH" || s.handoff === "MEDIUM");
    if (handoff) {
      reasons.push({ points: 2, text: "Took it on: said they would check or pass it to the developer/technical team" });
      if (mine.some(({ m }) => m.ts >= handoff.m.ts + 5 * 60_000)) reasons.push({ points: 2, text: "Came back to the customer after the hand-off" });
    }
    // A fix stated before a reopen was undone by it: it earns nothing.
    if (mine.some(({ m, s }) => s.employeeResolved && (wc.reopenedAt === null || m.ts >= wc.reopenedAt))) reasons.push({ points: 2, text: "Told the customer it was fixed" });
    if (wc.reopenedAt !== null && human.find(({ m }) => m.ts >= wc.reopenedAt!)?.m.memberId === id) {
      reasons.push({ points: 2, text: "Took it on again after the customer reopened it" });
    }
    if (lastBeforeResolution?.m.memberId === id) reasons.push({ points: 1, text: "Last employee to reply before it was resolved" });
    if (mine.length / human.length > 0.5 && members.length > 1) reasons.push({ points: 1, text: "Wrote most of the team's replies" });
    const points = reasons.reduce((sum, r) => sum + r.points, 0);
    return { id, points, reasons, first: mine[0]!.m.ts, handoffReturned: reasons.some((r) => r.text.startsWith("Came back")), stated: reasons.some((r) => r.text.startsWith("Told")) };
  });
  scored.sort((a, b) => b.points - a.points || a.first - b.first);
  const top = scored[0]!;
  const runnerUp = scored[1];
  const strong = (top.handoffReturned || (top.stated && resolution !== null && resolution.confidence !== "LOW"));
  const confidence: SignalConfidence =
    strong && (!runnerUp || runnerUp.points < top.points)
      ? "HIGH"
      : members.length === 1
        ? "MEDIUM"
        : runnerUp && runnerUp.points === top.points
          ? "LOW"
          : "MEDIUM";
  const reasons = top.reasons.sort((a, b) => b.points - a.points).map((r) => r.text);
  if (members.length === 1) reasons.push("The only employee who replied");
  return { memberId: top.id, confidence, reasons };
}

function complexityOf(c: Omit<SupportCase, "complexity" | "complexityReasons">): { complexity: Complexity; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;
  if (c.turns >= 12) {
    points += 2;
    reasons.push(`${c.turns} back-and-forth turns`);
  } else if (c.turns >= 6) {
    points += 1;
    reasons.push(`${c.turns} back-and-forth turns`);
  }
  const span = c.lastAt - c.openedAt;
  if (span >= 4 * 3_600_000) {
    points += 2;
    reasons.push(`Ran for ${Math.round(span / 3_600_000)} hours`);
  } else if (span >= 3_600_000) {
    points += 1;
    reasons.push(`Ran for over an hour`);
  }
  // Passing it to the developer/technical team is real extra work; "I'll check and let you know" is
  // an ordinary step that may or may not have involved anyone else, so it weighs less.
  if (c.handoffs.some((h) => h.confidence === "HIGH")) {
    points += 2;
    reasons.push("Passed to the developer/technical team");
  } else if (c.handoffs.some((h) => h.confidence === "MEDIUM")) {
    points += 1;
    reasons.push("Needed checking before it could be answered");
  }
  if (c.memberIds.length > 1) {
    points += 1;
    reasons.push(`${c.memberIds.length} employees involved`);
  }
  if (c.escalated) {
    points += 2;
    reasons.push("An SLA escalation opened");
  }
  if (c.reopened) {
    points += 1;
    reasons.push("Reopened after it was reported fixed");
  }
  return { complexity: points >= 4 ? "COMPLEX" : points >= 2 ? "MODERATE" : "SIMPLE", reasons };
}

function finishCase(wc: WorkingCase, measuredTo: number, settings: IntelSettings, facts: CaseFacts): SupportCase {
  const msgs = wc.messages;
  const opener = msgs[0]!.m;
  const lastAt = msgs[msgs.length - 1]!.m.ts;
  const closed = measuredTo - lastAt >= settings.caseGapMs;
  const closeBound = closed ? lastAt + settings.caseGapMs : measuredTo;
  const resolution = evaluateResolution(wc, facts, closeBound);

  let turns = 0;
  let prevSide: "C" | "T" | null = null;
  const memberIds: string[] = [];
  let firstHuman: IntelMessage | null = null;
  let firstReply: IntelMessage | null = null;
  const handoffs: CaseHandoff[] = [];
  let customerMessages = 0;
  let teamMessages = 0;
  let humanReplies = 0;
  let aiReplies = 0;
  let ruleReplies = 0;
  for (const { m, s } of msgs) {
    const side = m.actor === "CUSTOMER" ? "C" : "T";
    if (prevSide !== null && side !== prevSide) turns += 1;
    prevSide = side;
    if (side === "C") customerMessages += 1;
    else {
      teamMessages += 1;
      if (!firstReply) firstReply = m;
      if (isHumanReply(m.actor)) {
        humanReplies += 1;
        if (!firstHuman) firstHuman = m;
      }
      if (m.actor === "AI") aiReplies += 1;
      if (m.actor === "RULE") ruleReplies += 1;
      if (m.actor === "MEMBER" && m.memberId && !memberIds.includes(m.memberId)) memberIds.push(m.memberId);
      if (s.handoff) {
        handoffs.push({
          memberId: m.memberId,
          actor: m.actor,
          at: m.ts,
          confidence: s.handoff,
          messageKey: m.key,
          returned: msgs.some(({ m: later }) => later.ts >= m.ts + 5 * 60_000 && isHumanReply(later.actor) && later.actor === m.actor && later.memberId === m.memberId),
        });
      }
    }
  }

  const lastCustomerIndex = msgs.map(({ m }) => m.actor).lastIndexOf("CUSTOMER");
  const awaitingReply = lastCustomerIndex !== -1 && !msgs.slice(lastCustomerIndex + 1).some(({ m }) => isTeamActor(m.actor));
  const escalated = facts.escalations.some((e) => e.groupKey === wc.groupKey && e.openedAt >= opener.ts && e.openedAt <= closeBound);
  const escalationOpen = facts.escalations.some(
    (e) => e.groupKey === wc.groupKey && e.openedAt >= opener.ts && e.openedAt <= closeBound && (e.closedAt === null || e.closedAt > measuredTo),
  );

  const last = msgs[msgs.length - 1]!;
  const lastTeam = [...msgs].reverse().find(({ m }) => isHumanReply(m.actor));
  let state: CaseState;
  if (resolution) state = "RESOLVED";
  else if (closed) state = awaitingReply ? "MISSED" : "ABANDONED";
  else if (escalationOpen) state = "ESCALATED";
  else if (awaitingReply) state = wc.reopenedAt !== null ? "REOPENED" : "ACTIVE";
  else if (lastTeam && (lastTeam.s.handoff === "HIGH" || lastTeam.s.handoff === "MEDIUM") && last === lastTeam) state = "WAITING_INTERNAL";
  else state = wc.reopenedAt !== null ? "REOPENED" : "WAITING_CUSTOMER";

  const base = {
    id: caseId(wc.groupKey, opener.ts),
    groupKey: wc.groupKey,
    customer: opener.sender,
    customerName: opener.senderName,
    openedAt: opener.ts,
    openingMessageKey: opener.key,
    lastAt,
    closed,
    closedAt: closed ? lastAt + settings.caseGapMs : null,
    state,
    messageKeys: msgs.map(({ m }) => m.key),
    customerMessages,
    teamMessages,
    humanReplies,
    aiReplies,
    ruleReplies,
    turns,
    memberIds,
    firstHumanReplyAt: firstHuman?.ts ?? null,
    firstHumanReplyBy: firstHuman ? { actor: firstHuman.actor, memberId: firstHuman.memberId } : null,
    firstReplyAt: firstReply?.ts ?? null,
    firstReplyActor: firstReply?.actor ?? null,
    handoffs,
    escalated,
    resolution,
    supersededResolutions: wc.superseded,
    reopened: wc.reopenedAt !== null,
    reopenedAt: wc.reopenedAt,
    owner: ownershipOf(wc, resolution),
    awaitingReply,
  };
  const { complexity, reasons } = complexityOf(base);
  return { ...base, complexity, complexityReasons: reasons };
}

/**
 * Every case in the messages, group by group.
 *
 * A case OPENS at a customer message when no case is open in that group (a bare acknowledgement —
 * "ok", "ji vai", a thumbs-up — never opens one) — or REOPENS the group's
 * previous case when that case was resolved less than the reopen window ago AND the message carries
 * it on (quotes one of its messages, or says it is still broken). A customer message after a
 * resolution signal inside an open case either reopens it (the same continuity test) or, if it is
 * not a thank-you or confirmation, closes it and opens a new one: a new question after "it's fixed"
 * is a new problem, not the old one. A team message with no case open (a greeting, an announcement)
 * belongs to no case. A case closes after `caseGapMs` of silence.
 *
 * `measuredTo` is the period end, or now if the period has not ended: what has not been silent long
 * enough by then is still open.
 */
export function buildCases(messages: readonly IntelMessage[], measuredTo: number, settings: IntelSettings, facts: CaseFacts = NO_FACTS): SupportCase[] {
  const byGroup = new Map<string, IntelMessage[]>();
  for (const m of messages) {
    const list = byGroup.get(m.groupKey);
    if (list) list.push(m);
    else byGroup.set(m.groupKey, [m]);
  }
  const out: SupportCase[] = [];
  for (const [groupKey, list] of byGroup) {
    list.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
    const done: WorkingCase[] = [];
    let open: WorkingCase | null = null;
    const keysOf = (wc: WorkingCase) => new Set(wc.messages.map(({ m }) => m.key));
    const resolvedNow = (wc: WorkingCase, at: number) => evaluateResolution(wc, facts, at);

    for (const m of list) {
      const s = signalsOf(m);
      if (open && m.ts - open.messages[open.messages.length - 1]!.m.ts >= settings.caseGapMs) {
        done.push(open);
        open = null;
      }
      if (m.actor === "CUSTOMER") {
        if (open) {
          const prior = resolvedNow(open, m.ts);
          if (prior && !s.customerConfirm && !s.thanks && !s.acknowledgement) {
            if (continues(m, s, keysOf(open))) {
              open.superseded.push(prior);
              open.reopenedAt = m.ts;
              open.messages.push({ m, s });
            } else {
              done.push(open);
              open = { groupKey, messages: [{ m, s }], reopenedAt: null, superseded: [] };
            }
            continue;
          }
          open.messages.push({ m, s });
          continue;
        }
        const previous = done[done.length - 1];
        if (previous) {
          const lastAt = previous.messages[previous.messages.length - 1]!.m.ts;
          const prior = resolvedNow(previous, lastAt + settings.caseGapMs);
          if (prior && m.ts - lastAt <= settings.reopenWindowMs && continues(m, s, keysOf(previous))) {
            done.pop();
            previous.superseded.push(prior);
            previous.reopenedAt = m.ts;
            previous.messages.push({ m, s });
            open = previous;
            continue;
          }
        }
        // "ok", "thanks", "it's working now", a thumbs-up: nothing was asked, so nothing opens.
        if (isClosingRemark(m, s)) continue;
        open = { groupKey, messages: [{ m, s }], reopenedAt: null, superseded: [] };
      } else if (open) {
        open.messages.push({ m, s });
      }
    }
    if (open) done.push(open);
    for (const wc of done) out.push(finishCase(wc, measuredTo, settings, facts));
  }
  return out.sort((a, b) => a.openedAt - b.openedAt || a.groupKey.localeCompare(b.groupKey));
}

// ---------------------------------------------------------------------------------------------
// Sessions

export interface SupportSession2 {
  id: string;
  memberId: string;
  groupKey: string;
  start: number;
  end: number;
  messages: number;
  messageKeys: string[];
  /** Cases this session touched. */
  caseIds: string[];
  /** The state of the last case it touched, or ACTIVE while the employee is still within the gap. */
  state: CaseState | "NO_CASE";
}

/**
 * One employee's interaction with one group: their messages there, split wherever they went quiet in
 * that group for longer than the session gap. Starts at their first message and ends at their last,
 * so time spent waiting for a customer who never replied is not counted as work. A session of one
 * message lasts zero seconds — honest rather than flattering.
 *
 * Session TIME is never summed across groups (see observedTime): this list is for coverage, counts
 * and outcomes.
 */
export function buildSessions(messages: readonly IntelMessage[], cases: readonly SupportCase[], settings: Pick<IntelSettings, "sessionGapMs">): SupportSession2[] {
  const caseOf = new Map<string, SupportCase>();
  for (const c of cases) for (const k of c.messageKeys) caseOf.set(k, c);
  const byPair = new Map<string, IntelMessage[]>();
  for (const m of messages) {
    if (m.actor !== "MEMBER" || !m.memberId) continue;
    const k = `${m.memberId}|${m.groupKey}`;
    const list = byPair.get(k);
    if (list) list.push(m);
    else byPair.set(k, [m]);
  }
  const out: SupportSession2[] = [];
  for (const list of byPair.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let current: IntelMessage[] = [];
    const flush = () => {
      if (!current.length) return;
      const first = current[0]!;
      const touched = [...new Set(current.map((m) => caseOf.get(m.key)?.id).filter((id): id is string => Boolean(id)))];
      const lastCase = touched.length ? cases.find((c) => c.id === touched[touched.length - 1]) : undefined;
      out.push({
        id: `${first.memberId}|${first.groupKey}|${first.ts}`,
        memberId: first.memberId!,
        groupKey: first.groupKey,
        start: first.ts,
        end: current[current.length - 1]!.ts,
        messages: current.length,
        messageKeys: current.map((m) => m.key),
        caseIds: touched,
        state: lastCase ? lastCase.state : "NO_CASE",
      });
      current = [];
    };
    for (const m of list) {
      if (current.length && m.ts - current[current.length - 1]!.ts > settings.sessionGapMs) flush();
      current.push(m);
    }
    flush();
  }
  return out.sort((a, b) => a.start - b.start || a.memberId.localeCompare(b.memberId));
}

export interface ObservedTime {
  /** Seconds covered by at least one session — the union, never the sum. */
  observedSeconds: number;
  /** The sum of session durations, for reference: equal to observedSeconds only when nothing overlapped. */
  summedSessionSeconds: number;
  /** The most sessions running at one instant. */
  peakConcurrency: number;
  /** summedSessionSeconds ÷ observedSeconds — how many groups at once, on average, while working. Null with no time. */
  averageConcurrency: number | null;
  /** The merged intervals, for duty splitting. */
  intervals: Array<{ start: number; end: number }>;
}

/**
 * Observed Support Session Time for one employee: the union of their session intervals across every
 * group. Group A 10:00–10:30, B 10:10–10:40 and C 10:20–10:50 are 50 minutes of observed time, not 90
 * — while peak concurrency (3) and average concurrency (1.8) say they were handling three groups.
 */
export function observedTime(sessions: readonly Pick<SupportSession2, "start" | "end">[], bounds?: { start: number; end: number }): ObservedTime {
  const clipped = sessions
    .map((s) => ({ start: bounds ? Math.max(s.start, bounds.start) : s.start, end: bounds ? Math.min(s.end, bounds.end) : s.end }))
    .filter((s) => s.end >= s.start)
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of clipped) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const observedMs = merged.reduce((sum, i) => sum + (i.end - i.start), 0);
  const summedMs = clipped.reduce((sum, s) => sum + (s.end - s.start), 0);
  // Peak: sweep the start/end events; an end at the same instant as a start closes first.
  const events = clipped.flatMap((s) => (s.end > s.start ? [[s.start, 1], [s.end, -1]] : [[s.start, 1], [s.start, -1]]) as Array<[number, number]>);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  for (const [, delta] of events) {
    live += delta;
    peak = Math.max(peak, live);
  }
  return {
    observedSeconds: Math.round(observedMs / 1000),
    summedSessionSeconds: Math.round(summedMs / 1000),
    peakConcurrency: peak,
    averageConcurrency: observedMs > 0 ? Math.round((summedMs / observedMs) * 100) / 100 : null,
    intervals: merged,
  };
}

// ---------------------------------------------------------------------------------------------
// Human waits

export type HumanWaitStatus = "ON_TIME" | "LATE" | "MISSED" | "PENDING";

export interface HumanWait {
  groupKey: string;
  customer: string;
  askedAt: number;
  askedMessageKey: string;
  /** The first HUMAN reply — AI, rules and broadcasts never end a human wait. */
  repliedAt: number | null;
  repliedBy: { actor: IntelActor; memberId: string | null; operatorUserId: string | null } | null;
  /** The first automated reply inside the wait, if one came before a human did. */
  automatedFirstAt: number | null;
  automatedFirstActor: IntelActor | null;
  waitSeconds: number | null;
  thresholdSeconds: number;
  status: HumanWaitStatus;
}

/**
 * Human Response SLA waits. The same shape as the Team Report's wait — a run of customer lines is
 * one wait, measured from the first — with two differences. The point of it: only a HUMAN reply ends
 * it. And a closing remark ("thanks", "it's working now") does not start one, because nothing is
 * waiting for an answer. A customer answered by the AI at once and by a person forty minutes later waited
 * forty minutes for a person. The existing Response SLA, where any reply counts, is unchanged.
 *
 * Only waits starting inside [rangeStart, rangeEnd) count; replies are read from what was loaded
 * after it.
 */
export function humanWaits(
  messages: readonly IntelMessage[],
  opts: { rangeStart: number; rangeEnd: number; measuredTo: number; thresholdMs: (groupKey: string) => number },
): HumanWait[] {
  const byGroup = new Map<string, IntelMessage[]>();
  for (const m of messages) {
    const list = byGroup.get(m.groupKey);
    if (list) list.push(m);
    else byGroup.set(m.groupKey, [m]);
  }
  const out: HumanWait[] = [];
  for (const [groupKey, list] of byGroup) {
    list.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
    let open: HumanWait | null = null;
    const threshold = opts.thresholdMs(groupKey);
    for (const m of list) {
      if (m.actor === "CUSTOMER") {
        if (!open && !isClosingRemark(m)) {
          open = {
            groupKey,
            customer: m.sender,
            askedAt: m.ts,
            askedMessageKey: m.key,
            repliedAt: null,
            repliedBy: null,
            automatedFirstAt: null,
            automatedFirstActor: null,
            waitSeconds: null,
            thresholdSeconds: Math.round(threshold / 1000),
            status: "PENDING",
          };
        }
      } else if (open) {
        if (isHumanReply(m.actor)) {
          open.repliedAt = m.ts;
          open.repliedBy = { actor: m.actor, memberId: m.memberId, operatorUserId: m.operatorUserId };
          open.waitSeconds = Math.round((m.ts - open.askedAt) / 1000);
          open.status = m.ts - open.askedAt <= threshold ? "ON_TIME" : "LATE";
          out.push(open);
          open = null;
        } else if (open.automatedFirstAt === null) {
          open.automatedFirstAt = m.ts;
          open.automatedFirstActor = m.actor;
        }
      }
    }
    if (open) {
      open.status = opts.measuredTo - open.askedAt > threshold ? "MISSED" : "PENDING";
      out.push(open);
    }
  }
  return out.filter((w) => w.askedAt >= opts.rangeStart && w.askedAt < opts.rangeEnd).sort((a, b) => a.askedAt - b.askedAt);
}
