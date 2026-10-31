import { LARGE_LIST_PAGE_SIZES } from "./listPageSizes";
import type { Prisma } from "@prisma/client";
import {
  addCalendarDays,
  CLIENT_CHANNEL_KINDS,
  CLIENT_STATUSES,
  DEFAULT_RENEWAL_WINDOW_DAYS,
  dhakaToday,
  isClientChannelKind,
  isClientStatus,
  isSubscriptionState,
  normalizeCurrencyCode,
  normalizeTag,
  type SubscriptionState,
} from "@support-automation/shared";

/**
 * The client list's filter vocabulary, in one place.
 *
 * The list page, "select all N matching", the export and the bulk actions all resolve a set of
 * clients from the same URL parameters. One builder, imported by all of them, is what makes "export
 * the 312 clients on screen" mean exactly those 312 — a second hand-written `where` would quietly
 * export, archive or delete a different set (same reasoning as `lib/groupFilters.ts`).
 *
 * "use server" files may only export async functions, which is why this is not in the actions file.
 */

export const CLIENT_PAGE_SIZES = LARGE_LIST_PAGE_SIZES;
export const DEFAULT_CLIENT_PAGE_SIZE = 50;
/** Ceiling on one bulk action or one export. Stated before the click, not discovered as a refusal. */
export const MAX_CLIENT_BULK = 5000;

export const CLIENT_SORTS = ["name", "code", "created", "updated", "contact", "country", "expiry"] as const;
export type ClientSort = (typeof CLIENT_SORTS)[number];

export const EXPIRY_WINDOWS = ["7", "30", "90", "expired"] as const;

export interface ClientFilters {
  q: string;
  /** "" = every status except ARCHIVED; "ALL" = including archived; otherwise one status. */
  status: string;
  category: string;
  tag: string;
  /** "" = anyone; "none" = unassigned; otherwise an InternalTeamMember id. */
  assigned: string;
  /** A channel kind the client must have. */
  channel: string;
  source: string;
  /** ISO country code. */
  country: string;
  /** "" = any; "none" = no team; otherwise a Team id (the client's assigned team). */
  team: string;
  /** "" = any; "none" = no seller; otherwise an InternalTeamMember id (who sold the current term, or brought the client in). */
  seller: string;
  /** Current subscription's service, exact (case-insensitive). */
  service: string;
  /** A SubscriptionState. */
  state: string;
  /** "7" / "30" / "90" days from today, or "expired". */
  expiry: string;
  /** "linked" / "unlinked" (an active WhatsApp group link). */
  group: string;
  /** Preferred currency. */
  currency: string;
  /** "1" = returning customers only. */
  repeat: string;
  /** "open" / "overdue" — honoured only for a viewer allowed to see billing. */
  due: string;
}

export const EMPTY_CLIENT_FILTERS: ClientFilters = {
  q: "",
  status: "",
  category: "",
  tag: "",
  assigned: "",
  channel: "",
  source: "",
  country: "",
  team: "",
  seller: "",
  service: "",
  state: "",
  expiry: "",
  group: "",
  currency: "",
  repeat: "",
  due: "",
};

/** What the filters are evaluated against. Billing filters are dropped unless `billing` is true. */
export interface ClientFilterContext {
  /** Dhaka `YYYY-MM-DD`. */
  today: string;
  renewalWindowDays: number;
  billing: boolean;
}

export function defaultFilterContext(): ClientFilterContext {
  return { today: dhakaToday(new Date()), renewalWindowDays: DEFAULT_RENEWAL_WINDOW_DAYS, billing: false };
}

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
const idLike = (v: string) => (/^[A-Za-z0-9_-]{1,60}$/.test(v) ? v : "");

