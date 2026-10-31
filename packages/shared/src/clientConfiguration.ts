/**
 * The Client Configuration Center (Smart Import V5 §9, CLIENT_CONFIGURATION.md): the pure rules for a project's
 * own lists — tags, categories, business types and service plans — and for matching what a spreadsheet or a form
 * says to an entry of those lists. No database here; the server actions call these and nothing else decides.
 *
 * A list is a convenience, not a gate: a client keeps whatever tag, category or business type it was given, an
 * archived entry stays on every client that has it, and nothing a person typed before the list existed changes.
 */

import { CLIENT_LIMITS, normalizeTag } from "./clients.js";
import { addDuration, type SubscriptionDurationUnit, type SubscriptionKind } from "./clientSubscriptions.js";
import { currencyMinorUnits, fitsCurrencyDecimals, isIsoCurrency, readMoneyText } from "./currencyCatalog.js";

export const CLIENT_CATALOG_KINDS = ["TAG", "CATEGORY", "BUSINESS_TYPE"] as const;
export type ClientCatalogKindValue = (typeof CLIENT_CATALOG_KINDS)[number];

export const CLIENT_CATALOG_KIND_LABELS: Record<ClientCatalogKindValue, { one: string; many: string }> = {
  TAG: { one: "Tag", many: "Tags" },
  CATEGORY: { one: "Category", many: "Categories" },
  BUSINESS_TYPE: { one: "Business type", many: "Business types" },
};

export const isClientCatalogKind = (v: unknown): v is ClientCatalogKindValue => typeof v === "string" && (CLIENT_CATALOG_KINDS as readonly string[]).includes(v);

export const CLIENT_CONFIG_LIMITS = {
  /** Entries per list per project; generous, and a bound against a runaway import. */
  entries: 2000,
  plans: 500,
  aliases: 20,
  alias: 80,
  planName: 120,
  prices: 50,
  /** Longest duration a plan may suggest, in days (ten years). */
  maxDurationDays: 3660,
} as const;

/** The longest a name of each kind may be — the column it lands in on a client decides. */
const MAX_NAME: Record<ClientCatalogKindValue, number> = { TAG: CLIENT_LIMITS.tag, CATEGORY: CLIENT_LIMITS.category, BUSINESS_TYPE: 80 };

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * An entry's name as it will be stored, or the reason it cannot be. A tag is stored the way a client's tags are
 * (`normalizeTag`: lower case, single spaces), so "VIP " and "vip" are one tag; categories and business types
 * keep their case ("Corporate") and lose only extra spaces.
 */
export function cleanCatalogName(kind: ClientCatalogKindValue, raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw : "";
  if (CONTROL.test(text)) return { ok: false, error: "The name contains invisible control characters." };
  const name = kind === "TAG" ? (normalizeTag(text) ?? "") : text.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: `Type a name for the ${CLIENT_CATALOG_KIND_LABELS[kind].one.toLowerCase()}.` };
  if (name.length > MAX_NAME[kind]) return { ok: false, error: `${CLIENT_CATALOG_KIND_LABELS[kind].one} names can be at most ${MAX_NAME[kind]} characters.` };
  if (/^[=+\-@]/.test(name)) return { ok: false, error: "A name cannot start with = + - or @ (a spreadsheet would run it as a formula)." };
  return { ok: true, name };
}

/** "Corp, Corporate; Company" → ["Corp", "Corporate", "Company"]: other spellings an import maps to an entry. */
export function parseAliases(raw: unknown): { ok: true; aliases: string[] } | { ok: false; error: string } {
  const list = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,;\n]/) : []).map((a) => a.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  for (const alias of list) {
    if (CONTROL.test(alias)) return { ok: false, error: "An alias contains invisible control characters." };
    if (alias.length > CLIENT_CONFIG_LIMITS.alias) return { ok: false, error: `An alias can be at most ${CLIENT_CONFIG_LIMITS.alias} characters.` };
    if (!out.some((o) => o.toLowerCase() === alias.toLowerCase())) out.push(alias);
  }
  if (out.length > CLIENT_CONFIG_LIMITS.aliases) return { ok: false, error: `At most ${CLIENT_CONFIG_LIMITS.aliases} aliases.` };
  return { ok: true, aliases: out };
}

