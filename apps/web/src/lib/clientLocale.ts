import { parsePhoneNumberFromString } from "libphonenumber-js";
import { isCountryCode, suggestedCurrency } from "@/lib/clientPhone";

/**
 * One rule for phone numbers and a client's country, currency and language (Smart Import V5,
 * CLIENT_CONFIGURATION.md), used by Add / Edit Client, both imports and the review. Built on the same
 * maintained data as `readPhone`: libphonenumber (numbering plans), CLDR through `Intl` (a country's likely
 * language) and `country-to-currency`. Pure: no database, so the browser and the server answer alike.
 *
 * Nothing is invented. A number is written in E.164 only when it is valid for exactly one reading; a country
 * comes from the file, a person, a valid number or the project's default — in that order — and anything less
 * certain is a suggestion marked "Needs review", never a stored guess.
 */

// ── Phone numbers ───────────────────────────────────────────────────────────────────────────────

export type PhoneStatus =
  /** Valid, written in E.164. */
  | "VALID"
  /** Digits that could be a local number of several countries, or local and international at once. */
  | "AMBIGUOUS"
  /** A local number, and no country to read it in. */
  | "NEEDS_COUNTRY"
  /** Excel stored the number as a float and dropped digits ("9.66551E+11"): it cannot be rebuilt. */
  | "DAMAGED"
  /** Not a number valid anywhere it could belong. Kept as written. */
  | "INVALID";

export interface PhoneNormalization {
  /** What the file or the person wrote. */
  original: string;
  status: PhoneStatus;
  /** "+966551234567" — only when VALID. */
  e164: string | null;
  /** The country the number belongs to, when VALID and certain. */
  country: string | null;
  /** The other readings, for AMBIGUOUS ("+8801712345678 or a local Saudi number"). */
  candidates: string[];
  /** A sentence for the review; null when there is nothing to say. */
  note: string | null;
}

