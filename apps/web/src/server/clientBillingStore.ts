import type { Prisma } from "@prisma/client";
import { diffDue, formatInvoiceNumber, isDueKind, parseCalendarDay, type DueKind, type ValidDue } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { recordClientActivity } from "@/server/clientRecords";
import { nextDocumentNumber, sellerSnapshot } from "@/server/clientSubscriptionStore";

/**
 * Raising an invoice (a `ClientDue` with a number), shared by the Billing card, the Billing List's
 * "Create bill" and a subscription sale. Not a "use server" file; every caller has checked
 * `clients.edit_billing` and that billing is on.
 */

type Tx = Prisma.TransactionClient;

export interface InvoiceExtras {
  kind: DueKind | null;
  issuedDate: string;
  service: string | null;
  subscriptionId: string | null;
  soldByMemberId: string | null;
}

/** Reads and checks the invoice fields beyond the due itself. `today` is the Dhaka day used when no issue date is typed. */
export async function readInvoiceExtras(
  input: { kind?: string; issuedDate?: string; service?: string; subscriptionId?: string; soldByMemberId?: string },
  clientId: string,
  today: string,
): Promise<InvoiceExtras | { error: string }> {
  const kindRaw = (input.kind ?? "").trim();
  if (kindRaw && !isDueKind(kindRaw)) return { error: "Choose what the invoice is for." };
  const issuedRaw = (input.issuedDate ?? "").trim();
  const issuedDate = issuedRaw ? parseCalendarDay(issuedRaw) : today;
  if (!issuedDate) return { error: "The issue date is not a real date." };
  const service = (input.service ?? "").trim().slice(0, 120) || null;
  const subscriptionId = (input.subscriptionId ?? "").trim() || null;
  if (subscriptionId && !(await prisma.clientSubscription.findFirst({ where: { id: subscriptionId, clientId }, select: { id: true } }))) {
    return { error: "That subscription does not belong to this client." };
  }
  const soldByMemberId = (input.soldByMemberId ?? "").trim() || null;
  if (soldByMemberId) {
    const seller = await sellerSnapshot(soldByMemberId);
    if ("error" in seller) return seller;
  }
  return { kind: kindRaw ? (kindRaw as DueKind) : null, issuedDate, service, subscriptionId, soldByMemberId };
}

const snapshot = (d: ValidDue): Record<string, string | null> => ({
  dueDate: d.dueDate,
  amount: d.amount,
  currency: d.currency,
  status: d.status,
  paidAmount: d.paidAmount,
  note: d.note,
});

/** Creates the invoice, its first audit event and the timeline line, inside the caller's transaction. */
export async function createInvoice(tx: Tx, clientId: string, actorUserId: string, due: ValidDue, extras: InvoiceExtras): Promise<{ id: string; invoiceNumber: string }> {
  const invoiceNumber = formatInvoiceNumber(await nextDocumentNumber(tx, "invoice"));
  const created = await tx.clientDue.create({
    data: {
      clientId,
      invoiceNumber,
      kind: extras.kind,
      issuedDate: new Date(`${extras.issuedDate}T00:00:00.000Z`),
      service: extras.service,
      subscriptionId: extras.subscriptionId,
      soldByMemberId: extras.soldByMemberId,
      dueDate: new Date(`${due.dueDate}T00:00:00.000Z`),
      amount: due.amount,
      currency: due.currency,
      status: due.status,
      paidAmount: due.paidAmount,
      note: due.note,
      createdById: actorUserId,
      updatedById: actorUserId,
      statusChangedAt: new Date(),
    },
    select: { id: true },
  });
  await tx.clientDueEvent.create({
    data: { dueId: created.id, clientId, type: "CREATED", changes: { ...diffDue({}, snapshot(due)), invoiceNumber: { from: null, to: invoiceNumber } }, actorUserId },
  });
  // The timeline says THAT an invoice exists, never its amount or date (the timeline needs only clients.view).
  await recordClientActivity(tx, clientId, actorUserId, { type: "BILLING_CHANGED", summary: `Invoice ${invoiceNumber} added` });
  return { id: created.id, invoiceNumber };
}
