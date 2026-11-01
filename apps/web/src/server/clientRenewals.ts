import type { Prisma } from "@prisma/client";
import {
  addCalendarDays,
  calendarDaysBetween,
  clientDisplayName,
  decimalToMinor,
  dhakaToday,
  describeDuration,
  followUpDue,
  formatMinor,
  offerLapsed,
  OPEN_RENEWAL_OFFER_STATUSES,
  RENEWAL_OFFER_STATUS_LABELS,
  RENEWAL_VIEWS,
  RENEWAL_VIEW_STATUS,
  type RenewalOfferStatus,
  type RenewalView,
} from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * The Renewal workspace (CLIENT_CRM_V7.md §4) — READS. Not a "use server" file; every caller has checked
 * `clients.view`. Two kinds of view: TERMS that need attention (renewing soon, expired) — each with its open offer
 * when there is one — and OFFERS by status. Neither creates or implies any money owed: an expiring term is not an
 * invoice, and a proposed price is not a due.
 */

export const RENEWAL_PAGE_SIZE = 50;

export interface RenewalRow {
  client: { id: string; code: string; name: string; archived: boolean };
  term: { id: string; service: string; endDate: string; daysLeft: number; paused: boolean; durationValue: number | null; durationUnit: string | null } | null;
  offer: {
    id: string;
    status: RenewalOfferStatus;
    statusLabel: string;
    service: string;
    duration: string;
    durationValue: number;
    durationUnit: string;
    /** Only for billing viewers; null otherwise or when no price was proposed. */
    price: string | null;
    amount: string | null;
    currency: string | null;
    validUntil: string | null;
    followUpDate: string | null;
    contactCount: number;
    lastContactAt: Date | null;
    lapsed: boolean;
    followUpDue: boolean;
    createdByName: string | null;
    renewedSubscriptionId: string | null;
    invoiceDueId: string | null;
  } | null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

const OFFER_SELECT = {
  id: true,
  status: true,
  service: true,
  durationValue: true,
  durationUnit: true,
  amount: true,
  currency: true,
  validUntil: true,
  followUpDate: true,
  contactCount: true,
  lastContactAt: true,
  createdByName: true,
  renewedSubscriptionId: true,
  invoiceDueId: true,
} satisfies Prisma.ClientRenewalOfferSelect;

type OfferRow = Prisma.ClientRenewalOfferGetPayload<{ select: typeof OFFER_SELECT }>;

function offerView(o: OfferRow, today: string, billing: boolean): NonNullable<RenewalRow["offer"]> {
  const status = o.status as RenewalOfferStatus;
  const validUntil = o.validUntil ? day(o.validUntil) : null;
  const followUpDate = o.followUpDate ? day(o.followUpDate) : null;
  return {
    id: o.id,
    status,
    statusLabel: RENEWAL_OFFER_STATUS_LABELS[status],
    service: o.service,
    duration: describeDuration(o.durationValue, o.durationUnit),
    durationValue: o.durationValue,
    durationUnit: o.durationUnit,
    price: billing && o.amount !== null && o.currency ? formatMinor(decimalToMinor(o.amount) ?? BigInt(0), o.currency) : null,
    amount: billing ? (o.amount?.toFixed(2) ?? null) : null,
    currency: billing ? o.currency : null,
    validUntil,
    followUpDate,
    contactCount: o.contactCount,
    lastContactAt: o.lastContactAt,
    lapsed: offerLapsed({ status, validUntil }, today),
    followUpDue: followUpDue({ status, followUpDate }, today),
    createdByName: o.createdByName,
    renewedSubscriptionId: o.renewedSubscriptionId,
    invoiceDueId: o.invoiceDueId,
  };
}

export function parseRenewalView(v: unknown): RenewalView {
  return (RENEWAL_VIEWS as readonly string[]).includes(String(v)) ? (v as RenewalView) : "renewing";
}

function termWhere(view: "renewing" | "expired", today: string, windowDays: number, q: string): Prisma.ClientSubscriptionWhereInput {
  const and: Prisma.ClientSubscriptionWhereInput[] = [
    { cancelledAt: null },
    // Only the term that speaks for its client: a renewed-away term is history, not a renewal to chase.
    { currentFor: { some: { status: { not: "ARCHIVED" } } } },
    view === "renewing" ? { endDate: { gte: asDate(today), lte: asDate(addCalendarDays(today, windowDays)) } } : { endDate: { lt: asDate(today) } },
  ];
  if (q) and.push({ client: { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }, { companyName: { contains: q, mode: "insensitive" } }] } });
  return { AND: and };
}

