/**
 * Currencies (Smart Import V5, CLIENT_CONFIGURATION.md): the ISO 4217 list a project chooses from, each
 * currency's own number of decimals, the names spreadsheets use for them, and an exact reader for money
 * written as text. Pure data and string arithmetic only — no floating point, no exchange rates, and no
 * total is ever formed across two currencies here.
 *
 * Availability is not conversion: a currency on this list can be chosen for a client or a column; nothing
 * here turns one currency into another.
 */

/**
 * ISO 4217 currencies in use (national and regional), with their minor units, as published by the ISO 4217
 * maintenance agency (list of 2025). Funds, precious metals and testing codes (XAU, XDR, XTS, BOV, CLF, …)
 * are left out: nobody bills a client in them. A code already stored on a record stays valid even when it
 * is not here (`isCurrencyCodeShape`), so history is never refused.
 */
export const ISO_CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  AED: 2, AFN: 2, ALL: 2, AMD: 2, ANG: 2, AOA: 2, ARS: 2, AUD: 2, AWG: 2, AZN: 2,
  BAM: 2, BBD: 2, BDT: 2, BGN: 2, BHD: 3, BIF: 0, BMD: 2, BND: 2, BOB: 2, BRL: 2, BSD: 2, BTN: 2, BWP: 2, BYN: 2, BZD: 2,
  CAD: 2, CDF: 2, CHF: 2, CLP: 0, CNY: 2, COP: 2, CRC: 2, CUP: 2, CVE: 2, CZK: 2,
  DJF: 0, DKK: 2, DOP: 2, DZD: 2,
  EGP: 2, ERN: 2, ETB: 2, EUR: 2,
  FJD: 2, FKP: 2,
  GBP: 2, GEL: 2, GHS: 2, GIP: 2, GMD: 2, GNF: 0, GTQ: 2, GYD: 2,
  HKD: 2, HNL: 2, HTG: 2, HUF: 2,
  IDR: 2, ILS: 2, INR: 2, IQD: 3, IRR: 2, ISK: 0,
  JMD: 2, JOD: 3, JPY: 0,
  KES: 2, KGS: 2, KHR: 2, KMF: 0, KPW: 2, KRW: 0, KWD: 3, KYD: 2, KZT: 2,
  LAK: 2, LBP: 2, LKR: 2, LRD: 2, LSL: 2, LYD: 3,
  MAD: 2, MDL: 2, MGA: 2, MKD: 2, MMK: 2, MNT: 2, MOP: 2, MRU: 2, MUR: 2, MVR: 2, MWK: 2, MXN: 2, MYR: 2, MZN: 2,
  NAD: 2, NGN: 2, NIO: 2, NOK: 2, NPR: 2, NZD: 2,
  OMR: 3,
  PAB: 2, PEN: 2, PGK: 2, PHP: 2, PKR: 2, PLN: 2, PYG: 0,
  QAR: 2,
  RON: 2, RSD: 2, RUB: 2, RWF: 0,
  SAR: 2, SBD: 2, SCR: 2, SDG: 2, SEK: 2, SGD: 2, SHP: 2, SLE: 2, SOS: 2, SRD: 2, SSP: 2, STN: 2, SVC: 2, SYP: 2, SZL: 2,
  THB: 2, TJS: 2, TMT: 2, TND: 3, TOP: 2, TRY: 2, TTD: 2, TWD: 2, TZS: 2,
  UAH: 2, UGX: 0, USD: 2, UYU: 2, UZS: 2,
  VED: 2, VES: 2, VND: 0, VUV: 0,
  WST: 2,
  XAF: 0, XCD: 2, XCG: 2, XOF: 0, XPF: 0,
  YER: 2,
  ZAR: 2, ZMW: 2, ZWG: 2,
};

export const ISO_CURRENCY_CODES: readonly string[] = Object.keys(ISO_CURRENCY_MINOR_UNITS).sort();

export const isIsoCurrency = (code: string): boolean => Object.prototype.hasOwnProperty.call(ISO_CURRENCY_MINOR_UNITS, code);

/** Any three upper-case letters: a code stored on an older record is kept, even one ISO has since withdrawn. */
export const isCurrencyCodeShape = (code: string): boolean => /^[A-Z]{3}$/.test(code);

/** A currency's own number of decimals (KWD 3, JPY 0, most 2). Unknown codes: 2. */
export function currencyMinorUnits(code: string): number {
  return ISO_CURRENCY_MINOR_UNITS[code.toUpperCase()] ?? 2;
}

