import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@support-automation/db";
import {
  dhakaToday,
  formatPaymentAmount,
  formatPaymentLinkNumber,
  gatewayAmount,
  orderPaymentStatus,
  PAYMENT_LINK_CURRENCY,
  PAYMENT_PROVIDER_LABEL,
  type BkashCredentials,
  type ConversationRef,
  type PaymentModeValue,
  type PaymentProviderValue,
  type SslCommerzCredentials,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { subModuleOff } from "@/server/clientModule";
import { hasPermission } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { applyClientPayment } from "@/server/clientPaymentApply";
import { hashPaymentToken, newPaymentToken, paymentBaseUrl } from "@/server/platform/paymentLookup";
import { executeBkash, queryBkash, querySslCommerz, startBkash, startSslCommerz, type GatewayVerdict } from "@/server/payments/gateways";
import type { Session } from "@/server/auth";

/**
 * Payment links (PAYMENT_LINKS.md): making one, starting a payment, and settling what a gateway says happened. Everything
 * runs inside the link's project. A paid link settles its invoice or order through the same code a person's payment uses.
 */

type Fetch = typeof fetch;

export interface PaymentActor {
  userId: string | null;
  name: string;
}

async function projectCustomerId(): Promise<string | null> {
  const row = await prisma.project.findFirst({ where: { id: await activeProjectId() }, select: { customerId: true } });
  return row?.customerId ?? null;
}

export async function paymentUrl(tokenCiphertext: string): Promise<string> {
  return `${await paymentBaseUrl(await projectCustomerId())}/pay/${decryptSecret(tokenCiphertext)}`;
}

export interface NewPaymentLink {
  amountMinor: bigint;
  description: string | null;
  days: number;
  conversation: ConversationRef | null;
  clientDueId: string | null;
  orderId: string | null;
  clientId: string | null;
  contactId: string | null;
  customerName: string | null;
}

export async function createPaymentLinkRow(input: NewPaymentLink, actor: PaymentActor): Promise<{ id: string; number: number; url: string }> {
  const projectId = await activeProjectId();
  const token = newPaymentToken();
  const now = new Date();
  const link = await prisma.$transaction(async (tx) => {
    const [counter] = await tx.$queryRaw<Array<{ n: number }>>`
      INSERT INTO "PaymentSettings" ("id", "projectId", "lastNumber", "updatedAt") VALUES (gen_random_uuid()::text, ${projectId}, 1, ${now})
      ON CONFLICT ("projectId") DO UPDATE SET "lastNumber" = "PaymentSettings"."lastNumber" + 1
      RETURNING "lastNumber" AS n`;
    const row = await tx.paymentLink.create({
      data: {
        number: counter!.n,
        tokenHash: hashPaymentToken(token),
        tokenCiphertext: encryptSecret(token),
        amountMinor: input.amountMinor,
        currency: PAYMENT_LINK_CURRENCY,
        description: input.description,
        expiresAt: new Date(now.getTime() + input.days * 86_400_000),
        clientDueId: input.clientDueId,
        orderId: input.orderId,
        clientId: input.clientId,
        contactId: input.contactId,
        customerName: input.customerName,
        ...(input.conversation?.kind === "whatsapp" ? { accountId: input.conversation.accountId, chatId: input.conversation.chatId } : input.conversation?.kind === "channel" ? { channelConversationId: input.conversation.conversationId } : {}),
        createdById: actor.userId,
        createdByName: actor.name,
      },
      select: { id: true, number: true },
    });
    await tx.paymentLinkEvent.create({ data: { linkId: row.id, kind: "CREATED", detail: formatPaymentAmount(input.amountMinor), actorName: actor.name } });
    return row;
  });
  return { ...link, url: `${await paymentBaseUrl(await projectCustomerId())}/pay/${token}` };
}

// ── Gateways ────────────────────────────────────────────────────────────────────────────────────

type Gateway = { provider: PaymentProviderValue; mode: PaymentModeValue; credentials: Record<string, string> };

async function enabledGateway(provider: PaymentProviderValue): Promise<Gateway | null> {
  const row = await prisma.paymentGateway.findFirst({ where: { provider, enabled: true } });
  return row ? { provider, mode: row.mode, credentials: JSON.parse(decryptSecret(row.credentialsCiphertext)) as Record<string, string> } : null;
}

async function gatewayOf(provider: PaymentProviderValue): Promise<Gateway | null> {
  const row = await prisma.paymentGateway.findFirst({ where: { provider } });
  return row ? { provider, mode: row.mode, credentials: JSON.parse(decryptSecret(row.credentialsCiphertext)) as Record<string, string> } : null;
}

export async function enabledProviders(): Promise<PaymentProviderValue[]> {
  return (await prisma.paymentGateway.findMany({ where: { enabled: true }, select: { provider: true }, orderBy: { provider: "desc" } })).map((g) => g.provider);
}

const MAX_ATTEMPTS = 25;

export async function startPayment(linkId: string, token: string, provider: PaymentProviderValue, fetchImpl: Fetch = fetch): Promise<{ url: string } | { error: string }> {
  const link = await prisma.paymentLink.findFirst({ where: { id: linkId } });
  if (!link) return { error: "This payment link no longer exists." };
  const now = new Date();
  if (link.status === "PAID") return { error: "This has already been paid." };
  if (link.status !== "OPEN") return { error: "This payment link is no longer active." };
  if (link.expiresAt <= now) {
    await prisma.paymentLink.updateMany({ where: { id: link.id, status: "OPEN" }, data: { status: "EXPIRED" } });
    return { error: "This payment link has expired. Please ask for a new one." };
  }
  const gateway = await enabledGateway(provider);
  if (!gateway) return { error: "That way of paying is not available." };
  const count = await prisma.paymentAttempt.count({ where: { linkId: link.id } });
  if (count >= MAX_ATTEMPTS) return { error: "Too many tries on this link. Please contact the business." };

  const reference = `${formatPaymentLinkNumber(link.number)}-${randomBytes(5).toString("hex")}`;
  const attempt = await prisma.paymentAttempt.create({ data: { linkId: link.id, provider, mode: gateway.mode, reference } });
  const base = await paymentBaseUrl(await projectCustomerId());
  const started =
    provider === "SSLCOMMERZ"
      ? await startSslCommerz({ creds: gateway.credentials as unknown as SslCommerzCredentials, mode: gateway.mode, reference, amountMinor: link.amountMinor, description: link.description ?? formatPaymentLinkNumber(link.number), customerName: link.customerName, callbackBase: `${base}/api/pay/sslcommerz/${token}` }, fetchImpl)
      : await startBkash({ creds: gateway.credentials as unknown as BkashCredentials, mode: gateway.mode, reference, amountMinor: link.amountMinor, callbackUrl: `${base}/api/pay/bkash/${token}` }, fetchImpl);
  if (!started.ok) {
    await prisma.paymentAttempt.updateMany({ where: { id: attempt.id }, data: { status: "FAILED", note: started.message.slice(0, 300) } });
    return { error: "Payment could not be started. Please try again in a moment." };
  }
  await prisma.paymentAttempt.updateMany({ where: { id: attempt.id }, data: { sessionRef: started.sessionRef } });
  return { url: started.url };
}

export type SettleOutcome = "PAID" | "ALREADY" | "DOUBLE" | "MISMATCH" | "NOT_PAID" | "UNKNOWN";

/** Records what the gateway said about one try. Safe to run any number of times for the same try. */
export async function settleAttempt(attemptId: string, verdict: GatewayVerdict): Promise<SettleOutcome> {
  const attempt = await prisma.paymentAttempt.findFirst({ where: { id: attemptId }, include: { link: true } });
  if (!attempt) return "NOT_PAID";
  if (attempt.status === "PAID") return "ALREADY";
  const { link } = attempt;
  const label = PAYMENT_PROVIDER_LABEL[attempt.provider];

  if (verdict.state === "UNKNOWN") {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["STARTED", "UNKNOWN"] } }, data: { status: "UNKNOWN", note: verdict.note.slice(0, 300) } });
      if (moved.count) await tx.paymentLink.updateMany({ where: { id: link.id }, data: { needsAttention: true, attentionNote: `${label} could not confirm a payment. Use Check again.` } });
    });
    return "UNKNOWN";
  }
  if (verdict.state === "NOT_PAID") {
    await prisma.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ["STARTED", "UNKNOWN"] } }, data: { status: "FAILED", note: verdict.note.slice(0, 300) } });
    return "NOT_PAID";
  }

  // The customer's money moved, so anything odd from here on is for a person, never silently dropped.
  if (verdict.amountMinor !== link.amountMinor || (verdict.currency !== null && verdict.currency !== link.currency)) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: { not: "PAID" } }, data: { status: "MISMATCH", gatewayTxnId: verdict.txnId, note: "The amount paid is not the amount asked for." } });
      if (moved.count) {
        await tx.paymentLink.updateMany({ where: { id: link.id }, data: { needsAttention: true, attentionNote: `${label} reports a different amount from this link. Check it in your ${label} account.` } });
        await tx.paymentLinkEvent.create({ data: { linkId: link.id, kind: "AMOUNT_MISMATCH", detail: `${label} ${verdict.txnId ?? ""}`.trim() } });
      }
    });
    return "MISMATCH";
  }

  const now = new Date();
  return prisma.$transaction(
    async (tx): Promise<SettleOutcome> => {
      const claimed = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, status: { not: "PAID" } }, data: { status: "PAID", gatewayTxnId: verdict.txnId, note: null } });
      if (claimed.count === 0) return "ALREADY";

      const first = await tx.paymentLink.updateMany({ where: { id: link.id, status: { not: "PAID" } }, data: { status: "PAID", paidAt: now, paidProvider: attempt.provider, gatewayTxnId: verdict.txnId, needsAttention: false, attentionNote: null } });
      if (first.count === 0) {
        await tx.paymentLink.updateMany({ where: { id: link.id }, data: { needsAttention: true, attentionNote: `Paid a second time through ${label} (${verdict.txnId ?? "no reference"}). Refund one of them.` } });
        await tx.paymentLinkEvent.create({ data: { linkId: link.id, kind: "PAID_TWICE", detail: `${label} ${verdict.txnId ?? ""}`.trim() } });
        return "DOUBLE";
      }
      await tx.paymentLinkEvent.create({ data: { linkId: link.id, kind: "PAID", detail: `${label} ${verdict.txnId ?? ""}`.trim() } });
      if (link.status !== "OPEN") await tx.paymentLink.updateMany({ where: { id: link.id }, data: { needsAttention: true, attentionNote: "Paid after this link was cancelled or had expired." } });

      const attention = (note: string) => tx.paymentLink.updateMany({ where: { id: link.id }, data: { needsAttention: true, attentionNote: note } });
      if (link.clientDueId) {
        const off = await subModuleOff("payments");
        if (off) await attention("Paid, but the invoice could not be updated because Payments is switched off for clients.");
        else {
          const result = await applyClientPayment(tx, { key: `paylink-${link.id}`, method: attempt.provider === "BKASH" ? "MOBILE_BANKING" : "ONLINE", receivedDate: dhakaToday(now), reference: verdict.txnId ?? "", note: formatPaymentLinkNumber(link.number), lines: [{ dueId: link.clientDueId, amount: gatewayAmount(link.amountMinor) }] }, null);
          if (result.ok) await tx.paymentLink.updateMany({ where: { id: link.id }, data: { receiptNumber: result.receipts?.[0]?.receiptNumber ?? null } });
          else await attention(`Paid, but the invoice could not be updated: ${result.message} Record it by hand.`);
        }
      }
      if (link.orderId) {
        const order = await tx.commerceOrder.findFirst({ where: { id: link.orderId }, select: { paidMinor: true, totalMinor: true, paymentStatus: true } });
        const paid = order ? order.paidMinor + link.amountMinor : null;
        if (!order || paid === null || order.paymentStatus === "REFUNDED" || paid > order.totalMinor) await attention("Paid, but the order could not be updated. Record it by hand.");
        else await tx.commerceOrder.updateMany({ where: { id: link.orderId, paidMinor: order.paidMinor }, data: { paidMinor: paid, paymentStatus: orderPaymentStatus(paid, order.totalMinor) } });
      }
      return "PAID";
    },
    { timeout: 20_000 },
  );
}

