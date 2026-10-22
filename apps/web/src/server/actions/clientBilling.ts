"use server";

import { revalidatePath } from "next/cache";
import { CLIENT_BILLING_LIMITS, decimalToMinor, dhakaToday, diffDue, formatMinor, normalizeCurrencyCode, toMinor, validateDue, type ValidDue } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { recordClientActivity } from "@/server/clientRecords";
import { subModuleOff } from "@/server/clientModule";
import { createInvoice, readInvoiceExtras } from "@/server/clientBillingStore";

/**
 * Billing actions (CLIENT_CENTER_PLAN.md §2). Every one is a public endpoint, so every one makes its
 * own check: `clients.edit_billing`. A due is manual data: nothing is sent because of it, nothing is
 * connected to a payment system, and a settled due is never deleted (cancel it instead).
 *
 * The client's timeline (readable with `clients.view`) records THAT billing changed, never an amount
 * or a date; the amounts live in ClientDueEvent, readable only with `clients.view_billing`.
 */

export interface DueFormState {
  error?: string;
  success?: boolean;
  /** What was typed, returned with a refusal (React clears an uncontrolled form after every action). */
  values?: Record<string, string>;
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

function echo(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) if (typeof value === "string" && !key.startsWith("$ACTION")) out[key] = value.slice(0, 2000);
  return out;
}

async function refresh(clientId?: string) {
  revalidatePath(await projectPath("/clients/dues"));
  if (clientId) revalidatePath(await projectPath(`/clients/${clientId}`));
}

const dueInput = (formData: FormData) => ({
  dueDate: text(formData, "dueDate"),
  amount: text(formData, "amount"),
  currency: text(formData, "currency"),
  status: text(formData, "status") || "UNPAID",
  paidAmount: text(formData, "paidAmount"),
  note: text(formData, "note"),
});

const snapshot = (d: ValidDue): Record<string, string | null> => ({
  dueDate: d.dueDate,
  amount: d.amount,
  currency: d.currency,
  status: d.status,
  paidAmount: d.paidAmount,
  note: d.note,
});

async function enabledCodes(): Promise<string[]> {
  return (await prisma.clientBillingCurrency.findMany({ where: { enabled: true }, select: { code: true } })).map((c) => c.code);
}

export async function createDue(clientId: string, _prev: DueFormState, formData: FormData): Promise<DueFormState> {
  const granted = await checkPermission("clients.edit_billing");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };
  const off = await subModuleOff("billing");
  if (off) return { error: off, values: echo(formData) };
  const client = await prisma.client.findFirst({ where: { id: clientId }, select: { status: true } });
  if (!client) return { error: "That client no longer exists.", values: echo(formData) };
  if (client.status === "ARCHIVED") return { error: "This client is archived. Restore it before changing its billing.", values: echo(formData) };

  const parsed = validateDue(dueInput(formData), await enabledCodes());
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(formData) };
  const extras = await readInvoiceExtras(
    { kind: text(formData, "kind"), issuedDate: text(formData, "issuedDate"), service: text(formData, "service"), subscriptionId: text(formData, "subscriptionId"), soldByMemberId: text(formData, "soldByMemberId") },
    clientId,
    dhakaToday(new Date()),
  );
  if ("error" in extras) return { error: extras.error, values: echo(formData) };

  // Every new due is an invoice with its own number (CLIENTS_V3.md §4); the audit and timeline are written with it.
  await prisma.$transaction((tx) => createInvoice(tx, clientId, granted.session.userId, parsed.due, extras));
  await refresh(clientId);
  return { success: true };
}