const key = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface CatalogEntryLike {
  id: string;
  name: string;
  aliases: readonly string[];
  archivedAt?: Date | string | null;
}

/**
 * The entry a typed or imported value names: its name or one of its aliases, ignoring case and extra spaces.
 * Archived entries still match (a client keeps them); two entries claiming the same alias is ambiguous → null.
 */
export function matchCatalogEntry<T extends CatalogEntryLike>(value: string, entries: readonly T[]): T | null {
  const k = key(value);
  if (!k) return null;
  const byName = entries.filter((e) => key(e.name) === k);
  if (byName.length === 1) return byName[0]!;
  const byAlias = entries.filter((e) => e.aliases.some((a) => key(a) === k));
  return byAlias.length === 1 ? byAlias[0]! : null;
}

// ── Service plans ───────────────────────────────────────────────────────────────────────────────

const KINDS: readonly SubscriptionKind[] = ["PAID", "TRIAL", "DEMO", "COMPLIMENTARY"];
const UNITS: readonly SubscriptionDurationUnit[] = ["DAY", "WEEK", "MONTH", "YEAR"];
const DAYS_PER: Record<SubscriptionDurationUnit, number> = { DAY: 1, WEEK: 7, MONTH: 31, YEAR: 366 };

export interface ServicePlanPrice {
  currency: string;
  /** Exact decimal text as typed, within the currency's own decimals ("30.00", "8.000"). */
  amount: string;
}

export interface ServicePlanInput {
  name: unknown;
  service?: unknown;
  defaultKind?: unknown;
  defaultDuration?: unknown;
  defaultUnit?: unknown;
  prices?: unknown;
  aliases?: unknown;
}

export interface ValidServicePlan {
  name: string;
  service: string | null;
  defaultKind: SubscriptionKind;
  defaultDuration: number | null;
  defaultUnit: SubscriptionDurationUnit | null;
  prices: ServicePlanPrice[];
  aliases: string[];
}

/**
 * A plan as it will be stored, or every reason it cannot be. A duration and its unit come together or not at
 * all. A price is a SUGGESTION per currency: an ISO code, a positive amount within that currency's decimals
 * (no digit is dropped), one per currency. Nothing is billed because a plan has a price.
 */
export function validatePlan(input: ServicePlanInput): { ok: true; plan: ValidServicePlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name) errors.push("Type the plan's name.");
  else if (name.length > CLIENT_CONFIG_LIMITS.planName) errors.push(`A plan name can be at most ${CLIENT_CONFIG_LIMITS.planName} characters.`);
  else if (CONTROL.test(name) || /^[=+\-@]/.test(name)) errors.push("The plan name cannot start with = + - or @, or contain control characters.");
  const service = typeof input.service === "string" && input.service.trim() ? input.service.replace(/\s+/g, " ").trim().slice(0, CLIENT_CONFIG_LIMITS.planName) : null;
  const kindText = typeof input.defaultKind === "string" && input.defaultKind ? input.defaultKind.toUpperCase() : "PAID";
  if (!(KINDS as readonly string[]).includes(kindText)) errors.push("Choose Paid, Trial, Demo or Complimentary.");
  const durationText = input.defaultDuration === undefined || input.defaultDuration === null ? "" : String(input.defaultDuration).trim();
  const unitText = typeof input.defaultUnit === "string" ? input.defaultUnit.toUpperCase() : "";
  let defaultDuration: number | null = null;
  let defaultUnit: SubscriptionDurationUnit | null = null;
  if (durationText || unitText) {
    const n = Number(durationText);
    if (!durationText || !Number.isInteger(n) || n < 1) errors.push("The default duration must be a whole number of at least 1.");
    else if (!(UNITS as readonly string[]).includes(unitText)) errors.push("Choose days, weeks, months or years for the default duration.");
    else if (n * DAYS_PER[unitText as SubscriptionDurationUnit] > CLIENT_CONFIG_LIMITS.maxDurationDays) errors.push("The default duration can be at most ten years.");
    else {
      defaultDuration = n;
      defaultUnit = unitText as SubscriptionDurationUnit;
    }
  }
  const prices: ServicePlanPrice[] = [];
  const pricesIn = Array.isArray(input.prices) ? input.prices : [];
  if (pricesIn.length > CLIENT_CONFIG_LIMITS.prices) errors.push(`At most ${CLIENT_CONFIG_LIMITS.prices} prices.`);
  for (const p of pricesIn.slice(0, CLIENT_CONFIG_LIMITS.prices)) {
    const currency = String((p as { currency?: unknown })?.currency ?? "").trim().toUpperCase();
    const amountText = String((p as { amount?: unknown })?.amount ?? "").trim();
    if (!currency && !amountText) continue;
    if (!isIsoCurrency(currency)) {
      errors.push(`"${currency.slice(0, 10)}" is not a currency code.`);
      continue;
    }
    const read = readMoneyText(amountText);
    if (read.kind !== "AMOUNT" || read.zero) {
      errors.push(`${currency}: the price must be an amount above zero.`);
      continue;
    }
    if (read.currency && read.currency !== currency) {
      errors.push(`${currency}: the price is written in ${read.currency}.`);
      continue;
    }
    if (!fitsCurrencyDecimals(read.amount, currency)) {
      errors.push(`${currency} has ${currencyMinorUnits(currency)} decimal places; ${read.amount} has more, and no digit is dropped.`);
      continue;
    }
    if (read.amount.replace(".", "").length > 15) {
      errors.push(`${currency}: the price is too large.`);
      continue;
    }
    if (prices.some((x) => x.currency === currency)) {
      errors.push(`${currency} is given twice.`);
      continue;
    }
    prices.push({ currency, amount: read.amount });
  }
  const aliases = parseAliases(input.aliases);
  if (!aliases.ok) errors.push(aliases.error);
  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { name, service, defaultKind: kindText as SubscriptionKind, defaultDuration, defaultUnit, prices, aliases: aliases.ok ? aliases.aliases : [] } };
}

