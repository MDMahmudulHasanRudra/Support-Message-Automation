import {
  normalizeEmail,
  parseDurationUnit,
  parseImportDate,
  parseSubscriptionKind,
  readCurrencyName,
  type ClientImportFieldKey,
  type SmartMapping,
  type SmartSamples,
} from "@support-automation/shared";
import { countryName, countryOptions } from "@/lib/clientPhone";
import { normalizePhone, resolveClientLocale, splitPhoneCell, type PhoneNormalization } from "@/lib/clientLocale";

/**
 * The Visual Mapping grid's preview (Smart Import V5 §1, §3): for the first rows of the file AS STAGED, what
 * each client field would receive — the original text, and below it the value after normalization (a phone in
 * E.164, a date as YYYY-MM-DD, a country by name) or the value derived for it (country, currency and language
 * from a valid number).
 *
 * A preview row is ONE row of the file. Each column is never filled from that column's own first non-empty
 * values independently: that showed one client's phone beside another client's name. Pure, so the grid and its
 * tests read the same thing.
 */

export interface PreviewSourceRow {
  /** The row's place in the sheet, as a person counts it. */
  rowNumber: number;
  cells: Readonly<Record<string, string>>;
}

export type PreviewTone =
  /** Nothing is written for this field on this row. */
  | "empty"
  /** Imported exactly as written. */
  | "same"
  /** Imported in a normalized form (shown under the original). */
  | "changed"
  /** Not in the file: filled from another field (country from the phone, …) — marked Auto selected. */
  | "derived"
  /** Will be refused or needs a decision in the review. */
  | "problem";

export interface PreviewCell {
  original: string;
  /** The value the client gets, when it differs from `original` or was derived. */
  value: string | null;
  tone: PreviewTone;
  /** Why it is a problem, or where a derived value came from. */
  note: string | null;
  /** The original came from the "if empty" column rather than the chosen one. */
  fromFallback?: boolean;
}

let countryIndex: Map<string, string> | null = null;
/** "Saudi Arabia", "saudi arabia", "SA", "KSA"… → "SA". */
export function countryCodeOf(text: string): string | null {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  if (!countryIndex) {
    countryIndex = new Map();
    for (const c of countryOptions()) {
      countryIndex.set(c.code.toLowerCase(), c.code);
      countryIndex.set(c.name.toLowerCase(), c.code);
    }
    for (const [alias, code] of Object.entries({ ksa: "SA", uae: "AE", uk: "GB", usa: "US", "u.s.a.": "US", "united states of america": "US", bangladesh: "BD" })) countryIndex.set(alias, code);
  }
  return countryIndex.get(key) ?? null;
}

/** The text a field gets from its rule on one row, and whether it came from the fallback column. */
export function originalOf(field: ClientImportFieldKey, row: PreviewSourceRow, mapping: SmartMapping, samples: SmartSamples): { text: string; fromFallback: boolean } {
  const rule = mapping.fields[field];
  if (!rule) return { text: "", fromFallback: false };
  if (rule.mode === "constant") return { text: rule.value.trim(), fromFallback: false };
  if (rule.mode === "sample") return { text: samples[field] ?? "", fromFallback: false };
  if (rule.mode !== "source") return { text: "", fromFallback: false };
  const main = (row.cells[rule.column] ?? "").trim();
  if (main || !rule.fallback) return { text: main, fromFallback: false };
  const fb = (row.cells[rule.fallback] ?? "").trim();
  return { text: fb, fromFallback: Boolean(fb) };
}

const same = (original: string): PreviewCell => ({ original, value: null, tone: original ? "same" : "empty", note: null });
const changedTo = (original: string, value: string): PreviewCell => (value === original ? same(original) : { original, value, tone: "changed", note: null });
const problem = (original: string, note: string): PreviewCell => ({ original, value: null, tone: "problem", note });

function phoneCell(original: string, country: string | null): { cell: PreviewCell; readings: PhoneNormalization[] } {
  if (!original) return { cell: same(""), readings: [] };
  const readings = splitPhoneCell(original).map((p) => normalizePhone(p, country));
  const bad = readings.find((r) => r.status !== "VALID");
  if (bad) return { cell: problem(original, bad.note ?? "Check this number."), readings };
  return { cell: changedTo(original, readings.map((r) => r.e164!).join("; ")), readings };
}

