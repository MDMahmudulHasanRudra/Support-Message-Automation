/**
 * Smart Bulk Import — where a subscription's expiry comes from (SMART_IMPORT.md §11). Pure.
 *
 * A file can say when a client's service expires in four ways: one complete date, separate year /
 * month / day columns, a start date plus a duration, or only a month and a year. This module turns
 * whichever the file uses into ONE exact `YYYY-MM-DD`, or into an issue the person must resolve:
 *   - a missing day is never invented — only the explicitly chosen "last day of the month" policy fills it;
 *   - a start date is never invented — an expiry with no start becomes a RECORDED expiry on the client,
 *     labelled as such, never a subscription term;
 *   - a duration and an explicit expiry that disagree are never silently reconciled.
 * Dates are read by the import's own `parseImportDate` and durations computed by the subscriptions'
 * own calendar-aware `addDuration`, so this adds no second date or duration rule.
 */

import type { ClientImportFieldKey } from "./clients.js";
import { parseDurationUnit, parseImportDate } from "./clientImportExtras.js";
import { addDuration, SUBSCRIPTION_DURATION_LABELS } from "./clientSubscriptions.js";

export const EXPIRY_PART_KEYS = ["expiryYear", "expiryMonth", "expiryDay"] as const;
export type ExpiryPartKey = (typeof EXPIRY_PART_KEYS)[number];
export const EXPIRY_PART_LABELS: Record<ExpiryPartKey, string> = { expiryYear: "Expiry year", expiryMonth: "Expiry month", expiryDay: "Expiry day" };
export const EXPIRY_PART_SYNONYMS: Record<ExpiryPartKey, readonly string[]> = {
  expiryYear: ["expiry year", "expire year", "expiration year", "expiry yr", "exp year", "exp yr", "expiry yyyy"],
  expiryMonth: ["expiry month", "expire month", "expiration month", "exp month", "expiry mon", "expiry mm"],
  expiryDay: ["expiry day", "expire day", "expiration day", "exp day", "exp date day", "expiry dd"],
};

/** How the expiry is entered — a choice in the mapping editor; the rules below follow the mapped columns. */
export const EXPIRY_MODES = ["DATE", "PARTS", "DURATION", "MONTH_YEAR"] as const;
export type ExpiryMode = (typeof EXPIRY_MODES)[number];

/** A month and year with no day: the day must be given, or the last day of the month explicitly chosen. */
export const MONTH_YEAR_POLICIES = ["REQUIRE_DAY", "LAST_DAY"] as const;
export type MonthYearPolicy = (typeof MONTH_YEAR_POLICIES)[number];

/** When a file's expiry and start + duration disagree: keep the row in review, or use one of them for every row. */
export const EXPIRY_CONFLICT_RULES = ["ASK", "SOURCE", "CALCULATED"] as const;
export type ExpiryConflictRule = (typeof EXPIRY_CONFLICT_RULES)[number];

export interface SmartExpiryOptions {
  expiryMode?: ExpiryMode;
  monthYearPolicy?: MonthYearPolicy;
  expiryConflict?: ExpiryConflictRule;
}

export const EXPIRY_YEAR_RANGE = { min: 1990, max: 2100 } as const;

export type IssueSeverity = "error" | "warning" | "info";
export interface FieldIssue {
  field: ClientImportFieldKey;
  severity: IssueSeverity;
  message: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const lastDayOf = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function monthNumber(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? n : null;
  }
  const i = MONTHS.indexOf(t.slice(0, 3));
  return i >= 0 && t.length >= 3 && (t.length === 3 || MONTHS[i] === t.slice(0, 3)) ? i + 1 : null;
}

function yearNumber(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{4}$/.test(t)) return null; // "27" is never read as 2027: the century would be a guess
  const n = Number(t);
  return n >= EXPIRY_YEAR_RANGE.min && n <= EXPIRY_YEAR_RANGE.max ? n : null;
}

