/**
 * Client subscriptions (CLIENTS_V3.md §3): the pure rules. Nothing here touches a database or a clock —
 * every caller passes "today" as a Dhaka `YYYY-MM-DD`.
 *
 * A subscription is a TERM of service ("Tiger IPTV, 17 Oct 2026 → 17 Nov 2026"), never money. Its expiry
 * is not a debt: an expired subscription that was paid for owes nothing, and an invoice can be overdue
 * while the service is still running. Money lives in ClientDue / ClientPayment; a due may point at the
 * subscription it bills, and that is the only connection.
 *
 * Dates: `startDate` is the first day of service, `endDate` the day it expires. The service runs while
 * today < endDate, so on the expiry day itself it reads "Expired 0 days ago" — a renewal made that day
 * starts on the same date and leaves no gap.
 */

export const SUBSCRIPTION_KINDS = ["PAID", "TRIAL", "DEMO", "COMPLIMENTARY"] as const;
export type SubscriptionKind = (typeof SUBSCRIPTION_KINDS)[number];

export const SUBSCRIPTION_KIND_LABELS: Record<SubscriptionKind, string> = {
  PAID: "Paid subscription",
  TRIAL: "Trial",
  DEMO: "Demo",
  COMPLIMENTARY: "Complimentary",
};

export const SUBSCRIPTION_DURATION_UNITS = ["DAY", "WEEK", "MONTH", "YEAR"] as const;
export type SubscriptionDurationUnit = (typeof SUBSCRIPTION_DURATION_UNITS)[number];

export const SUBSCRIPTION_DURATION_LABELS: Record<SubscriptionDurationUnit, [singular: string, plural: string]> = {
  DAY: ["day", "days"],
  WEEK: ["week", "weeks"],
  MONTH: ["month", "months"],
  YEAR: ["year", "years"],
};

/** The upper bound per unit: ten years in any unit. Longer is a typo, not a plan. */
const MAX_DURATION: Record<SubscriptionDurationUnit, number> = { DAY: 3660, WEEK: 522, MONTH: 120, YEAR: 10 };

/**
 * What a client's subscription looks like today. Derived at read time, never stored, so it moves with
 * the calendar by itself.
 *  - NONE       no subscription was ever recorded
 *  - SCHEDULED  the only term starts in the future (a renewal that follows a running term is ACTIVE)
 *  - TRIAL      a running trial or demo
 *  - ACTIVE     a running paid or complimentary term with more than the renewal window left
 *  - EXPIRING   a running paid/complimentary term inside the renewal window ("Renew soon")
 *  - EXPIRED    the latest term has ended
 *  - PAUSED     the latest term was paused by staff
 *  - CANCELLED  every term was cancelled
 */
export const SUBSCRIPTION_STATES = ["NONE", "SCHEDULED", "TRIAL", "ACTIVE", "EXPIRING", "EXPIRED", "PAUSED", "CANCELLED"] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const SUBSCRIPTION_STATE_LABELS: Record<SubscriptionState, string> = {
  NONE: "No subscription",
  SCHEDULED: "Starts later",
  TRIAL: "Trial",
  ACTIVE: "Active",
  EXPIRING: "Renew soon",
  EXPIRED: "Expired",
  PAUSED: "Paused",
  CANCELLED: "Cancelled",
};

/** The states a list filter can ask for. NONE is "no subscription" and is a filter too. */
export const isSubscriptionState = (v: unknown): v is SubscriptionState => typeof v === "string" && (SUBSCRIPTION_STATES as readonly string[]).includes(v);
export const isSubscriptionKind = (v: unknown): v is SubscriptionKind => typeof v === "string" && (SUBSCRIPTION_KINDS as readonly string[]).includes(v);
export const isSubscriptionDurationUnit = (v: unknown): v is SubscriptionDurationUnit =>
  typeof v === "string" && (SUBSCRIPTION_DURATION_UNITS as readonly string[]).includes(v);

export const DEFAULT_RENEWAL_WINDOW_DAYS = 7;
export const SUBSCRIPTION_LIMITS = { service: 120, note: 1000 } as const;

// ── Calendar arithmetic on `YYYY-MM-DD` ─────────────────────────────────────────────────────────

