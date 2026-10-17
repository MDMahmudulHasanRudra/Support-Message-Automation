"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import {
  decimalToMinor,
  dhakaToday,
  formatMinor,
  formatReceiptNumber,
  fromMinor,
  isPaymentMethod,
  parseCalendarDay,
  PAYMENT_LIMITS,
  planPayments,
  reverseLine,
  type AllocationRequest,
  type PayableDue,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { recordClientActivity } from "@/server/clientRecords";
import { subModuleOff } from "@/server/clientModule";
import { nextDocumentNumber } from "@/server/clientSubscriptionStore";

/**
 * Recording money received (CLIENTS_V3.md §4). Every action checks `clients.edit_billing` and that
 * Payments is on in this project. Nothing is connected to a bank or gateway and nothing is sent.
 *
 * One submission = one idempotency key, chosen by the browser when the dialog opens. It becomes ONE
 * payment per (client, currency) — never one payment across two currencies or two clients — each
 * allocated to its dues. The whole batch is planned and written in one transaction, with the dues
 * locked, so it is either recorded entirely or not at all, and pressing Record twice records once.
 */

export interface PaymentLineInput {
  dueId: string;
  amount: string;
}

export interface RecordPaymentsInput {
  idempotencyKey: string;
  method: string;
  receivedDate: string;
  reference: string;
  note: string;
  lines: PaymentLineInput[];
}

export interface RecordPaymentsResult {
  ok: boolean;
  message: string;
  /** Per-invoice reasons, keyed by due id, when the batch was refused. */
  lineErrors?: Record<string, string>;
  receipts?: Array<{ receiptNumber: string; clientId: string; currency: string; amount: string }>;
  alreadyRecorded?: boolean;
}

const ZERO = BigInt(0);

async function refresh(clientIds: string[]) {
  for (const path of ["/clients", "/clients/dues", "/clients/payments"]) revalidatePath(await projectPath(path));
  for (const id of clientIds.slice(0, 20)) revalidatePath(await projectPath(`/clients/${id}`));
}

