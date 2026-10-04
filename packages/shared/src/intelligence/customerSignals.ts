import { signalsOf, type IntelMessage, type SupportCase } from "./model.js";
import { textNamesMember, type AppreciationKind, type SignalConfidence } from "./textSignals.js";

/**
 * Customer appreciation and preference (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md stages 7–8).
 *
 * Two different strengths, kept apart on purpose:
 *   GENERAL_THANKS    "thanks", "ধন্যবাদ" — politeness, weighted half in any figure;
 *   EMPLOYEE_PRAISE   "আপনি অনেক ভালো support দেন", "great support" — a judgement about the help.
 *
 * Who it is for is decided by evidence, strongest first: a quote of the employee's message or an
 * @mention (HIGH), the employee's name in the text (MEDIUM), the only employee who replied in that
 * case (MEDIUM), several employees replied (LOW, attributed to the case owner). Addressed to
 * everyone ("thanks everyone", "সবাইকে ধন্যবাদ") it belongs to nobody. Only HIGH and MEDIUM ever
 * count toward an employee.
 */

export interface AppreciationSignal {
  messageKey: string;
  groupKey: string;
  at: number;
  customer: string;
  customerName: string | null;
  kind: AppreciationKind;
  memberId: string | null;
  confidence: SignalConfidence | null;
  attribution: string;
  text: string;
  caseId: string | null;
}

export interface PreferenceSignal {
  messageKey: string;
  groupKey: string;
  at: number;
  customer: string;
  memberId: string;
  confidence: SignalConfidence;
  /** EXPLICIT_REQUEST ("rahim vai ke din", "আপনার কাছেই support নিতে চাই") or REPEATED_PRAISE. */
  kind: "EXPLICIT_REQUEST" | "REPEATED_PRAISE";
  attribution: string;
  text: string;
}

interface Attribution {
  memberId: string | null;
  confidence: SignalConfidence | null;
  attribution: string;
}

function caseFor(m: IntelMessage, cases: readonly SupportCase[]): SupportCase | null {
  return cases.find((c) => c.groupKey === m.groupKey && c.messageKeys.includes(m.key)) ?? null;
}

/** The latest case in the group that ended before this message, within the case gap — "thanks" after a case closed. */
function caseBefore(m: IntelMessage, cases: readonly SupportCase[], gapMs: number): SupportCase | null {
  let best: SupportCase | null = null;
  for (const c of cases) {
    if (c.groupKey !== m.groupKey || c.lastAt > m.ts || m.ts - c.lastAt > gapMs) continue;
    if (!best || c.lastAt > best.lastAt) best = c;
  }
  return best;
}

function attribute(
  m: IntelMessage,
  genericTeam: boolean,
  praise: boolean,
  theCase: SupportCase | null,
  memberNames: ReadonlyMap<string, string>,
): Attribution {
  if (m.quotedMemberId) return { memberId: m.quotedMemberId, confidence: "HIGH", attribution: "Quotes this employee's message" };
  if (m.mentionedMemberIds.length === 1) return { memberId: m.mentionedMemberIds[0]!, confidence: "HIGH", attribution: "@mentions this employee" };
  if (m.text) {
    const named = [...memberNames].filter(([, name]) => textNamesMember(m.text!, name)).map(([id]) => id);
    if (named.length === 1) return { memberId: named[0]!, confidence: "MEDIUM", attribution: "Names this employee" };
  }
  if (genericTeam) return { memberId: null, confidence: null, attribution: "Addressed to everyone — not attributed to one employee" };
  if (!theCase || theCase.memberIds.length === 0) return { memberId: null, confidence: null, attribution: "No employee replied in this conversation" };
  if (theCase.memberIds.length === 1) {
    return { memberId: theCase.memberIds[0]!, confidence: "MEDIUM", attribution: praise ? "The only employee who helped in this case" : "The only employee who replied in this case" };
  }
  return { memberId: theCase.owner?.memberId ?? null, confidence: "LOW", attribution: `${theCase.memberIds.length} employees replied in this case; attributed to its owner with low confidence` };
}

