"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { decimalToMinor, fromMinor, reverseLine } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { recordClientActivity } from "@/server/clientRecords";
import { canDeleteClientRecords } from "@/server/clientModule";
import { lockClient, refreshCurrentSubscription } from "@/server/clientSubscriptionStore";
import { DELETE_REFUSED } from "@/lib/clientDeleteRule";

/**
 * Deleting things inside a client (owner's rule, 17 Oct 2026): subscriptions, invoices, payments and
 * notes. Every action needs an Administrator, or a role an Administrator gave `clients.delete`
 * (`canDeleteClientRecords`) — the same rule as deleting a client. Archive, cancel and reverse stay the
 * everyday tools; delete is for what should never have been recorded (a duplicate, a test, a typo).
 *
 * What each delete keeps true:
 *   - a subscription: the client's current term is recomputed under the client lock; invoices raised
 *     for it stay (their link is cleared), because money is separate from terms;
 *   - an invoice: refused while a recorded (unreversed) payment settles any of it — deleting it would
 *     leave money received against nothing. Reverse or delete that payment first;
 *   - a payment: an unreversed one is first taken off the invoices it settled (exactly what a reversal
 *     does), so no invoice keeps a paid amount nobody can trace.
 * Each delete is on the client's timeline and in the System Log (ids and numbers, never amounts' owners).
 */

export interface DeleteResult {
  ok: boolean;
  message: string;
}

const MAX = 500;

async function guard(): Promise<{ session: { userId: string } } | { error: string }> {
  // The project and the Client Management feature, as for any client action…
  const granted = await checkPermission("clients.view");
  if ("denied" in granted) return { error: granted.denied };
  // …then the delete rule itself.
  if (!(await canDeleteClientRecords(granted.session))) return { error: DELETE_REFUSED };
  return { session: granted.session };
}

function cleanIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids)) return null;
  const out = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 64))];
  return out.length && out.length <= MAX ? out : null;
}

async function refresh(clientIds: string[]) {
  for (const path of ["/clients", "/clients/subscriptions", "/clients/dues", "/clients/payments"]) revalidatePath(await projectPath(path));
  for (const id of clientIds.slice(0, 20)) revalidatePath(await projectPath(`/clients/${id}`));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Deletes subscription terms. The client's current term is recomputed without them. */
export async function deleteSubscriptions(ids: string[]): Promise<DeleteResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, message: g.error };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: `Choose between 1 and ${MAX} subscriptions.` };
  const terms = await prisma.clientSubscription.findMany({ where: { id: { in: clean } }, select: { id: true, clientId: true, service: true, startDate: true, endDate: true } });
  if (!terms.length) return { ok: false, message: "Those subscriptions no longer exist." };
  const byClient = new Map<string, typeof terms>();
  for (const t of terms) byClient.set(t.clientId, [...(byClient.get(t.clientId) ?? []), t]);
  let removed = 0;
  // One client per transaction, in id order, so two deletes cannot deadlock on the client locks.
  for (const clientId of [...byClient.keys()].sort()) {
    const mine = byClient.get(clientId)!;
    removed += await prisma.$transaction(async (tx) => {
      if (!(await lockClient(tx, clientId))) return 0;
      const termIds = mine.map((t) => t.id);
      // The current-term pointer may name one of them; clear it, then recompute from what is left.
      await tx.client.updateMany({ where: { id: clientId, currentSubscriptionId: { in: termIds } }, data: { currentSubscriptionId: null } });
      const gone = await tx.clientSubscription.deleteMany({ where: { id: { in: termIds }, clientId } });
      await refreshCurrentSubscription(tx, clientId);
      for (const t of mine) {
        await recordClientActivity(tx, clientId, g.session.userId, {
          type: "SUBSCRIPTION_DELETED",
          summary: `Subscription deleted: ${t.service} (${t.startDate.toISOString().slice(0, 10)} → ${t.endDate.toISOString().slice(0, 10)})`,
          details: { subscriptionId: t.id },
        });
      }
      return gone.count;
    });
  }
  await logSystemEvent("WARN", "clients", `Deleted ${plural(removed, "subscription")}`, { count: removed, ids: terms.slice(0, 100).map((t) => t.id) }, { actorUserId: g.session.userId, targetType: "ClientSubscription" });
  await refresh([...byClient.keys()]);
  return { ok: true, message: `${plural(removed, "subscription")} deleted. Invoices raised for them are kept on the Billing List.` };
}

