import {
  calendarDaysBetween,
  clientMessageState,
  CLIENT_MESSAGE_STATE_LABELS,
  decimalToMinor,
  describeDuration,
  dhakaToday,
  emailConnectionState,
  emailEligibility,
  formatMinor,
  remainingOn,
  whatsappClickToChatUrl,
  type ClientMessageState,
  type EmailEligibility,
  type MessageVariableKey,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { requireActiveProject } from "@/server/projectContext";
import { currentDocumentSettings } from "@/server/clientDocuments";
import { formatDay } from "@/lib/clientDisplay";

/**
 * Client messages (CLIENT_CRM_V7.md §6) — READS and value resolution. Not a "use server" file; every caller has
 * made its own permission check. Values come only from the client's OWN records, read through the project-scoped
 * client: a template can never reach another client's or another project's data, because every lookup is narrowed
 * to this client id and the related record must belong to it.
 */

/** What a message is about. Each id is checked to belong to the client before anything is read from it. */
export interface MessageContext {
  dueId?: string;
  paymentId?: string;
  offerId?: string;
  subscriptionId?: string;
}

export function readMessageContext(raw: unknown): MessageContext {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(v) ? v : undefined);
  return { dueId: id(r.dueId), paymentId: id(r.paymentId), offerId: id(r.offerId), subscriptionId: id(r.subscriptionId) };
}

export interface ResolvedValues {
  values: Partial<Record<MessageVariableKey, string>>;
  /** The context records that really belong to this client (anything else was dropped). */
  context: MessageContext;
}

/**
 * The variable values for one client. Money (invoice, payment, offer price) is filled only for a viewer allowed to
 * see billing; for anyone else those variables are simply empty, exactly as a missing value.
 */
export async function resolveMessageValues(clientId: string, context: MessageContext, opts: { billing: boolean }): Promise<ResolvedValues | null> {
  const client = await prisma.client.findFirst({
    where: { id: clientId },
    select: {
      id: true,
      name: true,
      code: true,
      companyName: true,
      currentSubscription: { select: { id: true, service: true, endDate: true } },
    },
  });
  if (!client) return null;
  const today = dhakaToday(new Date());
  const [settings, project, due, payment, offer, subscription] = await Promise.all([
    currentDocumentSettings(),
    requireActiveProject(),
    context.dueId ? prisma.clientDue.findFirst({ where: { id: context.dueId, clientId }, select: { id: true, invoiceNumber: true, amount: true, paidAmount: true, currency: true, status: true, dueDate: true, service: true } }) : null,
    context.paymentId ? prisma.clientPayment.findFirst({ where: { id: context.paymentId, clientId }, select: { id: true, receiptNumber: true, amount: true, currency: true, receivedDate: true, reversedAt: true } }) : null,
    context.offerId
      ? prisma.clientRenewalOffer.findFirst({ where: { id: context.offerId, clientId }, select: { id: true, service: true, durationValue: true, durationUnit: true, amount: true, currency: true, validUntil: true, subscriptionId: true } })
      : null,
    context.subscriptionId ? prisma.clientSubscription.findFirst({ where: { id: context.subscriptionId, clientId }, select: { id: true, service: true, endDate: true } }) : null,
  ]);
  const term = subscription ?? (offer ? await prisma.clientSubscription.findFirst({ where: { id: offer.subscriptionId, clientId }, select: { id: true, service: true, endDate: true } }) : null) ?? client.currentSubscription;
  const day = (d: Date) => formatDay(d.toISOString().slice(0, 10));
  const values: Partial<Record<MessageVariableKey, string>> = {
    client_name: client.name,
    client_code: client.code,
    company_name: client.companyName ?? undefined,
    business_name: settings.value.businessName ?? project.name,
    support_phone: settings.value.phone ?? undefined,
    support_email: settings.value.email ?? undefined,
    service_name: offer?.service ?? due?.service ?? term?.service ?? undefined,
  };
  if (term) {
    const end = term.endDate.toISOString().slice(0, 10);
    values.subscription_end_date = day(term.endDate);
    const left = calendarDaysBetween(today, end);
    if (left >= 0) values.days_left = String(left);
  }
  if (offer) {
    values.offer_duration = describeDuration(offer.durationValue, offer.durationUnit);
    if (offer.validUntil) values.offer_valid_until = day(offer.validUntil);
    if (opts.billing && offer.amount !== null && offer.currency) values.offer_amount = formatMinor(decimalToMinor(offer.amount) ?? BigInt(0), offer.currency);
  }
  if (opts.billing && due) {
    values.invoice_number = due.invoiceNumber ?? undefined;
    values.due_date = day(due.dueDate);
    if (due.amount !== null && due.currency) {
      const amount = decimalToMinor(due.amount) ?? BigInt(0);
      const paid = decimalToMinor(due.paidAmount) ?? BigInt(0);
      values.invoice_amount = formatMinor(amount, due.currency);
      values.amount_due = formatMinor(remainingOn({ status: due.status, amount, paid }), due.currency);
      values.currency = due.currency;
    }
  }
  if (opts.billing && payment && !payment.reversedAt) {
    values.receipt_number = payment.receiptNumber;
    values.payment_amount = formatMinor(decimalToMinor(payment.amount) ?? BigInt(0), payment.currency);
    values.payment_date = day(payment.receivedDate);
    values.currency = values.currency ?? payment.currency;
  }
  if (!values.currency && opts.billing && offer?.currency) values.currency = offer.currency;
  return {
    values,
    context: {
      dueId: due?.id,
      paymentId: payment && !payment.reversedAt ? payment.id : undefined,
      offerId: offer?.id,
      subscriptionId: term?.id,
    },
  };
}

