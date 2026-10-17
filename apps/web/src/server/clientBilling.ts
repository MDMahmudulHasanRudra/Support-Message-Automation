import { Prisma } from "@prisma/client";
import { decimalToMinor, dhakaToday, fromMinor, invoiceState, payableRefusal, remainingOn, summarizeDues, type BillingSummary, type InvoiceState } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Billing READS (CLIENT_CENTER_PLAN.md §2). Not a "use server" file: nothing here is an endpoint, and
 * every caller has already checked `clients.view_billing`. All queries go through the project-scoped
 * client, so another project's dues are neither listed nor counted.
 */

export interface DueView {
  id: string;
  invoiceNumber: string | null;
  clientId: string;
  /** `YYYY-MM-DD`, a Dhaka calendar day. */
  dueDate: string;
  amount: string | null;
  currency: string | null;
  status: string;
  paidAmount: string | null;
  note: string | null;
  overdue: boolean;
  updatedAt: string;
}

export interface DueEventView {
  id: string;
  dueId: string;
  type: string;
  changes: Record<string, { from: string | null; to: string | null }>;
  actor: string | null;
  at: Date;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const money = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(2));

export const DUES_PAGE_SIZE = 200;

const FIELD_LABELS: Record<string, string> = { dueDate: "due date", amount: "amount", currency: "currency", status: "status", paidAmount: "paid amount", note: "note" };

/** One line for the change history. Says which fields moved; shows a value only for the status. */
export function describeDueEvent(type: string, changes: DueEventView["changes"], dueDate: string | null): string {
  const on = dueDate ? ` (due ${dueDate})` : "";
  if (type === "CREATED") return `Due added${on}`;
  const status = changes.status;
  if (status) return `Status ${status.from ?? "—"} → ${status.to ?? "—"}${on}`;
  const fields = Object.keys(changes).map((k) => FIELD_LABELS[k] ?? k);
  return `Changed ${fields.join(", ") || "nothing"}${on}`;
}

export function toDueView(row: { id: string; invoiceNumber?: string | null; clientId: string; dueDate: Date; amount: Prisma.Decimal | null; currency: string | null; status: string; paidAmount: Prisma.Decimal | null; note: string | null; updatedAt: Date }, today: string): DueView {
  const dueDate = day(row.dueDate);
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber ?? null,
    clientId: row.clientId,
    dueDate,
    amount: money(row.amount),
    currency: row.currency,
    status: row.status,
    paidAmount: money(row.paidAmount),
    note: row.note,
    overdue: (row.status === "UNPAID" || row.status === "PARTIALLY_PAID") && dueDate < today,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The currencies this project has enabled, in code order. Empty until somebody adds one. */
export async function listBillingCurrencies() {
  return prisma.clientBillingCurrency.findMany({ orderBy: { code: "asc" } });
}

/** One client's dues (newest first), the history of changes, the enabled currencies and the derived summary. */
export async function getClientBilling(clientId: string) {
  const today = dhakaToday(new Date());
  const [rows, currencies, events] = await Promise.all([
    prisma.clientDue.findMany({ where: { clientId }, orderBy: [{ dueDate: "desc" }, { createdAt: "desc" }], take: 200 }),
    listBillingCurrencies(),
    prisma.clientDueEvent.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 100, include: { actor: { select: { name: true } } } }),
  ]);
  const dues = rows.map((r) => toDueView(r, today));
  const history: DueEventView[] = events.map((e) => ({
    id: e.id,
    dueId: e.dueId,
    type: e.type,
    changes: (e.changes ?? {}) as DueEventView["changes"],
    actor: e.actor?.name ?? null,
    at: e.createdAt,
  }));
  const summary: BillingSummary = summarizeDues(dues, today);
  return { dues, history, currencies, summary, today };
}

export interface DueFilters {
  /** "open" (default: unpaid and partially paid), "overdue", "all", or one status. */
  view: string;
  q: string;
}

