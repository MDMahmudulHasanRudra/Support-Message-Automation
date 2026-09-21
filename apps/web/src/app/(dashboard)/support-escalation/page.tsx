/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import type { EscalationStatus, Prisma, SupportPriority } from "@prisma/client";
import {
  ActiveFilters,
  Alert,
  EmptyState,
  FilterBar,
  HelpButton,
  HelpSection,
  NoFilterResults,
  PageHeader,
  StatTile,
  type ActiveFilter,
} from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";
import { ActiveCasesTable, type ActiveCaseRow } from "./ActiveCasesTable";

const ACTIVE_STATUSES: EscalationStatus[] = [
  "NEW",
  "MONITORING",
  "WAITING_FOR_HUMAN",
  "SECOND_ALERT",
  "MEMBER_ESCALATED",
  "ADMIN_ESCALATED",
  "FOLLOW_UP",
];

/**
 * This list is unpaginated on purpose — it is a "deal with these now" queue, and the longest-waiting
 * case is always at the top, so page two would be where cases go to be forgotten. It is still
 * bounded: an escalation storm (or monitoring switched on across hundreds of groups at once) must
 * not turn the page into a multi-thousand-row render. Anything beyond the cap is announced, never
 * silently dropped.
 */
const ACTIVE_CASE_LIMIT = 200;

const PRIORITIES: SupportPriority[] = ["P1", "P2", "P3"];

/** How long a case must have gone unanswered to count as "stale" for the filter — long enough that
 *  every SLA tier has already fired, so what is left is a queue nobody has cleared. */
const STALE_CASE_HOURS = 24;

interface EscalationSearchParams {
  priority?: string;
  status?: string;
  stale?: string;
}

function isPriority(value: string | undefined): value is SupportPriority {
  return (PRIORITIES as string[]).includes(value ?? "");
}

function isActiveStatus(value: string | undefined): value is EscalationStatus {
  return (ACTIVE_STATUSES as string[]).includes(value ?? "");
}

