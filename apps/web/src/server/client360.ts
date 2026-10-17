import {
  decimalToMinor,
  describeExpiry,
  dhakaToday,
  fromMinor,
  remainingOn,
  summarizeOutstanding,
  termState,
  type SubscriptionState,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { ClientViewerCaps } from "@/server/clientModule";

/**
 * The extra reads behind the 360° client page (CLIENTS_V3.md §5): subscriptions, WhatsApp group links,
 * outstanding money and receipts. Not a "use server" file. Billing figures are read only when
 * `caps.billing` says this viewer may see them; group links only when the sub-module is on.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);
const ZERO = BigInt(0);

export interface SubscriptionView {
  id: string;
  service: string;
  kind: string;
  startDate: string;
  endDate: string;
  durationValue: number | null;
  durationUnit: string | null;
  state: SubscriptionState;
  expiryText: string;
  isRenewal: boolean;
  isCurrent: boolean;
  soldBy: string | null;
  soldByMemberId: string | null;
  soldByTeam: string | null;
  note: string | null;
  cancelReason: string | null;
}

export interface GroupLinkView {
  id: string;
  groupName: string;
  accountId: string | null;
  accountLabel: string | null;
  accountStatus: string | null;
  groupId: string | null;
  groupActive: boolean;
  linkedBy: string | null;
  linkedAt: Date;
  unlinkedAt: Date | null;
  unlinkedBy: string | null;
  unlinkReason: string | null;
}

export interface OpenInvoice {
  id: string;
  invoiceNumber: string | null;
  dueDate: string;
  currency: string;
  remaining: string;
  service: string | null;
}

export async function getClient360(clientId: string, caps: ClientViewerCaps) {
  const today = dhakaToday(new Date());
  const [client, terms, links, dues, payments] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId }, select: { currentSubscriptionId: true } }),
    caps.subscriptions
      ? prisma.clientSubscription.findMany({ where: { clientId }, orderBy: [{ endDate: "desc" }, { createdAt: "desc" }], include: { soldByMember: { select: { name: true } } } })
      : Promise.resolve([]),
    caps.groups
      ? prisma.clientWhatsAppGroupLink.findMany({
          where: { clientId },
          orderBy: [{ unlinkedAt: { sort: "desc", nulls: "first" } }, { linkedAt: "desc" }],
          take: 60,
          include: {
            account: { select: { label: true, phoneNumber: true, status: true } },
            group: { select: { isActive: true, name: true } },
            linkedBy: { select: { name: true } },
            unlinkedBy: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    caps.billing
      ? prisma.clientDue.findMany({ where: { clientId }, select: { id: true, invoiceNumber: true, status: true, currency: true, amount: true, paidAmount: true, dueDate: true, service: true } })
      : Promise.resolve([]),
    caps.billing
      ? prisma.clientPayment.findMany({
          where: { clientId },
          orderBy: [{ receivedDate: "desc" }, { recordedAt: "desc" }],
          take: 20,
          include: { recordedBy: { select: { name: true } }, allocations: { select: { due: { select: { invoiceNumber: true } } } } },
        })
      : Promise.resolve([]),
  ]);
  const currentId = client?.currentSubscriptionId ?? null;

  const subscriptions: SubscriptionView[] = terms.map((t) => {
    const startDate = day(t.startDate);
    const endDate = day(t.endDate);
    const state = termState({ id: t.id, kind: t.kind, startDate, endDate, pausedAt: t.pausedAt, cancelledAt: t.cancelledAt, isRenewal: t.isRenewal }, today, caps.settings.renewalWindowDays);
    return {
      id: t.id,
      service: t.service,
      kind: t.kind,
      startDate,
      endDate,
      durationValue: t.durationValue,
      durationUnit: t.durationUnit,
      state,
      expiryText: state === "CANCELLED" ? "Cancelled" : state === "PAUSED" ? "Paused by staff" : describeExpiry(startDate, endDate, today),
      isRenewal: t.isRenewal,
      isCurrent: t.id === currentId,
      soldBy: t.soldByMember?.name ?? t.soldByName,
      soldByMemberId: t.soldByMemberId,
      soldByTeam: t.soldByTeamName,
      note: t.note,
      cancelReason: t.cancelReason,
    };
  });
  const current = subscriptions.find((s) => s.isCurrent) ?? null;
  // The current term speaks for the client; with none left, every term was cancelled (or there never was one).
  const overallState: SubscriptionState = current ? current.state : subscriptions.length ? "CANCELLED" : "NONE";

  const groupLinks: GroupLinkView[] = links.map((l) => ({
    id: l.id,
    groupName: l.group?.name ?? l.groupName,
    accountId: l.accountId,
    accountLabel: l.account ? l.account.label + (l.account.phoneNumber ? ` (${l.account.phoneNumber})` : "") : null,
    accountStatus: l.account?.status ?? null,
    groupId: l.groupId,
    groupActive: Boolean(l.group?.isActive),
    linkedBy: l.linkedBy?.name ?? null,
    linkedAt: l.linkedAt,
    unlinkedAt: l.unlinkedAt,
    unlinkedBy: l.unlinkedBy?.name ?? null,
    unlinkReason: l.unlinkReason,
  }));

  const minorDues = dues.map((d) => ({ ...d, amountMinor: decimalToMinor(d.amount), paidMinor: decimalToMinor(d.paidAmount) ?? ZERO, day: day(d.dueDate) }));
  const lines = caps.billing
    ? summarizeOutstanding(
        minorDues.map((d) => ({ status: d.status, currency: d.currency, amount: d.amountMinor, paid: d.paidMinor, dueDate: d.day })),
        today,
      )
    : null;
  // Billed / collected / remaining per currency for the Billing Summary card — never summed across currencies.
  const ledger = lines
    ? lines.map((l) => ({ currency: l.currency, billed: fromMinor(l.billed), collected: fromMinor(l.collected), remaining: fromMinor(l.remaining), openCount: l.openCount, overdueCount: l.overdueCount }))
    : null;
  const outstanding = lines
    ? lines
        .filter((l) => l.remaining > ZERO)
        .map((l) => ({ currency: l.currency, remaining: fromMinor(l.remaining), overdue: l.overdueCount > 0 }))
    : null;
  const invoiceCount = caps.billing ? dues.filter((d) => d.status !== "CANCELLED").length : 0;
  const openInvoices: OpenInvoice[] = minorDues
    .filter((d) => d.currency && remainingOn({ status: d.status, amount: d.amountMinor, paid: d.paidMinor }) > ZERO)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ id: d.id, invoiceNumber: d.invoiceNumber, dueDate: d.day, currency: d.currency!, remaining: fromMinor(remainingOn({ status: d.status, amount: d.amountMinor, paid: d.paidMinor })), service: d.service }));

  return {
    today,
    subscriptions,
    current,
    overallState,
    groupLinks,
    outstanding,
    ledger,
    invoiceCount,
    openInvoices,
    payments: payments.map((p) => ({
      id: p.id,
      receiptNumber: p.receiptNumber,
      currency: p.currency,
      amount: p.amount.toFixed(2),
      method: p.method,
      reference: p.reference,
      receivedDate: day(p.receivedDate),
      recordedBy: p.recordedBy?.name ?? null,
      reversed: Boolean(p.reversedAt),
      invoices: p.allocations.map((a) => a.due.invoiceNumber ?? "older due"),
    })),
  };
}