/** Every previewed field of one row. `fields` decides which are computed (the grid's visible columns). */
export function previewRow(
  row: PreviewSourceRow,
  mapping: SmartMapping,
  samples: SmartSamples,
  fields: readonly ClientImportFieldKey[],
  opts: { defaultCountry?: string | null; fillLocale?: boolean } = {},
): Partial<Record<ClientImportFieldKey, PreviewCell>> {
  const text = (f: ClientImportFieldKey) => originalOf(f, row, mapping, samples);
  const countryText = text("country").text;
  const fileCountry = countryText ? countryCodeOf(countryText) : null;
  const readCountry = fileCountry ?? opts.defaultCountry ?? null;
  const phone = phoneCell(text("phone").text, readCountry);
  const whatsapp = phoneCell(text("whatsapp").text, readCountry);
  const currencyText = text("currency").text;
  const fileCurrency = currencyText ? readCurrencyName(currencyText) : null;
  const languageText = text("language").text;
  const locale = resolveClientLocale({
    file: { country: fileCountry, currency: fileCurrency && "code" in fileCurrency ? fileCurrency.code : null, language: languageText || null },
    phones: [...phone.readings, ...whatsapp.readings],
    projectCountry: opts.defaultCountry ?? null,
  });

  const out: Partial<Record<ClientImportFieldKey, PreviewCell>> = {};
  for (const field of fields) {
    const { text: original, fromFallback } = text(field);
    let cell: PreviewCell;
    switch (field) {
      case "phone":
        cell = phone.cell;
        break;
      case "whatsapp":
        cell = whatsapp.cell;
        break;
      case "email": {
        if (!original) cell = same("");
        else {
          const parts = original.split(/[;,\s]+/).filter(Boolean);
          const read = parts.map((p) => normalizeEmail(p));
          cell = read.some((r) => !r) ? problem(original, `"${parts[read.findIndex((r) => !r)]}" is not an email address.`) : changedTo(original, read.join("; "));
        }
        break;
      }
      case "startDate":
      case "expiryDate": {
        if (!original) cell = same("");
        else {
          const iso = parseImportDate(original);
          cell = iso ? changedTo(original, iso) : problem(original, `"${original}" is not a date this import can read (use 2026-10-17 or 17/10/2026).`);
        }
        break;
      }
      case "subscriptionType": {
        const kind = original ? parseSubscriptionKind(original) : null;
        cell = !original ? same("") : kind === "INVALID" ? problem(original, `"${original}" is not Paid, Trial, Demo or Complimentary.`) : changedTo(original, kind!.charAt(0) + kind!.slice(1).toLowerCase());
        break;
      }
      case "durationUnit": {
        const unit = original ? parseDurationUnit(original) : null;
        cell = !original ? same("") : unit === "INVALID" ? problem(original, `"${original}" is not Days, Weeks, Months or Years.`) : changedTo(original, `${unit!.charAt(0)}${unit!.slice(1).toLowerCase()}s`);
        break;
      }
      case "country": {
        if (original) cell = fileCountry ? changedTo(original, `${countryName(fileCountry)} (${fileCountry})`) : problem(original, `"${original}" is not a country this import knows. Use its name or two-letter code.`);
        else if (opts.fillLocale === false) cell = same("");
        else if (locale.country.value && locale.country.source === "PHONE") {
          cell = { original: "", value: `${countryName(locale.country.value)} (${locale.country.value})`, tone: "derived", note: "From the phone number" };
        }
        else cell = locale.country.source === "REVIEW" ? { original: "", value: null, tone: "problem", note: locale.country.note ?? "Choose the country." } : same("");
        break;
      }
      case "currency": {
        if (original) {
          cell = !fileCurrency
            ? problem(original, `"${original}" is not a currency code or name this import knows.`)
            : "ambiguous" in fileCurrency
              ? problem(original, `"${original}" can mean ${fileCurrency.ambiguous.join(", ")}. Choose one in the review.`)
              : changedTo(original, fileCurrency.code);
        } else cell = opts.fillLocale !== false && locale.currency.value && (fileCountry || locale.country.source === "PHONE") ? { original: "", value: locale.currency.value, tone: "derived", note: "Suggested from the country" } : same("");
        break;
      }
      case "language": {
        cell = original ? same(original) : opts.fillLocale !== false && locale.language.value && (fileCountry || locale.country.source === "PHONE") ? { original: "", value: locale.language.value, tone: "derived", note: "Suggested from the country" } : same("");
        break;
      }
      default:
        cell = same(original);
    }
    out[field] = fromFallback && cell.tone !== "empty" ? { ...cell, fromFallback: true } : cell;
  }
  return out;
}
