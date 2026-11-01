"use server";

import { revalidatePath } from "next/cache";
import {
  describeDuration,
  dhakaToday,
  renewalStartDate,
  SUBSCRIPTION_KIND_LABELS,
  SUBSCRIPTION_LIMITS,
  validateDue,
  validateSubscription,
  type SubscriptionKind,
  type ValidDue,
  type ValidSubscription,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { projectPath } from "@/server/projectPaths";
import { recordClientActivity } from "@/server/clientRecords";
import { subModuleOff } from "@/server/clientModule";
import { lockClient, refreshCurrentSubscription, sellerSnapshot } from "@/server/clientSubscriptionStore";
import { createTermInTx, type TermWrite } from "@/server/clientTermStore";

/**
 * Subscriptions (CLIENTS_V3.md §3). Every action is a public endpoint and checks its own key,
 * `clients.manage_subscriptions`, and that the sub-module is on in this project. A term is never
 * deleted — paused or cancelled, so "how many times did they renew" stays answerable.
 *
 * A sale may also raise its invoice in the same step, which needs `clients.edit_billing` and Billing
 * on; the subscription and the invoice stay separate records (an expiry is not a debt).
 */

export interface SubscriptionFormState {
  error?: string;
  success?: boolean;
  message?: string;
  values?: Record<string, string>;
}

export interface SubscriptionResult {
  ok: boolean;
  message: string;
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

function echo(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) if (typeof value === "string" && !key.startsWith("$ACTION")) out[key] = value.slice(0, 2000);
  return out;
}

async function refresh(clientId: string) {
  for (const path of ["/clients", "/clients/subscriptions", "/clients/dues", `/clients/${clientId}`]) revalidatePath(await projectPath(path));
}

const subscriptionInput = (formData: FormData) => ({
  service: text(formData, "service"),
  kind: text(formData, "kind"),
  startDate: text(formData, "startDate"),
  durationValue: text(formData, "durationValue"),
  durationUnit: text(formData, "durationUnit"),
  endDate: text(formData, "endDate"),
  note: text(formData, "note"),
});

/** The optional invoice typed beside a sale. Null when no amount was typed (nothing to bill). */
async function readSaleInvoice(formData: FormData, userSession: Parameters<typeof hasPermission>[0]) {
  const amount = text(formData, "invoiceAmount");
  if (!amount) return { invoice: null } as const;
  if (!(await hasPermission(userSession, "clients.edit_billing"))) return { error: "Raising an invoice needs the Edit Client Billing permission. Save the subscription without an amount, or ask someone who has it." } as const;
  const off = await subModuleOff("billing");
  if (off) return { error: off } as const;
  const codes = (await prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code);
  const due = validateDue({ dueDate: text(formData, "invoiceDueDate"), amount, currency: text(formData, "invoiceCurrency"), status: "UNPAID", paidAmount: "", note: "" }, codes);
  if (!due.ok) return { error: `Invoice: ${due.errors.join(" ")}` } as const;
  return { invoice: due.due } as const;
}

/**
 * The shared write: creates the term (and its invoice), recomputes the client's current term, records
 * the timeline. Runs under the client row lock.
 */
async function writeTerm(opts: TermWrite): Promise<{ ok: true; subscriptionId: string; invoiceNumber: string | null } | { ok: false; message: string }> {
  return prisma.$transaction((tx) => createTermInTx(tx, opts));
}

async function guard(formData?: FormData) {
  const granted = await checkPermission("clients.manage_subscriptions");
  if ("denied" in granted) return { error: granted.denied, values: formData ? echo(formData) : undefined } as const;
  const off = await subModuleOff("subscriptions");
  if (off) return { error: off, values: formData ? echo(formData) : undefined } as const;
  return { session: granted.session } as const;
}

/** A new term for a client: service, type, start and a duration (or expiry), seller from the real roster. */
export async function createSubscription(clientId: string, _prev: SubscriptionFormState, formData: FormData): Promise<SubscriptionFormState> {
  const g = await guard(formData);
  if ("error" in g) return { error: g.error, values: g.values };
  const parsed = validateSubscription(subscriptionInput(formData));
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(formData) };
  const seller = await sellerSnapshot(text(formData, "soldByMemberId") || null);
  if ("error" in seller) return { error: seller.error, values: echo(formData) };
  const sale = await readSaleInvoice(formData, g.session);
  if ("error" in sale) return { error: sale.error, values: echo(formData) };
  const today = dhakaToday(new Date());
  const result = await writeTerm({ clientId, actorUserId: g.session.userId, term: parsed.value, seller, renewedFromId: null, invoice: sale.invoice, today });
  if (!result.ok) return { error: result.message, values: echo(formData) };
  await refresh(clientId);
  return { success: true, message: result.invoiceNumber ? `Subscription saved, and invoice ${result.invoiceNumber} raised.` : "Subscription saved." };
}

/**
 * Renews a term: a NEW term that starts where the old one ends (or today, when it has lapsed), with the
 * same service and duration unless changed. The old term is left as history.
 */