// ── Names spreadsheets use ──────────────────────────────────────────────────────────────────────

/**
 * A word or symbol that names exactly one currency. Matched on the whole token, case-insensitively.
 * "USA" is the country, but in a column of amounts it means dollars (customer exports do this).
 */
const UNIQUE_ALIASES: Readonly<Record<string, string>> = {
  RAND: "ZAR", RANDS: "ZAR", R: "ZAR",
  TK: "BDT", TAKA: "BDT", "৳": "BDT",
  KSH: "KES", KSHS: "KES", "KES.": "KES",
  USA: "USD", US: "USD", "US$": "USD", USDOLLAR: "USD",
  EURO: "EUR", EUROS: "EUR", "€": "EUR",
  POUND: "GBP", POUNDS: "GBP", "£": "GBP",
  "₹": "INR",
  RINGGIT: "MYR", RM: "MYR",
  YEN: "JPY",
  NAIRA: "NGN", "₦": "NGN",
  CEDI: "GHS", CEDIS: "GHS",
  LIRA: "TRY", "₺": "TRY",
  SR: "SAR", SAUDIRIYAL: "SAR",
  QR: "QAR",
  KD: "KWD",
  BD: "BHD",
  OR: "OMR", RO: "OMR",
  JD: "JOD",
  "₱": "PHP",
};

/**
 * Words that name SEVERAL currencies. "Rial" is Omani, Iranian or Yemeni (and "riyal" Saudi or Qatari);
 * "dinar" is Kuwaiti, Bahraini, Jordanian, Iraqi, Libyan, Tunisian, Algerian or Serbian; "dh" is the UAE or
 * Moroccan dirham. The reader never picks one: the person confirms which, once per column.
 */
const AMBIGUOUS_ALIASES: Readonly<Record<string, readonly string[]>> = {
  RIAL: ["OMR", "IRR", "YER"],
  RIALS: ["OMR", "IRR", "YER"],
  DIN: ["KWD", "BHD", "JOD", "IQD", "LYD", "TND", "DZD", "RSD"],
  DINAR: ["KWD", "BHD", "JOD", "IQD", "LYD", "TND", "DZD", "RSD"],
  DINARS: ["KWD", "BHD", "JOD", "IQD", "LYD", "TND", "DZD", "RSD"],
  RIYAL: ["SAR", "QAR"],
  RIYALS: ["SAR", "QAR"],
  "﷼": ["SAR", "QAR", "OMR", "YER", "IRR"],
  DIRHAM: ["AED", "MAD"],
  DIRHAMS: ["AED", "MAD"],
  DH: ["AED", "MAD"],
  DHS: ["AED", "MAD"],
  KR: ["SEK", "NOK", "DKK", "ISK"],
  SHILLING: ["KES", "UGX", "TZS", "SOS"],
  SHILLINGS: ["KES", "UGX", "TZS", "SOS"],
  FRANC: ["CHF", "XOF", "XAF", "XPF"],
  "$": ["USD", "CAD", "AUD", "NZD", "SGD", "HKD"],
  DOLLAR: ["USD", "CAD", "AUD", "NZD", "SGD", "HKD"],
  DOLLARS: ["USD", "CAD", "AUD", "NZD", "SGD", "HKD"],
  RS: ["INR", "PKR", "LKR", "NPR"],
  RUPEE: ["INR", "PKR", "LKR", "NPR"],
  RUPEES: ["INR", "PKR", "LKR", "NPR"],
  "¥": ["JPY", "CNY"],
  PESO: ["PHP", "MXN", "ARS", "CLP", "COP"],
  PESOS: ["PHP", "MXN", "ARS", "CLP", "COP"],
};

export type CurrencyNameReading = { code: string } | { ambiguous: readonly string[] } | null;

/** What a header, a cell prefix or a typed name says the currency is. Null = not a currency name. */
export function readCurrencyName(raw: string): CurrencyNameReading {
  const token = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!token) return null;
  if (/^[A-Z]{3}$/.test(token) && isIsoCurrency(token)) return { code: token };
  const unique = UNIQUE_ALIASES[token];
  if (unique) return { code: unique };
  const many = AMBIGUOUS_ALIASES[token];
  if (many) return { ambiguous: many };
  return null;
}

/**
 * A spreadsheet header that names a currency column ("SAR", "Amount (AED)", "KWD paid", "TK", "RAND").
 * Only a header whose words include exactly one currency name is read; "Name", "Status" or "Remarks" are
 * never a currency, and a header with two currency words is left to the person.
 */
