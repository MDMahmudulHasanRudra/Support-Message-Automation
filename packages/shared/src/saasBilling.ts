/**
 * SaaS billing rules (SAAS_PLATFORM_PLAN.md §10): what state a customer's subscription is in, when
 * it holds the workspace, which reminders are due, money formatting and plan limits. Pure, so the
 * Main Admin portal, the customer's own Subscription page, the worker's billing loop and the tests
 * share one reading of every rule.
 *
 * Currency: BDT only for now, but every amount carries its currency and is never summed across
 * currencies, so adding one later is a matter of allowing it, not of migrating money.
 */

export const SUPPORTED_CURRENCIES = ["BDT"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = "BDT";

export const BILLING_INTERVALS = ["MONTH", "YEAR"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export const BILLING_INTERVAL_LABELS: Record<BillingInterval, string> = { MONTH: "Monthly", YEAR: "Yearly" };

export const SAAS_PAYMENT_METHODS = ["BKASH", "NAGAD", "BANK_TRANSFER", "CASH", "CARD", "OTHER"] as const;
export type SaasPaymentMethod = (typeof SAAS_PAYMENT_METHODS)[number];
export const SAAS_PAYMENT_METHOD_LABELS: Record<SaasPaymentMethod, string> = {
  BKASH: "bKash",
  NAGAD: "Nagad",
  BANK_TRANSFER: "Bank transfer",
  CASH: "Cash",
  CARD: "Card",
  OTHER: "Other",
};

export function isSaasPaymentMethod(value: unknown): value is SaasPaymentMethod {
  return typeof value === "string" && (SAAS_PAYMENT_METHODS as readonly string[]).includes(value);
}
export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value);
}
export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export const DEFAULT_GRACE_DAYS = 7;
export const DEFAULT_REMINDER_DAYS = [7, 3, 1] as const;
export const MAX_GRACE_DAYS = 90;

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/** "1,500" / "1500.50" / "৳ 1,500" → minor units (poisha). Null when it is not an amount ≥ 0. */
export function parseMoneyToMinor(raw: unknown): bigint | null {
  const text = String(raw ?? "").replace(/[৳,\s]|BDT|Tk\.?/gi, "").trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2));
}