export default async function SupportEscalationDashboardPage({
  searchParams,
}: {
  searchParams: Promise<EscalationSearchParams>;
}) {
  await requireSession();
  const params = await searchParams;

  // Dhaka midnight, not the container's — under UTC, setHours() started "today" at 06:00 Dhaka
  // and quietly omitted everything resolved overnight.
  const todayStart = getDhakaDayRange(new Date()).start;

  const priority = isPriority(params.priority) ? params.priority : null;
  const status = isActiveStatus(params.status) ? params.status : null;
  const staleOnly = params.stale === "1";
  // eslint-disable-next-line react-hooks/purity -- server component runs fresh per request; not subject to render-purity rules
  const staleBefore = new Date(Date.now() - STALE_CASE_HOURS * 60 * 60 * 1000);

  /**
   * Filters narrow WHICH active cases are listed; they never widen the set beyond active ones.
   * A closed case is history and lives on its own page — surfacing one here would put something
   * in the "deal with these now" queue that nobody needs to deal with.
   */
  const where: Prisma.SupportEscalationCaseWhereInput = {
    status: status ? status : { in: ACTIVE_STATUSES },
    ...(priority ? { priority } : {}),
    ...(staleOnly ? { lastCustomerMessageAt: { lt: staleBefore } } : {}),
  };

  const [activeCases, filteredCount, activeCaseCount, waitingCount, escalatedCount, pausedCount, resolvedTodayCount] =
    await Promise.all([
      prisma.supportEscalationCase.findMany({
        where,
        include: { group: { select: { name: true } }, assignedTeamMember: { select: { name: true } } },
        orderBy: { lastCustomerMessageAt: "asc" },
        take: ACTIVE_CASE_LIMIT,
      }),
      prisma.supportEscalationCase.count({ where }),
      prisma.supportEscalationCase.count({ where: { status: { in: ACTIVE_STATUSES } } }),
      prisma.supportEscalationCase.count({ where: { status: { in: ["NEW", "MONITORING", "WAITING_FOR_HUMAN"] } } }),
      prisma.supportEscalationCase.count({ where: { status: { in: ["SECOND_ALERT", "MEMBER_ESCALATED", "ADMIN_ESCALATED", "FOLLOW_UP"] } } }),
      prisma.supportEscalationCase.count({ where: { status: "PAUSED" } }),
      prisma.supportEscalationCase.count({ where: { resolvedAt: { gte: todayStart } } }),
    ]);

  const buildHref = (overrides: Partial<EscalationSearchParams> = {}): string => {
    const merged = {
      priority: priority ?? "",
      status: status ?? "",
      stale: staleOnly ? "1" : "",
      ...overrides,
    };
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) if (value) qs.set(key, String(value));
    const query = qs.toString();
    return query ? `/support-escalation?${query}` : "/support-escalation";
  };

  const activeFilters: ActiveFilter[] = [];
  if (priority) {
    activeFilters.push({ label: "Priority", value: priority, removeHref: buildHref({ priority: "" }) });
  }
  if (status) activeFilters.push({ label: "Status", value: status, removeHref: buildHref({ status: "" }) });
  if (staleOnly) {
    activeFilters.push({
      label: "Waiting",
      value: `over ${STALE_CASE_HOURS}h`,
      removeHref: buildHref({ stale: "" }),
    });
  }

  const rows: ActiveCaseRow[] = activeCases.map((c) => ({
    id: c.id,
    groupName: c.group.name,
    priority: c.priority,
    status: c.status,
    waitingSinceLabel: formatDateTime(c.lastCustomerMessageAt),
    escalationLevel: c.escalationLevel,
    assignedName: c.assignedTeamMember?.name ?? null,
  }));

  return (
    <div>
      <PageHeader
        title="Active Cases"
        description="High-priority groups with unanswered customer messages, and where escalation currently stands. Configure per-group priority on the Groups page."
        actions={
          <HelpButton moduleTitle="Active Cases">
            <HelpSection title="What this page is for">
              <p>
                Lists every currently active case — a priority-tagged group with a customer message
                nobody's replied to yet — sorted so the longest-waiting case is always at the top.
                Resolved/cancelled/human-replied cases drop off this list automatically (they're still
                viewable via their own case page, just not listed here as active).
              </p>
            </HelpSection>
            <HelpSection title="How a case gets here">
              <p>
                Only groups tagged P1/P2/P3 on the Groups page are monitored at all — it's entirely
                opt-in. A case opens automatically the moment a non-team-member sends a message in a
                monitored group's chat with no case already open for it; a second message while one is
                open just extends the existing case rather than duplicating it.
              </p>
            </HelpSection>
            <HelpSection title="Status meanings">
              <p>
                NEW/MONITORING — just opened, nothing sent yet. WAITING_FOR_HUMAN — first group alert
                sent. SECOND_ALERT — a re-alert nudge sent. MEMBER_ESCALATED — assigned team member
                DM'd. ADMIN_ESCALATED — escalation admin DM'd. FOLLOW_UP — repeating follow-up DMs to
                the admin. Any real human reply in the chat immediately ends the chain — see the
                Policies page's help for exact timing.
              </p>
            </HelpSection>
            <HelpSection title="Manual controls (on the case detail page)">
              <p>
                <strong>Pause/Resume</strong> freezes/unfreezes the timers. <strong>Escalate
                Immediately</strong> forces the next tier to fire right now instead of waiting out its
                timer. <strong>Reassign</strong> changes who gets the member-tier DM, even mid-case.{" "}
                <strong>Reset</strong> puts a case back to the very start (keeping its history).{" "}
                <strong>Stop Escalation</strong> ends tracking without claiming a human replied.{" "}
                <strong>Mark Resolved</strong> closes it out for good, once the issue is actually
                handled.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Waiting for first response" value={waitingCount} tone={waitingCount > 0 ? "warning" : "neutral"} />
        <StatTile label="Escalated" value={escalatedCount} tone={escalatedCount > 0 ? "danger" : "neutral"} />
        <StatTile label="Paused" value={pausedCount} />
        <StatTile label="Resolved today" value={resolvedTodayCount} tone="success" />
      </div>

      <FilterBar>
        <div className="flex flex-wrap gap-1.5">
          <CaseChip href={buildHref({ priority: "" })} active={!priority} label="All priorities" />
          {PRIORITIES.map((value) => (
            <CaseChip
              key={value}
              href={buildHref({ priority: value })}
              active={priority === value}
              label={value}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <CaseChip href={buildHref({ status: "" })} active={!status} label="Any status" />
          {ACTIVE_STATUSES.map((value) => (
            <CaseChip
              key={value}
              href={buildHref({ status: value })}
              active={status === value}
              label={value.replace(/_/g, " ")}
            />
          ))}
        </div>
        {/* The queue this page is opened to clear: everything whose whole alert ladder has already
            fired and which is still sitting there. */}
        <CaseChip
          href={buildHref({ stale: staleOnly ? "" : "1" })}
          active={staleOnly}
          label={`Waiting over ${STALE_CASE_HOURS}h`}
        />
      </FilterBar>

      <ActiveFilters
        filters={activeFilters}
        clearAllHref="/support-escalation"
        resultCount={filteredCount}
        totalCount={activeCaseCount}
        noun={{ singular: "case", plural: "cases" }}
      />

      {filteredCount > activeCases.length ? (
        <div className="mb-6">
          <Alert tone="warning" title={`Showing the longest-waiting ${activeCases.length} of ${filteredCount} cases`}>
            Resolve or stop escalation on some of these to see the rest — you can now select several
            at once. Every case is still counted in the totals above and reachable from its own page.
          </Alert>
        </div>
      ) : null}

      {rows.length === 0 ? (
        activeFilters.length > 0 ? (
          <NoFilterResults clearAllHref="/support-escalation" filters={activeFilters}>
            No active cases match these filters.
          </NoFilterResults>
        ) : (
          <EmptyState>No active priority support cases right now.</EmptyState>
        )
      ) : (
        <ActiveCasesTable cases={rows} />
      )}
    </div>
  );
}

function CaseChip({ href, active, label }: { href: string; active: boolean; label: string }) {
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
