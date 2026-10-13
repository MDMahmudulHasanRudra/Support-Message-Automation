import type { Prisma } from "@prisma/client";
import { CLIENT_CHANNEL_KINDS, CLIENT_STATUSES, isClientChannelKind, isClientStatus, normalizeTag } from "@support-automation/shared";

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

export const CLIENT_PAGE_SIZES = [25, 50, 100, 250] as const;
export const DEFAULT_CLIENT_PAGE_SIZE = 50;
/** Ceiling on one bulk action or one export. Stated before the click, not discovered as a refusal. */
export const MAX_CLIENT_BULK = 5000;

export const CLIENT_SORTS = ["name", "code", "created", "updated", "contact"] as const;
export type ClientSort = (typeof CLIENT_SORTS)[number];

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
}

export const EMPTY_CLIENT_FILTERS: ClientFilters = { q: "", status: "", category: "", tag: "", assigned: "", channel: "", source: "" };

type Params = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();

export function parseClientFilters(params: Params): ClientFilters {
  const status = one(params.status).toUpperCase();
  const channel = one(params.channel).toUpperCase();
  return {
    q: one(params.q).slice(0, 120),
    status: status === "ALL" || isClientStatus(status) ? status : "",
    category: one(params.category).slice(0, 80),
    tag: normalizeTag(one(params.tag)) ?? "",
    assigned: one(params.assigned).slice(0, 60),
    channel: isClientChannelKind(channel) ? channel : "",
    source: one(params.source).toUpperCase().slice(0, 20),
  };
}

export function parseClientSort(params: Params): { sort: ClientSort; dir: "asc" | "desc" } {
  const sort = one(params.sort);
  const dir = one(params.dir) === "desc" ? "desc" : "asc";
  return { sort: (CLIENT_SORTS as readonly string[]).includes(sort) ? (sort as ClientSort) : "name", dir };
}

export function clientOrderBy(sort: ClientSort, dir: "asc" | "desc"): Prisma.ClientOrderByWithRelationInput[] {
  const key =
    sort === "code" ? "code" : sort === "created" ? "createdAt" : sort === "updated" ? "updatedAt" : sort === "contact" ? "lastContactAt" : "name";
  // `id` last so two clients with the same name never swap places between pages.
  return [{ [key]: key === "lastContactAt" ? { sort: dir, nulls: "last" } : dir } as Prisma.ClientOrderByWithRelationInput, { id: "asc" }];
}

/** Search and every filter. The status chips' own counts are computed against `buildClientSearchWhere`. */
export function buildClientSearchWhere(filters: ClientFilters): Prisma.ClientWhereInput {
  const and: Prisma.ClientWhereInput[] = [];
  const q = filters.q.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    and.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { code: { contains: q, mode: "insensitive" } },
        { companyName: { contains: q, mode: "insensitive" } },
        { channels: { some: { value: { contains: q, mode: "insensitive" } } } },
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
  return and.length ? { AND: and } : {};
}

export function buildClientWhere(filters: ClientFilters): Prisma.ClientWhereInput {
  const search = buildClientSearchWhere(filters);
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
