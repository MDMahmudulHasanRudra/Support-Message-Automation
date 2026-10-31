/**
 * Client payments (CLIENTS_V3.md §4): the pure rules for recording money received against dues.
 *
 * A payment is a person's record that money arrived ("BDT 1,500 by bank transfer, ref TX-88"). It is
 * ALLOCATED to one or more dues of the same client and currency; each allocation raises that due's
 * paid amount and moves its status (Unpaid → Partially paid → Paid). Nothing is connected to a bank or
 * a gateway, and nothing is sent because of a payment.
 *
 * Money is handled as integer minor units (BigInt cents), never as floating point: 0.1 + 0.2 must be
 * 0.30 exactly when it decides whether an invoice is settled. Storage is `Decimal(12,2)`, so two
 * decimals is the most any amount carries; a currency with fewer (JPY: none) refuses more.
 */

import { CLIENT_DUE_STATUSES, MAX_DUE_AMOUNT, type ClientDueStatusValue } from "./clientBilling.js";

import { storedPrecisionRefusal } from "./currencyCatalog.js";

export const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "MOBILE_BANKING", "CARD", "CHEQUE", "ONLINE", "OTHER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank transfer",
  MOBILE_BANKING: "Mobile banking (bKash, Nagad…)",
  CARD: "Card",
  CHEQUE: "Cheque",
  ONLINE: "Online / gateway (recorded by hand)",
  OTHER: "Other",
};

export const isPaymentMethod = (v: unknown): v is PaymentMethod => typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);

export const PAYMENT_LIMITS = { reference: 120, note: 1000, reversalReason: 500, batchLines: 100 } as const;

// ── Money in minor units ────────────────────────────────────────────────────────────────────────

/**
 * "1,250.5" → 125050n. Null when it is not a non-negative amount that fits two stored decimals. Zeros past the
 * second decimal are the same value ("2.550" is 2.55) and are accepted; a real third decimal ("2.555") is not —
 * it is refused, never rounded.
 */
export function toMinor(raw: string): bigint | null {
  const text = raw.trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const fraction = m[2] ?? "";
  if (fraction.length > 2 && !/^0+$/.test(fraction.slice(2))) return null;
  return BigInt(m[1]!) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
}


/** 125050n → "1250.50" (the stored form). */
export function fromMinor(n: bigint): string {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** A stored `Decimal(12,2)` (string, number or Prisma Decimal) → minor units. Null stays null. */
export function decimalToMinor(value: { toFixed(digits: number): string } | string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "object" ? value.toFixed(2) : typeof value === "number" ? value.toFixed(2) : value;
  const negative = text.trim().startsWith("-");
  const minor = toMinor(text.trim().replace(/^-/, ""));
  if (minor === null) return null;
  return negative ? -minor : minor;
}

/**
 * How many decimals a currency is written with, from the platform's own currency data (Intl), capped
 * at the two decimals storage holds. An unknown code gets two.
 */
export function currencyDecimals(code: string): number {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
    return Math.min(2, Math.max(0, digits));
  } catch {
    return 2;
  }
}

/** A typed payment amount, in minor units, checked against the currency's decimals. */
export function parsePaymentAmount(raw: string, currency: string): { ok: true; minor: bigint } | { ok: false; error: string } {
  const text = raw.trim().replace(/,/g, "");
  if (!text) return { ok: false, error: "Enter an amount." };
  const minor = toMinor(text);
  if (minor === null) return { ok: false, error: storedPrecisionRefusal(text, currency) ?? "The amount must be a number with at most two decimals." };
  if (minor <= 0n) return { ok: false, error: "The amount must be more than zero." };
  const decimals = currencyDecimals(currency);
  if (decimals < 2 && minor % 10n ** BigInt(2 - decimals) !== 0n) {
    return { ok: false, error: decimals === 0 ? `${currency} has no decimals.` : `${currency} has only ${decimals} decimal.` };
  }
  if (minor > BigInt(Math.round(MAX_DUE_AMOUNT * 100))) return { ok: false, error: "The amount is too large." };
  return { ok: true, minor };
}

/** "BDT 1,250.50" from minor units, written with the currency's own decimals. */
export function formatMinor(minor: bigint, currency: string | null): string {
  const decimals = currency ? currencyDecimals(currency) : 2;
  const text = fromMinor(minor);
  const [whole, cents] = text.replace(/^-/, "").split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = text.startsWith("-") ? "-" : "";
  const fraction = decimals === 0 ? "" : `.${(cents ?? "00").slice(0, decimals)}`;
  return `${sign}${currency ? `${currency} ` : ""}${grouped}${fraction}`;
}

