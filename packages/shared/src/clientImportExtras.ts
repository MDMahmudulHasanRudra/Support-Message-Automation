/**
 * The Clients V3 columns of a client import (CLIENTS_V3.md §Import): country, preferred currency,
 * team, sold by, assigned staff, and the client's first subscription. Pure: names are resolved to
 * roster ids on the server (`server/clientImportExtras.ts`), because only the server knows the roster.
 */

import { isSubscriptionDurationUnit, validateSubscription, type SubscriptionDurationUnit, type SubscriptionKind, type ValidSubscription } from "./clientSubscriptions.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (n: number) => String(n).padStart(2, "0");
function real(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * A date as people type it in a sheet, to `YYYY-MM-DD`, or null. Accepted:
 *   2026-10-17 · 17-10-2026 · 17/10/2026 · 17.10.2026 (day first, the Bangladesh and Gulf way)
 *   17 Oct 2026 · Oct 17, 2026 · 17-Oct-2026
 *   46312 (an Excel date serial, see below)
 * Month-first numeric dates (10/17/2026) are NOT guessed: 03/04/2026 would be ambiguous.
 */
export function parseImportDate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  // A date typed into Excel is stored as a day count from 1899-12-30, and a reader that does not apply
  // the cell's format hands over that number. Only five digits (1954–2119) count, never a year or a code.
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial < 20000 || serial > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
  }
  let m =/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(text);
  if (m) return real(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (m) return real(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-,]+(\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    return month < 0 ? null : real(Number(m[3]), month + 1, Number(m[1]));
  }
  m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
    return month < 0 ? null : real(Number(m[3]), month + 1, Number(m[2]));
  }
  return null;
}

const UNIT_WORDS: Record<string, SubscriptionDurationUnit> = {
  day: "DAY", days: "DAY", d: "DAY",
  week: "WEEK", weeks: "WEEK", w: "WEEK",
  month: "MONTH", months: "MONTH", m: "MONTH", mo: "MONTH",
  year: "YEAR", years: "YEAR", y: "YEAR", yr: "YEAR", yrs: "YEAR",
};

/** "Months", "month", "MONTH", "m" → MONTH. Blank → null (the caller decides the default). */
export function parseDurationUnit(raw: string): SubscriptionDurationUnit | "INVALID" | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (isSubscriptionDurationUnit(text.toUpperCase())) return text.toUpperCase() as SubscriptionDurationUnit;
  return UNIT_WORDS[text] ?? "INVALID";
}

const KIND_WORDS: Record<string, SubscriptionKind> = {
  paid: "PAID", "paid subscription": "PAID", regular: "PAID",
  trial: "TRIAL", "free trial": "TRIAL",
  demo: "DEMO",
  complimentary: "COMPLIMENTARY", free: "COMPLIMENTARY", gift: "COMPLIMENTARY",
};

/** "Trial", "paid subscription", "FREE" → the kind. Blank → PAID. */
export function parseSubscriptionKind(raw: string): SubscriptionKind | "INVALID" {
  const text = raw.trim().toLowerCase();
  if (!text) return "PAID";
  return KIND_WORDS[text] ?? (["PAID", "TRIAL", "DEMO", "COMPLIMENTARY"].includes(text.toUpperCase()) ? (text.toUpperCase() as SubscriptionKind) : "INVALID");
}

export interface ImportExtrasRaw {
  country: string;
  currency: string;
  team: string;
  soldBy: string;
  assignedTo: string;
  service: string;
  subscriptionType: string;
  startDate: string;
  duration: string;
  durationUnit: string;
  expiryDate: string;
}

export interface ImportExtras {
  /** Raw text, resolved on the server against the project's own lists. */
  country: string | null;
  currency: string | null;
  team: string | null;
  soldBy: string | null;
  assignedTo: string | null;
  /** A complete, consistent term — or null when the row has no subscription columns filled. */
  subscription: ValidSubscription | null;
}

/**
 * The V3 columns of one row: free text kept for the server to resolve, and the subscription parsed
 * whole or refused whole (never half a term). A duration without a unit is read as months.
 */
export function readImportExtras(raw: ImportExtrasRaw): { ok: true; value: ImportExtras } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const t = (s: string) => s.trim() || null;
  const subscriptionTouched = Boolean(raw.service.trim() || raw.startDate.trim() || raw.duration.trim() || raw.expiryDate.trim());
  let subscription: ValidSubscription | null = null;
  if (subscriptionTouched) {
    const kind = parseSubscriptionKind(raw.subscriptionType);
    if (kind === "INVALID") errors.push(`Subscription type "${raw.subscriptionType}" is not one of Paid, Trial, Demo, Complimentary.`);
    const unit = parseDurationUnit(raw.durationUnit);
    if (unit === "INVALID") errors.push(`Duration unit "${raw.durationUnit}" is not Days, Weeks, Months or Years.`);
    const start = raw.startDate.trim() ? parseImportDate(raw.startDate) : null;
    if (raw.startDate.trim() && !start) errors.push(`Start date "${raw.startDate}" is not a date. Use 2026-10-17 or 17/10/2026.`);
    const expiry = raw.expiryDate.trim() ? parseImportDate(raw.expiryDate) : null;
    if (raw.expiryDate.trim() && !expiry) errors.push(`Expiry date "${raw.expiryDate}" is not a date. Use 2026-11-17 or 17/11/2026.`);
    if (!errors.length) {
      const checked = validateSubscription({
        service: raw.service,
        kind: kind === "INVALID" ? "" : kind,
        startDate: start ?? "",
        durationValue: raw.duration.trim(),
        durationUnit: raw.duration.trim() ? (unit && unit !== "INVALID" ? unit : "MONTH") : "",
        endDate: raw.duration.trim() ? "" : (expiry ?? ""),
        note: "",
      });
      if (checked.ok) subscription = checked.value;
      else errors.push(...checked.errors.map((e) => `Subscription: ${e}`));
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { country: t(raw.country), currency: t(raw.currency), team: t(raw.team), soldBy: t(raw.soldBy), assignedTo: t(raw.assignedTo), subscription } };
}
