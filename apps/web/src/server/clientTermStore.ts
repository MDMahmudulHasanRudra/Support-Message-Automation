import type { Prisma } from "@prisma/client";
import { SUBSCRIPTION_KIND_LABELS, type SubscriptionKind, type ValidDue, type ValidSubscription } from "@support-automation/shared";
import { recordClientActivity } from "@/server/clientRecords";
import { createInvoice } from "@/server/clientBillingStore";
import { lockClient, refreshCurrentSubscription, type SellerSnapshot } from "@/server/clientSubscriptionStore";

/**
 * Writing a subscription term (CLIENTS_V3.md §3, CLIENT_CRM_V7.md §4). Not a "use server" file: nothing here is an
 * endpoint, and every caller has made its own permission check. Its own file because it needs both stores
 * (subscriptions and invoices), which already import each other's helpers in one direction.
 */

type Tx = Prisma.TransactionClient;
const day = (d: Date) => d.toISOString().slice(0, 10);

export interface TermWrite {
  clientId: string;
  actorUserId: string;
  term: ValidSubscription;
  seller: SellerSnapshot;
  renewedFromId: string | null;
  invoice: ValidDue | null;
  today: string;
}

/**
 * Creates a term (and its invoice) INSIDE a transaction, under the client row lock: the shared write behind
 * Add subscription, Renew and Renew from offer (CLIENT_CRM_V7.md §4). Recomputes the client's current term and
 * records the timeline.
 *
 * A term is renewed ONCE: a second renewal of the same term (a double press, two people at once — they serialise
 * on the client lock) is refused, never written twice. To extend again, renew the newer term.
 */
export async function createTermInTx(tx: Tx, opts: TermWrite): Promise<{ ok: true; subscriptionId: string; invoiceId: string | null; invoiceNumber: string | null } | { ok: false; message: string }> {
  if (!(await lockClient(tx, opts.clientId))) return { ok: false, message: "That client no longer exists." };
  const client = await tx.client.findFirst({ where: { id: opts.clientId }, select: { status: true } });
  if (!client) return { ok: false, message: "That client no longer exists." };
  if (client.status === "ARCHIVED") return { ok: false, message: "This client is archived. Restore it first." };
  if (opts.renewedFromId) {
    const already = await tx.clientSubscription.findFirst({ where: { renewedFromId: opts.renewedFromId, cancelledAt: null }, select: { endDate: true } });
    if (already) return { ok: false, message: `This term was already renewed (until ${day(already.endDate)}). To extend again, renew the newer term.` };
  }
  // A repeat purchase: renewing, or buying again after an earlier term (any, cancelled ones included).
  const hadBefore = (await tx.clientSubscription.count({ where: { clientId: opts.clientId } })) > 0;
  const created = await tx.clientSubscription.create({
    data: {
      clientId: opts.clientId,
      service: opts.term.service,
      kind: opts.term.kind,
      startDate: new Date(`${opts.term.startDate}T00:00:00.000Z`),
      endDate: new Date(`${opts.term.endDate}T00:00:00.000Z`),
      durationValue: opts.term.durationValue,
      durationUnit: opts.term.durationUnit,
      isRenewal: Boolean(opts.renewedFromId) || hadBefore,
      renewedFromId: opts.renewedFromId,
      ...opts.seller,
      note: opts.term.note,
      createdById: opts.actorUserId,
    },
    select: { id: true },
  });
  await refreshCurrentSubscription(tx, opts.clientId);
  await recordClientActivity(tx, opts.clientId, opts.actorUserId, {
    type: opts.renewedFromId ? "SUBSCRIPTION_RENEWED" : "SUBSCRIPTION_ADDED",
    summary: `${opts.renewedFromId ? "Renewed" : "Subscription added"}: ${opts.term.service} (${SUBSCRIPTION_KIND_LABELS[opts.term.kind as SubscriptionKind]}, ${opts.term.startDate} → ${opts.term.endDate})`,
    details: { subscriptionId: created.id, renewedFromId: opts.renewedFromId, soldByMemberId: opts.seller.soldByMemberId },
  });
  let invoiceId: string | null = null;
  let invoiceNumber: string | null = null;
  if (opts.invoice) {
    const invoice = await createInvoice(tx, opts.clientId, opts.actorUserId, opts.invoice, {
      kind: opts.renewedFromId ? "RENEWAL" : "SUBSCRIPTION",
      issuedDate: opts.today,
      service: opts.term.service,
      subscriptionId: created.id,
      soldByMemberId: opts.seller.soldByMemberId,
    });
    invoiceId = invoice.id;
    invoiceNumber = invoice.invoiceNumber;
  }
  return { ok: true, subscriptionId: created.id, invoiceId, invoiceNumber };
}
