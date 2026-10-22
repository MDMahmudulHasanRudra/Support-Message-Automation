"use server";

import { revalidatePath } from "next/cache";
import { applyPlanFeatures, customerProjectWhere, encryptSecret, prisma as globalPrisma, recomputeCustomerBilling, type Prisma } from "@support-automation/db";
import {
  addDays,
  addInterval,
  DEFAULT_CURRENCY,
  formatMoneyMinor,
  isBillingInterval,
  isSaasPaymentMethod,
  MAX_GRACE_DAYS,
  parseMoneyToMinor,
  parsePlanInput,
  PROJECT_FEATURES,
  SAAS_PAYMENT_METHOD_LABELS,
  subscriptionState,
  type BillingInterval,
} from "@support-automation/shared";
import { platformPrisma as customerPrisma } from "@/server/db";
import { forgetProjectAccessDecisions } from "@/server/projectContext";
import { forgetProjectFeatureStates } from "@/server/projectFeatures";
import { createUserWithAccess } from "@/server/adminUsers";
import { runWithTenant, tenantOfCustomer } from "@/server/tenant";
import { requireOperatorAction } from "@/server/platform/auth";
import { logPlatformEvent } from "@/server/platform/log";
import { getBillingSettings, invitationBaseUrl, newInvitationToken } from "@/server/platform/billing";
import { isUniqueViolation } from "@/lib/prismaErrors";

/**
 * SaaS billing actions — RELQIVO platform layer (SAAS_PLATFORM_PLAN.md §10, §12): billing settings,
 * plans, a customer's subscription, invoices, payments, suspend / unlock, and the customer owner's
 * access. Every action needs a signed-in platform operator and checks it itself — a Server Action is a
 * public endpoint — and no customer's login, of any role, can ever pass that check. Every change is
 * recorded twice: a SubscriptionEvent (the customer's own history) and a platform log entry. Every
 * change that could move the customer's hold ends in `recomputeCustomerBilling`, the only writer of it.
 *
 * Nothing here is ever applied to a customer automatically: a customer without a subscription is
 * never held or limited, and a subscription suspends by itself only when an admin turned
 * enforcement on for it. That is Customer #1's protection.
 */

async function requireManage(): Promise<{ session: { username: string } } | { denied: string }> {
  const access = await requireOperatorAction();
  return "denied" in access ? access : { session: { username: access.operator.username } };
}

export interface BillingActionResult {
  error?: string;
  success?: string;
  /** An invitation link, shown once so it can be copied. */
  link?: string;
  fieldErrors?: Record<string, string>;
  savedAt?: number;
}

function refresh() {
  forgetProjectAccessDecisions();
  forgetProjectFeatureStates();
  revalidatePath("/platform", "layout");
}

async function event(customerId: string, kind: string, detail: Record<string, unknown>, actor: string) {
  await globalPrisma.subscriptionEvent.create({ data: { customerId, kind, detail: detail as Prisma.InputJsonValue, actorUsername: actor } });
  await logPlatformEvent("INFO", `Subscription: ${kind}`, { customerId, ...detail, changedBy: actor }, { type: "Customer", id: customerId });
}

const dateField = (raw: FormDataEntryValue | null): Date | null => {
  const text = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const KNOWN_FEATURES = PROJECT_FEATURES.map((f) => f.key);

// ---------------------------------------------------------------------------------------------
// Billing settings
// ---------------------------------------------------------------------------------------------

export async function saveBillingSettings(_prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const grace = Number(String(formData.get("defaultGraceDays") ?? "").trim());
  if (!Number.isInteger(grace) || grace < 0 || grace > MAX_GRACE_DAYS) return { fieldErrors: { defaultGraceDays: `Grace days must be between 0 and ${MAX_GRACE_DAYS}.` } };
  const days = String(formData.get("reminderDaysBefore") ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 60)) return { fieldErrors: { reminderDaysBefore: "Use whole days between 1 and 60, for example 7, 3, 1." } };
  const reminderDaysBefore = [...new Set(days)].sort((a, b) => b - a);
  const paymentInstructions = String(formData.get("paymentInstructions") ?? "").trim().slice(0, 1_000) || null;
  const defaultPlanRaw = String(formData.get("defaultPlanId") ?? "");
  const defaultPlan = defaultPlanRaw ? await globalPrisma.plan.findFirst({ where: { id: defaultPlanRaw, isActive: true }, select: { id: true } }) : null;
  if (defaultPlanRaw && !defaultPlan) return { fieldErrors: { defaultPlanId: "Choose an active plan, or none." } };
  const data = { defaultGraceDays: grace, reminderDaysBefore, paymentInstructions, defaultPlanId: defaultPlan?.id ?? null, updatedByUsername: access.session.username };
  await globalPrisma.platformBillingSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  await logPlatformEvent("INFO", "Billing settings saved", { ...data });
  refresh();
  return { savedAt: Date.now() };
}

