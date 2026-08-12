import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { Button, EmptyState, FilterBar, Input, PageHeader, Pagination } from "@/components/ui";
import { GroupsTable, type GroupRow } from "./GroupsTable";
import { SyncGroupsButton } from "./SyncGroupsButton";

const PAGE_SIZE_OPTIONS = [10, 50, 100, 500, 1000] as const;
const DEFAULT_PAGE_SIZE = 50;
type FilterKey = "all" | "monitored" | "unmonitored" | "active" | "inactive";

interface GroupsSearchParams {
  search?: string;
  filter?: string;
  page?: string;
  pageSize?: string;
}

export default async function GroupsPage({ searchParams }: { searchParams: Promise<GroupsSearchParams> }) {
  await requireSession();
  const params = await searchParams;
  const filter: FilterKey = isFilterKey(params.filter) ? params.filter : "all";
  const search = (params.search ?? "").trim();
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requestedPageSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const PAGE_SIZE = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const searchOnlyWhere: Prisma.WhatsAppGroupWhereInput = search
    ? { name: { contains: search, mode: "insensitive" } }
    : {};
  const where: Prisma.WhatsAppGroupWhereInput = { ...searchOnlyWhere };
  if (filter === "monitored") where.isMonitored = true;
  if (filter === "unmonitored") where.isMonitored = false;
  if (filter === "active") where.isActive = true;
  if (filter === "inactive") where.isActive = false;

  const [groups, totalCount, allCount, monitoredCount, unmonitoredCount, activeCount, inactiveCount, teamMembers] =
    await Promise.all([
      prisma.whatsAppGroup.findMany({
        where,
        include: { account: { select: { label: true } }, assignedTeamMember: { select: { name: true } } },
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
      prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);

  const rows: GroupRow[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    whatsappGroupId: g.whatsappGroupId,
    accountLabel: g.account.label,
    isMonitored: g.isMonitored,
    isActive: g.isActive,
    participantCount: g.participantCount,
    lastSyncedAt: g.lastSyncedAt?.toISOString() ?? null,
    priority: g.priority,
    assignedTeamMemberId: g.assignedTeamMemberId,
    assignedTeamMemberName: g.assignedTeamMember?.name ?? null,
    escalationMonitoringEnabled: g.escalationMonitoringEnabled,
  }));

  return (
    <div>
      <PageHeader
        title="WhatsApp Groups"
        description="Only monitored groups are eligible for auto-reply. Use Accounts → Resync Groups to discover new ones."
      />

      <FilterBar>
        <form className="flex flex-wrap items-end gap-2" method="GET">
          <Input name="search" placeholder="Search group name…" defaultValue={search} className="w-64" />
          <input type="hidden" name="filter" value={filter} />
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip href={buildHref(search, "all")} active={filter === "all"} label={`All (${allCount})`} />
          <FilterChip
            href={buildHref(search, "monitored")}
            active={filter === "monitored"}
            label={`Monitored (${monitoredCount})`}
          />
          <FilterChip
            href={buildHref(search, "unmonitored")}
            active={filter === "unmonitored"}
            label={`Not Monitored (${unmonitoredCount})`}
          />
          <FilterChip href={buildHref(search, "active")} active={filter === "active"} label={`Active (${activeCount})`} />
          <FilterChip
            href={buildHref(search, "inactive")}
            active={filter === "inactive"}
            label={`Inactive (${inactiveCount})`}
          />
        </div>
        <SyncGroupsButton />
      </FilterBar>

      {groups.length === 0 ? (
        <EmptyState>No groups match the current search/filter.</EmptyState>
      ) : (
        <>
          <GroupsTable
            groups={rows}
            pageSize={PAGE_SIZE}
            pageSizeHrefs={PAGE_SIZE_OPTIONS.map((size) => ({ size, href: buildHref(search, filter, 1, size) }))}
            teamMembers={teamMembers}
          />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={totalCount}
            buildHref={(p) => buildHref(search, filter, p, PAGE_SIZE)}
          />
        </>
      )}
    </div>
  );
}

function isFilterKey(value: string | undefined): value is FilterKey {
  return (
    value === "all" ||
    value === "monitored" ||
    value === "unmonitored" ||
    value === "active" ||
    value === "inactive"
  );
}

function buildHref(search: string, filter: FilterKey, page = 1, pageSize = DEFAULT_PAGE_SIZE): string {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  qs.set("filter", filter);
  if (page > 1) qs.set("page", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(pageSize));
  return `/groups?${qs.toString()}`;
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs transition-colors ${
        active
          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
          : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"
      }`}
    >
      {label}
    </Link>
  );
}