export function appreciationSignals(
  messages: readonly IntelMessage[],
  cases: readonly SupportCase[],
  memberNames: ReadonlyMap<string, string>,
  opts: { rangeStart: number; rangeEnd: number; caseGapMs: number },
): AppreciationSignal[] {
  const out: AppreciationSignal[] = [];
  for (const m of messages) {
    if (m.actor !== "CUSTOMER" || !m.text || m.ts < opts.rangeStart || m.ts >= opts.rangeEnd) continue;
    const s = signalsOf(m);
    if (!s.thanks && !s.praise) continue;
    const theCase = caseFor(m, cases) ?? caseBefore(m, cases, opts.caseGapMs);
    const a = attribute(m, s.genericTeam, s.praise, theCase, memberNames);
    out.push({
      messageKey: m.key,
      groupKey: m.groupKey,
      at: m.ts,
      customer: m.sender,
      customerName: m.senderName,
      kind: s.praise ? "EMPLOYEE_PRAISE" : "GENERAL_THANKS",
      memberId: a.memberId,
      confidence: a.confidence,
      attribution: a.attribution,
      text: m.text,
      caseId: theCase?.id ?? null,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Counted toward an employee: HIGH or MEDIUM attribution. Praise weighs 1, general thanks 0.5. */
export function countsTowardEmployee(s: Pick<AppreciationSignal, "confidence" | "memberId">): boolean {
  return s.memberId !== null && (s.confidence === "HIGH" || s.confidence === "MEDIUM");
}
export const appreciationWeight = (s: Pick<AppreciationSignal, "kind">) => (s.kind === "EMPLOYEE_PRAISE" ? 1 : 0.5);

export function preferenceSignals(
  messages: readonly IntelMessage[],
  cases: readonly SupportCase[],
  appreciation: readonly AppreciationSignal[],
  memberNames: ReadonlyMap<string, string>,
  opts: { rangeStart: number; rangeEnd: number; caseGapMs: number },
): PreferenceSignal[] {
  const out: PreferenceSignal[] = [];
  for (const m of messages) {
    if (m.actor !== "CUSTOMER" || !m.text || m.ts < opts.rangeStart || m.ts >= opts.rangeEnd) continue;
    const s = signalsOf(m);
    if (!s.preference) continue;
    const theCase = caseFor(m, cases) ?? caseBefore(m, cases, opts.caseGapMs);
    const a = attribute(m, s.genericTeam, true, theCase, memberNames);
    if (!a.memberId || !a.confidence || a.confidence === "LOW") continue;
    out.push({ messageKey: m.key, groupKey: m.groupKey, at: m.ts, customer: m.sender, memberId: a.memberId, confidence: a.confidence, kind: "EXPLICIT_REQUEST", attribution: a.attribution, text: m.text });
  }
  for (const p of appreciation) {
    if (p.kind !== "EMPLOYEE_PRAISE" || !countsTowardEmployee(p) || out.some((o) => o.messageKey === p.messageKey)) continue;
    out.push({ messageKey: p.messageKey, groupKey: p.groupKey, at: p.at, customer: p.customer, memberId: p.memberId!, confidence: p.confidence!, kind: "REPEATED_PRAISE", attribution: p.attribution, text: p.text });
  }
  return out.sort((a, b) => a.at - b.at);
}

export const PREFERENCE_MIN_INTERACTIONS = 5;
export const PREFERENCE_MIN_SIGNALS = 2;

export interface CustomerPreference {
  customer: string;
  customerName: string | null;
  memberId: string;
  /** Cases this customer opened that this employee took part in. */
  interactions: number;
  signals: number;
  groupKeys: string[];
  status: "PREFERRED" | "INSUFFICIENT_SAMPLE";
}

/**
 * A customer prefers an employee only with enough evidence: at least five cases together AND at least
 * two explicit signals (a request by name, or praise attributed to them). Below that the pair is an
 * insufficient sample — never a negative mark on anyone.
 */
export function customerPreferences(cases: readonly SupportCase[], signals: readonly PreferenceSignal[]): CustomerPreference[] {
  const pairs = new Map<string, CustomerPreference>();
  const key = (customer: string, memberId: string) => `${customer}|${memberId}`;
  for (const c of cases) {
    for (const memberId of c.memberIds) {
      const k = key(c.customer, memberId);
      const row = pairs.get(k) ?? { customer: c.customer, customerName: c.customerName, memberId, interactions: 0, signals: 0, groupKeys: [], status: "INSUFFICIENT_SAMPLE" as const };
      row.interactions += 1;
      if (!row.groupKeys.includes(c.groupKey)) row.groupKeys.push(c.groupKey);
      pairs.set(k, row);
    }
  }
  for (const s of signals) {
    const k = key(s.customer, s.memberId);
    const row = pairs.get(k) ?? { customer: s.customer, customerName: null, memberId: s.memberId, interactions: 0, signals: 0, groupKeys: [s.groupKey], status: "INSUFFICIENT_SAMPLE" as const };
    row.signals += 1;
    pairs.set(k, row);
  }
  return [...pairs.values()]
    .filter((p) => p.signals > 0)
    .map((p) => ({ ...p, status: p.interactions >= PREFERENCE_MIN_INTERACTIONS && p.signals >= PREFERENCE_MIN_SIGNALS ? ("PREFERRED" as const) : ("INSUFFICIENT_SAMPLE" as const) }))
    .sort((a, b) => (a.status === b.status ? b.signals - a.signals || b.interactions - a.interactions : a.status === "PREFERRED" ? -1 : 1));
}