// ---------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------

/** Create (planId null) or edit a plan. Editing never changes a customer already on it (snapshot). */
export async function savePlan(planId: string | null, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const parsed = parsePlanInput(formData, KNOWN_FEATURES);
  if ("errors" in parsed) return { fieldErrors: parsed.errors as Record<string, string> };
  try {
    if (planId) {
      const updated = await globalPrisma.plan.updateMany({ where: { id: planId }, data: parsed.plan });
      if (updated.count === 0) return { error: "This plan no longer exists." };
    } else {
      await globalPrisma.plan.create({ data: parsed.plan });
    }
  } catch (err) {
    if (isUniqueViolation(err)) return { fieldErrors: { name: `A plan called "${parsed.plan.name}" already exists.` } };
    throw err;
  }
  await logPlatformEvent("INFO", `Plan "${parsed.plan.name}" ${planId ? "updated" : "created"}`, {
    price: formatMoneyMinor(parsed.plan.priceMinor, parsed.plan.currency),
    interval: parsed.plan.interval,
    changedBy: access.session.username,
  });
  refresh();
  return { savedAt: Date.now(), success: planId ? "Plan saved. Customers already on it keep their current terms." : "Plan created." };
}

/** Archive or restore a plan. An archived plan cannot be given to anyone new; current customers keep it. */
export async function setPlanActive(planId: string, active: boolean): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const updated = await globalPrisma.plan.updateMany({ where: { id: planId }, data: { isActive: active } });
  if (updated.count === 0) return { error: "This plan no longer exists." };
  await logPlatformEvent("INFO", active ? "Plan restored" : "Plan archived", { planId, changedBy: access.session.username });
  refresh();
  return { success: active ? "Plan restored." : "Plan archived. Customers already on it keep it." };
}

// ---------------------------------------------------------------------------------------------
// A customer's subscription
// ---------------------------------------------------------------------------------------------

async function currentSubscription(customerId: string) {
  return globalPrisma.subscription.findFirst({ where: { customerId, endedAt: null } });
}

/**
 * Put a customer on a plan: ends the current subscription (kept as history) and starts a new one
 * with a snapshot of the plan. The plan's features become the workspace's modules. Automatic
 * enforcement is OFF unless the admin ticks it — never assumed.
 */
