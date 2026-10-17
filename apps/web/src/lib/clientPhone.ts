import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import countryToCurrency from "country-to-currency";

/**
 * Phone numbers and countries for the Client form (CLIENTS_V3.md §6), on maintained data rather than a
 * list copied into this repository: `libphonenumber-js` (Google's numbering metadata) for numbers and
 * region codes, the platform's `Intl.DisplayNames` for country names, and `country-to-currency` for a
 * SUGGESTED currency. Used by the browser (live feedback) and the server action (what is stored) alike.
 */

export interface PhoneReading {
  /** E.164 ("+8801711000000") when the number is valid for its country; otherwise null. */
  e164: string | null;
  /** "+880 1711-000000", for display, when it could be read. */
  international: string | null;
  /** The one country the number belongs to, only when that is certain. */
  country: string | null;
  /** Countries that share the calling code, when the number alone cannot say which one. */
  sharedWith: string[];
  valid: boolean;
  /** A sentence for the person typing; null when there is nothing to say. */
  note: string | null;
}

const EMPTY: PhoneReading = { e164: null, international: null, country: null, sharedWith: [], valid: false, note: null };

export function isCountryCode(code: string | null | undefined): code is CountryCode {
  return Boolean(code) && (getCountries() as string[]).includes(code!);
}

/**
 * Reads what was typed. A number with "+" and its country code is read worldwide; one without is read
 * as a number of `defaultCountry` (the project's setting or the country chosen on the form), and when
 * there is none it is not guessed.
 */
export function readPhone(raw: string, defaultCountry?: string | null): PhoneReading {
  const text = raw.trim();
  if (!text) return EMPTY;
  const fallback = isCountryCode(defaultCountry) ? defaultCountry : undefined;
  const international = text.startsWith("+") || text.startsWith("00");
  const normalized = text.startsWith("00") ? `+${text.slice(2)}` : text;
  if (!international && !fallback) {
    return { ...EMPTY, note: "Add the country code (for example +880 or +971), or choose the country first." };
  }
  const parsed = parsePhoneNumberFromString(normalized, fallback);
  if (!parsed) return { ...EMPTY, note: "This does not look like a phone number." };
  const sharedWith = parsed.getPossibleCountries?.() ?? [];
  const valid = parsed.isValid();
  const country = valid && parsed.country ? parsed.country : null;
  let note: string | null = null;
  if (!valid) {
    note =
      sharedWith.length > 1
        ? `+${parsed.countryCallingCode} is shared by ${sharedWith.length} countries and this number is not valid for any of them. Check it.`
        : "This number is not valid for its country. It will be saved as typed — check it.";
  } else if (!country && sharedWith.length > 1) {
    note = `+${parsed.countryCallingCode} is shared by several countries; choose the country yourself.`;
  }
  return { e164: valid ? parsed.number : null, international: parsed.formatInternational(), country, sharedWith, valid, note };
}

let namesCache: Intl.DisplayNames | null = null;
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    namesCache ??= new Intl.DisplayNames(["en"], { type: "region" });
    return namesCache.of(code) ?? code;
  } catch {
    return code;
  }
}

export interface CountryOption {
  code: string;
  name: string;
  callingCode: string;
}

/** Every region the numbering metadata knows, by name. */
export function countryOptions(): CountryOption[] {
  return getCountries()
    .map((code) => ({ code, name: countryName(code) ?? code, callingCode: getCountryCallingCode(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The currency usually used in a country: a suggestion for the form, never a rule. */
export function suggestedCurrency(country: string | null | undefined): string | null {
  if (!country) return null;
  return (countryToCurrency as Record<string, string>)[country] ?? null;
}