export async function updateDue(dueId: string, _prev: DueFormState, formData: FormData): Promise<DueFormState> {
  const granted = await checkPermission("clients.edit_billing");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };
  const off = await subModuleOff("billing");
  if (off) return { error: off, values: echo(formData) };
  const existing = await prisma.clientDue.findFirst({ where: { id: dueId }, include: { client: { select: { status: true } } } });
  if (!existing) return { error: "That due no longer exists.", values: echo(formData) };
  if (existing.client.status === "ARCHIVED") return { error: "This client is archived. Restore it before changing its billing.", values: echo(formData) };

  const parsed = validateDue(dueInput(formData), await enabledCodes(), existing.currency);
  if (!parsed.ok) return { error: parsed.errors.join(" "), values: echo(formData) };
  const due = parsed.due;

  // Money recorded through Payments stays recorded: a hand edit may not drop the paid amount below what
  // the (unreversed) receipts settled, nor change the currency or remove the amount they were paid against.
  const allocated = await prisma.clientPaymentAllocation.aggregate({ where: { dueId, payment: { reversedAt: null } }, _sum: { amount: true } });
  const allocatedMinor = decimalToMinor(allocated._sum.amount) ?? BigInt(0);
  if (allocatedMinor > BigInt(0)) {
    const paidMinor = due.paidAmount === null ? BigInt(0) : toMinor(due.paidAmount)!;
    if (due.amount === null || due.currency !== existing.currency) {
      return { error: "Payments are recorded against this invoice, so its amount and currency stay. Reverse the payments first.", values: echo(formData) };
    }
    if ((due.status === "UNPAID" || due.status === "PARTIALLY_PAID" || due.status === "PAID") && paidMinor < allocatedMinor) {
      return { error: `Recorded payments already settled ${formatMinor(allocatedMinor, existing.currency)} of this invoice. To lower it, reverse a payment on Payments & Receipts.`, values: echo(formData) };
    }
  }

  const before: Record<string, string | null> = {
    dueDate: existing.dueDate.toISOString().slice(0, 10),
    amount: existing.amount?.toFixed(2) ?? null,
    currency: existing.currency,
    status: existing.status,
    paidAmount: existing.paidAmount?.toFixed(2) ?? null,
    note: existing.note,
  };
  const changes = diffDue(before, snapshot(due));
  if (Object.keys(changes).length === 0) return { success: true };
  const statusChanged = "status" in changes;

  const done = await prisma.$transaction(async (tx) => {
    // Conditional on the row being as it was read: two people editing one due must not silently overwrite each other.
    const updated = await tx.clientDue.updateMany({
      where: { id: dueId, updatedAt: existing.updatedAt },
      data: {
        dueDate: new Date(`${due.dueDate}T00:00:00.000Z`),
        amount: due.amount,
        currency: due.currency,
        status: due.status,
        paidAmount: due.paidAmount,
        note: due.note,
        updatedById: granted.session.userId,
        ...(statusChanged ? { statusChangedAt: new Date() } : {}),
      },
    });
    if (updated.count === 0) return false;
    await tx.clientDueEvent.create({ data: { dueId, clientId: existing.clientId, type: statusChanged ? "STATUS_CHANGED" : "UPDATED", changes, actorUserId: granted.session.userId } });
    await recordClientActivity(tx, existing.clientId, granted.session.userId, { type: "BILLING_CHANGED", summary: statusChanged ? "Billing status changed" : "Billing record updated" });
    return true;
  });
  if (!done) return { error: "Someone changed this due while you were editing it. Reload and try again.", values: echo(formData) };
  await refresh(existing.clientId);
  return { success: true };
}

export async function addBillingCurrency(_prev: DueFormState, formData: FormData): Promise<DueFormState> {
  const granted = await checkPermission("clients.edit_billing");
  if ("denied" in granted) return { error: granted.denied, values: echo(formData) };
  const code = normalizeCurrencyCode(text(formData, "code"));
  if (!code) return { error: "Enter a three-letter currency code, such as BDT.", values: echo(formData) };
  if ((await prisma.clientBillingCurrency.count()) >= CLIENT_BILLING_LIMITS.currencies) return { error: `A project can list at most ${CLIENT_BILLING_LIMITS.currencies} currencies.`, values: echo(formData) };
  try {
    await prisma.clientBillingCurrency.create({ data: { code, enabled: true, addedById: granted.session.userId } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Already listed: turn it back on rather than refusing.
      await prisma.clientBillingCurrency.updateMany({ where: { code }, data: { enabled: true } });
    } else throw err;
  }
  await refresh();
  return { success: true };
}

export async function setBillingCurrencyEnabled(code: string, enabled: boolean): Promise<{ ok: boolean; message: string }> {
  const granted = await checkPermission("clients.edit_billing");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const updated = await prisma.clientBillingCurrency.updateMany({ where: { code }, data: { enabled } });
  if (updated.count === 0) return { ok: false, message: "That currency is not on the list." };
  await refresh();
  return { ok: true, message: enabled ? `${code} is offered on new dues.` : `${code} is no longer offered on new dues. Dues that already use it are unchanged.` };
}