export function currencyOfHeader(header: string): CurrencyNameReading {
  const words = header
    .toUpperCase()
    .replace(/[()[\]{}:/\\,_\-.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // One-letter or common-English tokens ("R", "OR", "US", "BD", "KR") are only a currency when they ARE the header.
  const loneOnly = new Set(["R", "OR", "US", "BD", "KR", "RO", "RS", "SR", "QR", "JD", "KD", "RM", "DH", "DHS", "DIN"]);
  const hits = new Map<string, CurrencyNameReading>();
  for (const word of words) {
    if (loneOnly.has(word) && words.length > 1) continue;
    const reading = readCurrencyName(word);
    if (reading) hits.set(word, reading);
  }
  if (hits.size !== 1) return null;
  return [...hits.values()][0]!;
}

// ── Reading money written as text ───────────────────────────────────────────────────────────────

export type MoneyReading =
  /** Nothing written: the cell is blank. */
  | { kind: "BLANK" }
  /** A number, exactly as written (`amount` is a plain decimal string), with the currency it names, if any. */
  | { kind: "AMOUNT"; amount: string; decimals: number; zero: boolean; currency: string | null; ambiguousCurrencies: readonly string[] | null; original: string }
  /** Something that is not an amount ("paid", "-", "n/a 30"). Kept as written, never turned into a number. */
  | { kind: "INVALID"; original: string; reason: string };

/**
 * "SAR30.00", "dh30.00", "Rial4.000", "din 8.000", "7.35", "1,250", "30 KWD" → an exact decimal string and
 * the currency word written with it. Thousands separators (commas) are accepted; a comma used as the decimal
 * mark ("30,50") is refused as ambiguous rather than guessed. The decimals written are kept as written.
 */
export function readMoneyText(raw: string): MoneyReading {
  const original = String(raw ?? "");
  // "500/-" and "500=" are how amounts are often closed in South Asian books: the mark is not part of the number.
  const text = original.trim().replace(/\s*(\/-|=)$/, "");
  if (!text) return { kind: "BLANK" };
  const m = /^([^\d.\-+]*?)\s*([+-]?[\d,]*\.?\d+)\s*([^\d.]*)$/.exec(text);
  if (!m) return { kind: "INVALID", original, reason: `"${text.slice(0, 40)}" is not an amount.` };
  const before = m[1]!.trim();
  const numberText = m[2]!;
  const after = m[3]!.trim();
  if (before && after) return { kind: "INVALID", original, reason: `"${text.slice(0, 40)}" names a currency on both sides of the number.` };
  const word = before || after;
  let currency: string | null = null;
  let ambiguous: readonly string[] | null = null;
  if (word) {
    const reading = readCurrencyName(word);
    if (!reading) return { kind: "INVALID", original, reason: `"${word.slice(0, 20)}" is not a currency this import knows.` };
    if ("code" in reading) currency = reading.code;
    else ambiguous = reading.ambiguous;
  }
  if (numberText.startsWith("-")) return { kind: "INVALID", original, reason: "A negative amount cannot be imported as a payment amount." };
  const unsigned = numberText.replace(/^\+/, "");
  // "30,50" (comma as the decimal mark) and "1,25,0" are not read: which digits are the cents is a guess.
  if (unsigned.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(unsigned) && !/^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/.test(unsigned)) {
    return { kind: "INVALID", original, reason: `"${unsigned}" uses a comma where the decimal point would be. Write it as ${unsigned.replace(",", ".")} if that is what it means.` };
  }
  const plain = unsigned.replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(plain)) return { kind: "INVALID", original, reason: `"${text.slice(0, 40)}" is not an amount.` };
  const [whole, fraction = ""] = plain.split(".");
  const amount = `${(whole ?? "").replace(/^0+(?=\d)/, "") || "0"}${fraction ? `.${fraction}` : ""}`;
  const zero = /^0*$/.test((whole ?? "") + fraction);
  return { kind: "AMOUNT", amount, decimals: fraction.length, zero, currency, ambiguousCurrencies: ambiguous, original };
}

/**
 * Whether an amount fits its currency's decimals exactly (no digit would be lost): "8.000" KWD yes,
 * "7.355" USD no, "30.0" JPY yes (the zero is not information), "30.5" JPY no.
 */
export function fitsCurrencyDecimals(amount: string, currency: string): boolean {
  const [, fraction = ""] = amount.split(".");
  const allowed = currencyMinorUnits(currency);
  return fraction.length <= allowed || /^0*$/.test(fraction.slice(allowed));
}
