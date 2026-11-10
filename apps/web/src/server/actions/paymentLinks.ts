"use server";

import { revalidatePath } from "next/cache";
import { encryptSecret } from "@support-automation/db";
import { formatPaymentAmount, gatewayCredentialFields, isPaymentProvider, MAX_PAYMENT_MINOR, parseConversationRef, parseLinkAmount, paymentLinkMessage, PAYMENT_LINK_DEFAULT_DAYS } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { hasPermission } from "@/server/permissions";
import { conversationInProject } from "@/server/inboxWorkspace";
import { logSystemEvent } from "@/server/logSystemEvent";
import { clientOfChat, createPaymentLinkRow, enabledProviders, recheckPaymentLink } from "@/server/payments/core";

/** Payment links (PAYMENT_LINKS.md). A link only fills the reply box: a person presses send. */

type Fail = { error: string };
const FEATURE = "PAYMENT_LINKS" as const;

async function refresh(id?: string) {
  revalidatePath(await projectPath("/payments"));
  if (id) revalidatePath(await projectPath(`/payments/${id}`));
}

export async function createPaymentLink(input: { amount?: unknown; description?: unknown; days?: unknown; conversation?: unknown; clientDueId?: unknown }): Promise<{ id: string; label: string; url: string; message: string } | Fail> {
  const granted = await checkPermission("payments.create", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const minor = parseLinkAmount(String(input.amount ?? ""));
  if (minor === null) return { error: "Enter an amount, for example 1500." };
  if (minor > MAX_PAYMENT_MINOR) return { error: `A link can ask for at most ${formatPaymentAmount(MAX_PAYMENT_MINOR)}.` };
  if ((await enabledProviders()).length === 0) return { error: "Set up a payment account first (Settings → Payment accounts)." };
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 200) || null : null;
  const days = Math.min(30, Math.max(1, Math.round(Number(input.days) || PAYMENT_LINK_DEFAULT_DAYS)));

  const disabled = await activeDisabledFeatures();
  const conversation = input.conversation ? parseConversationRef(input.conversation) : null;
  if (input.conversation && (!conversation || !(await conversationInProject(conversation, disabled)))) return { error: "That conversation is not in this project." };

  let clientDueId: string | null = null;
  let clientId: string | null = null;
  if (typeof input.clientDueId === "string" && input.clientDueId) {
    if (!(await hasPermission(granted.session, "clients.view_billing"))) return { error: "You cannot see client billing, so you cannot link an invoice." };
    const due = await prisma.clientDue.findFirst({ where: { id: input.clientDueId }, select: { id: true, clientId: true, currency: true, amount: true, paidAmount: true, status: true } });
    if (!due || !due.amount) return { error: "That invoice is not in this project." };
    if (due.currency !== "BDT") return { error: "Payment links are in BDT, and that invoice is not." };
    if (due.status !== "UNPAID" && due.status !== "PARTIALLY_PAID") return { error: "That invoice is already settled." };
    const remaining = BigInt(due.amount.mul(100).toFixed(0)) - BigInt((due.paidAmount ?? due.amount.mul(0)).mul(100).toFixed(0));
    if (minor > remaining) return { error: `That is more than is left on the invoice (${formatPaymentAmount(remaining)}).` };
    clientDueId = due.id;
    clientId = due.clientId;
  }
  if (!clientId && conversation) clientId = await clientOfChat(conversation);

  let customerName: string | null = null;
  let contactId: string | null = null;
  if (conversation) {
    const link = await prisma.contactConversationLink.findFirst({ where: conversation.kind === "whatsapp" ? { chatId: conversation.chatId } : { channelConversationId: conversation.conversationId }, select: { contact: { select: { id: true, name: true } } } });
    contactId = link?.contact.id ?? null;
    customerName = link?.contact.name ?? null;
  }

  const actor = { userId: granted.session.userId, name: granted.session.name || granted.session.username };
  const made = await createPaymentLinkRow({ amountMinor: minor, description, days, conversation, clientDueId, orderId: null, clientId, contactId, customerName }, actor);
  await refresh();
  return { id: made.id, label: `PAY-${String(made.number).padStart(4, "0")}`, url: made.url, message: paymentLinkMessage(formatPaymentAmount(minor), description, made.url) };
}

export async function cancelPaymentLink(id: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("payments.create", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.paymentLink.updateMany({ where: { id, status: "OPEN" }, data: { status: "CANCELLED" } });
    if (r.count) await tx.paymentLinkEvent.create({ data: { linkId: id, kind: "CANCELLED", actorName: granted.session.name || granted.session.username } });
    return r.count;
  });
  if (!done) return { error: "Only an open link can be cancelled." };
  await refresh(id);
  return { ok: true };
}

/** Asks the gateway directly about anything unresolved on this link. */
export async function recheckPayment(id: string): Promise<{ paid: number } | Fail> {
  const granted = await checkPermission("payments.view", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  if (!(await prisma.paymentLink.findFirst({ where: { id }, select: { id: true } }))) return { error: "That link is no longer here." };
  const paid = await recheckPaymentLink(id);
  await refresh(id);
  return { paid };
}

export async function clearPaymentAttention(id: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("payments.manage", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  await prisma.$transaction(async (tx) => {
    const r = await tx.paymentLink.updateMany({ where: { id, needsAttention: true }, data: { needsAttention: false } });
    if (r.count) await tx.paymentLinkEvent.create({ data: { linkId: id, kind: "RESOLVED", actorName: granted.session.name || granted.session.username } });
  });
  await refresh(id);
  return { ok: true };
}

export interface GatewayFormState {
  error?: string;
  success?: string;
}

/** Saves a merchant account. Details are write-only: nothing shows them again, and empty boxes keep what is stored. */
export async function saveGateway(_prev: GatewayFormState, form: FormData): Promise<GatewayFormState> {
  const granted = await checkPermission("payments.manage", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const provider = form.get("provider");
  if (!isPaymentProvider(provider)) return { error: "Choose a payment service." };
  const mode = form.get("mode") === "LIVE" ? "LIVE" : "SANDBOX";
  const enabled = form.get("enabled") === "on";
  const fields = gatewayCredentialFields(provider);
  const typed = Object.fromEntries(fields.map((f) => [f.key, String(form.get(f.key) ?? "").trim()]));
  const anyTyped = Object.values(typed).some(Boolean);
  const existing = await prisma.paymentGateway.findFirst({ where: { provider }, select: { id: true } });
  if (anyTyped && fields.some((f) => !typed[f.key])) return { error: "Fill in every detail, or leave them all empty to keep what is saved." };
  if (!anyTyped && !existing) return { error: "Enter the account details." };
  const name = granted.session.name || granted.session.username;
  if (existing) await prisma.paymentGateway.updateMany({ where: { id: existing.id }, data: { mode, enabled, updatedByName: name, ...(anyTyped ? { credentialsCiphertext: encryptSecret(JSON.stringify(typed)) } : {}) } });
  else await prisma.paymentGateway.create({ data: { provider, mode, enabled, updatedByName: name, credentialsCiphertext: encryptSecret(JSON.stringify(typed)) } });
  await logSystemEvent("WARN", "payments", `Payment account saved: ${provider}`, { provider, mode, enabled, detailsChanged: anyTyped }, { actorUserId: granted.session.userId });
  revalidatePath(await projectPath("/settings/payment-gateways"));
  return { success: "Saved." };
}
