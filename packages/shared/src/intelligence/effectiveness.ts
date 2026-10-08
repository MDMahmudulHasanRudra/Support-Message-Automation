import { formatDhakaDateKey } from "../dhakaDay.js";
import { appreciationWeight, countsTowardEmployee, type AppreciationSignal, type CustomerPreference } from "./customerSignals.js";
import { observedTime, type HumanWait, type ObservedTime, type SupportCase, type SupportSession2 } from "./model.js";

/**
 * Employee effectiveness (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md stages 6, 10–11).
 *
 * Not a message count and not a black box. Every employee gets raw metrics (always shown), eight
 * dimension scores (each with its formula, raw value, sample and whether it counted) and — only when
 * the sample is large enough and the days verified — an overall Support Effectiveness score with the
 * weights, the positive and negative factors, and what was missing.
 *
 * Fairness, by construction:
 *   - rates, never totals — more groups or more messages never raise a score by themselves;
 *   - every rate is SHRUNK toward the team's rate in proportion to its sample (an empirical-Bayes
 *     prior of k observations), so 3 perfect cases sit near the team average while 200 good ones
 *     earn their distance from it;
 *   - a dimension with no opportunity (no hand-offs, say) is left out and the weights renormalised —
 *     never scored 0;
 *   - time outside duty is shown, never scored;
 *   - below the eligibility threshold the answer is INSUFFICIENT SAMPLE, not a low score.
 */

// ---------------------------------------------------------------------------------------------
// Duty split

export interface DutyWindow {
  /** The Dhaka day the shift starts on. */
  day: string;
  start: number;
  end: number;
}

export interface DutySplit {
  scheduledSeconds: number;
  inDutySeconds: number;
  beforeShiftSeconds: number;
  afterShiftSeconds: number;
  offDaySeconds: number;
}

/**
 * Observed support intervals cut against shift windows. Inside a window is "during duty". Outside it,
 * on a day that has a shift, time before the shift's start is "before shift" and after its end is
 * "after shift"; on a day with no shift it is "off-day". A cross-midnight shift belongs to the day it
 * starts, as Duty History reads it.
 */
