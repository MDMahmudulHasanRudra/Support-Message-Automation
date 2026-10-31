/**
 * Client billing (CLIENT_CENTER_PLAN.md §2): the pure rules for a manual due record. Nothing here
 * touches a database or a clock (the caller passes "today").
 *
 * A due is a person's statement: "this client owes this on this day", and later "they paid". There is
 * no invoice, no ledger and no payment connection, and nothing is sent because of a due. Nothing is
 * invented either: no default currency, no placeholder amount.
 */

export const CLIENT_DUE_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID", "WAIVED", "CANCELLED"] as const;
export type ClientDueStatusValue = (typeof CLIENT_DUE_STATUSES)[number];

export const CLIENT_DUE_STATUS_LABELS: Record<ClientDueStatusValue, string> = {
  UNPAID: "Unpaid",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  WAIVED: "Waived",
  CANCELLED: "Cancelled",
};

/** A due that still expects money, so it can be upcoming or overdue. */
export const OPEN_DUE_STATUSES: readonly ClientDueStatusValue[] = ["UNPAID", "PARTIALLY_PAID"];

/** No cap on how many currencies a project lists (V5): every ISO 4217 currency may be offered. */
export const CLIENT_BILLING_LIMITS = { note: 1000 } as const;
/** Decimal(12,2) holds 10 integer digits. */
export const MAX_DUE_AMOUNT = 9_999_999_999.99;

export const isClientDueStatus = (v: string): v is ClientDueStatusValue => (CLIENT_DUE_STATUSES as readonly string[]).includes(v);
export const isOpenDue = (status: string): boolean => (OPEN_DUE_STATUSES as readonly string[]).includes(status);

/** An ISO 4217 shaped code, upper-cased; null when it is not three letters. */
export function normalizeCurrencyCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * A typed amount as a string of at most two decimals, or null when blank. `ok: false` carries the
 * reason. Commas as thousands separators are accepted ("12,500.50"); a negative or zero amount is not.
 */
export function parseAmount(raw: string, label = "Amount"): { ok: true; value: string | null } | { ok: false; error: string } {
  const text = raw.trim().replace(/,/g, "");
  if (!text) return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return { ok: false, error: `${label} must be a number with at most two decimals.` };
  const n = Number(text);
  if (!(n > 0)) return { ok: false, error: `${label} must be more than zero.` };
  if (n > MAX_DUE_AMOUNT) return { ok: false, error: `${label} is too large.` };
  return { ok: true, value: n.toFixed(2) };
}

/** `YYYY-MM-DD` that is a real calendar day, or null. */
export function parseDueDate(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? m[0] : null;
}

/** Today's calendar day in Dhaka, as `YYYY-MM-DD`. */
export function dhakaToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "BDT 12,500.00", or "No amount". The amount is the stored two-decimal string. */
export function formatMoney(amount: string | null, currency: string | null): string {
  if (amount === null) return "No amount";
  const [whole, cents] = amount.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency ? `${currency} ` : ""}${grouped}.${cents ?? "00"}`;
}

export interface DueInput {
  dueDate: string;
  amount: string;
  currency: string;
  status: string;
  paidAmount: string;
  note: string;
}

export interface ValidDue {
  dueDate: string;
  amount: string | null;
  currency: string | null;
  status: ClientDueStatusValue;
  paidAmount: string | null;
  note: string | null;
}

/**
 * Validates one due. `enabledCurrencies` is the project's list; `keepCurrency` is the currency the
 * due already carries, which stays valid when editing even if the list has since dropped it.
 *
 *   - the date is a real day;
 *   - the amount is optional; the currency is required ONLY when an amount is present, and must be
 *     on the list; a currency without an amount is dropped (it would describe nothing);
 *   - paid amount needs an amount and cannot exceed it; PARTIALLY_PAID with an amount needs one.
 */
export function validateDue(input: DueInput, enabledCurrencies: readonly string[], keepCurrency?: string | null): { ok: true; due: ValidDue } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const dueDate = parseDueDate(input.dueDate);
  if (!dueDate) errors.push("Choose the due date.");
  if (!isClientDueStatus(input.status)) errors.push("Choose a status.");

  const amount = parseAmount(input.amount);
  if (!amount.ok) errors.push(amount.error);
  const paid = parseAmount(input.paidAmount, "Paid amount");
  if (!paid.ok) errors.push(paid.error);

  const amountValue = amount.ok ? amount.value : null;
  const paidValue = paid.ok ? paid.value : null;
  let currency: string | null = null;
  if (amountValue !== null) {
    const code = normalizeCurrencyCode(input.currency);
    if (!code) errors.push(enabledCurrencies.length === 0 && !keepCurrency ? "Add a currency to this project's list before entering an amount." : "Choose a currency for the amount.");
    else if (!enabledCurrencies.includes(code) && code !== keepCurrency) errors.push(`${code} is not on this project's currency list.`);
    else currency = code;
  }
  if (paidValue !== null) {
    if (amountValue === null) errors.push("Enter the amount before the paid amount.");
    else if (Number(paidValue) > Number(amountValue)) errors.push("The paid amount cannot be more than the amount.");
  }
  if (input.status === "PARTIALLY_PAID" && amountValue !== null && paidValue === null) errors.push("Enter how much has been paid.");
  if (input.status === "PAID" && paidValue !== null && amountValue !== null && Number(paidValue) < Number(amountValue)) {
    errors.push("A paid due cannot have a paid amount below the amount. Use Partially paid, or clear the paid amount.");
  }
  const note = input.note.trim();
  if (note.length > CLIENT_BILLING_LIMITS.note) errors.push(`The note can be at most ${CLIENT_BILLING_LIMITS.note} characters.`);

  if (errors.length || !dueDate) return { ok: false, errors };
  return { ok: true, due: { dueDate, amount: amountValue, currency, status: input.status as ClientDueStatusValue, paidAmount: paidValue, note: note || null } };
}

export interface BillingSummary {
  /** The earliest open due on or after today. */
  nextDueDate: string | null;
  overdueCount: number;
  /** The earliest open due before today. */
  oldestOverdueDate: string | null;
  openCount: number;
}

/** Derived from the dues, never stored. `today` is a Dhaka `YYYY-MM-DD`; due dates are the same shape. */
export function summarizeDues(dues: ReadonlyArray<{ dueDate: string; status: string }>, today: string): BillingSummary {
  const open = dues.filter((d) => isOpenDue(d.status)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const overdue = open.filter((d) => d.dueDate < today);
  return {
    nextDueDate: open.find((d) => d.dueDate >= today)?.dueDate ?? null,
    overdueCount: overdue.length,
    oldestOverdueDate: overdue[0]?.dueDate ?? null,
    openCount: open.length,
  };
}

/** The fields that differ, as `{ field: { from, to } }` — what a ClientDueEvent records. */
export function diffDue(before: Record<string, string | null>, after: Record<string, string | null>): Record<string, { from: string | null; to: string | null }> {
  const out: Record<string, { from: string | null; to: string | null }> = {};
  for (const key of Object.keys(after)) if ((before[key] ?? null) !== (after[key] ?? null)) out[key] = { from: before[key] ?? null, to: after[key] ?? null };
  return out;
}
