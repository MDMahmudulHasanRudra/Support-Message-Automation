"use server";

import { revalidatePath } from "next/cache";
import {

  dhakaToday,
  describeDuration,
  isContactChannel,
  nextOfferStatus,
  parseCalendarDay,
  RENEWAL_OFFER_LIMITS,
  RENEWAL_OFFER_STATUS_LABELS,
  renewalStartDate,
  validateDue,
  validateRenewalOffer,
  validateSubscription,
  CONTACT_CHANNEL_LABELS,
  type ContactChannel,
  type RenewalOfferAction,
  type ValidDue,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { hasPermission } from "@/server/permissions";
import { projectPath } from "@/server/projectPaths";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { recordClientActivity } from "@/server/clientRecords";
import { subModuleOff } from "@/server/clientModule";
import { sellerSnapshot } from "@/server/clientSubscriptionStore";
import { createTermInTx } from "@/server/clientTermStore";

/**
 * Renewal offers (CLIENT_CRM_V7.md §4). Every function is a public endpoint and checks `clients.manage_subscriptions`
 * with Subscriptions switched on. An offer is a proposal and a record of the conversation about it — it is never an
 * invoice and never money owed. Each step is a conditional update on the status it was read in (two people pressing
 * at once change it once) and writes an append-only event in the same transaction.
 *
 * "Renew from offer" is the only step that creates anything outside the offer: the new term, through the same write
 * as Renew (one renewal per term, under the client lock), and — only if the person asks and may edit billing — its
 * invoice. The offer is claimed ACCEPTED → RENEWED in the SAME transaction, so an offer renews once.
 */

export interface OfferFormState {
  error?: string;
  success?: string;
  values?: Record<string, string>;
}

export interface OfferResult {
  ok: boolean;
  message: string;
}

const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
function echo(f: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of f.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = v.slice(0, 2000);
  return out;
}

async function guard() {
  const granted = await checkPermission("clients.manage_subscriptions");
  if ("denied" in granted) return { error: granted.denied } as const;
  const off = await subModuleOff("subscriptions");
  if (off) return { error: off } as const;
  return { session: granted.session } as const;
}

async function refresh(clientId: string) {
  for (const path of ["/clients/subscriptions/renewals", "/clients/subscriptions", `/clients/${clientId}`]) revalidatePath(await projectPath(path));
}

async function enabledCurrencies(): Promise<string[]> {
  return (await prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code);
}

/** Prepare an offer for a term. Nothing is sent and nothing is owed because of it. */
export async function prepareRenewalOffer(subscriptionId: string, _prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const g = await guard();
  if ("error" in g) return { error: g.error, values: echo(form) };
  const term = await prisma.clientSubscription.findFirst({ where: { id: subscriptionId }, select: { id: true, clientId: true, service: true, cancelledAt: true, client: { select: { status: true } } } });
  if (!term) return { error: "That subscription no longer exists.", values: echo(form) };
  if (term.cancelledAt) return { error: "A cancelled subscription cannot get a renewal offer. Add a new subscription instead.", values: echo(form) };
  if (term.client.status === "ARCHIVED") return { error: "This client is archived. Restore it first.", values: echo(form) };
  const today = dhakaToday(new Date());
  const parsed = validateRenewalOffer(
    { service: text(form, "service"), durationValue: text(form, "durationValue"), durationUnit: text(form, "durationUnit"), amount: text(form, "amount"), currency: text(form, "currency"), validUntil: text(form, "validUntil"), followUpDate: text(form, "followUpDate"), note: text(form, "note") },
    await enabledCurrencies(),
    today,
  );
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(form) };
  // A price is money: proposing one needs the billing view (the same people who will raise the invoice).
  if (parsed.value.amount !== null && !(await hasPermission(g.session, "clients.view_billing"))) return { error: "Proposing a price needs the View Client Billing permission. Leave the amount empty, or ask someone who has it.", values: echo(form) };
  const sellerId = text(form, "soldByMemberId") || null;
  const seller = await sellerSnapshot(sellerId);
  if ("error" in seller) return { error: seller.error, values: echo(form) };
  const o = parsed.value;
  try {
    await prisma.$transaction(async (tx) => {
      const offer = await tx.clientRenewalOffer.create({
        data: {
          clientId: term.clientId,
          subscriptionId: term.id,
          service: o.service,
          durationValue: o.durationValue,
          durationUnit: o.durationUnit,
          amount: o.amount,
          currency: o.currency,
          validUntil: o.validUntil ? new Date(`${o.validUntil}T00:00:00.000Z`) : null,
          followUpDate: o.followUpDate ? new Date(`${o.followUpDate}T00:00:00.000Z`) : null,
          note: o.note,
          soldByMemberId: seller.soldByMemberId,
          createdById: g.session.userId,
          createdByName: g.session.name,
        },
        select: { id: true },
      });
      await tx.clientRenewalOfferEvent.create({ data: { offerId: offer.id, clientId: term.clientId, type: "PREPARED", toStatus: "PREPARED", note: o.note, actorUserId: g.session.userId, actorName: g.session.name } });
      await recordClientActivity(tx, term.clientId, g.session.userId, { type: "RENEWAL_OFFER_PREPARED", summary: `Renewal offer prepared: ${o.service}, ${describeDuration(o.durationValue, o.durationUnit)}`, details: { offerId: offer.id, subscriptionId: term.id } });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "This term already has an open renewal offer. Continue with that one, or withdraw it first.", values: echo(form) };
    throw err;
  }
  await refresh(term.clientId);
  return { success: "Offer prepared. Nothing was sent and nothing is owed until you renew and raise an invoice." };
}

/**
 * One step on an offer: record a contact attempt, mark awaiting, record acceptance or decline, withdraw, or schedule a
 * follow-up. Conditional on the status it was read in.
 */
export async function updateRenewalOffer(offerId: string, action: RenewalOfferAction, input: { note?: string; channel?: string; followUpDate?: string }): Promise<OfferResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, message: g.error! };
  if (action === "RENEW") return { ok: false, message: "Use Renew from offer." };
  const offer = await prisma.clientRenewalOffer.findFirst({ where: { id: offerId }, select: { id: true, status: true, clientId: true, service: true, client: { select: { status: true } } } });
  if (!offer) return { ok: false, message: "That offer no longer exists." };
  if (offer.client.status === "ARCHIVED") return { ok: false, message: "This client is archived. Restore it first." };
  const next = nextOfferStatus(offer.status, action);
  if (!next.ok) return { ok: false, message: next.error };
  const note = String(input.note ?? "").trim();
  if (note.length > RENEWAL_OFFER_LIMITS.response) return { ok: false, message: `The note can be at most ${RENEWAL_OFFER_LIMITS.response} characters.` };
  let channel: ContactChannel | null = null;
  if (action === "RECORD_CONTACT") {
    if (!isContactChannel(input.channel)) return { ok: false, message: "Choose how the customer was contacted." };
    channel = input.channel;
  }
  let followUp: string | null = null;
  if (action === "SCHEDULE_FOLLOW_UP") {
    followUp = parseCalendarDay(String(input.followUpDate ?? ""));
    if (!followUp) return { ok: false, message: "Choose the follow-up date." };
  }
  if ((action === "DECLINE" || action === "WITHDRAW") && !note) return { ok: false, message: action === "DECLINE" ? "Note what the customer said." : "Say why it is withdrawn." };

  const now = new Date();
  const done = await prisma.$transaction(async (tx) => {
    const moved = await tx.clientRenewalOffer.updateMany({
      where: { id: offerId, status: offer.status },
      data: {
        status: next.to,
        ...(action === "RECORD_CONTACT" ? { contactCount: { increment: 1 }, lastContactAt: now } : {}),
        ...(action === "SCHEDULE_FOLLOW_UP" ? { followUpDate: new Date(`${followUp}T00:00:00.000Z`) } : {}),
        ...(action === "ACCEPT" || action === "DECLINE" ? { decidedAt: now, decidedById: g.session.userId, decidedByName: g.session.name, responseNote: note || null } : {}),
      },
    });
    if (moved.count !== 1) return false;
    await tx.clientRenewalOfferEvent.create({
      data: {
        offerId,
        clientId: offer.clientId,
        type: action === "RECORD_CONTACT" ? "CONTACT" : action === "SCHEDULE_FOLLOW_UP" ? "FOLLOW_UP" : "STATUS",
        fromStatus: offer.status,
        toStatus: next.to,
        channel,
        note: action === "SCHEDULE_FOLLOW_UP" ? `Follow up on ${followUp}${note ? ` — ${note}` : ""}` : note || null,
        actorUserId: g.session.userId,
        actorName: g.session.name,
      },
    });
    const summary =
      action === "RECORD_CONTACT"
        ? `Renewal offer: contacted by ${CONTACT_CHANNEL_LABELS[channel!]}`
        : action === "SCHEDULE_FOLLOW_UP"
          ? `Renewal follow-up scheduled for ${followUp}`
          : `Renewal offer: ${RENEWAL_OFFER_STATUS_LABELS[next.to].toLowerCase()}`;
    await recordClientActivity(tx, offer.clientId, g.session.userId, { type: "RENEWAL_OFFER_UPDATED", summary, details: { offerId } });
    return true;
  });
  if (!done) return { ok: false, message: "Someone changed this offer a moment ago. Reload the page." };
  await refresh(offer.clientId);
  const messages: Partial<Record<RenewalOfferAction, string>> = {
    RECORD_CONTACT: "Contact recorded.",
    MARK_AWAITING: "Marked as awaiting the customer's response.",
    ACCEPT: "Acceptance recorded. Nothing is owed yet — renew from the offer, and raise an invoice if one is due.",
    DECLINE: "Decline recorded. No balance was created.",
    WITHDRAW: "Offer withdrawn.",
    SCHEDULE_FOLLOW_UP: "Follow-up scheduled.",
  };
  return { ok: true, message: messages[action] ?? "Saved." };
}