export function parseClientFilters(params: Params): ClientFilters {
  const status = one(params.status).toUpperCase();
  const channel = one(params.channel).toUpperCase();
  const state = one(params.state).toUpperCase();
  const expiry = one(params.expiry);
  const group = one(params.group);
  const due = one(params.due);
  const country = one(params.country).toUpperCase();
  return {
    q: one(params.q).slice(0, 120),
    status: status === "ALL" || isClientStatus(status) ? status : "",
    category: one(params.category).slice(0, 80),
    tag: normalizeTag(one(params.tag)) ?? "",
    assigned: one(params.assigned).slice(0, 60),
    channel: isClientChannelKind(channel) ? channel : "",
    source: one(params.source).toUpperCase().slice(0, 20),
    country: /^[A-Z]{2}$/.test(country) ? country : "",
    team: idLike(one(params.team)),
    seller: idLike(one(params.seller)),
    service: one(params.service).slice(0, 120),
    state: isSubscriptionState(state) ? state : "",
    expiry: (EXPIRY_WINDOWS as readonly string[]).includes(expiry) ? expiry : "",
    group: group === "linked" || group === "unlinked" ? group : "",
    currency: normalizeCurrencyCode(one(params.currency)) ?? "",
    repeat: one(params.repeat) === "1" ? "1" : "",
    due: due === "open" || due === "overdue" ? due : "",
  };
}

export function parseClientSort(params: Params): { sort: ClientSort; dir: "asc" | "desc" } {
  const sort = one(params.sort);
  const dir = one(params.dir) === "desc" ? "desc" : "asc";
  return { sort: (CLIENT_SORTS as readonly string[]).includes(sort) ? (sort as ClientSort) : "name", dir };
}

export function clientOrderBy(sort: ClientSort, dir: "asc" | "desc"): Prisma.ClientOrderByWithRelationInput[] {
  // `id` last so two clients with the same value never swap places between pages.
  if (sort === "expiry") return [{ currentSubscription: { endDate: dir } }, { name: "asc" }, { id: "asc" }];
  if (sort === "country") return [{ country: { sort: dir, nulls: "last" } }, { name: "asc" }, { id: "asc" }];
  const key =
    sort === "code" ? "code" : sort === "created" ? "createdAt" : sort === "updated" ? "updatedAt" : sort === "contact" ? "lastContactAt" : "name";
  return [{ [key]: key === "lastContactAt" ? { sort: dir, nulls: "last" } : dir } as Prisma.ClientOrderByWithRelationInput, { id: "asc" }];
}

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

/**
 * The client-level subscription state as a database condition on the CURRENT term — the same rule as
 * `termState` in packages/shared (a future-dated renewal is ACTIVE; a future first term is SCHEDULED).
 * `clientSubscriptionStates.integration.test.ts` runs both over the same rows and requires agreement.
 */
export function subscriptionStateWhere(state: SubscriptionState, ctx: ClientFilterContext): Prisma.ClientWhereInput {
  const today = day(ctx.today);
  const windowEnd = day(addCalendarDays(ctx.today, ctx.renewalWindowDays));
  const running = { pausedAt: null, endDate: { gt: today } } as const;
  switch (state) {
    case "NONE":
      return { subscriptions: { none: {} } };
    case "CANCELLED":
      return { currentSubscriptionId: null, subscriptions: { some: {} } };
    case "PAUSED":
      return { currentSubscription: { pausedAt: { not: null } } };
    case "EXPIRED":
      return { currentSubscription: { pausedAt: null, endDate: { lte: today } } };
    case "SCHEDULED":
      return { currentSubscription: { ...running, startDate: { gt: today }, isRenewal: false } };
    case "TRIAL":
      return { currentSubscription: { ...running, startDate: { lte: today }, kind: { in: ["TRIAL", "DEMO"] } } };
    case "EXPIRING":
      return { currentSubscription: { pausedAt: null, endDate: { gt: today, lte: windowEnd }, startDate: { lte: today }, kind: { in: ["PAID", "COMPLIMENTARY"] } } };
    case "ACTIVE":
      return {
        OR: [
          { currentSubscription: { pausedAt: null, endDate: { gt: windowEnd }, startDate: { lte: today }, kind: { in: ["PAID", "COMPLIMENTARY"] } } },
          { currentSubscription: { ...running, startDate: { gt: today }, isRenewal: true } },
        ],
      };
  }
}

/** Open dues with an amount (what "has a financial due" means) — the same set `summarizeOutstanding` counts. */
const OPEN_DUE = { status: { in: ["UNPAID", "PARTIALLY_PAID"] as Array<"UNPAID" | "PARTIALLY_PAID"> }, amount: { not: null } } satisfies Prisma.ClientDueWhereInput;

