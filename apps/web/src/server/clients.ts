import { Prisma } from "@prisma/client";
import {
  CLIENT_STATUSES,
  clientSubscriptionState,
  decimalToMinor,
  describeExpiry,
  fromMinor,
  summarizeOutstanding,
  type OutstandingByCurrency,
  type SubscriptionState,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import {
  buildClientSearchWhere,
  buildClientWhere,
  clientOrderBy,
  DEFAULT_CLIENT_PAGE_SIZE,
  CLIENT_PAGE_SIZES,
  defaultFilterContext,
  type ClientFilterContext,
  type ClientFilters,
  type ClientSort,
} from "@/lib/clientFilters";
import { findDuplicateClients, type DuplicateClient } from "@/server/clientRecords";

/**
 * Reads for the Client pages. Everything goes through the project-scoped client, so another
 * project's clients cannot appear here whatever the URL says. Billing figures are read ONLY when the
 * caller says the viewer may see them (`ctx.billing`); otherwise the query never selects them.
 */

export function resolvePageSize(requested: string | undefined): number {
  const n = Number(requested);
  return (CLIENT_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_CLIENT_PAGE_SIZE;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
/** Web code targets below ES2020, where a `0n` literal does not compile. */
const ZERO = BigInt(0);

export interface ClientSubscriptionSummary {
  id: string;
  service: string;
  kind: string;
  startDate: string;
  endDate: string;
  durationValue: number | null;
  durationUnit: string | null;
  state: SubscriptionState;
  expiryText: string;
}

export interface ClientListRow {
  id: string;
  code: string;
  name: string;
  companyName: string | null;
  status: string;
  category: string | null;
  tags: string[];
  source: string;
  country: string | null;
  preferredCurrency: string | null;
  address: string | null;
  assignedMemberName: string | null;
  assignedTeamName: string | null;
  lastContactAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  photoVersion: number | null;
  channels: Array<{ kind: string; value: string; isPrimary: boolean }>;
  /** True when a one-to-one WhatsApp chat is linked (ClientWhatsAppChatLink). */
  chatLinked: boolean;
  subscription: ClientSubscriptionSummary | null;
  subscriptionState: SubscriptionState;
  subscriptionCount: number;
  returning: boolean;
  /** The seller of the current term, else whoever brought the client in. */
  soldBy: { id: string | null; name: string; detail: string | null } | null;
  groups: Array<{ linkId: string; name: string; accountId: string | null; accountLabel: string | null; groupId: string | null; active: boolean }>;
  /** Present only for a viewer allowed to see billing. */
  billing: { outstanding: Array<{ currency: string; remaining: string; overdue: boolean }>; nextDueDate: string | null; openInvoices: number } | null;
}

export interface ClientRegisterKpis {
  total: number;
  linkedGroups: number;
  renewalAttention: number;
  returning: number;
}

const LIST_SELECT = {
  id: true,
  code: true,
  name: true,
  companyName: true,
  status: true,
  category: true,
  tags: true,
  source: true,
  country: true,
  preferredCurrency: true,
  address: true,
  lastContactAt: true,
  createdAt: true,
  updatedAt: true,
  photoUpdatedAt: true,
  assignedMember: { select: { name: true } },
  assignedTeam: { select: { name: true } },
  soldByMember: { select: { id: true, name: true, role: true, team: { select: { name: true } } } },
  // The first few channels only: the list shows how a client can be reached, not every reference.
  channels: { select: { kind: true, value: true, isPrimary: true }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 6 },
  currentSubscription: {
    select: {
      id: true,
      service: true,
      kind: true,
      startDate: true,
      endDate: true,
      durationValue: true,
      durationUnit: true,
      pausedAt: true,
      cancelledAt: true,
      isRenewal: true,
      soldByMemberId: true,
      soldByName: true,
      soldByTeamName: true,
      soldByMember: { select: { name: true, role: true } },
    },
  },
  groupLinks: {
    where: { unlinkedAt: null },
    orderBy: { linkedAt: "asc" },
    take: 3,
    select: { id: true, groupName: true, accountId: true, groupId: true, account: { select: { label: true, phoneNumber: true } }, group: { select: { isActive: true, name: true } } },
  },
  chatLinks: { where: { unlinkedAt: null }, select: { id: true }, take: 1 },
  _count: { select: { subscriptions: true } },
} satisfies Prisma.ClientSelect;

type ListRecord = Prisma.ClientGetPayload<{ select: typeof LIST_SELECT }>;

function summarizeTerm(t: NonNullable<ListRecord["currentSubscription"]>, ctx: ClientFilterContext): ClientSubscriptionSummary {
  const startDate = day(t.startDate);
  const endDate = day(t.endDate);
  const state = clientSubscriptionState({ id: t.id, kind: t.kind, startDate, endDate, pausedAt: t.pausedAt, cancelledAt: t.cancelledAt, isRenewal: t.isRenewal }, false, ctx.today, ctx.renewalWindowDays);
  return {
    id: t.id,
    service: t.service,
    kind: t.kind,
    startDate,
    endDate,
    durationValue: t.durationValue,
    durationUnit: t.durationUnit,
    state,
    expiryText: state === "PAUSED" ? "Paused by staff" : describeExpiry(startDate, endDate, ctx.today),
  };
}

function toRow(r: ListRecord, ctx: ClientFilterContext, billing: Map<string, ClientListRow["billing"]> | null, returningIds: Set<string>): ClientListRow {
  const term = r.currentSubscription;
  const subscription = term ? summarizeTerm(term, ctx) : null;
  const termSeller = term && (term.soldByMemberId || term.soldByName) ? { id: term.soldByMemberId, name: term.soldByMember?.name ?? term.soldByName ?? "Former member", detail: term.soldByTeamName ?? term.soldByMember?.role ?? null } : null;
  const clientSeller = r.soldByMember ? { id: r.soldByMember.id, name: r.soldByMember.name, detail: r.soldByMember.team?.name ?? r.soldByMember.role ?? null } : null;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    companyName: r.companyName,
    status: r.status,
    category: r.category,
    tags: r.tags,
    source: r.source,
    country: r.country,
    preferredCurrency: r.preferredCurrency,
    address: r.address,
    assignedMemberName: r.assignedMember?.name ?? null,
    assignedTeamName: r.assignedTeam?.name ?? null,
    lastContactAt: r.lastContactAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    photoVersion: r.photoUpdatedAt ? r.photoUpdatedAt.getTime() : null,
    channels: r.channels,
    chatLinked: r.chatLinks.length > 0,
    subscription,
    // A client whose every term was cancelled has no current term; the count tells it apart from "never had one".
    subscriptionState: subscription ? subscription.state : r._count.subscriptions > 0 ? "CANCELLED" : "NONE",
    subscriptionCount: r._count.subscriptions,
    returning: returningIds.has(r.id),
    soldBy: termSeller ?? clientSeller,
    groups: r.groupLinks.map((g) => ({
      linkId: g.id,
      name: g.group?.name ?? g.groupName,
      accountId: g.accountId,
      accountLabel: g.account ? g.account.label || g.account.phoneNumber : null,
      groupId: g.groupId,
      active: Boolean(g.group?.isActive),
    })),
    billing: billing ? (billing.get(r.id) ?? { outstanding: [], nextDueDate: null, openInvoices: 0 }) : null,
  };
}

/**
 * Billing for the clients on one page, in one grouped query (never one per client): what remains per
 * currency, the earliest open due and how many invoices are open.
 */
async function billingForClients(clientIds: string[], today: string): Promise<Map<string, ClientListRow["billing"]>> {
  const out = new Map<string, ClientListRow["billing"]>();
  if (!clientIds.length) return out;
  const rows = await prisma.clientDue.findMany({
    where: { clientId: { in: clientIds }, status: { in: ["UNPAID", "PARTIALLY_PAID"] } },
    select: { clientId: true, status: true, currency: true, amount: true, paidAmount: true, dueDate: true },
  });
  const byClient = new Map<string, typeof rows>();
  for (const row of rows) byClient.set(row.clientId, [...(byClient.get(row.clientId) ?? []), row]);
  for (const [clientId, dues] of byClient) {
    const lines: OutstandingByCurrency[] = summarizeOutstanding(
      dues.map((d) => ({ status: d.status, currency: d.currency, amount: decimalToMinor(d.amount), paid: decimalToMinor(d.paidAmount) ?? ZERO, dueDate: day(d.dueDate) })),
      today,
    );
    const next = dues.map((d) => day(d.dueDate)).sort()[0] ?? null;
    out.set(clientId, {
      outstanding: lines.filter((l) => l.remaining > ZERO).map((l) => ({ currency: l.currency, remaining: fromMinor(l.remaining), overdue: l.overdueCount > 0 })),
      nextDueDate: next,
      openInvoices: dues.length,
    });
  }
  return out;
}

export async function listClients(opts: {
  filters: ClientFilters;
  sort: ClientSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
  ctx?: ClientFilterContext;
}) {
  const ctx = opts.ctx ?? defaultFilterContext();
  const where = buildClientWhere(opts.filters, ctx);
  const [rows, total, statusCounts, categories, members, tagRows] = await Promise.all([
    prisma.client.findMany({ where, orderBy: clientOrderBy(opts.sort, opts.dir), skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, select: LIST_SELECT }),
    prisma.client.count({ where }),
    // Status chips count within the current search and filters, but across every status.
    prisma.client.groupBy({ by: ["status"], where: buildClientSearchWhere(opts.filters, ctx), _count: { _all: true } }),
    prisma.client.findMany({ where: { category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" }, take: 200 }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.client.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { tags: true }, take: 2000 }),
  ]);
  const ids = rows.map((r) => r.id);
  const [billing, returning] = await Promise.all([
    ctx.billing ? billingForClients(ids, ctx.today) : Promise.resolve(null),
    ids.length ? prisma.clientSubscription.findMany({ where: { clientId: { in: ids }, isRenewal: true }, select: { clientId: true }, distinct: ["clientId"] }) : Promise.resolve([]),
  ]);
  const returningIds = new Set(returning.map((r) => r.clientId));

  const counts: Record<string, number> = Object.fromEntries(CLIENT_STATUSES.map((s) => [s, 0]));
  for (const row of statusCounts) counts[row.status] = row._count._all;
  const knownTags = [...new Set(tagRows.flatMap((r) => r.tags))].sort();

  return {
    clients: rows.map((r) => toRow(r, ctx, billing, returningIds)),
    total,
    counts,
    categories: categories.map((c) => c.category!).filter(Boolean),
    members,
    knownTags,
  };
}

/** The four figures above the register. Counts only; no amount. */
export async function getClientRegisterKpis(ctx: ClientFilterContext): Promise<ClientRegisterKpis> {
  const today = new Date(`${ctx.today}T00:00:00.000Z`);
  const windowEnd = new Date(today.getTime() + ctx.renewalWindowDays * 86_400_000);
  const recentlyExpired = new Date(today.getTime() - 30 * 86_400_000);
  const current = { status: { not: "ARCHIVED" as const } };
  const [total, linkedGroups, renewalAttention, returning] = await Promise.all([
    prisma.client.count({ where: current }),
    prisma.clientWhatsAppGroupLink.count({ where: { unlinkedAt: null, client: current } }),
    // Inside the renewal window, or expired in the last 30 days and not renewed. Not a debt: a reminder to talk to them.
    prisma.client.count({ where: { ...current, currentSubscription: { pausedAt: null, endDate: { gt: recentlyExpired, lte: windowEnd } } } }),
    prisma.client.count({ where: { ...current, subscriptions: { some: { isRenewal: true } } } }),
  ]);
  return { total, linkedGroups, renewalAttention, returning };
}

/** Distinct services and countries in use, for the filter dropdowns. */
export async function getRegisterFilterOptions() {
  const [services, countries, currencies, teams] = await Promise.all([
    prisma.clientSubscription.findMany({ distinct: ["service"], select: { service: true }, orderBy: { service: "asc" }, take: 300 }),
    prisma.client.findMany({ where: { country: { not: null } }, distinct: ["country"], select: { country: true }, take: 300 }),
    prisma.client.findMany({ where: { preferredCurrency: { not: null } }, distinct: ["preferredCurrency"], select: { preferredCurrency: true }, take: 100 }),
    prisma.team.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    services: services.map((s) => s.service),
    countries: countries.map((c) => c.country!).filter(Boolean),
    currencies: currencies.map((c) => c.preferredCurrency!).filter(Boolean).sort(),
    teams,
  };
}

export async function getClientDetail(id: string) {
  const client = await prisma.client.findFirst({
    where: { id },
    include: {
      assignedMember: { select: { id: true, name: true } },
      assignedTeam: { select: { id: true, name: true } },
      soldByMember: { select: { id: true, name: true, role: true, status: true, team: { select: { name: true } } } },
      createdBy: { select: { name: true } },
      channels: { orderBy: [{ kind: "asc" }, { isPrimary: "desc" }, { createdAt: "asc" }] },
    },
  });
  if (!client) return null;

  const [notes, activities, groupNames] = await Promise.all([
    prisma.clientNote.findMany({ where: { clientId: id }, orderBy: { createdAt: "desc" }, take: 50, include: { author: { select: { name: true } } } }),
    prisma.clientActivity.findMany({ where: { clientId: id }, orderBy: { createdAt: "desc" }, take: 100, include: { actor: { select: { name: true } } } }),
    // A linked WhatsApp group shows its name, found by its WhatsApp id.
    (async () => {
      const ids = client.channels.filter((c) => c.kind === "WHATSAPP_GROUP").map((c) => c.normalizedValue);
      if (!ids.length) return new Map<string, string>();
      const groups = await prisma.whatsAppGroup.findMany({ where: { whatsappGroupId: { in: ids } }, select: { whatsappGroupId: true, name: true }, distinct: ["whatsappGroupId"] });
      return new Map(groups.map((g) => [g.whatsappGroupId, g.name]));
    })(),
  ]);

  // Other clients sharing one of this client's identifiers: for a person to look at, never merged automatically.
  const duplicates: DuplicateClient[] = await findDuplicateClients({
    channels: client.channels.map((c) => ({
      kind: c.kind,
      value: c.value,
      normalizedValue: c.normalizedValue,
      label: c.label,
      isPrimary: c.isPrimary,
      matchKey: `${c.kind === "PHONE" || c.kind === "WHATSAPP" ? "phone" : c.kind.toLowerCase()}:${c.normalizedValue}`,
    })),
    excludeClientId: id,
  });
  return { client, notes, activities, groupNames, duplicates };
}

export interface RosterMember {
  id: string;
  name: string;
  designation: string | null;
  teamId: string | null;
  teamName: string | null;
  active: boolean;
}

/**
 * Staff and teams for the form, from the project's REAL roster: `Team` and `InternalTeamMember` (never a
 * typed name). Inactive teams are listed only so an existing assignment still reads; nothing new may be
 * assigned to one (the action refuses it). Members carry their designation and current team, so the
 * form can narrow the list by team.
 */
export async function loadClientFormOptions() {
  const [members, teams] = await Promise.all([
    prisma.internalTeamMember.findMany({
      select: { id: true, name: true, role: true, status: true, teamId: true, team: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.team.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
  ]);
  const roster: RosterMember[] = members.map((m) => ({ id: m.id, name: m.name, designation: m.role || null, teamId: m.teamId, teamName: m.team?.name ?? null, active: m.status === "ACTIVE" }));
  return {
    // The original shape, still used by older callers (bulk assign, filters).
    members: roster.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name })),
    teams: teams.filter((t) => t.status === "ACTIVE").map((t) => ({ id: t.id, name: t.name })),
    roster,
    allTeams: teams.map((t) => ({ id: t.id, name: t.name, active: t.status === "ACTIVE" })),
  };
}

export type ClientFormOptions = Awaited<ReturnType<typeof loadClientFormOptions>>;
