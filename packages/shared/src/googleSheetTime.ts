import { DHAKA_OFFSET_MS } from "./dhakaDay.js";

/**
 * Google Sheets, Phase 7 — work time and viewing time (GOOGLE_SHEETS.md §7). ONE pure function turns
 * the recorded signals into time; the page, the reports and their exports all call it, and nothing
 * stores its answer, so a figure can never drift from the evidence behind it.
 *
 * The rule (threshold T = the project's inactivity minutes, default 5):
 *   1. WORK time is built from work signals only. Inside one session, the gap between two consecutive
 *      work signals counts when it is ≤ T; a longer gap is a pause. Nothing after the last signal of a
 *      stretch is credited, and a stretch of a single signal is zero — honest, not flattering.
 *   2. PRESENCE is built the same way from every signal (start, view, work).
 *   3. VIEWING time = presence − work.
 *   4. Per person, intervals are UNIONED across all their sessions and sheets, never summed: two tabs
 *      open is one person working, not two.
 *
 * Every work signal is also a presence signal, so a person's work always lies inside their presence
 * and viewing can never be negative.
 */

export const SESSION_SIGNAL_KINDS = ["START", "VIEW_SIGNAL", "WORK_SIGNAL", "CLOSE"] as const;
export type SessionSignalKind = (typeof SESSION_SIGNAL_KINDS)[number];

export const DEFAULT_INACTIVITY_MINUTES = 5;
export const MIN_INACTIVITY_MINUTES = 1;
export const MAX_INACTIVITY_MINUTES = 60;
/** The browser sends a view or work signal at most this often; the server ignores anything faster. */
export const SIGNAL_INTERVAL_MS = 30_000;

export function clampInactivityMinutes(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_INACTIVITY_MINUTES;
  return Math.min(MAX_INACTIVITY_MINUTES, Math.max(MIN_INACTIVITY_MINUTES, Math.round(n)));
}

export interface SessionSignal {
  sessionId: string;
  userId: string;
  spreadsheetId: string;
  kind: SessionSignalKind;
  at: Date;
}

/** A half-open stretch of time [start, end), in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Stretches from one session's signal times (any order). Consecutive signals at most `maxGapMs`
 * apart join one stretch; a stretch is first signal → last signal.
 */
export function stretchesFromSignals(times: readonly number[], maxGapMs: number): Interval[] {
  if (times.length === 0) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const out: Interval[] = [];
  let start = sorted[0]!;
  let end = start;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!;
    if (t - end <= maxGapMs) {
      end = t;
    } else {
      if (end > start) out.push({ start, end });
      start = t;
      end = t;
    }
  }
  if (end > start) out.push({ start, end });
  return out;
}

/** Overlapping or touching intervals merged, sorted. */
export function unionIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else out.push({ ...interval });
  }
  return out;
}

/** The parts of each interval inside [from, to). */
export function clipIntervals(intervals: readonly Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  for (const i of intervals) {
    const start = Math.max(i.start, from);
    const end = Math.min(i.end, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}

export function totalMs(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** Work and presence stretches of ONE session. */
export function sessionIntervals(signals: readonly SessionSignal[], inactivityMinutes: number): { work: Interval[]; presence: Interval[] } {
  const maxGap = clampInactivityMinutes(inactivityMinutes) * 60_000;
  const presence = signals.filter((s) => s.kind !== "CLOSE").map((s) => s.at.getTime());
  const work = signals.filter((s) => s.kind === "WORK_SIGNAL").map((s) => s.at.getTime());
  return { work: stretchesFromSignals(work, maxGap), presence: stretchesFromSignals(presence, maxGap) };
}

export interface PersonTime {
  userId: string;
  workMs: number;
  viewingMs: number;
  presenceMs: number;
  /** Unioned stretches, for a by-day split or a timeline. */
  work: Interval[];
  presence: Interval[];
}

/**
 * Work, viewing and presence per person over [from, to): each session's stretches, clipped to the
 * period, unioned per person. Optionally restricted to one spreadsheet (the sheet report's figures
 * are this same union, per person, on that sheet).
 */
export function computeSheetTime(
  signals: readonly SessionSignal[],
  options: { inactivityMinutes: number; from: Date; to: Date; spreadsheetId?: string },
): Map<string, PersonTime> {
  const from = options.from.getTime();
  const to = options.to.getTime();
  const bySession = new Map<string, SessionSignal[]>();
  for (const signal of signals) {
    if (options.spreadsheetId && signal.spreadsheetId !== options.spreadsheetId) continue;
    const list = bySession.get(signal.sessionId);
    if (list) list.push(signal);
    else bySession.set(signal.sessionId, [signal]);
  }
  const perPerson = new Map<string, { work: Interval[]; presence: Interval[] }>();
  for (const sessionSignals of bySession.values()) {
    const userId = sessionSignals[0]!.userId;
    const { work, presence } = sessionIntervals(sessionSignals, options.inactivityMinutes);
    const entry = perPerson.get(userId) ?? { work: [], presence: [] };
    entry.work.push(...clipIntervals(work, from, to));
    entry.presence.push(...clipIntervals(presence, from, to));
    perPerson.set(userId, entry);
  }
  const out = new Map<string, PersonTime>();
  for (const [userId, entry] of perPerson) {
    const work = unionIntervals(entry.work);
    const presence = unionIntervals(entry.presence);
    const workMs = totalMs(work);
    const presenceMs = totalMs(presence);
    out.set(userId, { userId, work, presence, workMs, presenceMs, viewingMs: Math.max(0, presenceMs - workMs) });
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Dhaka calendar day (YYYY-MM-DD) an instant falls on. */
export function dhakaDayKey(ms: number): string {
  return new Date(ms + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Milliseconds of the intervals on each Dhaka calendar day — a stretch over midnight is split there. */
export function msByDhakaDay(intervals: readonly Interval[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const interval of intervals) {
    let start = interval.start;
    while (start < interval.end) {
      const dayEnd = Math.floor((start + DHAKA_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - DHAKA_OFFSET_MS;
      const end = Math.min(interval.end, dayEnd);
      const key = dhakaDayKey(start);
      out.set(key, (out.get(key) ?? 0) + (end - start));
      start = end;
    }
  }
  return out;
}

/**
 * Whether a session is live: a signal within the threshold. Sessions are never closed by a job — a
 * session that goes quiet simply stops being live, and its time ends at its last signal (§7 rule 6).
 */
export function isLive(lastSignalAt: Date, now: Date, inactivityMinutes: number): boolean {
  return now.getTime() - lastSignalAt.getTime() <= clampInactivityMinutes(inactivityMinutes) * 60_000;
}