/** bKash sent the customer back: take the payment once, and read the outcome from bKash. */
export async function verifyBkashCallback(attemptId: string, paymentId: string, fetchImpl: Fetch = fetch): Promise<SettleOutcome> {
  const attempt = await prisma.paymentAttempt.findFirst({ where: { id: attemptId } });
  if (!attempt || attempt.sessionRef !== paymentId) return "NOT_PAID";
  const gateway = await gatewayOf("BKASH");
  if (!gateway) return "UNKNOWN";
  const creds = gateway.credentials as unknown as BkashCredentials;
  // Claimed so a refreshed page cannot execute twice. A second caller reads the outcome instead of taking money again.
  const claimed = await prisma.paymentAttempt.updateMany({ where: { id: attempt.id, status: "STARTED", note: null }, data: { note: "Executing" } });
  const verdict = claimed.count === 1 ? await executeBkash({ creds, mode: attempt.mode, paymentId }, fetchImpl) : await queryBkash({ creds, mode: attempt.mode, paymentId }, fetchImpl);
  return settleAttempt(attempt.id, verdict);
}

/** "Check again": asks the gateway about every unresolved try on a link. */
export async function recheckPaymentLink(linkId: string, fetchImpl: Fetch = fetch): Promise<number> {
  const attempts = await prisma.paymentAttempt.findMany({ where: { linkId, status: { in: ["STARTED", "UNKNOWN"] } } });
  let paid = 0;
  for (const attempt of attempts) {
    const gateway = await gatewayOf(attempt.provider);
    if (!gateway) continue;
    const verdict =
      attempt.provider === "SSLCOMMERZ"
        ? await querySslCommerz({ creds: gateway.credentials as unknown as SslCommerzCredentials, mode: attempt.mode, reference: attempt.reference }, fetchImpl)
        : attempt.sessionRef
          ? await queryBkash({ creds: gateway.credentials as unknown as BkashCredentials, mode: attempt.mode, paymentId: attempt.sessionRef }, fetchImpl)
          : null;
    if (!verdict) continue;
    if ((await settleAttempt(attempt.id, verdict)) === "PAID") paid += 1;
  }
  return paid;
}