export interface ServicePlanLike extends CatalogEntryLike {
  service?: string | null;
  defaultKind: string;
  defaultDuration: number | null;
  defaultUnit: string | null;
}

/**
 * What choosing a plan OFFERS on the form: its kind, and — when the plan has a default duration and a start
 * date is known — the expiry that duration gives. A person changes any of it before saving; nothing is
 * invoiced. A plan with no default duration offers no expiry (custom dates).
 */
export function planDefaults(plan: ServicePlanLike, startDate: string | null): { kind: string; duration: number | null; unit: string | null; expiry: string | null } {
  const unit = plan.defaultUnit && (UNITS as readonly string[]).includes(plan.defaultUnit) ? (plan.defaultUnit as SubscriptionDurationUnit) : null;
  const expiry = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) && plan.defaultDuration && unit ? addDuration(startDate, plan.defaultDuration, unit) : null;
  return { kind: plan.defaultKind, duration: plan.defaultDuration, unit, expiry };
}

// ── Fields on a client ──────────────────────────────────────────────────────────────────────────

export const CLIENT_LANGUAGE_LIMITS = { additional: 5, name: CLIENT_LIMITS.language } as const;

/** A client's business type as stored: free text (a list entry or not), at most 80 characters, or null. */
export function cleanBusinessType(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!text) return { ok: true, value: null };
  if (CONTROL.test(text) || /^[=+\-@]/.test(text)) return { ok: false, error: "The business type cannot start with = + - or @, or contain control characters." };
  if (text.length > MAX_NAME.BUSINESS_TYPE) return { ok: false, error: `The business type can be at most ${MAX_NAME.BUSINESS_TYPE} characters.` };
  return { ok: true, value: text };
}

/**
 * A client's languages besides the primary one ("Arabic, English"): distinct (case-insensitively), never the
 * primary language again, each at most 40 characters, at most five.
 */
export function parseAdditionalLanguages(raw: unknown, primary: string | null): { ok: true; languages: string[] } | { ok: false; error: string } {
  const list = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,;\n]/) : []).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  for (const lang of list) {
    if (CONTROL.test(lang) || lang.length > CLIENT_LANGUAGE_LIMITS.name) return { ok: false, error: `"${lang.slice(0, 20)}" is not a language name.` };
    if (primary && lang.toLowerCase() === primary.toLowerCase()) continue;
    if (!out.some((o) => o.toLowerCase() === lang.toLowerCase())) out.push(lang);
  }
  if (out.length > CLIENT_LANGUAGE_LIMITS.additional) return { ok: false, error: `A client can have at most ${CLIENT_LANGUAGE_LIMITS.additional} more languages.` };
  return { ok: true, languages: out };
}