export function splitByDuty(intervals: ReadonlyArray<{ start: number; end: number }>, windows: readonly DutyWindow[]): DutySplit {
  const scheduledMs = windows.reduce((sum, w) => sum + (w.end - w.start), 0);
  let inMs = 0;
  let beforeMs = 0;
  let afterMs = 0;
  let offMs = 0;
  const dayStarts = new Map<string, DutyWindow[]>();
  for (const w of windows) dayStarts.set(w.day, [...(dayStarts.get(w.day) ?? []), w]);
  for (const iv of intervals) {
    // Walk the interval in pieces split at every window edge.
    const cuts = new Set<number>([iv.start, iv.end]);
    for (const w of windows) {
      if (w.start > iv.start && w.start < iv.end) cuts.add(w.start);
      if (w.end > iv.start && w.end < iv.end) cuts.add(w.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const mid = (a + b) / 2;
      if (windows.some((w) => mid >= w.start && mid < w.end)) {
        inMs += b - a;
        continue;
      }
      const day = formatDhakaDateKey(new Date(mid));
      const same = dayStarts.get(day);
      if (!same) {
        offMs += b - a;
        continue;
      }
      const firstStart = Math.min(...same.map((w) => w.start));
      if (mid < firstStart) beforeMs += b - a;
      else afterMs += b - a;
    }
  }
  const s = (ms: number) => Math.round(ms / 1000);
  return { scheduledSeconds: s(scheduledMs), inDutySeconds: s(inMs), beforeShiftSeconds: s(beforeMs), afterShiftSeconds: s(afterMs), offDaySeconds: s(offMs) };
}

// ---------------------------------------------------------------------------------------------
// Metrics

export interface EmployeeMetrics {
  memberId: string;
  observed: ObservedTime;
  sessions: number;
  groups: number;
  activeDays: number;
  /** Active days that are verified and touched by no incomplete collection gap. */
  verifiedActiveDays: number;
  waitsHandled: number;
  waitsOnTime: number;
  waitsLate: number;
  medianResponseSeconds: number | null;
  /** Human waits that ended MISSED in groups assigned to this employee — the Team Report's charging rule. */
  missedCharged: number;
  casesParticipated: number;
  casesOwned: number;
  /** Owned cases resolved with HIGH or MEDIUM evidence. */
  resolvedOwned: number;
  resolvedOwnedHigh: number;
  reopenedOwned: number;
  complexOwned: number;
  handoffsStated: number;
  handoffsReturned: number;
  handoffsResolved: number;
  appreciationPraise: number;
  appreciationThanks: number;
  appreciationWeighted: number;
  preferredByCustomers: number;
  duty: DutySplit;
}

export interface EffectivenessInput {
  memberIds: readonly string[];
  cases: readonly SupportCase[];
  sessions: readonly SupportSession2[];
  waits: readonly HumanWait[];
  appreciation: readonly AppreciationSignal[];
  preferences: readonly CustomerPreference[];
  dutyWindows: ReadonlyMap<string, readonly DutyWindow[]>;
  assignedMemberFor: (groupKey: string) => string | null;
  rangeStart: number;
  rangeEnd: number;
  /** Days (Dhaka keys) whose data is not verified — before verified-from, or touched by an incomplete gap. */
  unverifiedDays: ReadonlySet<string>;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

export function employeeMetrics(input: EffectivenessInput): EmployeeMetrics[] {
  return input.memberIds.map((memberId) => {
    const sessions = input.sessions.filter((s) => s.memberId === memberId && s.end >= input.rangeStart && s.start < input.rangeEnd);
    const observed = observedTime(sessions, { start: input.rangeStart, end: input.rangeEnd });
    const days = new Set(sessions.map((s) => formatDhakaDateKey(new Date(Math.max(s.start, input.rangeStart)))));
    const waits = input.waits.filter((w) => w.repliedBy?.memberId === memberId);
    const owned = input.cases.filter((c) => c.owner?.memberId === memberId);
    const resolved = owned.filter((c) => c.resolution && c.resolution.confidence !== "LOW");
    const mine = input.appreciation.filter((a) => a.memberId === memberId && countsTowardEmployee(a));
    const handoffCases = input.cases.filter((c) => c.handoffs.some((h) => h.memberId === memberId && h.confidence !== "LOW"));
    return {
      memberId,
      observed,
      sessions: sessions.length,
      groups: new Set(sessions.map((s) => s.groupKey)).size,
      activeDays: days.size,
      verifiedActiveDays: [...days].filter((d) => !input.unverifiedDays.has(d)).length,
      waitsHandled: waits.length,
      waitsOnTime: waits.filter((w) => w.status === "ON_TIME").length,
      waitsLate: waits.filter((w) => w.status === "LATE").length,
      medianResponseSeconds: median(waits.map((w) => w.waitSeconds ?? 0)),
      missedCharged: input.waits.filter((w) => w.status === "MISSED" && input.assignedMemberFor(w.groupKey) === memberId).length,
      casesParticipated: input.cases.filter((c) => c.memberIds.includes(memberId)).length,
      casesOwned: owned.length,
      resolvedOwned: resolved.length,
      resolvedOwnedHigh: resolved.filter((c) => c.resolution!.confidence === "HIGH").length,
      reopenedOwned: owned.filter((c) => c.reopened).length,
      complexOwned: owned.filter((c) => c.complexity === "COMPLEX").length,
      handoffsStated: handoffCases.length,
      handoffsReturned: handoffCases.filter((c) => c.handoffs.some((h) => h.memberId === memberId && h.confidence !== "LOW" && h.returned)).length,
      handoffsResolved: handoffCases.filter((c) => c.resolution && c.resolution.confidence !== "LOW").length,
      appreciationPraise: mine.filter((a) => a.kind === "EMPLOYEE_PRAISE").length,
      appreciationThanks: mine.filter((a) => a.kind === "GENERAL_THANKS").length,
      appreciationWeighted: mine.reduce((sum, a) => sum + appreciationWeight(a), 0),
      preferredByCustomers: input.preferences.filter((p) => p.memberId === memberId && p.status === "PREFERRED").length,
      duty: splitByDuty(observed.intervals, input.dutyWindows.get(memberId) ?? []),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Scores

export const DIMENSIONS = ["response", "resolution", "ownership", "efficiency", "reliability", "appreciation", "handoff", "complexity"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_WEIGHTS: Record<Dimension, number> = {
  response: 20,
  resolution: 20,
  ownership: 15,
  efficiency: 15,
  reliability: 10,
  appreciation: 10,
  handoff: 5,
  complexity: 5,
};

export const DIMENSION_LABELS: Record<Dimension, string> = {
  response: "Human response (SLA)",
  resolution: "Resolution",
  ownership: "Ownership",
  efficiency: "Efficiency",
  reliability: "Reliability (not reopened)",
  appreciation: "Customer appreciation",
  handoff: "Hand-off follow-through",
  complexity: "Complex cases",
};

export const DIMENSION_FORMULAS: Record<Dimension, string> = {
  response: "Human waits answered within the SLA ÷ human waits answered (shrunk toward the team rate).",
  resolution: "Owned cases resolved with High or Medium evidence ÷ cases owned (shrunk).",
  ownership: "Cases owned ÷ cases taken part in (shrunk).",
  efficiency: "Resolved owned cases per hour of Observed Support Session Time, against the team rate: 50 = team average (shrunk by 5 pseudo-hours).",
  reliability: "Owned cases NOT reopened ÷ cases owned (shrunk).",
  appreciation: "Attributed appreciation per case taken part in (praise 1, thanks 0.5), against the team rate: 50 = team average (shrunk).",
  handoff: "Cases with a stated hand-off that ended resolved ÷ cases with a stated hand-off (shrunk).",
  complexity: "Owned cases classified Complex ÷ cases owned (shrunk).",
};

/** Pseudo-observations the shrinkage adds at the team rate. */
export const SHRINK_K = 10;
export const SHRINK_HOURS = 5;
export const ELIGIBILITY = { minWaitsHandled: 20, minVerifiedActiveDays: 3 } as const;

export interface DimensionScore {
  dimension: Dimension;
  label: string;
  /** 0–100, or null when there was no opportunity. */
  score: number | null;
  /** The raw ratio before shrinkage, in words ("14 of 18"). */
  raw: string;
  /** The denominator the score rests on. */
  sample: number;
  weight: number;
  counted: boolean;
}

export type EffectivenessConfidence = "HIGH" | "MEDIUM" | "INSUFFICIENT_SAMPLE";

export interface EmployeeEffectiveness {
  memberId: string;
  metrics: EmployeeMetrics;
  dimensions: DimensionScore[];
  eligible: boolean;
  /** Why not, when not. */
  eligibilityNote: string | null;
  /** Null unless eligible. */
  score: number | null;
  confidence: EffectivenessConfidence;
  positives: string[];
  negatives: string[];
  missing: string[];
}

const shrink = (successes: number, n: number, teamRate: number, k = SHRINK_K) => (successes + k * teamRate) / (n + k);

function teamRates(all: readonly EmployeeMetrics[]) {
  const sum = (pick: (m: EmployeeMetrics) => number) => all.reduce((s, m) => s + pick(m), 0);
  const ratio = (a: number, b: number, fallback: number) => (b > 0 ? a / b : fallback);
  const hours = sum((m) => m.observed.observedSeconds) / 3600;
  return {
    response: ratio(sum((m) => m.waitsOnTime), sum((m) => m.waitsHandled), 0.5),
    resolution: ratio(sum((m) => m.resolvedOwned), sum((m) => m.casesOwned), 0.5),
    ownership: ratio(sum((m) => m.casesOwned), sum((m) => m.casesParticipated), 0.5),
    efficiencyPerHour: ratio(sum((m) => m.resolvedOwned), hours, 0),
    reliability: ratio(sum((m) => m.casesOwned - m.reopenedOwned), sum((m) => m.casesOwned), 0.9),
    appreciationPerCase: ratio(sum((m) => m.appreciationWeighted), sum((m) => m.casesParticipated), 0),
    handoff: ratio(sum((m) => m.handoffsResolved), sum((m) => m.handoffsStated), 0.5),
    complexity: ratio(sum((m) => m.complexOwned), sum((m) => m.casesOwned), 0.1),
  };
}

const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10;
/** Relative-to-team scale: the team rate maps to 50, twice the team rate (or more) to 100. */
const relative = (v: number, team: number) => (team > 0 ? Math.round(Math.min(100, (50 * v) / team) * 10) / 10 : v > 0 ? 100 : 50);

export function effectivenessOf(all: readonly EmployeeMetrics[]): EmployeeEffectiveness[] {
  const team = teamRates(all);
  return all.map((m) => {
    const hours = m.observed.observedSeconds / 3600;
    const dims: DimensionScore[] = [
      { dimension: "response", sample: m.waitsHandled, raw: `${m.waitsOnTime} of ${m.waitsHandled} on time`, score: m.waitsHandled ? pct(shrink(m.waitsOnTime, m.waitsHandled, team.response)) : null },
      { dimension: "resolution", sample: m.casesOwned, raw: `${m.resolvedOwned} of ${m.casesOwned} resolved`, score: m.casesOwned ? pct(shrink(m.resolvedOwned, m.casesOwned, team.resolution)) : null },
      { dimension: "ownership", sample: m.casesParticipated, raw: `${m.casesOwned} owned of ${m.casesParticipated}`, score: m.casesParticipated ? pct(shrink(m.casesOwned, m.casesParticipated, team.ownership)) : null },
      {
        dimension: "efficiency",
        sample: Math.round(hours * 10) / 10,
        raw: `${m.resolvedOwned} resolved in ${Math.round(hours * 10) / 10} h`,
        score: hours > 0 ? relative((m.resolvedOwned + SHRINK_HOURS * team.efficiencyPerHour) / (hours + SHRINK_HOURS), team.efficiencyPerHour) : null,
      },
      { dimension: "reliability", sample: m.casesOwned, raw: `${m.reopenedOwned} of ${m.casesOwned} reopened`, score: m.casesOwned ? pct(shrink(m.casesOwned - m.reopenedOwned, m.casesOwned, team.reliability)) : null },
      {
        dimension: "appreciation",
        sample: m.casesParticipated,
        raw: `${m.appreciationPraise} praise, ${m.appreciationThanks} thanks over ${m.casesParticipated} cases`,
        score: m.casesParticipated ? relative(shrink(m.appreciationWeighted, m.casesParticipated, team.appreciationPerCase), team.appreciationPerCase) : null,
      },
      { dimension: "handoff", sample: m.handoffsStated, raw: `${m.handoffsResolved} of ${m.handoffsStated} resolved`, score: m.handoffsStated ? pct(shrink(m.handoffsResolved, m.handoffsStated, team.handoff)) : null },
      { dimension: "complexity", sample: m.casesOwned, raw: `${m.complexOwned} of ${m.casesOwned} complex`, score: m.casesOwned ? pct(shrink(m.complexOwned, m.casesOwned, team.complexity)) : null },
    ].map((d) => ({ ...d, dimension: d.dimension as Dimension, label: DIMENSION_LABELS[d.dimension as Dimension], weight: DIMENSION_WEIGHTS[d.dimension as Dimension], counted: d.score !== null }));

    const eligible = m.waitsHandled >= ELIGIBILITY.minWaitsHandled && m.verifiedActiveDays >= ELIGIBILITY.minVerifiedActiveDays;
    const reasons: string[] = [];
    if (m.waitsHandled < ELIGIBILITY.minWaitsHandled) reasons.push(`${m.waitsHandled} of ${ELIGIBILITY.minWaitsHandled} human waits handled`);
    if (m.verifiedActiveDays < ELIGIBILITY.minVerifiedActiveDays) reasons.push(`${m.verifiedActiveDays} of ${ELIGIBILITY.minVerifiedActiveDays} verified active days`);
    const counted = dims.filter((d) => d.counted);
    const weightSum = counted.reduce((s, d) => s + d.weight, 0);
    const score = eligible && weightSum > 0 ? Math.round((counted.reduce((s, d) => s + d.score! * d.weight, 0) / weightSum) * 10) / 10 : null;
    const confidence: EffectivenessConfidence = !eligible ? "INSUFFICIENT_SAMPLE" : m.waitsHandled >= 100 && m.verifiedActiveDays >= 10 ? "HIGH" : "MEDIUM";
    return {
      memberId: m.memberId,
      metrics: m,
      dimensions: dims,
      eligible,
      eligibilityNote: eligible ? null : `Insufficient sample: ${reasons.join("; ")}.`,
      score,
      confidence,
      positives: counted.filter((d) => d.score! >= 70).map((d) => `${d.label} ${d.score} (${d.raw})`),
      negatives: counted.filter((d) => d.score! <= 40).map((d) => `${d.label} ${d.score} (${d.raw})`),
      missing: dims.filter((d) => !d.counted).map((d) => `${d.label}: no opportunity in this period`),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Leaderboards

export const LEADERBOARDS = [
  { id: "overall", label: "Best overall effectiveness", metric: "Support Effectiveness score" },
  { id: "active", label: "Most active", metric: "Support sessions (then active days, groups)" },
  { id: "efficient", label: "Most efficient", metric: "Efficiency score" },
  { id: "sla", label: "Best human SLA", metric: "Human response score" },
  { id: "resolver", label: "Strongest resolver", metric: "Resolution score" },
  { id: "ownership", label: "Strongest ownership", metric: "Ownership score" },
  { id: "favorite", label: "Customer favourite", metric: "Customers who prefer them, then appreciation score" },
  { id: "complex", label: "High-complexity handler", metric: "Complex-case score" },
] as const;
export type LeaderboardId = (typeof LEADERBOARDS)[number]["id"];

const dim = (e: EmployeeEffectiveness, d: Dimension) => e.dimensions.find((x) => x.dimension === d)?.score ?? -1;

/** Separate rankings, eligible employees only. Never one merged list. */
export function leaderboard(rows: readonly EmployeeEffectiveness[], id: LeaderboardId): EmployeeEffectiveness[] {
  const eligible = rows.filter((r) => r.eligible);
  const by = (value: (e: EmployeeEffectiveness) => number, tie?: (e: EmployeeEffectiveness) => number) =>
    [...eligible].filter((e) => value(e) >= 0).sort((a, b) => value(b) - value(a) || (tie ? tie(b) - tie(a) : 0) || a.memberId.localeCompare(b.memberId));
  switch (id) {
    case "overall":
      return by((e) => e.score ?? -1);
    case "active":
      return by((e) => e.metrics.sessions, (e) => e.metrics.activeDays * 1000 + e.metrics.groups);
    case "efficient":
      return by((e) => dim(e, "efficiency"));
    case "sla":
      return by((e) => dim(e, "response"));
    case "resolver":
      return by((e) => dim(e, "resolution"));
    case "ownership":
      return by((e) => dim(e, "ownership"));
    case "favorite":
      return by((e) => e.metrics.preferredByCustomers * 1000 + Math.max(0, dim(e, "appreciation")));
    case "complex":
      return by((e) => dim(e, "complexity"));
  }
}

/**
 * Activity against efficiency, so volume is never mistaken for effectiveness: busy but below the
 * team's efficiency, or efficient on lighter volume. Eligible employees only; the split is the median
 * session count among them.
 */
export function volumeEfficiencyNote(e: EmployeeEffectiveness, all: readonly EmployeeEffectiveness[]): string | null {
  const eligible = all.filter((r) => r.eligible);
  if (!e.eligible || eligible.length < 3) return null;
  const counts = eligible.map((r) => r.metrics.sessions).sort((a, b) => a - b);
  const mid = counts[Math.floor(counts.length / 2)]!;
  const eff = dim(e, "efficiency");
  if (e.metrics.sessions >= mid && eff >= 0 && eff < 40) return "Active, but resolves fewer cases per hour than the team";
  if (e.metrics.sessions < mid && eff >= 60) return "Efficient despite lower volume";
  return null;
}
