import { CLIENT_STATUSES } from "@support-automation/shared";
import { prisma } from "@/server/db";
import {
  buildClientSearchWhere,
  buildClientWhere,
  clientOrderBy,
  DEFAULT_CLIENT_PAGE_SIZE,
  CLIENT_PAGE_SIZES,
  type ClientFilters,
  type ClientSort,
} from "@/lib/clientFilters";
import { findDuplicateClients, type DuplicateClient } from "@/server/clientRecords";

/**
 * Reads for the Client pages. Everything goes through the project-scoped client, so another
 * project's clients cannot appear here whatever the URL says. No billing figure is read or shown:
 * this module has none to read.
 */

export function resolvePageSize(requested: string | undefined): number {
  const n = Number(requested);
  return (CLIENT_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_CLIENT_PAGE_SIZE;
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
  assignedMemberName: string | null;
  lastContactAt: Date | null;
  createdAt: Date;
  channels: Array<{ kind: string; value: string; isPrimary: boolean }>;
}

export async function listClients(opts: { filters: ClientFilters; sort: ClientSort; dir: "asc" | "desc"; page: number; pageSize: number }) {
  const where = buildClientWhere(opts.filters);
  const [rows, total, statusCounts, categories, members, tagRows] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: clientOrderBy(opts.sort, opts.dir),
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      select: {
        id: true,
        code: true,
        name: true,
        companyName: true,
        status: true,
        category: true,
        tags: true,
        source: true,
        lastContactAt: true,
        createdAt: true,
        assignedMember: { select: { name: true } },
        // The first few channels only: the list shows how a client can be reached, not every reference.
        channels: { select: { kind: true, value: true, isPrimary: true }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 6 },
      },
    }),
    prisma.client.count({ where }),
    // Status chips count within the current search and filters, but across every status.
    prisma.client.groupBy({ by: ["status"], where: buildClientSearchWhere(opts.filters), _count: { _all: true } }),
    prisma.client.findMany({ where: { category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" }, take: 200 }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.client.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { tags: true }, take: 2000 }),
  ]);

  const counts: Record<string, number> = Object.fromEntries(CLIENT_STATUSES.map((s) => [s, 0]));
  for (const row of statusCounts) counts[row.status] = row._count._all;
  const knownTags = [...new Set(tagRows.flatMap((r) => r.tags))].sort();

  const clients: ClientListRow[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    companyName: r.companyName,
    status: r.status,
    category: r.category,
    tags: r.tags,
    source: r.source,
    assignedMemberName: r.assignedMember?.name ?? null,
    lastContactAt: r.lastContactAt,
    createdAt: r.createdAt,
    channels: r.channels,
  }));
  return { clients, total, counts, categories: categories.map((c) => c.category!).filter(Boolean), members, knownTags };
}

export async function getClientDetail(id: string) {
  const client = await prisma.client.findFirst({
    where: { id },
    include: {
      assignedMember: { select: { id: true, name: true } },
      assignedTeam: { select: { id: true, name: true } },
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

/** Staff and teams to choose an assignee from, for the form. */
export async function loadClientFormOptions() {
  const [members, teams] = await Promise.all([
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.team.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { members, teams };
}