// ── Due arithmetic ──────────────────────────────────────────────────────────────────────────────

export interface PayableDue {
  id: string;
  clientId: string;
  status: string;
  currency: string | null;
  /** Minor units; null = the due carries no amount and cannot take a payment. */
  amount: bigint | null;
  /** Minor units already paid (manual statement + allocations). */
  paid: bigint;
}

/** What is still owed on a due; 0 when nothing can be owed (no amount, settled, waived, cancelled). */
export function remainingOn(due: Pick<PayableDue, "status" | "amount" | "paid">): bigint {
  if (due.amount === null) return 0n;
  if (due.status !== "UNPAID" && due.status !== "PARTIALLY_PAID") return 0n;
  const left = due.amount - due.paid;
  return left > 0n ? left : 0n;
}

/** The status a due's paid amount implies. A waived or cancelled due keeps its status (it is not reached here). */
export function statusForPaid(amount: bigint, paid: bigint): ClientDueStatusValue {
  if (paid <= 0n) return "UNPAID";
  return paid >= amount ? "PAID" : "PARTIALLY_PAID";
}

/** Why a due cannot take a payment, or null when it can. */
export function payableRefusal(due: Pick<PayableDue, "status" | "amount" | "currency" | "paid">): string | null {
  if (!(CLIENT_DUE_STATUSES as readonly string[]).includes(due.status)) return "Its status is not recognised.";
  if (due.status === "PAID") return "It is already paid.";
  if (due.status === "WAIVED") return "It was waived.";
  if (due.status === "CANCELLED") return "It was cancelled.";
  if (due.amount === null) return "It has no amount, so a payment cannot be measured against it. Add the amount first.";
  if (!due.currency) return "It has no currency.";
  if (remainingOn(due) <= 0n) return "Nothing is left to pay on it.";
  return null;
}

// ── Planning a (batch) payment ──────────────────────────────────────────────────────────────────

export interface AllocationRequest {
  dueId: string;
  /** As typed. */
  amount: string;
}

export interface PlannedLine {
  dueId: string;
  amount: bigint;
  paidBefore: bigint;
  paidAfter: bigint;
  statusBefore: string;
  statusAfter: ClientDueStatusValue;
}

/** One real payment: one client, one currency, one or more dues. */
export interface PlannedPayment {
  clientId: string;
  currency: string;
  total: bigint;
  lines: PlannedLine[];
}

export interface PaymentPlanError {
  dueId: string | null;
  message: string;
}

/**
 * Turns a selection of dues and typed amounts into payments, or refuses with a reason per due.
 *
 *   - every due must exist (in this project — the caller only passes rows it could read), be open,
 *     carry an amount and a currency;
 *   - every amount must be more than zero, fit the currency's decimals, and not exceed what is left;
 *   - a due appears once;
 *   - ONE payment per (client, currency): one transfer can settle several invoices of one client in
 *     one currency, but money in two currencies, or from two clients, is never one payment.
 *
 * Nothing is partly accepted: any error refuses the whole batch, so a person never has to work out
 * which half of what they confirmed was recorded.
 */
export function planPayments(dues: readonly PayableDue[], requests: readonly AllocationRequest[]): { ok: true; payments: PlannedPayment[] } | { ok: false; errors: PaymentPlanError[] } {
  const errors: PaymentPlanError[] = [];
  if (requests.length === 0) return { ok: false, errors: [{ dueId: null, message: "Choose at least one invoice." }] };
  if (requests.length > PAYMENT_LIMITS.batchLines) return { ok: false, errors: [{ dueId: null, message: `At most ${PAYMENT_LIMITS.batchLines} invoices in one batch.` }] };

  const byId = new Map(dues.map((d) => [d.id, d]));
  const seen = new Set<string>();
  const groups = new Map<string, PlannedPayment>();
  for (const req of requests) {
    if (seen.has(req.dueId)) {
      errors.push({ dueId: req.dueId, message: "This invoice is in the batch twice." });
      continue;
    }
    seen.add(req.dueId);
    const due = byId.get(req.dueId);
    if (!due) {
      errors.push({ dueId: req.dueId, message: "This invoice no longer exists." });
      continue;
    }
    const refusal = payableRefusal(due);
    if (refusal) {
      errors.push({ dueId: due.id, message: refusal });
      continue;
    }
    const parsed = parsePaymentAmount(req.amount, due.currency!);
    if (!parsed.ok) {
      errors.push({ dueId: due.id, message: parsed.error });
      continue;
    }
    const left = remainingOn(due);
    if (parsed.minor > left) {
      errors.push({ dueId: due.id, message: `More than what is left (${formatMinor(left, due.currency)}). Overpayment is not recorded.` });
      continue;
    }
    const paidAfter = due.paid + parsed.minor;
    const key = `${due.clientId}\u0000${due.currency}`;
    const group = groups.get(key) ?? { clientId: due.clientId, currency: due.currency!, total: 0n, lines: [] };
    group.total += parsed.minor;
    group.lines.push({ dueId: due.id, amount: parsed.minor, paidBefore: due.paid, paidAfter, statusBefore: due.status, statusAfter: statusForPaid(due.amount!, paidAfter) });
    groups.set(key, group);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, payments: [...groups.values()] };
}

