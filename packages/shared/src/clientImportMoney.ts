/**
 * Amounts in a customer's spreadsheet (Smart Import V5 §7): reading money columns WITHOUT turning them into
 * financial records. A file may carry one amount column with a currency, or one column per currency ("SAR",
 * "AED", "RAND", "TK" …). Each row's amounts are read exactly as written — text kept, decimals kept — and the
 * result is retained on the client as "amounts recorded at import" for a person to look at.
 *
 * Nothing here creates an invoice, a receipt, a due or a payment, and nothing is converted between currencies
 * or added across them. "Paid 30" in a spreadsheet is a statement in a file, not a payment this software saw.
 */

import { currencyMinorUnits, currencyOfHeader, fitsCurrencyDecimals, isIsoCurrency, readCurrencyName, readMoneyText } from "./currencyCatalog.js";

export type SmartMoneyMapping =
  /** One amount column; the currency from a column of currency codes/names, or one fixed currency. */
  | { mode: "SINGLE"; amountColumn: string; currencyColumn?: string; currency?: string }
  /** One column per currency. */
  | { mode: "MULTI"; columns: Array<{ column: string; currency: string }> };

export interface ImportedAmount {
  /** ISO code, or null when it could not be told. */
  currency: string | null;
  /** Exact decimal text ("8.000"), or null when the cell is not an amount. */
  amount: string | null;
  /** The cell exactly as the file had it. */
  original: string;
  column: string;
  /** Why this one needs a look (unreadable, a currency that disagrees with its column, more decimals than the currency has). */
  problem?: string;
}

export type RowMoneyStatus =
  /** No money column mapped, or every money cell blank. */
  | "NONE"
  /** Only zero amounts: the client is imported, nothing is recorded. */
  | "ZERO"
  /** Exactly one amount. */
  | "ONE"
  /** Amounts in more than one currency on one row: imported only after a person acknowledges it. */
  | "MULTIPLE"
  /** A money cell that is not a readable amount: kept as written, flagged. */
  | "PROBLEM";

export interface RowMoney {
  status: RowMoneyStatus;
  /** What is recorded on the client: non-zero amounts and unreadable cells (zero amounts are not). */
  amounts: ImportedAmount[];
}

export interface MoneyColumnSuggestion {
  column: string;
  /** The one currency the header names. */
  currency?: string;
  /** The currencies a header like "Rial" or "din" could mean — the person chooses. */
  ambiguous?: readonly string[];
}

/** Headers that name a currency: suggestions for the multi-currency mapping, never applied by themselves. */
export function detectMoneyColumns(headers: readonly string[]): MoneyColumnSuggestion[] {
  const out: MoneyColumnSuggestion[] = [];
  for (const column of headers) {
    const r = currencyOfHeader(column);
    if (!r) continue;
    out.push("code" in r ? { column, currency: r.code } : { column, ambiguous: r.ambiguous });
  }
  return out;
}

/** A money mapping as the server stores it: columns the file has, real ISO currencies. Refuses rather than drops. */
export function sanitizeMoneyMapping(raw: unknown, headers: readonly string[]): { ok: true; money: SmartMoneyMapping | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, money: null };
  if (typeof raw !== "object") return { ok: false, error: "The amounts mapping could not be read." };
  const m = raw as Record<string, unknown>;
  const has = new Set(headers);
  const col = (c: unknown, label: string) => (typeof c === "string" && has.has(c) ? c : `${label}: the file has no column called "${String(c ?? "").slice(0, 40)}".`);
  if (m.mode === "SINGLE") {
    const amountColumn = col(m.amountColumn, "Amount");
    if (!has.has(amountColumn)) return { ok: false, error: amountColumn };
    let currencyColumn: string | undefined;
    if (m.currencyColumn !== undefined && m.currencyColumn !== "") {
      const c = col(m.currencyColumn, "Currency");
      if (!has.has(c)) return { ok: false, error: c };
      currencyColumn = c;
    }
    const currency = typeof m.currency === "string" && m.currency ? m.currency.toUpperCase() : undefined;
    if (currency && !isIsoCurrency(currency)) return { ok: false, error: `${currency.slice(0, 10)} is not a currency code.` };
    if (!currencyColumn && !currency) return { ok: false, error: "Choose the column that holds each amount's currency, or one currency for every row." };
    return { ok: true, money: { mode: "SINGLE", amountColumn, ...(currencyColumn ? { currencyColumn } : {}), ...(currency ? { currency } : {}) } };
  }
  if (m.mode === "MULTI") {
    const list = Array.isArray(m.columns) ? m.columns : [];
    if (!list.length) return { ok: false, error: "Choose at least one currency column." };
    if (list.length > 60) return { ok: false, error: "At most 60 currency columns." };
    const columns: Array<{ column: string; currency: string }> = [];
    for (const entry of list) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const column = col(e.column, "Currency column");
      if (!has.has(column)) return { ok: false, error: column };
      const currency = typeof e.currency === "string" ? e.currency.toUpperCase() : "";
      if (!isIsoCurrency(currency)) return { ok: false, error: `Column "${column}": choose which currency it holds.` };
      if (columns.some((c) => c.column === column)) return { ok: false, error: `Column "${column}" is chosen twice.` };
      columns.push({ column, currency });
    }
    return { ok: true, money: { mode: "MULTI", columns } };
  }
  return { ok: false, error: "Choose how amounts are laid out in the file." };
}