/** `YYYY-MM-DD` that is a real calendar day, or null. */
export function parseCalendarDay(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? m[0] : null;
}

const toUtc = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whole days from `a` to `b` (positive when b is later). */
export function calendarDaysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function addCalendarDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * 86_400_000);
}

/**
 * `day` plus a duration, calendar-aware: a month from 31 January is the last day of February (28 or
 * 29), never 3 March; a year from 29 February is 28 February. Weeks and days are exact.
 */
export function addDuration(day: string, value: number, unit: SubscriptionDurationUnit): string {
  if (unit === "DAY") return addCalendarDays(day, value);
  if (unit === "WEEK") return addCalendarDays(day, value * 7);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const months = unit === "YEAR" ? value * 12 : value;
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(year, month, Math.min(d, lastDay)));
}

export function describeDuration(value: number | null, unit: string | null): string {
  if (!value || !isSubscriptionDurationUnit(unit)) return "Custom dates";
  const [one, many] = SUBSCRIPTION_DURATION_LABELS[unit];
  return `${value} ${value === 1 ? one : many}`;
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────

export interface SubscriptionInput {
  service: string;
  kind: string;
  startDate: string;
  /** Either a duration … */
  durationValue: string;
  durationUnit: string;
  /** … or an explicit expiry date. When both are given the explicit date wins only if no duration was typed. */
  endDate: string;
  note: string;
}

export interface ValidSubscription {
  service: string;
  kind: SubscriptionKind;
  startDate: string;
  endDate: string;
  durationValue: number | null;
  durationUnit: SubscriptionDurationUnit | null;
  note: string | null;
}

/** True when the person typed anything subscription-shaped (the Add Client form's optional section). */
export function hasSubscriptionInput(input: Partial<SubscriptionInput>): boolean {
  return Boolean(input.service?.trim() || input.startDate?.trim() || input.durationValue?.trim() || input.endDate?.trim());
}

/**
 * One term. Service and a start are required; the end comes from a duration or is typed. Internally
 * consistent or refused — never half a subscription.
 */
export function validateSubscription(input: SubscriptionInput): { ok: true; value: ValidSubscription } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const service = input.service.trim();
  if (!service) errors.push("Name the service or plan.");
  else if (service.length > SUBSCRIPTION_LIMITS.service) errors.push(`The service name can be at most ${SUBSCRIPTION_LIMITS.service} characters.`);
  const kind = input.kind.trim() || "PAID";
  if (!isSubscriptionKind(kind)) errors.push("Choose the type of subscription.");
  const startDate = parseCalendarDay(input.startDate);
  if (!startDate) errors.push("Choose the start date.");

  let durationValue: number | null = null;
  let durationUnit: SubscriptionDurationUnit | null = null;
  let endDate: string | null = null;
  const rawValue = input.durationValue.trim();
  if (rawValue) {
    const n = Number(rawValue);
    const unit = input.durationUnit.trim();
    if (!Number.isInteger(n) || n < 1) errors.push("The duration must be a whole number of at least 1.");
    else if (!isSubscriptionDurationUnit(unit)) errors.push("Choose days, weeks, months or years.");
    else if (n > MAX_DURATION[unit]) errors.push(`At most ${MAX_DURATION[unit]} ${SUBSCRIPTION_DURATION_LABELS[unit][1]}.`);
    else {
      durationValue = n;
      durationUnit = unit;
      if (startDate) endDate = addDuration(startDate, n, unit);
    }
  } else if (input.endDate.trim()) {
    endDate = parseCalendarDay(input.endDate);
    if (!endDate) errors.push("The expiry date is not a real date.");
  } else {
    errors.push("Enter a duration or an expiry date.");
  }
  if (startDate && endDate && endDate <= startDate) errors.push("The expiry date must be after the start date.");
  if (startDate && endDate && calendarDaysBetween(startDate, endDate) > MAX_DURATION.DAY) errors.push("A single term can be at most ten years.");
  const note = input.note.trim();
  if (note.length > SUBSCRIPTION_LIMITS.note) errors.push(`The note can be at most ${SUBSCRIPTION_LIMITS.note} characters.`);

  if (errors.length || !startDate || !endDate || !isSubscriptionKind(kind)) return { ok: false, errors };
  return { ok: true, value: { service, kind, startDate, endDate, durationValue, durationUnit, note: note || null } };
}