/** Is the project's email channel switched on AND verified under its current settings? */
export async function emailChannelReady(): Promise<{ ready: boolean; reason: string | null }> {
  const s = await prisma.emailSettings.findFirst({ select: { enabled: true, host: true, fromAddress: true, passwordCiphertext: true, settingsVersion: true, verifiedVersion: true, lastTestOk: true } });
  if (!s) return { ready: false, reason: "Email is not set up for this project (Settings → Email)." };
  const state = emailConnectionState({ host: s.host, fromAddress: s.fromAddress, passwordSet: s.passwordCiphertext !== null, settingsVersion: s.settingsVersion, verifiedVersion: s.verifiedVersion, lastTestOk: s.lastTestOk });
  if (state !== "CONNECTED") return { ready: false, reason: "Email is not connected: send a test message under Settings → Email first." };
  if (!s.enabled) return { ready: false, reason: "Email is switched off for this project (Settings → Email)." };
  return { ready: true, reason: null };
}

/** The client's email addresses with their consent, for `emailEligibility`. */
export async function clientEmails(clientId: string): Promise<{ archived: boolean; emails: Array<{ value: string; consent: string; isPrimary: boolean }> } | null> {
  const c = await prisma.client.findFirst({ where: { id: clientId }, select: { status: true, channels: { where: { kind: "EMAIL" }, select: { value: true, consentStatus: true, isPrimary: true } } } });
  if (!c) return null;
  return { archived: c.status === "ARCHIVED", emails: c.channels.map((e) => ({ value: e.value, consent: e.consentStatus, isPrimary: e.isPrimary })) };
}

export interface WhatsAppRoute {
  /** This project's own WhatsApp Chat conversation, when one is linked to the client. */
  linkedChatHref: string | null;
  linkedAccountLabel: string | null;
  /** WhatsApp's own click-to-chat, opened on the person's device — never a send by Get Assist. */
  clickToChatNumber: string | null;
  /** Why neither exists, in a sentence. */
  reason: string | null;
}

/** How a person can reach this client on WhatsApp, best first (CLIENT_CRM_V7.md §2). */
export async function clientWhatsAppRoute(clientId: string): Promise<WhatsAppRoute> {
  const [link, channels] = await Promise.all([
    prisma.clientWhatsAppChatLink.findFirst({ where: { clientId, unlinkedAt: null }, orderBy: { linkedAt: "desc" }, select: { accountId: true, chatId: true, account: { select: { label: true } } } }),
    prisma.clientChannel.findMany({ where: { clientId, kind: { in: ["WHATSAPP", "PHONE"] } }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], select: { kind: true, normalizedValue: true } }),
  ]);
  const number = channels.find((c) => c.kind === "WHATSAPP") ?? channels.find((c) => c.kind === "PHONE");
  const usable = number && whatsappClickToChatUrl(number.normalizedValue) ? number.normalizedValue.replace(/\D/g, "") : null;
  return {
    linkedChatHref: link ? `/chat/account/${link.accountId}/personal/${encodeURIComponent(link.chatId)}` : null,
    linkedAccountLabel: link?.account.label ?? null,
    clickToChatNumber: usable,
    reason: link || usable ? null : number ? "The client's number is not a usable international number. Correct it on Edit client." : "The client has no WhatsApp or phone number. Add one on Edit client.",
  };
}

export interface ClientMessageView {
  id: string;
  channel: string;
  state: ClientMessageState;
  stateLabel: string;
  toAddress: string | null;
  subject: string | null;
  body: string;
  templateName: string | null;
  templateVersion: number | null;
  createdByName: string | null;
  createdAt: Date;
  batchId: string | null;
  error: string | null;
  skipReason: string | null;
}

/** Messages to a client or about one record, newest first. */
export async function listClientMessages(filter: { clientId?: string; dueId?: string; paymentId?: string; offerId?: string; batchId?: string }, take = 50): Promise<ClientMessageView[]> {
  const rows = await prisma.clientMessage.findMany({
    where: {
      ...(filter.clientId ? { clientId: filter.clientId } : {}),
      ...(filter.dueId ? { relatedDueId: filter.dueId } : {}),
      ...(filter.paymentId ? { relatedPaymentId: filter.paymentId } : {}),
      ...(filter.offerId ? { relatedOfferId: filter.offerId } : {}),
      ...(filter.batchId ? { batchId: filter.batchId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      channel: true,
      status: true,
      toAddress: true,
      subject: true,
      body: true,
      templateVersion: true,
      createdByName: true,
      createdAt: true,
      batchId: true,
      skipReason: true,
      template: { select: { name: true } },
      emailOutbox: { select: { status: true, lastError: true } },
    },
  });
  return rows.map((m) => {
    const state = clientMessageState(m, m.emailOutbox?.status ?? null);
    return {
      id: m.id,
      channel: m.channel,
      state,
      stateLabel: CLIENT_MESSAGE_STATE_LABELS[state],
      toAddress: m.toAddress,
      subject: m.subject,
      body: m.body,
      templateName: m.template?.name ?? null,
      templateVersion: m.templateVersion,
      createdByName: m.createdByName,
      createdAt: m.createdAt,
      batchId: m.batchId,
      error: state === "FAILED" || state === "UNKNOWN" ? (m.emailOutbox?.lastError ?? null) : null,
      skipReason: m.skipReason,
    };
  });
}

export type { EmailEligibility };
export { emailEligibility };