/** One cell under a known (or not yet known) currency. */
function readCell(original: string, column: string, columnCurrency: string | null): ImportedAmount | { blank: true } | { zero: true } {
  const r = readMoneyText(original);
  if (r.kind === "BLANK") return { blank: true };
  if (r.kind === "INVALID") return { currency: columnCurrency, amount: null, original, column, problem: r.reason };
  let currency = columnCurrency;
  if (r.currency) {
    if (columnCurrency && r.currency !== columnCurrency) return { currency: columnCurrency, amount: null, original, column, problem: `Written as ${r.currency} in the ${columnCurrency} column.` };
    currency = r.currency;
  } else if (r.ambiguousCurrencies) {
    // "Rial4.000" in the OMR column is OMR; "dh30.00" with no column currency is a question.
    if (!columnCurrency) return { currency: null, amount: r.amount, original, column, problem: `"${original.trim()}" could be ${r.ambiguousCurrencies.join(", ")}. Choose the currency.` };
    if (!r.ambiguousCurrencies.includes(columnCurrency)) return { currency: columnCurrency, amount: null, original, column, problem: `Written with a currency that is not ${columnCurrency}.` };
  }
  if (r.zero) return { zero: true };
  if (!currency) return { currency: null, amount: r.amount, original, column, problem: "No currency is given for this amount." };
  if (!fitsCurrencyDecimals(r.amount, currency)) {
    return { currency, amount: r.amount, original, column, problem: `${currency} has ${currencyMinorUnits(currency)} decimal places; ${r.amount} has more. Kept exactly as written.` };
  }
  return { currency, amount: r.amount, original, column };
}

/** One row's amounts under the mapping. Zero amounts are not recorded; nothing is ever added up. */
export function readRowMoney(source: Readonly<Record<string, string>>, money: SmartMoneyMapping | null | undefined): RowMoney {
  if (!money) return { status: "NONE", amounts: [] };
  const cells: ImportedAmount[] = [];
  let sawZero = false;
  const take = (original: string, column: string, currency: string | null) => {
    const r = readCell(original, column, currency);
    if ("blank" in r) return;
    if ("zero" in r) sawZero = true;
    else cells.push(r);
  };
  if (money.mode === "SINGLE") {
    let currency: string | null = money.currency ?? null;
    const named = money.currencyColumn ? (source[money.currencyColumn] ?? "").trim() : "";
    if (named) {
      const reading = readCurrencyName(named);
      currency = reading && "code" in reading ? reading.code : null;
      if (!currency) {
        const original = source[money.amountColumn] ?? "";
        if (original.trim()) cells.push({ currency: null, amount: null, original, column: money.amountColumn, problem: `"${named}" is not a currency this import can tell (${reading && "ambiguous" in reading ? `could be ${reading.ambiguous.join(", ")}` : "unknown"}).` });
        return finish(cells, sawZero);
      }
    }
    take(source[money.amountColumn] ?? "", money.amountColumn, currency);
  } else {
    for (const c of money.columns) take(source[c.column] ?? "", c.column, c.currency);
  }
  return finish(cells, sawZero);
}

function finish(cells: ImportedAmount[], sawZero: boolean): RowMoney {
  if (cells.some((c) => c.problem)) return { status: "PROBLEM", amounts: cells };
  if (!cells.length) return { status: sawZero ? "ZERO" : "NONE", amounts: [] };
  const currencies = new Set(cells.map((c) => c.currency));
  return { status: currencies.size > 1 || cells.length > 1 ? "MULTIPLE" : "ONE", amounts: cells };
}

/** "SAR 30.00 · AED 12.50": for display; never a total. */
export function describeAmounts(amounts: readonly ImportedAmount[]): string {
  return amounts.map((a) => (a.amount && a.currency ? `${a.currency} ${a.amount}` : `"${a.original.trim()}"`)).join(" · ");
}