function offerWhere(view: RenewalView, today: string, q: string): Prisma.ClientRenewalOfferWhereInput {
  const and: Prisma.ClientRenewalOfferWhereInput[] = [];
  const status = RENEWAL_VIEW_STATUS[view];
  if (status) and.push({ status });
  if (view === "follow-up") and.push({ status: { in: [...OPEN_RENEWAL_OFFER_STATUSES] }, followUpDate: { lte: asDate(today) } });
  if (q) and.push({ client: { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }, { companyName: { contains: q, mode: "insensitive" } }] } });
  return and.length ? { AND: and } : {};
}

export async function listRenewals(opts: { view: RenewalView; q: string; page: number; windowDays: number; billing: boolean }): Promise<{ rows: RenewalRow[]; total: number; today: string }> {
  const today = dhakaToday(new Date());
  const skip = (opts.page - 1) * RENEWAL_PAGE_SIZE;
  if (opts.view === "renewing" || opts.view === "expired") {
    const where = termWhere(opts.view, today, opts.windowDays, opts.q);
    const [terms, total] = await Promise.all([
      prisma.clientSubscription.findMany({
        where,
        orderBy: [{ endDate: opts.view === "renewing" ? "asc" : "desc" }, { id: "asc" }],
        skip,
        take: RENEWAL_PAGE_SIZE,
        select: {
          id: true,
          service: true,
          endDate: true,
          pausedAt: true,
          durationValue: true,
          durationUnit: true,
          client: { select: { id: true, code: true, name: true, companyName: true, status: true } },
          renewalOffers: { where: { status: { in: [...OPEN_RENEWAL_OFFER_STATUSES] } }, select: OFFER_SELECT, take: 1 },
        },
      }),
      prisma.clientSubscription.count({ where }),
    ]);
    return {
      today,
      total,
      rows: terms.map((t) => ({
        client: { id: t.client.id, code: t.client.code, name: clientDisplayName(t.client.name, t.client.companyName), archived: t.client.status === "ARCHIVED" },
        term: { id: t.id, service: t.service, endDate: day(t.endDate), daysLeft: calendarDaysBetween(today, day(t.endDate)), paused: t.pausedAt !== null, durationValue: t.durationValue, durationUnit: t.durationUnit },
        offer: t.renewalOffers[0] ? offerView(t.renewalOffers[0], today, opts.billing) : null,
      })),
    };
  }
  const where = offerWhere(opts.view, today, opts.q);
  const [offers, total] = await Promise.all([
    prisma.clientRenewalOffer.findMany({
      where,
      orderBy: opts.view === "follow-up" ? [{ followUpDate: "asc" }, { id: "asc" }] : [{ updatedAt: "desc" }, { id: "asc" }],
      skip,
      take: RENEWAL_PAGE_SIZE,
      select: {
        ...OFFER_SELECT,
        client: { select: { id: true, code: true, name: true, companyName: true, status: true } },
        subscription: { select: { id: true, service: true, endDate: true, pausedAt: true, durationValue: true, durationUnit: true } },
      },
    }),
    prisma.clientRenewalOffer.count({ where }),
  ]);
  return {
    today,
    total,
    rows: offers.map((o) => ({
      client: { id: o.client.id, code: o.client.code, name: clientDisplayName(o.client.name, o.client.companyName), archived: o.client.status === "ARCHIVED" },
      term: { id: o.subscription.id, service: o.subscription.service, endDate: day(o.subscription.endDate), daysLeft: calendarDaysBetween(today, day(o.subscription.endDate)), paused: o.subscription.pausedAt !== null, durationValue: o.subscription.durationValue, durationUnit: o.subscription.durationUnit },
      offer: offerView(o, today, opts.billing),
    })),
  };
}

/** Counts for the chips and cards, from the same `where` builders as the list. */
export async function renewalCounts(windowDays: number, q = ""): Promise<Record<RenewalView, number>> {
  const today = dhakaToday(new Date());
  const entries = await Promise.all(
    RENEWAL_VIEWS.map(async (v) => [v, v === "renewing" || v === "expired" ? await prisma.clientSubscription.count({ where: termWhere(v, today, windowDays, q) }) : await prisma.clientRenewalOffer.count({ where: offerWhere(v, today, q) })] as const),
  );
  return Object.fromEntries(entries) as Record<RenewalView, number>;
}

/** One client's offers, newest first, with their history (the client profile). */
export async function clientRenewalOffers(clientId: string, billing: boolean) {
  const today = dhakaToday(new Date());
  const offers = await prisma.clientRenewalOffer.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { ...OFFER_SELECT, subscriptionId: true, events: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, type: true, fromStatus: true, toStatus: true, channel: true, note: true, actorName: true, createdAt: true } } },
  });
  return offers.map((o) => ({ ...offerView(o, today, billing), subscriptionId: o.subscriptionId, events: o.events }));
}