/** Locks the dues for the rest of the transaction, in id order so two batches cannot deadlock. */
async function lockDues(tx: Prisma.TransactionClient, dueIds: string[]): Promise<void> {
  if (!dueIds.length) return;
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "ClientDue" WHERE "projectId" = ${await activeProjectId()} AND "id" IN (${Prisma.join([...dueIds].sort())}) ORDER BY "id" FOR UPDATE`,
  );
}

function receiptsOf(rows: Array<{ receiptNumber: string; clientId: string; currency: string; amount: Prisma.Decimal }>) {
  return rows.map((p) => ({ receiptNumber: p.receiptNumber, clientId: p.clientId, currency: p.currency, amount: p.amount.toFixed(2) }));
}

export async function recordPayments(input: RecordPaymentsInput): Promise<RecordPaymentsResult> {
  const granted = await checkPermission("clients.edit_billing");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const off = await subModuleOff("payments");
  if (off) return { ok: false, message: off };

  const key = String(input?.idempotencyKey ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) return { ok: false, message: "This form expired. Close it and open it again." };
  const method = String(input.method ?? "");
  if (!isPaymentMethod(method)) return { ok: false, message: "Choose how the money was paid." };
  const receivedDate = parseCalendarDay(String(input.receivedDate ?? ""));
  if (!receivedDate) return { ok: false, message: "Choose the payment date." };
  if (receivedDate > dhakaToday(new Date())) return { ok: false, message: "The payment date cannot be in the future." };
  const reference = String(input.reference ?? "").trim();
  if (reference.length > PAYMENT_LIMITS.reference) return { ok: false, message: `The reference can be at most ${PAYMENT_LIMITS.reference} characters.` };
  const note = String(input.note ?? "").trim();
  if (note.length > PAYMENT_LIMITS.note) return { ok: false, message: `The note can be at most ${PAYMENT_LIMITS.note} characters.` };
  const lines: AllocationRequest[] = (Array.isArray(input.lines) ? input.lines : []).slice(0, PAYMENT_LIMITS.batchLines + 1).map((l) => ({ dueId: String(l?.dueId ?? ""), amount: String(l?.amount ?? "") }));

  // Pressed twice: the first press already recorded it.
  const earlier = await prisma.clientPayment.findMany({ where: { idempotencyKey: { startsWith: `${key}:` } }, select: { receiptNumber: true, clientId: true, currency: true, amount: true } });
  if (earlier.length) return { ok: true, alreadyRecorded: true, message: `Already recorded (${earlier.map((p) => p.receiptNumber).join(", ")}).`, receipts: receiptsOf(earlier) };

  try {
    const result = await prisma.$transaction(async (tx): Promise<RecordPaymentsResult> => {
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
            recordedById: granted.session.userId,
          },
          select: { id: true },
        });
        for (const line of payment.lines) {
          await tx.clientPaymentAllocation.create({ data: { paymentId: created.id, dueId: line.dueId, amount: fromMinor(line.amount) } });
          const statusChanged = line.statusAfter !== line.statusBefore;
          await tx.clientDue.update({
            where: { id: line.dueId },
            data: { paidAmount: fromMinor(line.paidAfter), status: line.statusAfter, updatedById: granted.session.userId, ...(statusChanged ? { statusChangedAt: new Date() } : {}) },
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
              actorUserId: granted.session.userId,
            },
          });
        }
        // The timeline says a payment was recorded and which invoices — never the amount.
        const invoices = payment.lines.map((l) => invoiceOf.get(l.dueId) ?? "an older due").join(", ");
        await recordClientActivity(tx, payment.clientId, granted.session.userId, { type: "PAYMENT_RECORDED", summary: `Payment ${receiptNumber} recorded against ${invoices}`, details: { paymentId: created.id } });
        receipts.push({ receiptNumber, clientId: payment.clientId, currency: payment.currency, amount: fromMinor(payment.total) });
      }
      const total = payments.map((p) => formatMinor(p.total, p.currency)).join(" + ");
      return { ok: true, message: `Recorded ${receipts.length === 1 ? receipts[0]!.receiptNumber : `${receipts.length} receipts`}: ${total}.`, receipts };
    });
    if (result.ok) {
      await logSystemEvent("INFO", "clients", "Client payment(s) recorded", { receipts: result.receipts?.map((r) => r.receiptNumber), lines: lines.length }, { actorUserId: granted.session.userId });
      await refresh([...new Set(result.receipts?.map((r) => r.clientId) ?? [])]);
    }
    return result;
  } catch (err) {
    // Two presses racing past the check above: the unique key lets exactly one through.
    if (isUniqueViolation(err)) {
      const done = await prisma.clientPayment.findMany({ where: { idempotencyKey: { startsWith: `${key}:` } }, select: { receiptNumber: true, clientId: true, currency: true, amount: true } });
      return { ok: true, alreadyRecorded: true, message: "Already recorded.", receipts: receiptsOf(done) };
    }
    throw err;
  }
}

/**
 * Reverses a payment recorded by mistake: each invoice it settled gets that amount back as owed, and
 * the payment stays on the register, marked reversed, with the reason. Final — a reversal is not undone;
 * the right figure is recorded as a new payment.
 */
export async function reversePayment(paymentId: string, reason: string): Promise<{ ok: boolean; message: string }> {
  const granted = await checkPermission("clients.edit_billing");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const off = await subModuleOff("payments");
  if (off) return { ok: false, message: off };
  const why = String(reason ?? "").trim();
  if (!why) return { ok: false, message: "Say why the payment is being reversed." };
  if (why.length > PAYMENT_LIMITS.reversalReason) return { ok: false, message: `The reason can be at most ${PAYMENT_LIMITS.reversalReason} characters.` };

  const payment = await prisma.clientPayment.findFirst({ where: { id: paymentId }, select: { id: true, clientId: true, receiptNumber: true, reversedAt: true, allocations: { select: { dueId: true, amount: true } } } });
  if (!payment) return { ok: false, message: "That payment no longer exists." };
  if (payment.reversedAt) return { ok: false, message: "It was already reversed." };

  const done = await prisma.$transaction(async (tx) => {
    await lockDues(tx, payment.allocations.map((a) => a.dueId));
    // Conditional on still being unreversed: two people reversing at once reverse once.
    const marked = await tx.clientPayment.updateMany({ where: { id: paymentId, reversedAt: null }, data: { reversedAt: new Date(), reversedById: granted.session.userId, reversalReason: why } });
    if (marked.count === 0) return false;
    for (const allocation of payment.allocations) {
      const due = await tx.clientDue.findFirst({ where: { id: allocation.dueId }, select: { status: true, amount: true, paidAmount: true } });
      if (!due) continue;
      const before = decimalToMinor(due.paidAmount) ?? ZERO;
      const { paidAfter, statusAfter } = reverseLine({ status: due.status, amount: decimalToMinor(due.amount), paid: before }, decimalToMinor(allocation.amount)!);
      const statusChanged = statusAfter !== due.status;
      await tx.clientDue.update({
        where: { id: allocation.dueId },
        data: { paidAmount: paidAfter > ZERO ? fromMinor(paidAfter) : null, status: statusAfter as never, updatedById: granted.session.userId, ...(statusChanged ? { statusChangedAt: new Date() } : {}) },
      });
      await tx.clientDueEvent.create({
        data: {
          dueId: allocation.dueId,
          clientId: payment.clientId,
          type: "PAYMENT_REVERSED",
          changes: {
            paidAmount: { from: fromMinor(before), to: paidAfter > ZERO ? fromMinor(paidAfter) : null },
            ...(statusChanged ? { status: { from: due.status, to: statusAfter } } : {}),
            receipt: { from: payment.receiptNumber, to: null },
          },
          actorUserId: granted.session.userId,
        },
      });
    }
    await recordClientActivity(tx, payment.clientId, granted.session.userId, { type: "PAYMENT_REVERSED", summary: `Payment ${payment.receiptNumber} reversed`, details: { paymentId } });
    return true;
  });
  if (!done) return { ok: false, message: "It was already reversed." };
  await logSystemEvent("WARN", "clients", "Client payment reversed", { paymentId, receipt: payment.receiptNumber }, { actorUserId: granted.session.userId, targetType: "Client", targetId: payment.clientId });
  await refresh([payment.clientId]);
  return { ok: true, message: `${payment.receiptNumber} reversed. The invoices it settled are open again for that amount.` };
}
