/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";
import { Search } from "lucide-react";

import { pageAccess } from "@/server/authorize";
import { ActiveFilters, Button, EmptyState, FilterBar, HelpButton, HelpSection, Input, NoFilterResults, PageHeader, Pagination, type ActiveFilter, ViewOnlyNotice } from "@/components/ui";
import {
  buildGroupSearchWhere,
  buildGroupWhere,
  isGroupFilterKey,
  type GroupFilterKey,
} from "@/lib/groupFilters";
import { GroupsTable, type GroupRow } from "./GroupsTable";
import { SyncGroupsButton } from "./SyncGroupsButton";
import { AccountFilter } from "./AccountFilter";

const PAGE_SIZE_OPTIONS = [10, 50, 100, 500, 1000] as const;
const DEFAULT_PAGE_SIZE = 50;
type FilterKey = GroupFilterKey;

interface GroupsSearchParams {
  search?: string;
  accountId?: string;
  filter?: string;
  page?: string;
  pageSize?: string;
}

export default async function GroupsPage({ searchParams }: { searchParams: Promise<GroupsSearchParams> }) {
  const { canManage } = await pageAccess("whatsapp.view", "whatsapp.manage");
  const params = await searchParams;
  const filter: FilterKey = isFilterKey(params.filter) ? params.filter : "all";
  const search = (params.search ?? "").trim();
  const accountId = (params.accountId ?? "").trim() || null;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requestedPageSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const PAGE_SIZE = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  // Both come from lib/groupFilters, which `selectAllMatchingGroupIds` also reads — so "select all
  // 1,798 matching" can never resolve to a different 1,798 than this page counted and rendered.
  const searchOnlyWhere = buildGroupSearchWhere(search, accountId);
  const where = buildGroupWhere(search, filter, accountId);

  const [
    groups,
    totalCount,
    allCount,
    monitoredCount,
    unmonitoredCount,
    activeCount,
    inactiveCount,
    needsSetupCount,
    groupsPerAccount,
    teamMembers,
    aiSettings,
    accounts,
  ] = await Promise.all([
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
    prisma.whatsAppGroup.count({ where: { ...searchOnlyWhere, isActive: true, isMonitored: false } }),
    // Per-account counts for the account chips, within the current search but across ALL accounts —
    // each chip says how many groups picking it would show.
    prisma.whatsAppGroup.groupBy({ by: ["accountId"], where: buildGroupSearchWhere(search, null), _count: { _all: true } }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // Whether a row's own opt-in switch is what decides AI eligibility depends on the global
    // scope, so the table is told which mode it is rendering in rather than guessing. It depends
    // on nothing above it, so it rides along with the rest instead of adding a ninth round trip
    // after they have all finished.
    prisma.aiSettings.upsert({
      where: { id: "global" },
      update: {},
      create: { id: "global" },
      select: { aiAutomationScope: true },
    }),
    // Every account, not only connected ones: a disconnected number's groups are still listed and
    // still need filtering to, and hiding it would make its rows unreachable by account.
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true, isPrimary: true }, orderBy: { label: "asc" } }),
  ]);

  const selectedAccount = accountId ? accounts.find((a) => a.id === accountId) ?? null : null;

  const aiScopeIsGlobal = aiSettings.aiAutomationScope === "ALL_MONITORED_GROUPS";

  // What is actually narrowing the list right now, each removable on its own. The chips above say
  // what CAN be filtered; this says what IS, which is the question "why am I seeing 12 of 1,848?"
  // needs answered.
  const activeFilters: ActiveFilter[] = [];
  if (search) {
    activeFilters.push({ label: "Search", value: search, removeHref: buildHref("", filter, 1, PAGE_SIZE, accountId ?? "") });
  }
  if (selectedAccount) {
    activeFilters.push({
      label: "Account",
      value: selectedAccount.label,
      removeHref: buildHref(search, filter, 1, PAGE_SIZE, ""),
    });
  }
  if (filter !== "all") {
    activeFilters.push({
      label: "Showing",
      value: FILTER_LABELS[filter],
      removeHref: buildHref(search, "all", 1, PAGE_SIZE, accountId ?? ""),
    });
  }
  // Page size survives a clear — it is how the operator reads the list, not part of what they asked for.
  const clearAllHref = buildHref("", "all", 1, PAGE_SIZE, accountId ?? "");

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
    aiAutomationEnabled: g.aiAutomationEnabled,
    aiAutomationExcluded: g.aiAutomationExcluded,
    testModeEnabled: g.testModeEnabled,
    aiScopeIsGlobal,
    knowledgeBuiltAt: g.knowledgeBuiltAt?.toISOString() ?? null,
    aiSuppressedUntil: g.aiSuppressedUntil?.toISOString() ?? null,
  }));

  return (
    <div>
      <PageHeader
        title="WhatsApp Groups"
        description="Only monitored groups are eligible for auto-reply. Use Accounts → Resync Groups to discover new ones."
        actions={
          <HelpButton moduleTitle="WhatsApp Groups">
            <HelpSection title="What this page is for">
              <p>
                Every WhatsApp group your connected account(s) have synced, with per-group controls for
                automation, priority support, and participant counts. New groups appear here after a
                resync — this page never discovers groups on its own.
              </p>
            </HelpSection>
            <HelpSection title="Monitored — the single most important setting here">
              <p>
                A group must be marked <strong>Monitored</strong> before any automation rule (auto-reply,
                tagging, notifications) will ever fire for messages in it — this is separate from and
                checked in addition to whether a rule's keywords match. Every newly-synced group starts
                <strong> unmonitored</strong> by default, so if automation "isn't working" in a specific
                group, check here first. Use "Start Monitoring" per row, or select several rows and use
                Bulk Enable Monitoring.
              </p>
            </HelpSection>
            <HelpSection title="Active vs. Inactive">
              <p>
                A group becomes Inactive automatically when a resync no longer finds your account as a
                member of it (left the group, removed, etc.) — it isn't deleted, just soft-marked, so its
                message history stays intact. If a group you're still in shows Inactive, run Sync Groups.
              </p>
            </HelpSection>
            <HelpSection title="Sync Groups button">
              <p>
                Queues a group-list refresh for every connected WhatsApp account (not just one) — new
                groups you've joined appear, groups you've left get marked Inactive, and names/participant
                counts update. Takes a few seconds per account; you don't need to wait on this page.
              </p>
            </HelpSection>
            <HelpSection title="Priority Support column">
              <p>
                Click "Configure" to tag a group P1/P2/P3 for Priority Support Escalation, and optionally
                assign a team member who gets DM'd if nobody replies in time. Leaving priority unset
                (the default) means this group is never monitored for escalation — it's entirely opt-in.
                See the Escalations → Active Cases page's own Help for what the tiers actually do.
              </p>
            </HelpSection>
            <HelpSection title="AI Automation column">
              <p>
                Opt-in for the Hybrid AI Automation fallback layer, per group. Even when enabled here,
                AI only ever runs for a message in this group when it's also Monitored, and the
                account-wide AI Engine + Auto Response switches (Settings → AI Settings) are both on
                — this is one gate among several, never the only one. Disabling it just stops that one
                group from ever reaching the AI/human-fallback stage; every other automation on the
                group is unaffected. A yellow "Human active until…" badge means a team member sent
                a message here recently — AI is briefly paused for this group (configurable on the
                Settings → AI Settings page) so it doesn't step on a human who's already engaged;
                deterministic rules and escalation are unaffected and keep working normally.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <FilterBar>
        <form className="flex flex-wrap items-end gap-2" method="GET">
          <Input name="search" placeholder="Search group name…" defaultValue={search} className="w-64" />
          {/* The account travels with a search rather than being reset by it. */}
          {accountId ? <input type="hidden" name="accountId" value={accountId} /> : null}
          <input type="hidden" name="filter" value={filter} />
          <Button type="submit" size="sm">
            <Search className="size-3.5" aria-hidden />
            Search
          </Button>
        </form>
        {/* Right after Search, always visible — even with one number, it says which account's
            groups these are. Applies on change; see AccountFilter. */}
        <AccountFilter
          value={accountId ?? ""}
          options={[
            {
              value: "",
              label: `All accounts (${groupsPerAccount.reduce((sum, row) => sum + row._count._all, 0)})`,
              href: buildHref(search, filter, 1, PAGE_SIZE, ""),
            },
            ...accounts.map((a) => ({
              value: a.id,
              label: `${a.label}${a.isPrimary ? " · Primary" : ""} (${groupsPerAccount.find((row) => row.accountId === a.id)?._count._all ?? 0})`,
              href: buildHref(search, filter, 1, PAGE_SIZE, a.id),
            })),
          ]}
        />
        <div className="flex flex-wrap gap-1.5">
          <FilterChip href={buildHref(search, "all", 1, PAGE_SIZE, accountId ?? "")} active={filter === "all"} label={`All (${allCount})`} />
          <FilterChip
            href={buildHref(search, "needs_setup", 1, PAGE_SIZE, accountId ?? "")}
            active={filter === "needs_setup"}
            label={`Active, not monitored (${needsSetupCount})`}
          />
          <FilterChip
            href={buildHref(search, "monitored", 1, PAGE_SIZE, accountId ?? "")}
            active={filter === "monitored"}
            label={`Monitored (${monitoredCount})`}
          />
          <FilterChip
            href={buildHref(search, "unmonitored", 1, PAGE_SIZE, accountId ?? "")}
            active={filter === "unmonitored"}
            label={`Not Monitored (${unmonitoredCount})`}
          />
          <FilterChip href={buildHref(search, "active", 1, PAGE_SIZE, accountId ?? "")} active={filter === "active"} label={`Active (${activeCount})`} />
          <FilterChip
            href={buildHref(search, "inactive", 1, PAGE_SIZE, accountId ?? "")}
            active={filter === "inactive"}
            label={`Inactive (${inactiveCount})`}
          />
        </div>
        <SyncGroupsButton />
      </FilterBar>

      <ActiveFilters
        filters={activeFilters}
        clearAllHref={clearAllHref}
        resultCount={totalCount}
        totalCount={allCount}
        noun={{ singular: "group", plural: "groups" }}
      />

      {groups.length === 0 ? (
        activeFilters.length > 0 ? (
          <NoFilterResults clearAllHref={clearAllHref} filters={activeFilters}>
            No groups match these filters.
          </NoFilterResults>
        ) : (
          <EmptyState>No groups yet — run Sync Groups to discover them.</EmptyState>
        )
      ) : (
        <>
          <GroupsTable
            groups={rows}
            teamMembers={teamMembers}
            totalMatching={totalCount}
            search={search}
            filter={filter}
            accountId={accountId}
          />
          {/* The page-size control lives here now rather than inside the table: it belonged to the
              pagination bar all along, and having it in both places meant two differently-shaped
              controls for one setting. */}
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={totalCount}
            buildHref={(p) => buildHref(search, filter, p, PAGE_SIZE, accountId ?? "")}
            pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
            buildPageSizeHref={(size) => buildHref(search, filter, 1, size, accountId ?? "")}
            sticky
          />
        </>
      )}
    </div>
  );
}

const isFilterKey = isGroupFilterKey;

/** The chip wording, reused by the active-filter pill so the two cannot describe it differently. */
const FILTER_LABELS: Record<FilterKey, string> = {
  all: "All",
  monitored: "Monitored",
  unmonitored: "Not monitored",
  active: "Active",
  inactive: "Inactive",
  needs_setup: "Active, not monitored",
};

function buildHref(
  search: string,
  filter: FilterKey,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
  accountId = "",
): string {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  qs.set("filter", filter);
  if (page > 1) qs.set("page", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(pageSize));
  if (accountId) qs.set("accountId", accountId);
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
