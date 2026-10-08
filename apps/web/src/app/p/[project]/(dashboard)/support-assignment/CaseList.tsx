import { AutoRefresh } from "@/components/AutoRefresh";
import Link from "@/components/ProjectLink";
import { Alert, Button, ButtonLink, Field, FilterBar, Input, Pagination, Select } from "@/components/ui";
import type { Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import {
  CLOSED_FILTERS,
  getAssignableMembers,
  getAssignmentCounts,
  getAssignmentFilterOptions,
  getMemberForUser,
  getSupportAssignmentSettings,
  hasSupportTeamConfigured,
  listAssignments,
  OPEN_TABS,
  parseAssignmentFilters,
  SUPPORT_ASSIGNMENT_PAGE_SIZES,
  type AssignmentView,
} from "@/server/supportAssignment";
import { CaseTable } from "./CaseTable";

const DEFAULT_PAGE_SIZE = 50;

const chip = (active: boolean) =>
  `rounded-full px-3 py-1 text-[12px] font-medium whitespace-nowrap ${
    active ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-neutral-bg)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
  }`;

/**
 * The body of Unanswered, My assignments and Completed: the same filters, the same table and the
 * same `where` (server/supportAssignment.ts), differing only in which cases the view selects.
 */
export async function CaseList({
  session,
  view,
  basePath,
  params,
}: {
  session: Session;
  view: AssignmentView;
  /** This page's own path, for chips and paging links. */
  basePath: string;
  params: Record<string, string | undefined>;
}) {
  const filters = parseAssignmentFilters(params, view);
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const requested = Number(params.pageSize ?? DEFAULT_PAGE_SIZE);
  const pageSize = (SUPPORT_ASSIGNMENT_PAGE_SIZES as readonly number[]).includes(requested) ? requested : DEFAULT_PAGE_SIZE;
  const now = new Date();
  const openView = view === "all" || view === "unassigned" || view === "assigned" || view === "overdue";

  const [settings, supportTeam, canAssign, mine, options] = await Promise.all([
    getSupportAssignmentSettings(),
    hasSupportTeamConfigured(),
    hasPermission(session, "support_assignment.assign"),
    getMemberForUser(session.userId),
    getAssignmentFilterOptions(),
  ]);
  const [{ rows, total }, counts, members] = await Promise.all([
    listAssignments(filters, page, pageSize, mine?.id ?? null),
    openView ? getAssignmentCounts(now) : null,
    canAssign ? getAssignableMembers(settings?.assignableTeamIds ?? []) : [],
  ]);

  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) if (value && key !== "page" && key !== "pageSize") query[key] = value;
  const href = (overrides: Record<string, string | null>) => {
    const qs = new URLSearchParams(query);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) qs.delete(k);
      else qs.set(k, v);
    }
    const s = qs.toString();
    return `${basePath}${s ? `?${s}` : ""}`;
  };

  const emptyMessage =
    view === "mine"
      ? "Nothing is waiting on you: every case assigned to you has been answered."
      : view === "closed"
        ? "No finished case matches these filters."
        : view === "unassigned"
          ? "No customer is waiting for an assignment."
          : view === "overdue"
            ? "Nothing is overdue."
            : view === "assigned"
              ? "No case is assigned and still inside its SLA."
              : "No customer is waiting: every support message matching these filters has been answered.";

  return (
    <div>
      {openView || view === "mine" ? <AutoRefresh intervalMs={15000} /> : null}

      {!settings?.enabled ? (
        <div className="mb-4">
          <Alert tone="warning" title="Support Assignment is switched off">
            No case is opened or followed until it is switched on under{" "}
            <Link href="/support-assignment/settings" className="underline">
              Settings → Support Assignment
            </Link>
            .
          </Alert>
        </div>
      ) : null}
      {!supportTeam ? (
        <div className="mb-4">
          <Alert tone="warning" title="Choose the Support Team first">
            Cases are built on Messages → Unanswered groups, which tracks nothing until the Support Team is chosen under{" "}
            <Link href="/support-activity/settings" className="underline">
              Settings → Support Activity Setup
            </Link>
            .
          </Alert>
        </div>
      ) : null}
      {view === "mine" && !mine ? (
        <div className="mb-4">
          <Alert tone="info" title="Your login is not linked to a team member">
            My assignments shows the cases assigned to the team member linked to your login. An admin links it on{" "}
            <Link href="/team-members" className="underline">
              Team Members
            </Link>{" "}
            → edit → Dashboard login.
          </Alert>
        </div>
      ) : null}

      {openView && counts ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {OPEN_TABS.map((tab) => (
            <Link
              key={tab.view}
              href={tab.view === "all" ? href({ view: null, page: null }) : href({ view: tab.view, page: null })}
              className={chip(view === tab.view)}
            >
              {tab.label} <span className="tabular opacity-80">{counts[tab.view].toLocaleString("en-US")}</span>
            </Link>
          ))}
          <span className="ml-auto text-[12px] text-[color:var(--color-muted-foreground)]">
            Today: {counts.openedToday.toLocaleString("en-US")} wait(s) seen,{" "}
            <Link href="/support-assignment/completed?status=IGNORED" className="underline">
              {counts.ignoredToday.toLocaleString("en-US")} filtered out
            </Link>{" "}
            by the ignore rules
          </span>
        </div>
      ) : null}

      {view === "closed" ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Link href={href({ status: null, page: null })} className={chip(filters.closedStatus === "")}>
            All finished
          </Link>
          {CLOSED_FILTERS.map((f) => (
            <Link key={f.status} href={href({ status: f.status, page: null })} className={chip(filters.closedStatus === f.status)}>
              {f.label}
            </Link>
          ))}
        </div>
      ) : null}

      <form method="get">
        {openView && view !== "all" ? <input type="hidden" name="view" value={view} /> : null}
        {view === "closed" && filters.closedStatus ? <input type="hidden" name="status" value={filters.closedStatus} /> : null}
        <FilterBar>
          <Field label="Search">
            <Input name="q" defaultValue={filters.q} placeholder="Group, customer or message" />
          </Field>
          {view !== "mine" ? (
            <Field label="Employee">
              <Select name="memberId" defaultValue={filters.memberId}>
                <option value="">Everyone</option>
                {options.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.status === "ACTIVE" ? "" : " (inactive)"}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Account">
            <Select name="accountId" defaultValue={filters.accountId}>
              <option value="">All accounts</option>
              {options.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input name="dateFrom" type="date" defaultValue={filters.dateFrom} />
          </Field>
          <Field label="To">
            <Input name="dateTo" type="date" defaultValue={filters.dateTo} />
          </Field>
          {pageSize !== DEFAULT_PAGE_SIZE ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
          <div className="flex gap-2">
            <Button type="submit">Apply</Button>
            <ButtonLink href={basePath}>Reset</ButtonLink>
          </div>
        </FilterBar>
      </form>

      <p className="mb-2 text-[13px] text-[color:var(--color-muted-foreground)]">
        <span className="tabular font-semibold text-[color:var(--color-foreground)]">{total.toLocaleString("en-US")}</span> case{total === 1 ? "" : "s"}
      </p>

      <CaseTable
        rows={rows}
        nowMs={now.getTime()}
        canAssign={canAssign && Boolean(settings?.enabled)}
        members={members}
        closedView={view === "closed"}
        emptyMessage={emptyMessage}
      />

      {total > 0 ? (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          buildHref={(p) => href({ page: p > 1 ? String(p) : null })}
          pageSizeOptions={[...SUPPORT_ASSIGNMENT_PAGE_SIZES]}
          buildPageSizeHref={(size) => href({ page: null, pageSize: size !== DEFAULT_PAGE_SIZE ? String(size) : null })}
          sticky
        />
      ) : null}
    </div>
  );
}
