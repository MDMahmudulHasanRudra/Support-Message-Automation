import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { EmptyState, PageHeader } from "@/components/ui";
import { GroupsTable, type GroupRow } from "./GroupsTable";

const PAGE_SIZE = 50;
type FilterKey = "all" | "monitored" | "unmonitored" | "active" | "inactive";

interface GroupsSearchParams {
  search?: string;
  filter?: string;
  page?: string;
}

export default async function GroupsPage({ searchParams }: { searchParams: Promise<GroupsSearchParams> }) {
  await requireSession();
  const params = await searchParams;
  const filter: FilterKey = isFilterKey(params.filter) ? params.filter : "all";
  const search = (params.search ?? "").trim();
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const searchOnlyWhere: Prisma.WhatsAppGroupWhereInput = search ? { name: { contains: search, mode: "insensitive" } } : {};
  const where: Prisma.WhatsAppGroupWhereInput = { ...searchOnlyWhere };
  if (filter === "monitored") where.isMonitored = true;
  if (filter === "unmonitored") where.isMonitored = false;
  if (filter === "active") where.isActive = true;
  if (filter === "inactive") where.isActive = false;

  const [groups, totalCount, allCount, monitoredCount, unmonitoredCount, activeCount, inactiveCount] = await Promise.all([
    prisma.whatsAppGroup.findMany({
      where,
      include: { account: { select: { label: true } } },
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.whatsAppGroup.count({ where }),
    prisma.whatsAppGroup.count({ where: searchOnlyWhere }),
    prisma.whatsAppGroup.count({ where: { ...searchOnlyWhere, isMonitored: true } }),
    prisma.whatsAppGroup.count({ where: { ...searchOnlyWhere, isMonitored: false } }),
    prisma.whatsAppGroup.count({ where: { ...searchOnlyWhere, isActive: true } }),
    prisma.whatsAppGroup.count({ where: { ...searchOnlyWhere, isActive: false } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const rows: GroupRow[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    accountLabel: g.account.label,
    isMonitored: g.isMonitored,
    isActive: g.isActive,
    participantCount: g.participantCount,
    lastSyncedAt: g.lastSyncedAt?.toISOString() ?? null,
  }));

  return (
    <div>
      <PageHeader
        title="WhatsApp Groups"
        description="Only monitored groups are eligible for auto-reply. Use Accounts → Resync Groups to discover new ones."
      />

      <form className="mb-3 flex flex-wrap gap-2 text-sm" method="GET">
        <input name="search" placeholder="Search group name…" defaultValue={search} className={inputClass} />
        <input type="hidden" name="filter" value={filter} />
        <button type="submit" className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900">
          Search
        </button>
      </form>

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <FilterChip href={buildHref(search, "all")} active={filter === "all"} label={`All (${allCount})`} />
        <FilterChip href={buildHref(search, "monitored")} active={filter === "monitored"} label={`Monitored (${monitoredCount})`} />
        <FilterChip href={buildHref(search, "unmonitored")} active={filter === "unmonitored"} label={`Not Monitored (${unmonitoredCount})`} />
        <FilterChip href={buildHref(search, "active")} active={filter === "active"} label={`Active (${activeCount})`} />
        <FilterChip href={buildHref(search, "inactive")} active={filter === "inactive"} label={`Inactive (${inactiveCount})`} />
      </div>

      {groups.length === 0 ? (
        <EmptyState>No groups match the current search/filter.</EmptyState>
      ) : (
        <>
          <GroupsTable groups={rows} />
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              Page {page} of {totalPages} ({totalCount} total)
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link href={buildHref(search, filter, page - 1)} className="rounded-md border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">
                  Previous
                </Link>
              ) : null}
              {page < totalPages ? (
                <Link href={buildHref(search, filter, page + 1)} className="rounded-md border border-zinc-300 px-3 py-1.5 dark:border-zinc-700">
                  Next
                </Link>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function isFilterKey(value: string | undefined): value is FilterKey {
  return value === "all" || value === "monitored" || value === "unmonitored" || value === "active" || value === "inactive";
}

function buildHref(search: string, filter: FilterKey, page = 1): string {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  qs.set("filter", filter);
  if (page > 1) qs.set("page", String(page));
  return `/groups?${qs.toString()}`;
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 ${
        active
          ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
      }`}
    >
      {label}
    </Link>
  );
}

const inputClass = "rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