export async function assignPlan(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const actor = access.session.username;
  const [customer, plan, settings] = await Promise.all([
    globalPrisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } }),
    globalPrisma.plan.findUnique({ where: { id: String(formData.get("planId") ?? "") } }),
    getBillingSettings(),
  ]);
  if (!customer) return { error: "This customer no longer exists." };
  if (!plan || !plan.isActive) return { fieldErrors: { planId: "Choose an active plan." } };

  const startsAt = dateField(formData.get("startsAt")) ?? new Date();
  const trialDaysRaw = String(formData.get("trialDays") ?? "").trim();
  const trialDays = trialDaysRaw === "" ? plan.trialDays : Number(trialDaysRaw);
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) return { fieldErrors: { trialDays: "Trial days must be between 0 and 365." } };
  const paidThrough = dateField(formData.get("paidThrough"));
  const graceRaw = String(formData.get("graceDays") ?? "").trim();
  const graceDays = graceRaw === "" ? settings.defaultGraceDays : Number(graceRaw);
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > MAX_GRACE_DAYS) return { fieldErrors: { graceDays: `Grace days must be between 0 and ${MAX_GRACE_DAYS}.` } };
  const autoEnforce = formData.get("autoEnforce") === "on";
  const applyFeatures = formData.get("applyFeatures") === "on";
  // The price agreed with this customer; empty = the plan's price.
  const priceRaw = String(formData.get("price") ?? "").trim();
  const priceMinor = priceRaw === "" ? plan.priceMinor : parseMoneyToMinor(priceRaw);
  if (priceMinor === null || priceMinor < BigInt(0)) return { fieldErrors: { price: "Enter the price for this customer, for example 1500, or leave it empty for the plan's price." } };
  const projectIds = (await globalPrisma.project.findMany({ where: await customerProjectWhere(globalPrisma, customerId), select: { id: true } })).map((p) => p.id);

  const now = new Date();
  await globalPrisma.$transaction(async (tx) => {
    await tx.subscription.updateMany({ where: { customerId, endedAt: null }, data: { endedAt: now } });
    await tx.subscription.create({
      data: {
        customerId,
        planId: plan.id,
        planName: plan.name,
        priceMinor,
        currency: plan.currency,
        interval: plan.interval,
        maxWhatsAppAccounts: plan.maxWhatsAppAccounts,
        maxUsers: plan.maxUsers,
        features: plan.features,
        allModules: plan.allModules,
        startsAt,
        trialEndsAt: trialDays > 0 ? addDays(startsAt, trialDays) : null,
        paidThrough,
        graceDays,
        autoEnforce,
        createdByUsername: actor,
      },
    });
    // The plan's modules become the modules of every project the customer runs (the existing
    // entitlement switches). "All Access" switches on every module.
    if (applyFeatures) await applyPlanFeatures(tx, projectIds, plan);
  });
  await event(customerId, "PLAN_ASSIGNED", { plan: plan.name, price: formatMoneyMinor(priceMinor, plan.currency), startsAt, trialDays, paidThrough, graceDays, autoEnforce, featuresApplied: applyFeatures }, actor);
  await recomputeCustomerBilling(globalPrisma, customerId, new Date(), actor);
  refresh();
  return { success: `${customer.name} is now on ${plan.name}.${autoEnforce ? "" : " Automatic suspension is off for this customer."}` };
}

/** Grace days, automatic enforcement and notes, on the current subscription. */
export async function updateSubscriptionTerms(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const sub = await currentSubscription(customerId);
  if (!sub) return { error: "This customer has no subscription yet." };
  const graceDays = Number(String(formData.get("graceDays") ?? "").trim());
  if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > MAX_GRACE_DAYS) return { fieldErrors: { graceDays: `Grace days must be between 0 and ${MAX_GRACE_DAYS}.` } };
  const autoEnforce = formData.get("autoEnforce") === "on";
  const notes = String(formData.get("notes") ?? "").trim().slice(0, 2_000) || null;
  await globalPrisma.subscription.update({ where: { id: sub.id }, data: { graceDays, autoEnforce, notes } });
  await event(customerId, "TERMS_CHANGED", { graceDays, autoEnforce, autoEnforceBefore: sub.autoEnforce }, access.session.username);
  await recomputeCustomerBilling(globalPrisma, customerId, new Date(), access.session.username);
  refresh();
  return { success: "Saved.", savedAt: Date.now() };
}

/** Add days to the paid period — from today when it has already ended. Unlocks an enforcement hold. */
export async function extendSubscription(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const sub = await currentSubscription(customerId);
  if (!sub) return { error: "This customer has no subscription yet." };
  const days = Number(String(formData.get("days") ?? "").trim());
  if (!Number.isInteger(days) || days < 1 || days > 3_650) return { fieldErrors: { days: "Enter the number of days to add (1 to 3650)." } };
  const now = new Date();
  const from = sub.paidThrough && sub.paidThrough > now ? sub.paidThrough : now;
  const paidThrough = addDays(from, days);
  await globalPrisma.subscription.update({ where: { id: sub.id }, data: { paidThrough } });
  await event(customerId, "EXTENDED", { days, paidThroughBefore: sub.paidThrough, paidThrough }, access.session.username);
  await recomputeCustomerBilling(globalPrisma, customerId, now, access.session.username);
  refresh();
  return { success: `Extended to ${paidThrough.toISOString().slice(0, 10)}.` };
}