// ── State ───────────────────────────────────────────────────────────────────────────────────────

export interface SubscriptionTerm {
  id: string;
  kind: string;
  startDate: string;
  endDate: string;
  pausedAt: Date | string | null;
  cancelledAt: Date | string | null;
  isRenewal: boolean;
}

/**
 * Which term speaks for the client: the latest-ending one that was not cancelled (ties: the later
 * start, then the id). Independent of today on purpose — it is stored as `Client.currentSubscriptionId`
 * and recomputed whenever a term changes, so sorting and filtering by expiry can run in the database.
 * "Latest ending" is "paid through": a renewal made early is what the client list should show.
 */
export function pickCurrentSubscription<T extends Pick<SubscriptionTerm, "id" | "startDate" | "endDate" | "cancelledAt">>(terms: readonly T[]): T | null {
  let best: T | null = null;
  for (const t of terms) {
    if (t.cancelledAt) continue;
    if (
      !best ||
      t.endDate > best.endDate ||
      (t.endDate === best.endDate && (t.startDate > best.startDate || (t.startDate === best.startDate && t.id > best.id)))
    ) {
      best = t;
    }
  }
  return best;
}

/** The state of ONE term, as of `today`. */
export function termState(term: SubscriptionTerm, today: string, renewalWindowDays = DEFAULT_RENEWAL_WINDOW_DAYS): SubscriptionState {
  if (term.cancelledAt) return "CANCELLED";
  if (term.pausedAt) return "PAUSED";
  if (today >= term.endDate) return "EXPIRED";
  if (today < term.startDate) return term.isRenewal ? "ACTIVE" : "SCHEDULED";
  if (term.kind === "TRIAL" || term.kind === "DEMO") return "TRIAL";
  return calendarDaysBetween(today, term.endDate) <= renewalWindowDays ? "EXPIRING" : "ACTIVE";
}

/**
 * The client-level state, from the current term (`pickCurrentSubscription`). A future-dated renewal
 * reads ACTIVE: the term it follows is still running. `anyCancelled` separates "never had one" from
 * "every one was cancelled".
 */
export function clientSubscriptionState(
  current: SubscriptionTerm | null,
  anyCancelled: boolean,
  today: string,
  renewalWindowDays = DEFAULT_RENEWAL_WINDOW_DAYS,
): SubscriptionState {
  if (!current) return anyCancelled ? "CANCELLED" : "NONE";
  return termState(current, today, renewalWindowDays);
}

/** "90 days remaining", "Expires today", "Expired 2 days ago", "Starts in 3 days". */
export function describeExpiry(startDate: string, endDate: string, today: string): string {
  if (today < startDate) {
    const n = calendarDaysBetween(today, startDate);
    return n === 1 ? "Starts tomorrow" : `Starts in ${n} days`;
  }
  const left = calendarDaysBetween(today, endDate);
  if (left > 1) return `${left} days remaining`;
  if (left === 1) return "1 day remaining";
  if (left === 0) return "Expires today";
  const ago = -left;
  return ago === 1 ? "Expired yesterday" : `Expired ${ago} days ago`;
}

/** Tone for an expiry date: an expired or about-to-expire term is highlighted. */
export function expiryTone(state: SubscriptionState): "danger" | "warning" | "neutral" {
  if (state === "EXPIRED") return "danger";
  if (state === "EXPIRING" || state === "TRIAL") return "warning";
  return "neutral";
}

/**
 * Where a renewal starts: at the old expiry when it has not passed (no gap and no overlap), otherwise
 * today (a lapsed client starts fresh — the days they were not served are not charged back).
 */
export function renewalStartDate(previousEndDate: string, today: string): string {
  return previousEndDate > today ? previousEndDate : today;
}

/** The renewal window a project chose, clamped to something a person would set: 0–90 days. */
export function clampRenewalWindow(raw: unknown): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.min(90, Math.max(0, n)) : DEFAULT_RENEWAL_WINDOW_DAYS;
}