/** Search and every filter. The status chips' own counts are computed against `buildClientSearchWhere`. */
export function buildClientSearchWhere(filters: ClientFilters, ctx: ClientFilterContext = defaultFilterContext()): Prisma.ClientWhereInput {
  const and: Prisma.ClientWhereInput[] = [];
  const q = filters.q.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        // A former code (CL-000041 before a conversion) or the code a file gave the client still finds it.
        { codeAliases: { some: { canonical: { contains: q.toUpperCase() } } } },
        { companyName: { contains: q, mode: "insensitive" } },
        { channels: { some: { value: { contains: q, mode: "insensitive" } } } },
        { currentSubscription: { service: { contains: q, mode: "insensitive" } } },
        { soldByMember: { name: { contains: q, mode: "insensitive" } } },
        { currentSubscription: { soldByName: { contains: q, mode: "insensitive" } } },
        // A phone typed with or without its separators finds the same client.
        ...(digits.length >= 5 ? [{ channels: { some: { normalizedValue: { contains: digits } } } }] : []),
      ],
    });
  }
  if (filters.category) and.push({ category: { equals: filters.category, mode: "insensitive" } });
  if (filters.tag) and.push({ tags: { has: filters.tag } });
  if (filters.assigned === "none") and.push({ assignedMemberId: null });
  else if (filters.assigned) and.push({ assignedMemberId: filters.assigned });
  if (filters.channel && (CLIENT_CHANNEL_KINDS as readonly string[]).includes(filters.channel)) {
    and.push({ channels: { some: { kind: filters.channel as (typeof CLIENT_CHANNEL_KINDS)[number] } } });
  }
  if (filters.source) and.push({ source: filters.source as never });
  if (filters.country) and.push({ country: filters.country });
  if (filters.team === "none") and.push({ assignedTeamId: null });
  else if (filters.team) and.push({ assignedTeamId: filters.team });
  if (filters.seller === "none") and.push({ soldByMemberId: null, OR: [{ currentSubscriptionId: null }, { currentSubscription: { soldByMemberId: null } }] });
  else if (filters.seller) and.push({ OR: [{ currentSubscription: { soldByMemberId: filters.seller } }, { currentSubscription: { soldByMemberId: null }, soldByMemberId: filters.seller }, { currentSubscriptionId: null, soldByMemberId: filters.seller }] });
  if (filters.service) and.push({ currentSubscription: { service: { equals: filters.service, mode: "insensitive" } } });
  if (filters.state && isSubscriptionState(filters.state)) and.push(subscriptionStateWhere(filters.state, ctx));
  if (filters.expiry === "expired") and.push(subscriptionStateWhere("EXPIRED", ctx));
  else if (filters.expiry) {
    and.push({ currentSubscription: { pausedAt: null, endDate: { gt: day(ctx.today), lte: day(addCalendarDays(ctx.today, Number(filters.expiry))) } } });
  }
  if (filters.group === "linked") and.push({ groupLinks: { some: { unlinkedAt: null } } });
  else if (filters.group === "unlinked") and.push({ groupLinks: { none: { unlinkedAt: null } } });
  if (filters.currency) and.push({ preferredCurrency: filters.currency });
  if (filters.repeat) and.push({ subscriptions: { some: { isRenewal: true } } });
  // A billing filter from someone who may not see billing is ignored, never answered: the size of the
  // filtered list would otherwise reveal who owes money.
  if (ctx.billing && filters.due === "open") and.push({ dues: { some: OPEN_DUE } });
  else if (ctx.billing && filters.due === "overdue") and.push({ dues: { some: { ...OPEN_DUE, dueDate: { lt: day(ctx.today) } } } });
  return and.length ? { AND: and } : {};
}

export function buildClientWhere(filters: ClientFilters, ctx: ClientFilterContext = defaultFilterContext()): Prisma.ClientWhereInput {
  const search = buildClientSearchWhere(filters, ctx);
  let statusWhere: Prisma.ClientWhereInput;
  if (filters.status === "ALL") statusWhere = {};
  else if (filters.status && (CLIENT_STATUSES as readonly string[]).includes(filters.status)) statusWhere = { status: filters.status as (typeof CLIENT_STATUSES)[number] };
  else statusWhere = { status: { not: "ARCHIVED" } };
  return { AND: [search, statusWhere] };
}

/** The query string for a filter set, for links that keep it (pagination, export, "clear"). */
export function clientQueryString(filters: ClientFilters, extra: Record<string, string | number | undefined> = {}): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== "" && value !== undefined) out.set(key, String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : "";
}