export function parseDueFilters(params: Record<string, string | string[] | undefined>): DueFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const view = one(params.view);
  return { view: ["open", "overdue", "all", "UNPAID", "PARTIALLY_PAID", "PAID", "WAIVED", "CANCELLED"].includes(view) ? view : "open", q: one(params.q).trim().slice(0, 100) };
}

/** Every due in the project, for the Dues page. Ordered by due date, earliest first. */
export async function listDues(filters: DueFilters) {
  const today = dhakaToday(new Date());
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const where: Prisma.ClientDueWhereInput = {};
  if (filters.view === "open") where.status = { in: ["UNPAID", "PARTIALLY_PAID"] };
  else if (filters.view === "overdue") {
    where.status = { in: ["UNPAID", "PARTIALLY_PAID"] };
    where.dueDate = { lt: todayDate };
  } else if (filters.view !== "all") where.status = filters.view as Prisma.ClientDueWhereInput["status"];
  if (filters.q) where.client = { OR: [{ name: { contains: filters.q, mode: "insensitive" } }, { code: { contains: filters.q, mode: "insensitive" } }] };

  const [rows, total] = await Promise.all([
    prisma.clientDue.findMany({ where, orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }], take: DUES_PAGE_SIZE, include: { client: { select: { id: true, code: true, name: true, status: true } } } }),
    prisma.clientDue.count({ where }),
  ]);
  return { dues: rows.map((r) => ({ ...toDueView(r, today), client: r.client })), total, today };
}

// ── The Billing List (CLIENTS_V3.md §4) ─────────────────────────────────────────────────────────

export const BILLING_PAGE_SIZES = [25, 50, 100, 200] as const;
export const BILLING_VIEWS = ["open", "overdue", "partial", "paid", "waived", "cancelled", "all"] as const;
export const BILLING_SORTS = ["due", "issued", "invoice", "client", "amount"] as const;

export interface BillingFilters {
  view: (typeof BILLING_VIEWS)[number];
  q: string;
  seller: string;
  team: string;
  service: string;
  currency: string;
  country: string;
  kind: string;
  from: string;
  to: string;
  sort: (typeof BILLING_SORTS)[number];
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

export function parseBillingFilters(params: Record<string, string | string[] | undefined>): BillingFilters {
  const one = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? "").trim();
  const pick = <T extends string>(v: string, list: readonly T[], fallback: T): T => ((list as readonly string[]).includes(v) ? (v as T) : fallback);
  const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  const id = (v: string) => (/^[A-Za-z0-9_-]{1,60}$/.test(v) ? v : "");
  const size = Number(one(params.pageSize));
  const currency = one(params.currency).toUpperCase();
  const country = one(params.country).toUpperCase();
  return {
    view: pick(one(params.view), BILLING_VIEWS, "open"),
    q: one(params.q).slice(0, 100),
    seller: id(one(params.seller)),
    team: id(one(params.team)),
    service: one(params.service).slice(0, 120),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "",
    country: /^[A-Z]{2}$/.test(country) ? country : "",
    kind: id(one(params.kind)).toUpperCase(),
    from: date(one(params.from)),
    to: date(one(params.to)),
    sort: pick(one(params.sort), BILLING_SORTS, "due"),
    dir: one(params.dir) === "desc" ? "desc" : "asc",
    page: Math.max(1, Math.floor(Number(one(params.page)) || 1)),
    pageSize: (BILLING_PAGE_SIZES as readonly number[]).includes(size) ? size : 50,
  };
}

const OPEN_STATUSES = { in: ["UNPAID", "PARTIALLY_PAID"] as Array<"UNPAID" | "PARTIALLY_PAID"> };