export async function renewSubscription(subscriptionId: string, _prev: SubscriptionFormState, formData: FormData): Promise<SubscriptionFormState> {
  const g = await guard(formData);
  if ("error" in g) return { error: g.error, values: g.values };
  const previous = await prisma.clientSubscription.findFirst({
    where: { id: subscriptionId },
    select: { id: true, clientId: true, service: true, kind: true, endDate: true, durationValue: true, durationUnit: true, soldByMemberId: true, cancelledAt: true },
  });
  if (!previous) return { error: "That subscription no longer exists.", values: echo(formData) };
  if (previous.cancelledAt) return { error: "A cancelled subscription cannot be renewed. Add a new one instead.", values: echo(formData) };
  const today = dhakaToday(new Date());
  const input = subscriptionInput(formData);
  const filled = {
    ...input,
    service: input.service || previous.service,
    // A trial that is renewed becomes a paid term unless somebody says otherwise.
    kind: input.kind || (previous.kind === "TRIAL" || previous.kind === "DEMO" ? "PAID" : previous.kind),
    startDate: input.startDate || renewalStartDate(previous.endDate.toISOString().slice(0, 10), today),
    durationValue: input.durationValue || (input.endDate ? "" : String(previous.durationValue ?? "")),
    durationUnit: input.durationUnit || previous.durationUnit || "",
  };
  const parsed = validateSubscription(filled);
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(formData) };
  const sellerId = formData.has("soldByMemberId") ? text(formData, "soldByMemberId") || null : previous.soldByMemberId;
  const seller = await sellerSnapshot(sellerId);
  if ("error" in seller) return { error: seller.error, values: echo(formData) };
  const sale = await readSaleInvoice(formData, g.session);
  if ("error" in sale) return { error: sale.error, values: echo(formData) };
  const result = await writeTerm({ clientId: previous.clientId, actorUserId: g.session.userId, term: parsed.value, seller, renewedFromId: previous.id, invoice: sale.invoice, today });
  if (!result.ok) return { error: result.message, values: echo(formData) };
  await refresh(previous.clientId);
  return {
    success: true,
    message: `Renewed until ${parsed.value.endDate} (${describeDuration(parsed.value.durationValue, parsed.value.durationUnit)}).${result.invoiceNumber ? ` Invoice ${result.invoiceNumber} raised.` : ""}`,
  };
}

/** Pause or resume a running term. Pausing does not move the expiry; it marks the service as on hold. */
export async function setSubscriptionPaused(subscriptionId: string, paused: boolean): Promise<SubscriptionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, message: g.error! };
  const term = await prisma.clientSubscription.findFirst({ where: { id: subscriptionId }, select: { clientId: true, service: true, cancelledAt: true, pausedAt: true } });
  if (!term) return { ok: false, message: "That subscription no longer exists." };
  if (term.cancelledAt) return { ok: false, message: "A cancelled subscription cannot be paused or resumed." };
  const done = await prisma.$transaction(async (tx) => {
    if (!(await lockClient(tx, term.clientId))) return false;
    // Conditional on the current state, so two presses change it once.
    const updated = await tx.clientSubscription.updateMany({ where: { id: subscriptionId, cancelledAt: null, pausedAt: paused ? null : { not: null } }, data: { pausedAt: paused ? new Date() : null } });
    if (updated.count === 0) return false;
    await recordClientActivity(tx, term.clientId, g.session.userId, { type: paused ? "SUBSCRIPTION_PAUSED" : "SUBSCRIPTION_RESUMED", summary: `${paused ? "Paused" : "Resumed"}: ${term.service}`, details: { subscriptionId } });
    return true;
  });
  if (!done) return { ok: false, message: paused ? "It is already paused." : "It is not paused." };
  await refresh(term.clientId);
  return { ok: true, message: paused ? "Subscription paused." : "Subscription resumed." };
}

/** Cancels a term (kept as history). The client's current term is recomputed without it. */
export async function cancelSubscription(subscriptionId: string, reason: string): Promise<SubscriptionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, message: g.error! };
  const why = String(reason ?? "").trim();
  if (!why) return { ok: false, message: "Say why it is being cancelled." };
  if (why.length > SUBSCRIPTION_LIMITS.note) return { ok: false, message: `The reason can be at most ${SUBSCRIPTION_LIMITS.note} characters.` };
  const term = await prisma.clientSubscription.findFirst({ where: { id: subscriptionId }, select: { clientId: true, service: true } });
  if (!term) return { ok: false, message: "That subscription no longer exists." };
  const done = await prisma.$transaction(async (tx) => {
    if (!(await lockClient(tx, term.clientId))) return false;
    const updated = await tx.clientSubscription.updateMany({ where: { id: subscriptionId, cancelledAt: null }, data: { cancelledAt: new Date(), cancelReason: why } });
    if (updated.count === 0) return false;
    await refreshCurrentSubscription(tx, term.clientId);
    await recordClientActivity(tx, term.clientId, g.session.userId, { type: "SUBSCRIPTION_CANCELLED", summary: `Cancelled: ${term.service}`, details: { subscriptionId } });
    return true;
  });
  if (!done) return { ok: false, message: "It was already cancelled." };
  await refresh(term.clientId);
  return { ok: true, message: "Subscription cancelled. Its invoices are unchanged — cancel or waive them on the Billing List if they should not be paid." };
}