/** Suspend now, whatever is paid: read-only workspace, nothing outward; data and sessions kept. */
export async function suspendSubscription(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const sub = await currentSubscription(customerId);
  if (!sub) return { error: "Give this customer a subscription first. (Suspending a project for another reason is done on its project page.)" };
  if (sub.suspendedAt) return { error: "Already suspended." };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500) || "Suspended by an admin";
  await globalPrisma.subscription.update({ where: { id: sub.id }, data: { suspendedAt: new Date(), suspendReason: reason } });
  await event(customerId, "SUSPENDED", { reason }, access.session.username);
  await recomputeCustomerBilling(globalPrisma, customerId, new Date(), access.session.username);
  refresh();
  return { success: "Suspended. The workspace is read-only and nothing is sent; incoming messages are still saved." };
}

/**
 * Unlock at once. Clears an admin's suspension and, when the subscription would still be held for
 * non-payment, grants its grace days from today, so pressing Unlock always unlocks.
 */
export async function unlockSubscription(customerId: string): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const sub = await currentSubscription(customerId);
  if (!sub) return { error: "This customer has no subscription." };
  const now = new Date();
  const cleared = { ...sub, suspendedAt: null, cancelledAt: sub.cancelledAt && sub.cancelledAt <= now ? null : sub.cancelledAt };
  const stillHeld = subscriptionState(cleared, now).held;
  const paidThrough = stillHeld ? addDays(now, Math.max(sub.graceDays, 1)) : sub.paidThrough;
  await globalPrisma.subscription.update({
    where: { id: sub.id },
    data: { suspendedAt: null, suspendReason: null, cancelledAt: cleared.cancelledAt, paidThrough },
  });
  await event(customerId, "UNLOCKED", { temporaryExtensionTo: stillHeld ? paidThrough : null }, access.session.username);
  await recomputeCustomerBilling(globalPrisma, customerId, now, access.session.username);
  refresh();
  return {
    success: stillHeld
      ? `Unlocked. It was unpaid, so service runs until ${paidThrough!.toISOString().slice(0, 10)} — record a payment before then.`
      : "Unlocked.",
  };
}

/** End service at the end of the paid period, or now. Data and sessions are kept; the workspace becomes read-only. */
export async function cancelSubscription(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const sub = await currentSubscription(customerId);
  if (!sub) return { error: "This customer has no subscription." };
  const now = new Date();
  const atPeriodEnd = formData.get("when") !== "now";
  const until = subscriptionState(sub, now).accessUntil;
  const cancelledAt = atPeriodEnd && until && until > now ? until : now;
  await globalPrisma.subscription.update({ where: { id: sub.id }, data: { cancelledAt } });
  await event(customerId, "CANCELLED", { cancelledAt, atPeriodEnd }, access.session.username);
  await recomputeCustomerBilling(globalPrisma, customerId, now, access.session.username);
  refresh();
  return { success: cancelledAt > now ? `Service ends on ${cancelledAt.toISOString().slice(0, 10)}.` : "Cancelled. The workspace is read-only." };
}

// ---------------------------------------------------------------------------------------------
// Invoices and payments
// ---------------------------------------------------------------------------------------------