/** A cell as Excel and copy-paste deliver it, before any reading: quotes, "tel:", trailing ".0", odd spaces. */
export function cleanPhoneText(raw: string): string {
  return String(raw ?? "")
    .replace(/[‎‏‪-‮   ]/g, " ")
    .trim()
    .replace(/^['’`]+/, "")
    .replace(/^tel:/i, "")
    .replace(/^(\d+)\.0+$/, "$1")
    .replace(/^\++/, "+")
    .trim();
}

/** Several numbers in one cell ("01711…; 01811…", "966…, 971…", "…/…"). A space never splits a number. */
export function splitPhoneCell(raw: string): string[] {
  const text = String(raw ?? "");
  const parts = text.split(/[;|\n]+|,(?=\s*[+\d(])|\s\/\s|\/(?=\s*\+)/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [];
}

/** "9.66551E+11", "8.80171E+12": a number Excel turned into a float. Its last digits are gone. */
export const looksDamagedByExcel = (text: string): boolean => /^\d(\.\d+)?e\+?\d+$/i.test(text.trim());

const valid = (text: string, country?: string) => {
  const parsed = parsePhoneNumberFromString(text, country && isCountryCode(country) ? country : undefined);
  return parsed && parsed.isValid() ? parsed : null;
};

/**
 * One number, read the way a person reading the file would:
 * - "+966…" / "00966…" — international; "++966…" is one plus.
 * - digits only — tried as a local number of `country` (the row's, a person's or the project's) and as an
 *   international number missing its "+". One valid reading wins; two different valid readings are AMBIGUOUS;
 *   none is INVALID (or NEEDS_COUNTRY when there was no country to try).
 * A valid number already in E.164 is returned unchanged.
 */
export function normalizePhone(raw: string, country?: string | null): PhoneNormalization {
  const original = String(raw ?? "");
  const text = cleanPhoneText(original);
  const base = { original, e164: null, country: null, candidates: [] as string[] };
  if (!text) return { ...base, status: "INVALID", note: null };
  if (looksDamagedByExcel(text)) {
    return { ...base, status: "DAMAGED", note: `Excel stored "${text}" as a number and dropped its last digits. Re-type it, or format the column as Text in Excel and export again.` };
  }
  if (!/^\+?[\d\s().\-/]+$/.test(text)) return { ...base, status: "INVALID", note: `"${text.slice(0, 30)}" is not a phone number.` };
  const international = text.startsWith("+") || text.startsWith("00");
  if (international) {
    const parsed = valid(text.startsWith("00") ? `+${text.slice(2)}` : text);
    if (!parsed) return { ...base, status: "INVALID", note: `${text} is not a valid number for its country code. It is kept as written.` };
    return { ...base, status: "VALID", e164: parsed.number, country: parsed.country ?? null, note: null };
  }
  const digits = text.replace(/\D/g, "");
  const local = country ? valid(digits, country) : null;
  const global = valid(`+${digits}`);
  if (local && global && local.number !== global.number) {
    return {
      ...base,
      status: "AMBIGUOUS",
      candidates: [local.number, global.number],
      note: `${digits} can be read as ${local.number} (a local number) or ${global.number}. Choose which one.`,
    };
  }
  const reading = local ?? global;
  if (reading) return { ...base, status: "VALID", e164: reading.number, country: reading.country ?? null, note: null };
  if (!country) return { ...base, status: "NEEDS_COUNTRY", note: `${digits} has no country code. Choose the client's country, or set the project's default country.` };
  return { ...base, status: "INVALID", note: `${digits} is not a valid number in ${country}, nor with a country code. It is kept as written.` };
}

// ── Country, currency, language ─────────────────────────────────────────────────────────────────

/** Where a value came from — shown beside it, so nobody mistakes a suggestion for what the file said. */
export type LocaleSource = "FILE" | "MANUAL" | "PHONE" | "DEFAULT" | "SUGGESTED" | "REVIEW";

export const LOCALE_SOURCE_LABELS: Record<LocaleSource, string> = {
  FILE: "From Excel",
  MANUAL: "Manually selected",
  PHONE: "Auto selected",
  DEFAULT: "Auto selected",
  SUGGESTED: "Auto selected",
  REVIEW: "Needs review",
};

/** The language most of a country speaks (CLDR likely subtags): "SA" → "ar", "BD" → "bn". Null when unknown. */
export function languageCodeForCountry(country: string | null | undefined): string | null {
  if (!country || !/^[A-Z]{2}$/.test(country)) return null;
  try {
    const lang = new Intl.Locale(`und-${country}`).maximize().language;
    return lang && lang !== "und" ? lang : null;
  } catch {
    return null;
  }
}

let languageNames: Intl.DisplayNames | null = null;
/** "ar" → "Arabic", "bn" → "Bangla" (the platform's own English names). */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    return languageNames.of(code) ?? null;
  } catch {
    return null;
  }
}

export interface LocaleValue {
  value: string | null;
  source: LocaleSource | null;
  /** Why it is in review, or which values were possible. */
  note?: string;
}

export interface LocaleInput {
  /** As the file gives them (already resolved to a code for country / currency), or null. */
  file: { country?: string | null; currency?: string | null; language?: string | null };
  /** What a person chose on the form or in the review. Always wins. */
  manual?: { country?: string | null; currency?: string | null; language?: string | null };
  /** The client's numbers, as normalized. */
  phones: readonly PhoneNormalization[];
  /** The project's default country (Settings → Client Module), or null. */
  projectCountry?: string | null;
  /** The project's own country → currency / language choices, when it set any (Configuration Center). */
  overrides?: { currencyByCountry?: Readonly<Record<string, string>>; languageByCountry?: Readonly<Record<string, string>> };
}

export interface LocaleResult {
  country: LocaleValue;
  currency: LocaleValue;
  language: LocaleValue;
}

/**
 * Country, preferred currency and preferred language for one client, each with where it came from.
 *
 * Precedence, per value: a person's choice → the file → (country only) the client's valid numbers when they
 * all agree → the project's default country; then currency and language are SUGGESTED from the country. A
 * currency or language a person or the file gave is never replaced because the country changed. Numbers
 * that point to two countries put the country in review instead of choosing.
 *
 * A preferred currency is only the client's usual currency; it is never the currency of a payment.
 */
export function resolveClientLocale(input: LocaleInput): LocaleResult {
  const manual = input.manual ?? {};
  const file = input.file;
  let country: LocaleValue = { value: null, source: null };
  if (manual.country) country = { value: manual.country, source: "MANUAL" };
  else if (file.country) country = { value: file.country, source: "FILE" };
  else {
    const fromPhones = [...new Set(input.phones.filter((p) => p.status === "VALID" && p.country).map((p) => p.country!))];
    if (fromPhones.length === 1) country = { value: fromPhones[0]!, source: "PHONE" };
    else if (fromPhones.length > 1) country = { value: null, source: "REVIEW", note: `The numbers belong to different countries (${fromPhones.join(", ")}). Choose the client's country.` };
    else if (input.projectCountry) country = { value: input.projectCountry, source: "DEFAULT" };
  }

  const pick = (kind: "currency" | "language"): LocaleValue => {
    if (manual[kind]) return { value: manual[kind]!, source: "MANUAL" };
    if (file[kind]) return { value: file[kind]!, source: "FILE" };
    if (!country.value) return { value: null, source: null };
    if (kind === "currency") {
      const value = input.overrides?.currencyByCountry?.[country.value] ?? suggestedCurrency(country.value);
      return value ? { value, source: "SUGGESTED" } : { value: null, source: null };
    }
    const value = input.overrides?.languageByCountry?.[country.value] ?? languageName(languageCodeForCountry(country.value));
    return value ? { value, source: "SUGGESTED" } : { value: null, source: null };
  };
  return { country, currency: pick("currency"), language: pick("language") };
}