/** "July 2027", "Jul-2027", "2027-07", "07/2027" → year and month. Anything with a day is not this. */
export function parseMonthYear(raw: string): { year: number; month: number } | null {
  const t = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})$/.exec(t);
  if (m) {
    const year = yearNumber(m[1]!);
    const month = monthNumber(m[2]!);
    return year && month ? { year, month } : null;
  }
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) {
    const year = yearNumber(m[2]!);
    const month = monthNumber(m[1]!);
    return year && month ? { year, month } : null;
  }
  m = /^([A-Za-z]{3,9})[\s\-,/]+(\d{4})$/.exec(t) ?? /^(\d{4})[\s\-,/]+([A-Za-z]{3,9})$/.exec(t);
  if (m) {
    const [a, b] = /^\d/.test(m[1]!) ? [m[2]!, m[1]!] : [m[1]!, m[2]!];
    const month = monthNumber(a);
    const year = yearNumber(b);
    return year && month ? { year, month } : null;
  }
  return null;
}

export interface ExpiryParts {
  year: string;
  month: string;
  day: string;
  /** Whether any of the three is mapped to something. */
  mapped: boolean;
}

export interface ExpiryResolution {
  /** The row's fields after resolution: expiry in YYYY-MM-DD, or a conflict side dropped by the chosen rule. */
  output: Record<ClientImportFieldKey, string>;
  issues: FieldIssue[];
  /** An exact expiry with no start date: recorded on the client, never a subscription term. */
  recordedExpiry: { date: string; service: string | null } | null;
  /** The exact expiry the row will have, however it was reached — for display. */
  finalExpiry: string | null;
  /** How `finalExpiry` was reached, in words. */
  basis: string | null;
}

/** The explicit expiry a row gives (its own date, or composed from parts), or why it cannot be read. */
function explicitExpiry(
  text: string,
  parts: ExpiryParts | null,
  policy: MonthYearPolicy,
): { date: string | null; issue?: string; warning?: string; original?: string } {
  if (parts?.mapped) {
    const { year: y, month: mo, day: d } = parts;
    if (!y.trim() && !mo.trim() && !d.trim()) return { date: null };
    const year = yearNumber(y);
    const month = monthNumber(mo);
    if (!y.trim()) return { date: null, issue: "The expiry year is missing. Add it — a year is never guessed." };
    if (!year) return { date: null, issue: `Expiry year "${y.trim()}" is not a four-digit year between ${EXPIRY_YEAR_RANGE.min} and ${EXPIRY_YEAR_RANGE.max}.` };
    if (!mo.trim()) return { date: null, issue: "The expiry month is missing." };
    if (!month) return { date: null, issue: `Expiry month "${mo.trim()}" is not a month (1–12, or a month name).` };
    if (!d.trim()) {
      if (policy === "LAST_DAY") return { date: `${year}-${pad(month)}-${pad(lastDayOf(year, month))}`, warning: `No expiry day: the last day of the month was used, as chosen in the mapping.` };
      return { date: null, issue: `The expiry day is missing for ${year}-${pad(month)}. Add the day, or choose "Use the last day of the month" in the mapping.`, original: `${year}-${pad(month)}` };
    }
    if (!/^\d{1,2}$/.test(d.trim())) return { date: null, issue: `Expiry day "${d.trim()}" is not a day number.` };
    const day = Number(d.trim());
    if (day < 1 || day > lastDayOf(year, month)) return { date: null, issue: `${year}-${pad(month)} has no day ${day}.` };
    return { date: `${year}-${pad(month)}-${pad(day)}` };
  }
  const t = text.trim();
  if (!t) return { date: null };
  const date = parseImportDate(t);
  if (date) return { date };
  const my = parseMonthYear(t);
  if (my) {
    if (policy === "LAST_DAY") return { date: `${my.year}-${pad(my.month)}-${pad(lastDayOf(my.year, my.month))}`, warning: `"${t}" has no day: the last day of the month was used, as chosen in the mapping.` };
    return { date: null, issue: `"${t}" has a month and year but no day. Add the day, or choose "Use the last day of the month" in the mapping.`, original: t };
  }
  return { date: null, issue: `Expiry date "${t}" is not a date. Use 2027-07-24, 24/07/2027 or 24 Jul 2027 (day first).` };
}

/**
 * Resolves a row's expiry. `expiryEdited` = the person typed the expiry on the review screen, which
 * then wins over the parts. Never invents a day, a year or a start date.
 */