/**
 * Renews the term from an ACCEPTED offer: a new term with the offer's service and duration, starting where the old
 * term ends (or today when it has lapsed) unless a start date is typed. An invoice is raised only when asked for —
 * with the offer's price, a due date, and the Edit Client Billing permission. The payment is recorded separately.
 */
export async function renewFromOffer(offerId: string, _prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const g = await guard();
  if ("error" in g) return { error: g.error, values: echo(form) };
  const offer = await prisma.clientRenewalOffer.findFirst({
    where: { id: offerId },
    select: { id: true, status: true, clientId: true, service: true, durationValue: true, durationUnit: true, amount: true, currency: true, soldByMemberId: true, subscription: { select: { id: true, kind: true, endDate: true, cancelledAt: true, soldByMemberId: true } } },
  });
  if (!offer) return { error: "That offer no longer exists.", values: echo(form) };
  const allowed = nextOfferStatus(offer.status, "RENEW");
  if (!allowed.ok) return { error: allowed.error, values: echo(form) };
  if (offer.subscription.cancelledAt) return { error: "The term this offer renews was cancelled. Add a new subscription instead.", values: echo(form) };

  const today = dhakaToday(new Date());
  const startDate = text(form, "startDate") || renewalStartDate(offer.subscription.endDate.toISOString().slice(0, 10), today);
  const parsed = validateSubscription({
    service: offer.service,
    kind: offer.subscription.kind === "TRIAL" || offer.subscription.kind === "DEMO" ? "PAID" : offer.subscription.kind,
    startDate,
    durationValue: String(offer.durationValue),
    durationUnit: offer.durationUnit,
    endDate: "",
    note: text(form, "note"),
  });
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(form) };
  const seller = await sellerSnapshot(offer.soldByMemberId ?? offer.subscription.soldByMemberId);
  // A seller who has since left does not block the renewal; the term is simply not credited to them.
  const sellerSnap = "error" in seller ? { soldByMemberId: null, soldByName: null, soldByTeamId: null, soldByTeamName: null } : seller;

  let invoice: ValidDue | null = null;
  if (form.get("raiseInvoice") === "1") {
    if (!(await hasPermission(g.session, "clients.edit_billing"))) return { error: "Raising an invoice needs the Edit Client Billing permission. Renew without it, or ask someone who has it.", values: echo(form) };
    const off = await subModuleOff("billing");
    if (off) return { error: off, values: echo(form) };
    if (offer.amount === null || !offer.currency) return { error: "This offer has no price, so there is nothing to invoice. Renew without an invoice and raise one on the Billing List.", values: echo(form) };
    const codes = (await prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code);
    const due = validateDue({ dueDate: text(form, "invoiceDueDate"), amount: offer.amount.toFixed(2), currency: offer.currency, status: "UNPAID", paidAmount: "", note: "" }, codes, offer.currency);
    if (!due.ok) return { error: `Invoice: ${due.errors.join(" ")}`, values: echo(form) };
    invoice = due.due;
  }

  class Refused extends Error {}
  let result: { invoiceNumber: string | null; endDate: string };
  try {
    result = await prisma.$transaction(async (tx) => {
      // Claim the offer first: two presses renew once.
      const claimed = await tx.clientRenewalOffer.updateMany({ where: { id: offerId, status: "ACCEPTED" }, data: { status: "RENEWED" } });
      if (claimed.count !== 1) throw new Refused("This offer was renewed a moment ago.");
      const term = await createTermInTx(tx, { clientId: offer.clientId, actorUserId: g.session.userId, term: parsed.value, seller: sellerSnap, renewedFromId: offer.subscription.id, invoice, today });
      if (!term.ok) throw new Refused(term.message);
      await tx.clientRenewalOffer.update({ where: { id: offerId }, data: { renewedSubscriptionId: term.subscriptionId, invoiceDueId: term.invoiceId } });
      await tx.clientRenewalOfferEvent.create({
        data: { offerId, clientId: offer.clientId, type: "RENEWED", fromStatus: "ACCEPTED", toStatus: "RENEWED", note: term.invoiceNumber ? `Invoice ${term.invoiceNumber} raised` : "No invoice raised", actorUserId: g.session.userId, actorName: g.session.name },
      });
      return { invoiceNumber: term.invoiceNumber, endDate: parsed.value.endDate };
    });
  } catch (err) {
    if (err instanceof Refused) return { error: err.message, values: echo(form) };
    throw err;
  }
  await refresh(offer.clientId);
  for (const path of ["/clients", "/clients/dues"]) revalidatePath(await projectPath(path));
  return { success: `Renewed until ${result.endDate}.${result.invoiceNumber ? ` Invoice ${result.invoiceNumber} raised — record the payment when it arrives.` : " No invoice was raised."}` };
}