/** Deletes invoices / dues — refused for any invoice a recorded payment still settles. */
export async function deleteDues(ids: string[]): Promise<DeleteResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, message: g.error };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: `Choose between 1 and ${MAX} invoices.` };
  const dues = await prisma.clientDue.findMany({
    where: { id: { in: clean } },
    select: { id: true, clientId: true, invoiceNumber: true, service: true, dueDate: true, allocations: { where: { payment: { reversedAt: null } }, select: { payment: { select: { receiptNumber: true } } } } },
  });
  if (!dues.length) return { ok: false, message: "Those invoices no longer exist." };
  const blocked = dues.filter((d) => d.allocations.length > 0);
  const deletable = dues.filter((d) => d.allocations.length === 0);
  let removed = 0;
  if (deletable.length) {
    removed = await prisma.$transaction(async (tx) => {
      const gone = await tx.clientDue.deleteMany({ where: { id: { in: deletable.map((d) => d.id) }, allocations: { none: { payment: { reversedAt: null } } } } });
      for (const d of deletable) {
        await recordClientActivity(tx, d.clientId, g.session.userId, { type: "BILLING_DELETED", summary: `Invoice deleted: ${d.invoiceNumber ?? `${d.service ?? "a due"} due ${d.dueDate.toISOString().slice(0, 10)}`}`, details: { dueId: d.id } });
      }
      return gone.count;
    });
    await logSystemEvent("WARN", "clients", `Deleted ${plural(removed, "invoice")}`, { count: removed, numbers: deletable.slice(0, 100).map((d) => d.invoiceNumber ?? d.id) }, { actorUserId: g.session.userId, targetType: "ClientDue" });
  }
  await refresh([...new Set(dues.map((d) => d.clientId))]);
  const parts = [removed ? `${plural(removed, "invoice")} deleted.` : ""];
  if (blocked.length) {
    const receipts = [...new Set(blocked.flatMap((d) => d.allocations.map((a) => a.payment.receiptNumber)))].slice(0, 5).join(", ");
    parts.push(`${plural(blocked.length, "invoice")} kept: a recorded payment (${receipts}) settles ${blocked.length === 1 ? "it" : "them"}. Reverse or delete that payment first.`);
  }
  return { ok: removed > 0, message: parts.filter(Boolean).join(" ") };
}

/** Deletes payments. An unreversed one is first taken off the invoices it settled, like a reversal. */
export async function deletePayments(ids: string[]): Promise<DeleteResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, message: g.error };
  const clean = cleanIds(ids);
  if (!clean) return { ok: false, message: `Choose between 1 and ${MAX} payments.` };
  const payments = await prisma.clientPayment.findMany({ where: { id: { in: clean } }, select: { id: true, clientId: true, receiptNumber: true, reversedAt: true, allocations: { select: { dueId: true, amount: true } } } });
  if (!payments.length) return { ok: false, message: "Those payments no longer exist." };
  const projectId = await activeProjectId();
  const removed = await prisma.$transaction(async (tx) => {
    const dueIds = [...new Set(payments.flatMap((p) => p.allocations.map((a) => a.dueId)))].sort();
    if (dueIds.length) await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ClientDue" WHERE "projectId" = ${projectId} AND "id" IN (${Prisma.join(dueIds)}) ORDER BY "id" FOR UPDATE`);
    let count = 0;
    for (const p of payments) {
      // Re-read under the locks: a reversal that landed meanwhile already took it off the invoices.
      const live = await tx.clientPayment.findFirst({ where: { id: p.id }, select: { reversedAt: true } });
      if (!live) continue;
      if (!live.reversedAt) {
        for (const allocation of p.allocations) {
          const due = await tx.clientDue.findFirst({ where: { id: allocation.dueId }, select: { status: true, amount: true, paidAmount: true } });
          if (!due) continue;
          const before = decimalToMinor(due.paidAmount) ?? BigInt(0);
          const { paidAfter, statusAfter } = reverseLine({ status: due.status, amount: decimalToMinor(due.amount), paid: before }, decimalToMinor(allocation.amount)!);
          const statusChanged = statusAfter !== due.status;
          await tx.clientDue.update({
            where: { id: allocation.dueId },
            data: { paidAmount: paidAfter > BigInt(0) ? fromMinor(paidAfter) : null, status: statusAfter as never, updatedById: g.session.userId, ...(statusChanged ? { statusChangedAt: new Date() } : {}) },
          });
          await tx.clientDueEvent.create({
            data: {
              dueId: allocation.dueId,
              clientId: p.clientId,
              type: "PAYMENT_DELETED",
              changes: { paidAmount: { from: fromMinor(before), to: paidAfter > BigInt(0) ? fromMinor(paidAfter) : null }, ...(statusChanged ? { status: { from: due.status, to: statusAfter } } : {}), receipt: { from: p.receiptNumber, to: null } },
              actorUserId: g.session.userId,
            },
          });
        }
      }
      const gone = await tx.clientPayment.deleteMany({ where: { id: p.id } });
      if (gone.count) {
        count += 1;
        await recordClientActivity(tx, p.clientId, g.session.userId, { type: "PAYMENT_DELETED", summary: `Payment ${p.receiptNumber} deleted${live.reversedAt ? " (it was already reversed)" : ""}`, details: { paymentId: p.id } });
      }
    }
    return count;
  });
  await logSystemEvent("WARN", "clients", `Deleted ${plural(removed, "payment")}`, { count: removed, receipts: payments.slice(0, 100).map((p) => p.receiptNumber) }, { actorUserId: g.session.userId, targetType: "ClientPayment" });
  await refresh([...new Set(payments.map((p) => p.clientId))]);
  return { ok: removed > 0, message: removed ? `${plural(removed, "payment")} deleted. The invoices they settled are open again for those amounts.` : "Those payments no longer exist." };
}

/** Deletes one internal note. */
export async function deleteClientNote(noteId: string): Promise<DeleteResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, message: g.error };
  const note = typeof noteId === "string" ? await prisma.clientNote.findFirst({ where: { id: noteId }, select: { id: true, clientId: true } }) : null;
  if (!note) return { ok: false, message: "That note no longer exists." };
  await prisma.$transaction(async (tx) => {
    await tx.clientNote.deleteMany({ where: { id: note.id } });
    await recordClientActivity(tx, note.clientId, g.session.userId, { type: "NOTE_DELETED", summary: "Internal note deleted", details: { noteId: note.id } });
  });
  await refresh([note.clientId]);
  return { ok: true, message: "Note deleted." };
}