async function nextInvoiceNumber(tx: Prisma.TransactionClient): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('subscription_invoice_seq') AS n`;
  return `INV-${String(row!.n).padStart(6, "0")}`;
}

/** The period the next invoice is for: from the end of what is paid (or the start), one interval long. */
/**
 * The period a payment or invoice covers: the billing cycle continues from the paid-through date,
 * unless that next period would already be over (the customer is more than a period behind) — then
 * it starts today, so a customer who pays is never left suspended by a period that has passed.
 */
function nextPeriod(sub: { paidThrough: Date | null; startsAt: Date; trialEndsAt: Date | null; interval: string }, now: Date = new Date()) {
  const interval: BillingInterval = isBillingInterval(sub.interval) ? sub.interval : "MONTH";
  const continued = sub.paidThrough ?? sub.trialEndsAt ?? sub.startsAt;
  const start = addInterval(continued, interval) > now ? continued : now;
  return { periodStart: start, periodEnd: addInterval(start, interval) };
}

/** Issue the invoice for the next period (OPEN until paid). The owner sees it in their workspace. */
export async function issueInvoice(customerId: string): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const sub = await currentSubscription(customerId);
  if (!sub) return { error: "Give this customer a subscription first." };
  const { periodStart, periodEnd } = nextPeriod(sub);
  const existing = await globalPrisma.subscriptionInvoice.findFirst({ where: { subscriptionId: sub.id, status: "OPEN", periodStart } });
  if (existing) return { error: `${existing.number} is already open for this period.` };
  const invoice = await globalPrisma.$transaction(async (tx) =>
    tx.subscriptionInvoice.create({
      data: {
        number: await nextInvoiceNumber(tx),
        customerId,
        subscriptionId: sub.id,
        periodStart,
        periodEnd,
        amountMinor: sub.priceMinor,
        currency: sub.currency,
        dueAt: periodStart,
        createdByUsername: access.session.username,
      },
    }),
  );
  await event(customerId, "INVOICE_ISSUED", { number: invoice.number, amount: formatMoneyMinor(invoice.amountMinor, invoice.currency), periodEnd }, access.session.username);
  refresh();
  return { success: `${invoice.number} issued for ${formatMoneyMinor(invoice.amountMinor, invoice.currency)}.` };
}

export async function voidInvoice(invoiceId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  if (!reason) return { fieldErrors: { reason: "Say why the invoice is voided." } };
  const invoice = await globalPrisma.subscriptionInvoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return { error: "This invoice no longer exists." };
  const updated = await globalPrisma.subscriptionInvoice.updateMany({ where: { id: invoiceId, status: "OPEN" }, data: { status: "VOID", voidedAt: new Date(), voidReason: reason } });
  if (updated.count === 0) return { error: "Only an open invoice can be voided." };
  await event(invoice.customerId, "INVOICE_VOIDED", { number: invoice.number, reason }, access.session.username);
  refresh();
  return { success: `${invoice.number} voided.` };
}

/**
 * Record a payment received by hand (bKash, Nagad, bank transfer, cash, card, other). It pays the
 * chosen open invoice — or, with none chosen, one is created already paid for the record — and moves
 * the paid period forward to the date entered (default: one more period). One transaction; the
 * hold is recomputed after, so paying a suspended customer unlocks them at once.
 */
export async function recordPayment(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const actor = access.session.username;
  const sub = await currentSubscription(customerId);
  if (!sub) return { error: "Give this customer a subscription first." };

  const fieldErrors: Record<string, string> = {};
  const amountMinor = parseMoneyToMinor(formData.get("amount"));
  if (amountMinor === null || amountMinor <= BigInt(0)) fieldErrors.amount = "Enter the amount received, for example 1500.";
  const method = String(formData.get("method") ?? "");
  if (!isSaasPaymentMethod(method)) fieldErrors.method = "Choose how it was paid.";
  const receivedAt = dateField(formData.get("receivedAt")) ?? new Date();
  const reference = String(formData.get("reference") ?? "").trim().slice(0, 120) || null;
  const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;
  const invoiceId = String(formData.get("invoiceId") ?? "") || null;
  const invoice = invoiceId ? await globalPrisma.subscriptionInvoice.findFirst({ where: { id: invoiceId, customerId } }) : null;
  if (invoiceId && (!invoice || invoice.status !== "OPEN")) fieldErrors.invoiceId = "That invoice is not open any more.";
  const period = invoice ? { periodStart: invoice.periodStart, periodEnd: invoice.periodEnd } : nextPeriod(sub);
  const coversThrough = dateField(formData.get("coversThrough")) ?? period.periodEnd;
  if (coversThrough <= (sub.paidThrough ?? new Date(0)) && !invoice) fieldErrors.coversThrough = "The payment should cover a date after the current paid-through date.";
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const paidThroughBefore = sub.paidThrough;
  const paidThrough = !paidThroughBefore || coversThrough > paidThroughBefore ? coversThrough : paidThroughBefore;
  const payment = await globalPrisma.$transaction(async (tx) => {
    let target = invoice;
    if (!target) {
      target = await tx.subscriptionInvoice.create({
        data: {
          number: await nextInvoiceNumber(tx),
          customerId,
          subscriptionId: sub.id,
          periodStart: period.periodStart,
          periodEnd: coversThrough,
          amountMinor: amountMinor!,
          currency: sub.currency,
          dueAt: period.periodStart,
          status: "OPEN",
          createdByUsername: actor,
        },
      });
    }
    const created = await tx.subscriptionPayment.create({
      data: {
        customerId,
        subscriptionId: sub.id,
        invoiceId: target.id,
        amountMinor: amountMinor!,
        currency: sub.currency || DEFAULT_CURRENCY,
        method,
        reference,
        receivedAt,
        note,
        recordedByUsername: actor,
      },
    });
    const paidSoFar = await tx.subscriptionPayment.aggregate({ where: { invoiceId: target.id, reversedAt: null }, _sum: { amountMinor: true } });
    if ((paidSoFar._sum.amountMinor ?? BigInt(0)) >= target.amountMinor) {
      await tx.subscriptionInvoice.updateMany({ where: { id: target.id, status: "OPEN" }, data: { status: "PAID", paidAt: receivedAt } });
    }
    await tx.subscription.update({ where: { id: sub.id }, data: { paidThrough } });
    return { ...created, invoiceNumber: target.number };
  });
  await event(
    customerId,
    "PAYMENT_RECORDED",
    {
      paymentId: payment.id,
      invoice: payment.invoiceNumber,
      amount: formatMoneyMinor(amountMinor!, sub.currency),
      method: SAAS_PAYMENT_METHOD_LABELS[method as keyof typeof SAAS_PAYMENT_METHOD_LABELS],
      paidThroughBefore,
      paidThrough,
    },
    actor,
  );
  await recomputeCustomerBilling(globalPrisma, customerId, new Date(), actor);
  refresh();
  return { success: `Payment recorded (${payment.invoiceNumber}). Paid through ${paidThrough.toISOString().slice(0, 10)}.` };
}

/**
 * Reverse a payment recorded by mistake (it is never edited or deleted — the database refuses).
 * Its invoice goes back to OPEN, and when this payment is what last moved the paid period, the
 * period goes back to where it was.
 */
export async function reversePayment(paymentId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  if (!reason) return { fieldErrors: { reason: "Say why the payment is reversed." } };
  const payment = await globalPrisma.subscriptionPayment.findUnique({ where: { id: paymentId } });
  if (!payment) return { error: "This payment no longer exists." };
  if (payment.reversedAt) return { error: "This payment is already reversed." };
  const recorded = await globalPrisma.subscriptionEvent.findFirst({
    where: { customerId: payment.customerId, kind: "PAYMENT_RECORDED", detail: { path: ["paymentId"], equals: paymentId } },
    orderBy: { createdAt: "desc" },
  });
  const detail = (recorded?.detail ?? {}) as { paidThroughBefore?: string | null; paidThrough?: string | null };
  await globalPrisma.$transaction(async (tx) => {
    const done = await tx.subscriptionPayment.updateMany({
      where: { id: paymentId, reversedAt: null },
      data: { reversedAt: new Date(), reversedByUsername: access.session.username, reversalReason: reason },
    });
    if (done.count !== 1) throw new Error("ALREADY_REVERSED");
    if (payment.invoiceId) await tx.subscriptionInvoice.updateMany({ where: { id: payment.invoiceId, status: "PAID" }, data: { status: "OPEN", paidAt: null } });
    const sub = await tx.subscription.findUnique({ where: { id: payment.subscriptionId }, select: { paidThrough: true } });
    if (sub?.paidThrough && detail.paidThrough && sub.paidThrough.toISOString() === new Date(detail.paidThrough).toISOString()) {
      await tx.subscription.update({ where: { id: payment.subscriptionId }, data: { paidThrough: detail.paidThroughBefore ? new Date(detail.paidThroughBefore) : null } });
    }
  });
  await event(payment.customerId, "PAYMENT_REVERSED", { paymentId, amount: formatMoneyMinor(payment.amountMinor, payment.currency), reason }, access.session.username);
  await recomputeCustomerBilling(globalPrisma, payment.customerId, new Date(), access.session.username);
  refresh();
  return { success: "Payment reversed." };
}

// ---------------------------------------------------------------------------------------------
// The customer's owner
// ---------------------------------------------------------------------------------------------

/**
 * The customer's software, as provisioning needs it: its tenant key, its Administrator role (the
 * customer's Main Admin role) and its first project.
 */
async function customerSoftware(customerId: string): Promise<{ tenant: string | null; administratorId: string; firstProjectId: string } | { error: string }> {
  const customer = await globalPrisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!customer) return { error: "This customer no longer exists." };
  const tenant = await tenantOfCustomer(customerId);
  const [role, project] = await Promise.all([
    globalPrisma.permissionModule.findFirst({ where: { customerId: tenant, name: "Administrator", isSystem: true }, select: { id: true } }),
    globalPrisma.project.findFirst({ where: await customerProjectWhere(globalPrisma, customerId), orderBy: { createdAt: "asc" }, select: { id: true } }),
  ]);
  if (!project) return { error: "This customer has no workspace yet." };
  if (!role) return { error: "This customer's Administrator role is missing. Run the deployment's seed step, then try again." };
  return { tenant, administratorId: role.id, firstProjectId: project.id };
}

/**
 * Create the owner's login directly: the customer's own Main Admin (its Administrator role), with
 * access to its first workspace. They manage their own software — projects, users, roles — and
 * nothing outside it: the login belongs to their customer, and no customer role reaches the platform.
 */
export async function createOwnerLogin(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const software = await customerSoftware(customerId);
  if ("error" in software) return { error: software.error };
  const result = await runWithTenant(software.tenant, () =>
    createUserWithAccess(customerPrisma, {
      username: formData.get("username"),
      name: formData.get("name"),
      email: formData.get("email"),
      password: formData.get("password"),
      confirmPassword: formData.get("confirmPassword"),
      permissionModuleId: software.administratorId,
      employee: null,
      access: [{ projectId: software.firstProjectId, level: "FULL" }],
    }),
  );
  if (!result.ok) return { error: result.error };
  await event(customerId, "OWNER_CREATED", { userId: result.userId, username: String(formData.get("username") ?? "") }, access.session.username);
  refresh();
  return { success: "Owner login created — the customer's Main Admin. Share the password privately; they can change it after signing in." };
}

/** Invite the owner: a single-use link (72 h), stored only as a hash, shown once here and emailed when platform email is set up. */
export async function inviteOwner(customerId: string, _prev: BillingActionResult, formData: FormData): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const software = await customerSoftware(customerId);
  if ("error" in software) return { error: software.error };
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const email = String(formData.get("email") ?? "").trim().toLowerCase().slice(0, 200) || null;
  if (!name) return { fieldErrors: { name: "Enter the owner's name." } };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { fieldErrors: { email: "Enter a valid email address, or leave it empty and copy the link." } };
  const base = await invitationBaseUrl(customerId);
  if ("error" in base) return { error: base.error };
  const { token, tokenHash } = newInvitationToken();
  const link = `${base.url}/invite/${token}`;
  // Kept encrypted only so the worker can email it; cleared once sent. No key = copy by hand.
  let linkCiphertext: string | null = null;
  if (email) {
    try {
      linkCiphertext = encryptSecret(link);
    } catch {
      linkCiphertext = null;
    }
  }
  await globalPrisma.userInvitation.create({
    data: { customerId, projectId: software.firstProjectId, name, email, tokenHash, linkCiphertext, expiresAt: addDays(new Date(), 3), createdByUsername: access.session.username },
  });
  await event(customerId, "OWNER_INVITED", { name, email }, access.session.username);
  refresh();
  return { success: linkCiphertext ? "Invitation created. It is emailed when platform email is configured; you can also copy the link." : "Invitation created. Copy the link and send it privately.", link };
}

export async function revokeInvitation(invitationId: string): Promise<BillingActionResult> {
  const access = await requireManage();
  if ("denied" in access) return { error: access.denied };
  const invitation = await globalPrisma.userInvitation.findUnique({ where: { id: invitationId }, select: { customerId: true, name: true } });
  if (!invitation) return { error: "This invitation no longer exists." };
  const done = await globalPrisma.userInvitation.updateMany({ where: { id: invitationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date(), linkCiphertext: null } });
  if (done.count === 0) return { error: "This invitation was already used or revoked." };
  await event(invitation.customerId, "INVITATION_REVOKED", { name: invitation.name }, access.session.username);
  refresh();
  return { success: "Invitation revoked." };
}