// ── Readings ────────────────────────────────────────────────────────────────────────────────────

export async function listPaymentLinks(status: string | null) {
  const rows = await prisma.paymentLink.findMany({
    where: status === "ATTENTION" ? { needsAttention: true } : status === "OPEN" || status === "PAID" || status === "CANCELLED" || status === "EXPIRED" ? { status } : {},
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, number: true, amountMinor: true, description: true, status: true, needsAttention: true, attentionNote: true, customerName: true, paidAt: true, paidProvider: true, createdAt: true, createdByName: true, expiresAt: true },
  });
  return rows.map((r) => ({ ...r, amount: formatPaymentAmount(r.amountMinor), label: formatPaymentLinkNumber(r.number), amountMinor: undefined, paidAt: r.paidAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString() }));
}

export async function loadPaymentLink(id: string) {
  const link = await prisma.paymentLink.findFirst({ where: { id }, include: { events: { orderBy: { createdAt: "desc" }, take: 40 }, attempts: { orderBy: { createdAt: "desc" }, take: 25 } } });
  if (!link) return null;
  return {
    id: link.id,
    label: formatPaymentLinkNumber(link.number),
    amount: formatPaymentAmount(link.amountMinor),
    description: link.description,
    status: link.status,
    customerName: link.customerName,
    needsAttention: link.needsAttention,
    attentionNote: link.attentionNote,
    gatewayTxnId: link.gatewayTxnId,
    paidProvider: link.paidProvider,
    receiptNumber: link.receiptNumber,
    paidAt: link.paidAt?.toISOString() ?? null,
    expiresAt: link.expiresAt.toISOString(),
    createdAt: link.createdAt.toISOString(),
    createdByName: link.createdByName,
    url: await paymentUrl(link.tokenCiphertext),
    events: link.events.map((e) => ({ id: e.id, kind: e.kind, detail: e.detail, actorName: e.actorName, createdAt: e.createdAt.toISOString() })),
    attempts: link.attempts.map((a) => ({ id: a.id, provider: a.provider, mode: a.mode, status: a.status, note: a.note, createdAt: a.createdAt.toISOString() })),
  };
}