/** 150000n, "BDT" → "BDT 1,500.00". */
export function formatMoneyMinor(minor: bigint | number | string, currency: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${currency} ${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** `date` plus `count` months or years, keeping the day of month where it exists (Jan 31 + 1 month = Feb 28/29). */
export function addInterval(date: Date, interval: BillingInterval, count = 1): Date {
  const out = new Date(date.getTime());
  const months = interval === "YEAR" ? 12 * count : count;
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days from `now` until `at`, rounded up (0 when it has passed). */
export function daysUntil(at: Date, now: Date): number {
  return Math.max(0, Math.ceil((at.getTime() - now.getTime()) / DAY_MS));
}

// ---------------------------------------------------------------------------------------------
// Subscription state
// ---------------------------------------------------------------------------------------------

export const SAAS_SUBSCRIPTION_STATES = ["TRIALING", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED"] as const;
export type SaasSubscriptionState = (typeof SAAS_SUBSCRIPTION_STATES)[number];

export const SAAS_SUBSCRIPTION_STATE_LABELS: Record<SaasSubscriptionState, string> = {
  TRIALING: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment due",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
};

export interface SubscriptionFacts {
  startsAt: Date;
  trialEndsAt: Date | null;
  paidThrough: Date | null;
  graceDays: number;
  autoEnforce: boolean;
  suspendedAt: Date | null;
  cancelledAt: Date | null;
}

export interface SubscriptionReading {
  state: SaasSubscriptionState;
  /** Held = the workspace is read-only, with no automation or outbound (incoming still stored). */
  held: boolean;
  /** Service is covered until this moment (the later of the trial and the paid period), or null. */
  accessUntil: Date | null;
  /** When an enforced, unpaid subscription will be (or was) suspended, or null. */
  suspendsAt: Date | null;
  /** Suspended by an admin's hand, rather than by enforcement. */
  manualSuspension: boolean;
}

/**
 * The one rule for a subscription's state at `now`:
 *   - suspended by an admin → SUSPENDED (held), whatever else is true;
 *   - cancelled and past the cancellation date → CANCELLED (held);
 *   - covered (trial or paid period not over) → TRIALING or ACTIVE;
 *   - not covered: PAST_DUE, and — ONLY when enforcement is on — SUSPENDED once the grace days
 *     have passed. With enforcement off a subscription is never held by itself: that is how a
 *     customer that was here before subscriptions (Customer #1) cannot be suspended by accident.
 *   - nothing covered and enforcement off (no expiry, billed by hand) → ACTIVE.
 */
export function subscriptionState(sub: SubscriptionFacts, now: Date): SubscriptionReading {
  const accessUntil = latest(sub.trialEndsAt, sub.paidThrough);
  if (sub.suspendedAt) return { state: "SUSPENDED", held: true, accessUntil, suspendsAt: sub.suspendedAt, manualSuspension: true };
  if (sub.cancelledAt && now.getTime() >= sub.cancelledAt.getTime()) {
    return { state: "CANCELLED", held: true, accessUntil, suspendsAt: null, manualSuspension: false };
  }
  if (accessUntil && now.getTime() < accessUntil.getTime()) {
    const paid = sub.paidThrough !== null && now.getTime() < sub.paidThrough.getTime();
    return { state: paid ? "ACTIVE" : "TRIALING", held: false, accessUntil, suspendsAt: null, manualSuspension: false };
  }
  if (!accessUntil && !sub.autoEnforce) return { state: "ACTIVE", held: false, accessUntil: null, suspendsAt: null, manualSuspension: false };
  if (!sub.autoEnforce) return { state: "PAST_DUE", held: false, accessUntil, suspendsAt: null, manualSuspension: false };
  const suspendsAt = addDays(accessUntil ?? sub.startsAt, Math.max(0, sub.graceDays));
  if (now.getTime() < suspendsAt.getTime()) return { state: "PAST_DUE", held: false, accessUntil, suspendsAt, manualSuspension: false };
  return { state: "SUSPENDED", held: true, accessUntil, suspendsAt, manualSuspension: false };
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

// ---------------------------------------------------------------------------------------------
// Notices and reminders
// ---------------------------------------------------------------------------------------------

export interface BillingNotice {
  tone: "danger" | "warning" | "info";
  title: string;
  message: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** What the customer's workspace shows about their subscription, or null when nothing needs saying. */
export function billingNotice(reading: SubscriptionReading, now: Date, remindWithinDays: number = DEFAULT_REMINDER_DAYS[0]): BillingNotice | null {
  switch (reading.state) {
    case "SUSPENDED":
      return {
        tone: "danger",
        title: "Your subscription is suspended",
        message:
          "This workspace is read-only: automation and outgoing messages are paused, and incoming messages are still being saved. Renew your subscription to continue.",
      };
    case "CANCELLED":
      return { tone: "danger", title: "Your subscription has ended", message: "This workspace is read-only. Contact us to renew." };
    case "PAST_DUE":
      return {
        tone: "warning",
        title: "Payment due",
        message: reading.suspendsAt
          ? `Your subscription ended${reading.accessUntil ? ` on ${day(reading.accessUntil)}` : ""}. Renew by ${day(reading.suspendsAt)} to avoid suspension.`
          : `Your subscription ended${reading.accessUntil ? ` on ${day(reading.accessUntil)}` : ""}. Please renew.`,
      };
    case "TRIALING":
    case "ACTIVE": {
      if (!reading.accessUntil) return null;
      const left = daysUntil(reading.accessUntil, now);
      if (left > remindWithinDays) return null;
      return {
        tone: "info",
        title: reading.state === "TRIALING" ? "Your trial ends soon" : "Your subscription renews soon",
        message: `It ends on ${day(reading.accessUntil)} (${left} day${left === 1 ? "" : "s"} left). Renew to keep everything running.`,
      };
    }
  }
}

export type ReminderKind = "EXPIRING" | "PAST_DUE" | "SUSPENDED";

export interface DueReminder {
  kind: ReminderKind;
  /** Unique per subscription + kind + period: a reminder is never sent twice. */
  dedupKey: string;
  daysBefore?: number;
}

/**
 * The reminder due now, if any. Before the end: only the CLOSEST reminder day already reached is
 * due (a subscription created three days before its end gets the 3-day reminder, not 7 and 3 at
 * once). After the end: one "payment due"; after suspension: one "suspended".
 */
export function dueReminder(subscriptionId: string, reading: SubscriptionReading, now: Date, reminderDays: readonly number[]): DueReminder | null {
  const period = reading.accessUntil ? reading.accessUntil.toISOString() : "none";
  if (reading.state === "SUSPENDED" && !reading.manualSuspension) {
    return { kind: "SUSPENDED", dedupKey: `${subscriptionId}:SUSPENDED:${period}` };
  }
  if (reading.state === "PAST_DUE") return { kind: "PAST_DUE", dedupKey: `${subscriptionId}:PAST_DUE:${period}` };
  if ((reading.state === "ACTIVE" || reading.state === "TRIALING") && reading.accessUntil) {
    const msLeft = reading.accessUntil.getTime() - now.getTime();
    const reached = [...reminderDays].filter((d) => d > 0 && msLeft <= d * DAY_MS).sort((a, b) => a - b);
    const closest = reached[0];
    if (closest !== undefined) return { kind: "EXPIRING", dedupKey: `${subscriptionId}:EXPIRING:${closest}:${period}`, daysBefore: closest };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export type LimitKind = "WHATSAPP_ACCOUNTS" | "USERS";

/** Null when one more is allowed; otherwise the plain reason. A null limit means unlimited. */
export function limitRefusal(kind: LimitKind, current: number, max: number | null | undefined, planName: string): string | null {
  if (max === null || max === undefined) return null;
  if (current < max) return null;
  const what = kind === "WHATSAPP_ACCOUNTS" ? `WhatsApp number${max === 1 ? "" : "s"}` : `user${max === 1 ? "" : "s"}`;
  return `The ${planName} plan includes ${max} ${what}, and all are in use. Upgrade the plan to add more — nothing existing is removed.`;
}

// ---------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------

export interface PlanInput {
  name: string;
  description: string | null;
  priceMinor: bigint;
  currency: Currency;
  interval: BillingInterval;
  trialDays: number;
  maxWhatsAppAccounts: number | null;
  maxUsers: number | null;
  features: string[];
  /** Every module, including ones added later ("All Access"); `features` is then ignored. */
  allModules: boolean;
}

const optionalCount = (raw: unknown): number | null | "invalid" => {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (!/^\d{1,5}$/.test(text)) return "invalid";
  return Number(text);
};

/** Reads and checks a plan form. `knownFeatures` is the feature catalogue's keys. */
export function parsePlanInput(
  form: { get(name: string): unknown; getAll(name: string): unknown[] },
  knownFeatures: readonly string[],
): { plan: PlanInput } | { errors: Partial<Record<keyof PlanInput, string>> } {
  const errors: Partial<Record<keyof PlanInput, string>> = {};
  const name = String(form.get("name") ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) errors.name = "Give the plan a name.";
  const priceMinor = parseMoneyToMinor(form.get("price"));
  if (priceMinor === null) errors.priceMinor = "Enter the price, for example 1500 or 1500.50.";
  const currency = String(form.get("currency") ?? DEFAULT_CURRENCY);
  if (!isCurrency(currency)) errors.currency = "Only BDT is supported for now.";
  const interval = String(form.get("interval") ?? "MONTH");
  if (!isBillingInterval(interval)) errors.interval = "Choose monthly or yearly.";
  const trialRaw = String(form.get("trialDays") ?? "0").trim() || "0";
  const trialDays = /^\d{1,3}$/.test(trialRaw) ? Number(trialRaw) : NaN;
  if (!Number.isFinite(trialDays) || trialDays > 365) errors.trialDays = "Trial days must be between 0 and 365.";
  const maxWhatsAppAccounts = optionalCount(form.get("maxWhatsAppAccounts"));
  if (maxWhatsAppAccounts === "invalid") errors.maxWhatsAppAccounts = "Enter a whole number, or leave it empty for no limit.";
  const maxUsers = optionalCount(form.get("maxUsers"));
  if (maxUsers === "invalid") errors.maxUsers = "Enter a whole number, or leave it empty for no limit.";
  const allModules = form.get("allModules") === "on";
  const features = allModules ? [] : [...new Set(form.getAll("features").map(String))].filter((k) => knownFeatures.includes(k));
  if (Object.keys(errors).length > 0) return { errors };
  return {
    plan: {
      name,
      description: String(form.get("description") ?? "").trim().slice(0, 500) || null,
      priceMinor: priceMinor!,
      currency: currency as Currency,
      interval: interval as BillingInterval,
      trialDays,
      maxWhatsAppAccounts: maxWhatsAppAccounts as number | null,
      maxUsers: maxUsers as number | null,
      features,
      allModules,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Emails (sent by the worker only when platform SMTP is configured)
// ---------------------------------------------------------------------------------------------

export interface BillingEmail {
  subject: string;
  text: string;
}

/** The reminder email for one due reminder. Plain text; no amount is invented, only the plan's own price. */
export function reminderEmail(input: {
  productName: string;
  customerName: string;
  planName: string;
  price: string;
  reminder: DueReminder;
  reading: SubscriptionReading;
  paymentInstructions: string | null;
}): BillingEmail {
  const { productName, customerName, planName, price, reminder, reading } = input;
  const until = reading.accessUntil ? day(reading.accessUntil) : null;
  const lines: string[] = [`Hello ${customerName},`, ""];
  let subject: string;
  if (reminder.kind === "EXPIRING") {
    subject = `${productName}: your subscription renews${until ? ` on ${until}` : " soon"}`;
    lines.push(`Your ${planName} subscription (${price}) is paid until ${until ?? "soon"}. Please renew before then to keep your workspace running without interruption.`);
  } else if (reminder.kind === "PAST_DUE") {
    subject = `${productName}: payment due`;
    lines.push(
      reading.suspendsAt
        ? `Your ${planName} subscription${until ? ` ended on ${until}` : " is unpaid"}. Please renew by ${day(reading.suspendsAt)} to avoid suspension.`
        : `Your ${planName} subscription${until ? ` ended on ${until}` : " is unpaid"}. Please renew.`,
    );
  } else {
    subject = `${productName}: subscription suspended`;
    lines.push(
      "Your workspace is now read-only: automation and outgoing messages are paused. Incoming messages are still being saved, and nothing has been deleted.",
      "Renew your subscription to continue.",
    );
  }
  if (input.paymentInstructions?.trim()) lines.push("", "How to pay:", input.paymentInstructions.trim());
  lines.push("", `You can see your plan, invoices and payments under Subscription in your ${productName} workspace.`);
  return { subject, text: lines.join("\n") };
}

/** The owner's invitation email. */
export function invitationEmail(input: { productName: string; name: string; customerName: string; link: string; expiresAt: Date }): BillingEmail {
  return {
    subject: `${input.productName}: your workspace is ready`,
    text: [
      `Hello ${input.name},`,
      "",
      `You have been invited to manage ${input.customerName}'s workspace on ${input.productName}.`,
      "Open this link to choose your username and password:",
      "",
      input.link,
      "",
      `The link works once and expires on ${input.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC. If you did not expect it, ignore this email.`,
    ].join("\n"),
  };
}

/** The built-in product name when no branding is saved (BRANDING.md). The web's DEFAULT_BRANDING reads it too. */
export const DEFAULT_PRODUCT_NAME = "Nexora";
