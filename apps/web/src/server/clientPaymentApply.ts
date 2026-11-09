import { Prisma } from "@prisma/client";
import {
  decimalToMinor,
  formatMinor,
  formatReceiptNumber,
  fromMinor,
  planPayments,
  type AllocationRequest,
  type PayableDue,
} from "@support-automation/shared";
import { activeProjectId } from "@/server/projectContext";
import { recordClientActivity } from "@/server/clientRecords";
import { nextDocumentNumber } from "@/server/clientSubscriptionStore";
import type { RecordPaymentsResult } from "@/server/actions/clientPayments";

/**
 * Applying money to client invoices (CLIENTS_V3.md §4). One body, called inside a transaction by a person recording a
 * payment and by a paid payment link (PAYMENT_LINKS.md), so an invoice is settled the same way however the money arrived.
 */

/** Locks the dues for the rest of the transaction, in id order so two batches cannot deadlock. */
export async function lockDues(tx: Prisma.TransactionClient, dueIds: string[]): Promise<void> {
  if (!dueIds.length) return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "ClientDue" WHERE "projectId" = ${await activeProjectId()} AND "id" IN (${Prisma.join([...dueIds].sort())}) ORDER BY "id" FOR UPDATE`,
  );
}

const ZERO = BigInt(0);

export interface ApplyPaymentInput {
  key: string;
  method: Prisma.ClientPaymentUncheckedCreateInput["method"];
  /** YYYY-MM-DD */
  receivedDate: string;
  reference: string;
  note: string;
  lines: AllocationRequest[];
}

export async function applyClientPayment(tx: Prisma.TransactionClient, input: ApplyPaymentInput, actorUserId: string | null): Promise<RecordPaymentsResult> {
  const { key, method, receivedDate, reference, note, lines } = input;
    const dueIds = [...new Set(lines.map((l) => l.dueId))];
    await lockDues(tx, dueIds);
    // Read through the project-scoped client: a due from another project is simply "no longer exists".
    const rows = await tx.clientDue.findMany({
      where: { id: { in: dueIds } },
      select: { id: true, clientId: true, status: true, currency: true, amount: true, paidAmount: true, invoiceNumber: true, client: { select: { status: true } } },
    });
    const archived = rows.find((r) => r.client.status === "ARCHIVED");
    if (archived) return { ok: false, message: "One of these clients is archived. Restore it before recording a payment.", lineErrors: { [archived.id]: "The client is archived." } };
    const dues: PayableDue[] = rows.map((r) => ({ id: r.id, clientId: r.clientId, status: r.status, currency: r.currency, amount: decimalToMinor(r.amount), paid: decimalToMinor(r.paidAmount) ?? ZERO }));
    const plan = planPayments(dues, lines);
    if (!plan.ok) {
      const lineErrors: Record<string, string> = {};
      for (const e of plan.errors) if (e.dueId) lineErrors[e.dueId] = e.message;
      const general = plan.errors.find((e) => !e.dueId)?.message;
      return { ok: false, message: general ?? "Nothing was recorded. Fix the highlighted invoices and try again.", lineErrors };
    }
    const invoiceOf = new Map(rows.map((r) => [r.id, r.invoiceNumber]));
    // Deterministic order, so the same submission always maps to the same keys.
    const payments = [...plan.payments].sort((a, b) => `${a.clientId}${a.currency}`.localeCompare(`${b.clientId}${b.currency}`));
    const receipts: NonNullable<RecordPaymentsResult["receipts"]> = [];
    for (const [index, payment] of payments.entries()) {
      const receiptNumber = formatReceiptNumber(await nextDocumentNumber(tx, "receipt"));
      const created = await tx.clientPayment.create({
        data: {
          receiptNumber,
          clientId: payment.clientId,
          currency: payment.currency,
          amount: fromMinor(payment.total),
          method,
          reference: reference || null,
          note: note || null,
          receivedDate: new Date(`${receivedDate}T00:00:00.000Z`),
          batchReference: payments.length > 1 || payment.lines.length > 1 ? `BATCH-${key.slice(0, 12)}` : null,
          idempotencyKey: `${key}:${index}`,
          recordedById: actorUserId,
        },
        select: { id: true },
      });
      for (const line of payment.lines) {
        await tx.clientPaymentAllocation.create({ data: { paymentId: created.id, dueId: line.dueId, amount: fromMinor(line.amount) } });
        const statusChanged = line.statusAfter !== line.statusBefore;
        await tx.clientDue.update({
          where: { id: line.dueId },
          data: { paidAmount: fromMinor(line.paidAfter), status: line.statusAfter, updatedById: actorUserId, ...(statusChanged ? { statusChangedAt: new Date() } : {}) },
        });
        await tx.clientDueEvent.create({
          data: {
            dueId: line.dueId,
            clientId: payment.clientId,
            type: "PAYMENT_RECORDED",
            changes: {
              paidAmount: { from: fromMinor(line.paidBefore), to: fromMinor(line.paidAfter) },
              ...(statusChanged ? { status: { from: line.statusBefore, to: line.statusAfter } } : {}),
              receipt: { from: null, to: receiptNumber },
            },
            actorUserId: actorUserId,
          },
        });
      }
      // The timeline says a payment was recorded and which invoices — never the amount.
      const invoices = payment.lines.map((l) => invoiceOf.get(l.dueId) ?? "an older due").join(", ");
      await recordClientActivity(tx, payment.clientId, actorUserId, { type: "PAYMENT_RECORDED", summary: `Payment ${receiptNumber} recorded against ${invoices}`, details: { paymentId: created.id } });
      receipts.push({ receiptNumber, clientId: payment.clientId, currency: payment.currency, amount: fromMinor(payment.total) });
    }
    const total = payments.map((p) => formatMinor(p.total, p.currency)).join(" + ");
    return { ok: true, message: `Recorded ${receipts.length === 1 ? receipts[0]!.receiptNumber : `${receipts.length} receipts`}: ${total}.`, receipts };
}