/** One `where` for the page and its counts, so the list and its totals always agree. */
export function billingWhere(f: BillingFilters, today: string): Prisma.ClientDueWhereInput {
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const and: Prisma.ClientDueWhereInput[] = [];
  if (f.view === "open") and.push({ status: OPEN_STATUSES });
  else if (f.view === "overdue") and.push({ status: OPEN_STATUSES, dueDate: { lt: todayDate } });
  else if (f.view === "partial") and.push({ status: "PARTIALLY_PAID" });
  else if (f.view === "paid") and.push({ status: "PAID" });
  else if (f.view === "waived") and.push({ status: "WAIVED" });
  else if (f.view === "cancelled") and.push({ status: "CANCELLED" });
  if (f.q) {
    const digits = f.q.replace(/\D/g, "");
    and.push({
      OR: [
        { invoiceNumber: { contains: f.q, mode: "insensitive" } },
        { service: { contains: f.q, mode: "insensitive" } },
        { note: { contains: f.q, mode: "insensitive" } },
        { client: { name: { contains: f.q, mode: "insensitive" } } },
        { client: { code: { contains: f.q, mode: "insensitive" } } },
        { client: { companyName: { contains: f.q, mode: "insensitive" } } },
        { soldByMember: { name: { contains: f.q, mode: "insensitive" } } },
        { allocations: { some: { payment: { reference: { contains: f.q, mode: "insensitive" } } } } },
        ...(digits.length >= 5 ? [{ client: { channels: { some: { normalizedValue: { contains: digits } } } } }] : []),
      ],
    });
  }
  if (f.seller) and.push({ soldByMemberId: f.seller });
  if (f.team) and.push({ soldByMember: { teamId: f.team } });
  if (f.service) and.push({ OR: [{ service: { equals: f.service, mode: "insensitive" } }, { service: null, subscription: { service: { equals: f.service, mode: "insensitive" } } }] });
  if (f.currency) and.push({ currency: f.currency });
  if (f.country) and.push({ client: { country: f.country } });
  if (f.kind) and.push({ kind: f.kind as never });
  if (f.from) and.push({ dueDate: { gte: new Date(`${f.from}T00:00:00.000Z`) } });
  if (f.to) and.push({ dueDate: { lte: new Date(`${f.to}T00:00:00.000Z`) } });
  return and.length ? { AND: and } : {};
}

function billingOrderBy(f: BillingFilters): Prisma.ClientDueOrderByWithRelationInput[] {
  const dir = f.dir;
  const first: Prisma.ClientDueOrderByWithRelationInput =
    f.sort === "issued"
      ? { issuedDate: { sort: dir, nulls: "last" } }
      : f.sort === "invoice"
        ? { invoiceNumber: { sort: dir, nulls: "last" } }
        : f.sort === "client"
          ? { client: { name: dir } }
          : f.sort === "amount"
            ? { amount: { sort: dir, nulls: "last" } }
            : { dueDate: dir };
  return [first, { createdAt: "asc" }, { id: "asc" }];
}

export interface BillingRow {
  id: string;
  invoiceNumber: string | null;
  kind: string | null;
  issuedDate: string;
  service: string | null;
  client: { id: string; code: string; name: string; companyName: string | null; country: string | null; phone: string | null; email: string | null; photoVersion: number | null; archived: boolean };
  soldBy: string | null;
  team: string | null;
  dueDate: string;
  currency: string | null;
  /** Two-decimal strings; null when the due has no amount. */
  amount: string | null;
  collected: string;
  remaining: string | null;
  status: string;
  state: InvoiceState;
  payable: boolean;
  note: string | null;
  createdBy: string | null;
  lastPaymentDate: string | null;
  subscriptionEnd: string | null;
}

