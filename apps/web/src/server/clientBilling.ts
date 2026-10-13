import { Prisma } from "@prisma/client";
import { dhakaToday, summarizeDues, type BillingSummary } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Billing READS (CLIENT_CENTER_PLAN.md §2). Not a "use server" file: nothing here is an endpoint, and
 * every caller has already checked `clients.view_billing`. All queries go through the project-scoped
 * client, so another project's dues are neither listed nor counted.
 */

export interface DueView {
  id: string;
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

export function toDueView(row: { id: string; clientId: string; dueDate: Date; amount: Prisma.Decimal | null; currency: string | null; status: string; paidAmount: Prisma.Decimal | null; note: string | null; updatedAt: Date }, today: string): DueView {
  const dueDate = day(row.dueDate);
  return {
    id: row.id,
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
