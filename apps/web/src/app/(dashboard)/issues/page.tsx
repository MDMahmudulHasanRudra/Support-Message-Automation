import Link from "next/link";
import { Plus } from "lucide-react";
import { prisma } from "@support-automation/db";
import { pageAccess } from "@/server/authorize";
import { formatDateTime } from "@/lib/date";
import { Download } from "lucide-react";
import type { Prisma, SupportIssueStatus } from "@prisma/client";
import { ActiveFilters, Button, ButtonLink, FilterBar, HelpButton, HelpSection, Input, NoFilterResults, PageHeader, Pagination, type ActiveFilter, ViewOnlyNotice } from "@/components/ui";
import { IssuesTable, type IssueRow } from "./IssuesTable";

/** Every status an issue can hold. Seven of them existed and none was filterable, so anybody
 *  hunting open work scrolled past everything already resolved. */
const ISSUE_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_DEVELOPER",
  "RESOLUTION_DETECTED",
  "WAITING_CUSTOMER_CHECK",
  "RESOLVED",
  "CLOSED",
] as const satisfies readonly SupportIssueStatus[];

/** The statuses that mean "still needs somebody" — the default question this page is opened with. */
const OPEN_STATUSES: SupportIssueStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_DEVELOPER",
  "RESOLUTION_DETECTED",
  "WAITING_CUSTOMER_CHECK",
];

const PAGE_SIZE_OPTIONS = [50, 200, 500] as const;
const DEFAULT_PAGE_SIZE = 50;

interface IssuesSearchParams {
  status?: string;
  q?: string;
  page?: string;
  pageSize?: string;
}

function isIssueStatus(value: string | undefined): value is SupportIssueStatus {
  return (ISSUE_STATUSES as readonly string[]).includes(value ?? "");
}

export default async function IssuesPage({ searchParams }: { searchParams: Promise<IssuesSearchParams> }) {
  const { canManage } = await pageAccess("teams_integration.view", "teams_integration.manage");
  const params = await searchParams;

  const status = isIssueStatus(params.status) ? params.status : null;
  const openOnly = params.status === "open";
  const q = (params.q ?? "").trim();

  const where: Prisma.SupportIssueWhereInput = {
    ...(status ? { status } : openOnly ? { status: { in: OPEN_STATUSES } } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { clientPhone: { contains: q, mode: "insensitive" as const } },
            { group: { name: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requestedPageSize = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const PAGE_SIZE = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

  const [issues, totalCount, allCount, openCount] = await Promise.all([
    prisma.supportIssue.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { group: true, teamsChannel: true },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.supportIssue.count({ where }),
    prisma.supportIssue.count(),
    prisma.supportIssue.count({ where: { status: { in: OPEN_STATUSES } } }),
  ]);

  const buildHref = (
    overrides: Partial<IssuesSearchParams> = {},
    nextPage = 1,
    nextPageSize = PAGE_SIZE,
  ): string => {
    const merged = { status: params.status ?? "", q, ...overrides };
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value) qs.set(key, String(value));
    if (nextPage > 1) qs.set("page", String(nextPage));
    if (nextPageSize !== DEFAULT_PAGE_SIZE) qs.set("pageSize", String(nextPageSize));
    const query = qs.toString();
    return query ? `/issues?${query}` : "/issues";
  };

  const activeFilters: ActiveFilter[] = [];
  if (status || openOnly) {
    activeFilters.push({
      label: "Status",
      value: status ? status.replace(/_/g, " ") : "Still open",
      removeHref: buildHref({ status: "" }),
    });
  }
  if (q) activeFilters.push({ label: "Search", value: q, removeHref: buildHref({ q: "" }) });

  const rows: IssueRow[] = issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    clientPhone: issue.clientPhone,
    groupName: issue.group.name,
    status: issue.status,
    teamsChannelName: issue.teamsChannel?.name ?? null,
    createdAtLabel: formatDateTime(issue.createdAt),
  }));

  return (
    <div>
      <PageHeader
        title="Issues"
        description="Links a customer's WhatsApp conversation to a developer's Teams thread — resolving the Teams thread can notify the customer automatically."
        actions={
          <>
            <ButtonLink href="/api/teams/export?type=issues&format=xlsx">
              <Download className="size-3.5" aria-hidden />
              Export
            </ButtonLink>
            <HelpButton moduleTitle="Issues">
              <HelpSection title="What this page is for">
                <p>
                  Create an Issue when a customer conversation needs developer attention. Link it
                  to a Teams channel (and optionally an exact thread) — once a developer&apos;s
                  reply there matches an active Resolution Rule, the issue is marked resolved and
                  the customer can be notified automatically over WhatsApp.
                </p>
              </HelpSection>
            </HelpButton>
            <Link href="/issues/new">
              <Button>
                <Plus className="size-3.5" aria-hidden />
                Create Issue
              </Button>
            </Link>
          </>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      <FilterBar>
        <form className="flex flex-wrap items-end gap-2" method="GET">
          <Input name="q" placeholder="Search title, phone or group…" defaultValue={q} className="w-64" />
          {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
          <Button type="submit" size="sm">
            Search
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          <IssueChip href={buildHref({ status: "" })} active={!params.status} label={`All (${allCount})`} />
          {/* The default question, ahead of the individual statuses: five of the seven mean
              "still needs somebody", and nobody opens this page to browse closed work. */}
          <IssueChip href={buildHref({ status: "open" })} active={openOnly} label={`Still open (${openCount})`} />
          {ISSUE_STATUSES.map((value) => (
            <IssueChip
              key={value}
              href={buildHref({ status: value })}
              active={status === value}
              label={value.replace(/_/g, " ")}
            />
          ))}
        </div>
      </FilterBar>

      <ActiveFilters
        filters={activeFilters}
        clearAllHref="/issues"
        resultCount={totalCount}
        totalCount={allCount}
        noun={{ singular: "issue", plural: "issues" }}
      />

      {rows.length === 0 && activeFilters.length > 0 ? (
        <NoFilterResults clearAllHref="/issues" filters={activeFilters}>
          No issues match these filters.
        </NoFilterResults>
      ) : (
        <>
          <IssuesTable issues={rows} />
          {rows.length > 0 ? (
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={totalCount}
              buildHref={(p) => buildHref({}, p, PAGE_SIZE)}
              pageSizeOptions={[...PAGE_SIZE_OPTIONS]}
              buildPageSizeHref={(size) => buildHref({}, 1, size)}
              sticky
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function IssueChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
          : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"
      }`}
    >
      {label}
    </Link>
  );
}