export async function gatewaySettingsView() {
  const rows = await prisma.paymentGateway.findMany({ select: { provider: true, mode: true, enabled: true, updatedAt: true, updatedByName: true } });
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
}

export interface ConversationPayments {
  canCreate: boolean;
  ready: boolean;
  links: Array<{ id: string; label: string; amount: string; status: string; needsAttention: boolean; description: string | null; url: string | null }>;
  dues: Array<{ id: string; label: string; amount: string; remaining: string; clientId: string }>;
}

/** The Payment tab beside a chat. Open invoices come only from a client this chat is linked to, and only for billing viewers. */
export async function loadConversationPayments(session: Session, ref: ConversationRef): Promise<ConversationPayments | null> {
  const disabled = await activeDisabledFeatures();
  if (disabled.has("PAYMENT_LINKS") || !(await hasPermission(session, "payments.view"))) return null;
  const where = ref.kind === "whatsapp" ? { chatId: ref.chatId } : { channelConversationId: ref.conversationId };
  const [canCreate, providers, rows] = await Promise.all([hasPermission(session, "payments.create"), enabledProviders(), prisma.paymentLink.findMany({ where, orderBy: { createdAt: "desc" }, take: 10 })]);

  let dues: ConversationPayments["dues"] = [];
  if (!disabled.has("CLIENT_CENTER") && (await hasPermission(session, "clients.view_billing"))) {
    const clientId = await clientOfChat(ref);
    if (clientId) {
      const open = await prisma.clientDue.findMany({ where: { clientId, status: { in: ["UNPAID", "PARTIALLY_PAID"] }, currency: PAYMENT_LINK_CURRENCY, amount: { not: null } }, orderBy: { dueDate: "asc" }, take: 8, select: { id: true, invoiceNumber: true, amount: true, paidAmount: true, service: true, note: true } });
      dues = open.map((d) => {
        const remaining = BigInt(d.amount!.mul(100).toFixed(0)) - BigInt((d.paidAmount ?? d.amount!.mul(0)).mul(100).toFixed(0));
        return { id: d.id, label: d.invoiceNumber ?? d.service ?? d.note ?? "Invoice", amount: formatPaymentAmount(BigInt(d.amount!.mul(100).toFixed(0))), remaining: gatewayAmount(remaining), clientId };
      });
    }
  }
  return {
    canCreate,
    ready: providers.length > 0,
    dues,
    links: await Promise.all(rows.map(async (r) => ({ id: r.id, label: formatPaymentLinkNumber(r.number), amount: formatPaymentAmount(r.amountMinor), status: r.status, needsAttention: r.needsAttention, description: r.description, url: r.status === "OPEN" ? await paymentUrl(r.tokenCiphertext) : null }))),
  };
}

export async function clientOfChat(ref: ConversationRef): Promise<string | null> {
  if (ref.kind === "whatsapp") {
    const group = await prisma.clientWhatsAppGroupLink.findFirst({ where: { whatsappGroupId: ref.chatId, unlinkedAt: null }, select: { clientId: true } });
    if (group) return group.clientId;
    const chat = await prisma.clientWhatsAppChatLink.findFirst({ where: { accountId: ref.accountId, chatId: ref.chatId, unlinkedAt: null }, select: { clientId: true } });
    if (chat) return chat.clientId;
  }
  const contact = await prisma.contactConversationLink.findFirst({ where: ref.kind === "whatsapp" ? { chatId: ref.chatId } : { channelConversationId: ref.conversationId }, select: { contact: { select: { linkedClientId: true } } } });
  return contact?.contact.linkedClientId ?? null;
}