export async function listBillingRegister(f: BillingFilters) {
  const today = dhakaToday(new Date());
  const where = billingWhere(f, today);
  const [rows, total] = await Promise.all([
    prisma.clientDue.findMany({
      where,
      orderBy: billingOrderBy(f),
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
      select: {
        id: true,
        invoiceNumber: true,
        kind: true,
        issuedDate: true,
        createdAt: true,
        service: true,
        dueDate: true,
        currency: true,
        amount: true,
        paidAmount: true,
        status: true,
        note: true,
        createdBy: { select: { name: true } },
        soldByMember: { select: { name: true, team: { select: { name: true } } } },
        subscription: { select: { service: true, endDate: true, soldByName: true, soldByTeamName: true } },
        client: {
          select: {
            id: true,
            code: true,
            name: true,
            companyName: true,
            country: true,
            status: true,
            photoUpdatedAt: true,
            channels: { where: { kind: { in: ["PHONE", "WHATSAPP", "EMAIL"] } }, select: { kind: true, value: true }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 4 },
          },
        },
        allocations: { where: { payment: { reversedAt: null } }, select: { payment: { select: { receivedDate: true } } }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    prisma.clientDue.count({ where }),
  ]);
  const zero = BigInt(0);
  const out: BillingRow[] = rows.map((r) => {
    const amount = decimalToMinor(r.amount);
    const paid = decimalToMinor(r.paidAmount) ?? zero;
    const remaining = amount === null ? null : remainingOn({ status: r.status, amount, paid });
    const dueDate = day(r.dueDate);
    return {
      id: r.id,
      invoiceNumber: r.invoiceNumber,
      kind: r.kind,
      issuedDate: day(r.issuedDate ?? r.createdAt),
      service: r.service ?? r.subscription?.service ?? null,
      client: {
        id: r.client.id,
        code: r.client.code,
        name: r.client.name,
        companyName: r.client.companyName,
        country: r.client.country,
        phone: r.client.channels.find((c) => c.kind === "PHONE" || c.kind === "WHATSAPP")?.value ?? null,
        email: r.client.channels.find((c) => c.kind === "EMAIL")?.value ?? null,
        photoVersion: r.client.photoUpdatedAt?.getTime() ?? null,
        archived: r.client.status === "ARCHIVED",
      },
      soldBy: r.soldByMember?.name ?? r.subscription?.soldByName ?? null,
      team: r.soldByMember?.team?.name ?? r.subscription?.soldByTeamName ?? null,
      dueDate,
      currency: r.currency,
      amount: amount === null ? null : fromMinor(amount),
      collected: fromMinor(amount !== null && paid > amount ? amount : paid),
      remaining: remaining === null ? null : fromMinor(remaining),
      status: r.status,
      state: invoiceState({ status: r.status, amount, paid, dueDate }, today),
      payable: payableRefusal({ status: r.status, amount, currency: r.currency, paid }) === null && r.client.status !== "ARCHIVED",
      note: r.note,
      createdBy: r.createdBy?.name ?? null,
      lastPaymentDate: r.allocations[0] ? day(r.allocations[0].payment.receivedDate) : null,
      subscriptionEnd: r.subscription ? day(r.subscription.endDate) : null,
    };
  });
  return { rows: out, total, today };
}

/** The tiles above the Billing List: counts, plus what is outstanding per currency (never summed across currencies). */
export async function getBillingKpis() {
  const today = dhakaToday(new Date());
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const [invoices, openCount, overdueCount, paidCount, openRows] = await Promise.all([
    prisma.clientDue.count({ where: { status: { not: "CANCELLED" } } }),
    prisma.clientDue.count({ where: { status: OPEN_STATUSES } }),
    prisma.clientDue.count({ where: { status: OPEN_STATUSES, dueDate: { lt: todayDate } } }),
    prisma.clientDue.count({ where: { status: "PAID" } }),
    prisma.clientDue.groupBy({ by: ["currency"], where: { status: OPEN_STATUSES, amount: { not: null }, currency: { not: null } }, _sum: { amount: true, paidAmount: true } }),
  ]);
  const zero = BigInt(0);
  const outstanding = openRows
    .map((r) => {
      const left = (decimalToMinor(r._sum.amount) ?? zero) - (decimalToMinor(r._sum.paidAmount) ?? zero);
      return { currency: r.currency!, remaining: fromMinor(left > zero ? left : zero) };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { invoices, openCount, overdueCount, paidCount, outstanding };
}

/** Distinct values for the Billing List filters. */
export async function getBillingFilterOptions() {
  const [sellers, teams, services, currencies] = await Promise.all([
    prisma.internalTeamMember.findMany({ where: { soldDues: { some: {} } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.clientDue.findMany({ where: { service: { not: null } }, distinct: ["service"], select: { service: true }, orderBy: { service: "asc" }, take: 200 }),
    prisma.clientDue.findMany({ where: { currency: { not: null } }, distinct: ["currency"], select: { currency: true }, orderBy: { currency: "asc" } }),
  ]);
  return { sellers, teams, services: services.map((s) => s.service!), currencies: currencies.map((c) => c.currency!) };
}

// ── Payments & Receipts ─────────────────────────────────────────────────────────────────────────

export interface PaymentRow {
  id: string;
  receiptNumber: string;
  client: { id: string; code: string; name: string };
  currency: string;
  amount: string;
  method: string;
  reference: string | null;
  receivedDate: string;
  batchReference: string | null;
  note: string | null;
  recordedBy: string | null;
  recordedAt: Date;
  reversed: { at: Date; by: string | null; reason: string | null } | null;
  invoices: Array<{ dueId: string; invoiceNumber: string | null; amount: string }>;
}

export async function listPayments(opts: { q: string; show: "all" | "active" | "reversed"; page: number; pageSize: number }) {
  const where: Prisma.ClientPaymentWhereInput = {
    ...(opts.show === "active" ? { reversedAt: null } : opts.show === "reversed" ? { reversedAt: { not: null } } : {}),
    ...(opts.q
      ? {
          OR: [
            { receiptNumber: { contains: opts.q, mode: "insensitive" } },
            { reference: { contains: opts.q, mode: "insensitive" } },
            { batchReference: { contains: opts.q, mode: "insensitive" } },
            { client: { name: { contains: opts.q, mode: "insensitive" } } },
            { client: { code: { contains: opts.q, mode: "insensitive" } } },
            { allocations: { some: { due: { invoiceNumber: { contains: opts.q, mode: "insensitive" } } } } },
          ],
        }
      : {}),
  };
  const [rows, total, totals] = await Promise.all([
    prisma.clientPayment.findMany({
      where,
      orderBy: [{ receivedDate: "desc" }, { recordedAt: "desc" }],
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        client: { select: { id: true, code: true, name: true } },
        recordedBy: { select: { name: true } },
        reversedBy: { select: { name: true } },
        allocations: { select: { dueId: true, amount: true, due: { select: { invoiceNumber: true } } } },
      },
    }),
    prisma.clientPayment.count({ where }),
    // Collected per currency for the same filter, reversed payments excluded.
    prisma.clientPayment.groupBy({ by: ["currency"], where: { AND: [where, { reversedAt: null }] }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const payments: PaymentRow[] = rows.map((p) => ({
    id: p.id,
    receiptNumber: p.receiptNumber,
    client: p.client,
    currency: p.currency,
    amount: p.amount.toFixed(2),
    method: p.method,
    reference: p.reference,
    receivedDate: day(p.receivedDate),
    batchReference: p.batchReference,
    note: p.note,
    recordedBy: p.recordedBy?.name ?? null,
    recordedAt: p.recordedAt,
    reversed: p.reversedAt ? { at: p.reversedAt, by: p.reversedBy?.name ?? null, reason: p.reversalReason } : null,
    invoices: p.allocations.map((a) => ({ dueId: a.dueId, invoiceNumber: a.due.invoiceNumber, amount: a.amount.toFixed(2) })),
  }));
  return {
    payments,
    total,
    collected: totals.map((t) => ({ currency: t.currency, amount: (t._sum.amount ?? new Prisma.Decimal(0)).toFixed(2), count: t._count._all })).sort((a, b) => a.currency.localeCompare(b.currency)),
  };
}