/**
 * Undoing one allocation on reversal: the paid amount it added comes off, and the status follows the
 * paid amount — unless staff have since waived or cancelled the due, which reversal does not undo.
 */
export function reverseLine(due: { status: string; amount: bigint | null; paid: bigint }, allocated: bigint): { paidAfter: bigint; statusAfter: string } {
  const paidAfter = due.paid - allocated > 0n ? due.paid - allocated : 0n;
  if (due.status === "WAIVED" || due.status === "CANCELLED" || due.amount === null) return { paidAfter, statusAfter: due.status };
  return { paidAfter, statusAfter: statusForPaid(due.amount, paidAfter) };
}

// ── Outstanding, by currency ────────────────────────────────────────────────────────────────────

export interface OutstandingByCurrency {
  currency: string;
  /** Minor units still owed. */
  remaining: bigint;
  billed: bigint;
  collected: bigint;
  openCount: number;
  overdueCount: number;
}

/**
 * What a set of dues says is owed, one line per currency — never summed across currencies, and no
 * exchange rate is invented. Dues with no amount count toward nothing (they cannot be measured).
 */
export function summarizeOutstanding(
  dues: ReadonlyArray<{ status: string; currency: string | null; amount: bigint | null; paid: bigint; dueDate: string }>,
  today: string,
): OutstandingByCurrency[] {
  const out = new Map<string, OutstandingByCurrency>();
  for (const d of dues) {
    if (d.amount === null || !d.currency) continue;
    if (d.status === "CANCELLED" || d.status === "WAIVED") continue;
    const line = out.get(d.currency) ?? { currency: d.currency, remaining: 0n, billed: 0n, collected: 0n, openCount: 0, overdueCount: 0 };
    line.billed += d.amount;
    line.collected += d.paid < d.amount ? d.paid : d.amount;
    const left = remainingOn(d);
    if (left > 0n) {
      line.remaining += left;
      line.openCount += 1;
      if (d.dueDate < today) line.overdueCount += 1;
    }
    out.set(d.currency, line);
  }
  return [...out.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** "INV-000042", from the project's invoice sequence. */
export function formatInvoiceNumber(n: number): string {
  return `INV-${String(n).padStart(6, "0")}`;
}

/** "RCPT-000042", from the receipt sequence. */
export function formatReceiptNumber(n: number): string {
  return `RCPT-${String(n).padStart(6, "0")}`;
}

/** What one billing line is for. */
export const DUE_KINDS = ["SUBSCRIPTION", "RENEWAL", "SERVICE", "ONE_OFF", "OTHER"] as const;
export type DueKind = (typeof DUE_KINDS)[number];
export const DUE_KIND_LABELS: Record<DueKind, string> = {
  SUBSCRIPTION: "Subscription",
  RENEWAL: "Renewal",
  SERVICE: "Service",
  ONE_OFF: "One-off",
  OTHER: "Other",
};
export const isDueKind = (v: unknown): v is DueKind => typeof v === "string" && (DUE_KINDS as readonly string[]).includes(v);

/** The billing-list payment state, derived from status + dates: what a person scanning the list needs. */
export type InvoiceState = "PAID" | "PART_PAID" | "OVERDUE" | "OPEN" | "WAIVED" | "CANCELLED" | "NO_AMOUNT";
export function invoiceState(due: { status: string; amount: bigint | null; paid: bigint; dueDate: string }, today: string): InvoiceState {
  if (due.status === "CANCELLED") return "CANCELLED";
  if (due.status === "WAIVED") return "WAIVED";
  if (due.status === "PAID") return "PAID";
  if (due.dueDate < today) return "OVERDUE";
  if (due.amount === null) return "NO_AMOUNT";
  return due.paid > 0n ? "PART_PAID" : "OPEN";
}
export const INVOICE_STATE_LABELS: Record<InvoiceState, string> = {
  PAID: "Paid",
  PART_PAID: "Part-paid",
  OVERDUE: "Overdue",
  OPEN: "Open",
  WAIVED: "Waived",
  CANCELLED: "Cancelled",
  NO_AMOUNT: "No amount",
};