export function resolveSmartExpiry(
  input: Record<ClientImportFieldKey, string>,
  parts: ExpiryParts | null,
  options: SmartExpiryOptions = {},
  expiryEdited = false,
): ExpiryResolution {
  const output = { ...input };
  const issues: FieldIssue[] = [];
  const policy = options.monthYearPolicy ?? "REQUIRE_DAY";
  const explicit = explicitExpiry(output.expiryDate, expiryEdited ? null : parts, policy);
  if (explicit.issue) issues.push({ field: "expiryDate", severity: "error", message: explicit.issue });
  if (explicit.warning) issues.push({ field: "expiryDate", severity: "warning", message: explicit.warning });
  // The canonical expiry is the exact date; an unreadable one keeps the person's own text for correction.
  output.expiryDate = explicit.date ?? (explicit.issue ? (explicit.original ?? output.expiryDate) : "");

  const start = output.startDate.trim() ? parseImportDate(output.startDate) : null;
  const rawDuration = output.duration.trim();
  const unit = parseDurationUnit(output.durationUnit) ?? (rawDuration ? "MONTH" : null);
  const n = Number(rawDuration);
  const durationOk = Boolean(rawDuration) && Number.isInteger(n) && n >= 1 && unit !== null && unit !== "INVALID";
  const calculated = start && durationOk ? addDuration(start, n, unit as "DAY" | "WEEK" | "MONTH" | "YEAR") : null;
  const durationWords = durationOk ? `${n} ${SUBSCRIPTION_DURATION_LABELS[unit as "DAY"][n === 1 ? 0 : 1]}` : "";

  // An exact expiry with no start and no duration: recorded on the client, not a subscription.
  if (explicit.date && !output.startDate.trim() && !rawDuration) {
    const service = output.service.trim() || null;
    output.expiryDate = "";
    output.service = "";
    output.subscriptionType = "";
    output.durationUnit = "";
    issues.push({ field: "expiryDate", severity: "warning", message: "No start date: this expiry is recorded on the client (\"Expiry on record\"), not as a subscription term. Add a start date to make it a subscription." });
    return { output, issues, recordedExpiry: { date: explicit.date, service }, finalExpiry: explicit.date, basis: "Expiry on record (no start date)" };
  }

  if (explicit.date && calculated) {
    if (explicit.date === calculated) {
      output.expiryDate = ""; // one value, reached both ways: the duration keeps the term's own length
      return { output, issues, recordedExpiry: null, finalExpiry: calculated, basis: `Start date + ${durationWords} (matches the file's expiry)` };
    }
    const conflict = options.expiryConflict ?? "ASK";
    if (conflict === "SOURCE") {
      output.duration = "";
      output.durationUnit = "";
      issues.push({ field: "expiryDate", severity: "info", message: `The file's expiry is used; Start date + ${durationWords} would give ${calculated}.` });
      return { output, issues, recordedExpiry: null, finalExpiry: explicit.date, basis: "From the file's expiry date" };
    }
    if (conflict === "CALCULATED") {
      output.expiryDate = "";
      issues.push({ field: "expiryDate", severity: "info", message: `Start date + ${durationWords} is used (${calculated}); the file said ${explicit.date}.` });
      return { output, issues, recordedExpiry: null, finalExpiry: calculated, basis: `Calculated from Start date + ${durationWords}` };
    }
    const message = `The file's expiry ${explicit.date} differs from Start date + ${durationWords} = ${calculated}. Correct one of them, or choose in the mapping which to use.`;
    issues.push({ field: "expiryDate", severity: "error", message }, { field: "duration", severity: "error", message });
    return { output, issues, recordedExpiry: null, finalExpiry: null, basis: null };
  }
  if (calculated) {
    output.expiryDate = "";
    return { output, issues, recordedExpiry: null, finalExpiry: calculated, basis: `Calculated from Start date + ${durationWords}` };
  }
  if (explicit.date) return { output, issues, recordedExpiry: null, finalExpiry: explicit.date, basis: start ? "From the file's expiry date" : null };
  return { output, issues, recordedExpiry: null, finalExpiry: null, basis: null };
}
