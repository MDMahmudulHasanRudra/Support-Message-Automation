import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { EmptyState, HelpButton, HelpSection, PageHeader, Pagination } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { RuleProposalsTable, type RuleProposalRow } from "./RuleProposalsTable";

const PAGE_SIZE = 20;

type FilterKey = "all" | "pending" | "approved" | "rejected" | "withdrawn";

interface SearchParams {
  page?: string;
  filter?: string;
}

export default async function RuleProposalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireSession();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);
  const filter: FilterKey = isFilterKey(params.filter) ? params.filter : "all";

  const where: Prisma.RuleProposalWhereInput = {};
  if (filter === "pending") where.status = "PENDING_REVIEW";
  if (filter === "approved") where.status = { in: ["APPROVED", "CONVERTED"] };
  if (filter === "rejected") where.status = "REJECTED";
  if (filter === "withdrawn") where.status = "WITHDRAWN";

  const [proposals, total, allCount, pendingCount, approvedCount, rejectedCount, withdrawnCount] = await Promise.all([
    prisma.ruleProposal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.ruleProposal.count({ where }),
    prisma.ruleProposal.count(),
    prisma.ruleProposal.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.ruleProposal.count({ where: { status: { in: ["APPROVED", "CONVERTED"] } } }),
    prisma.ruleProposal.count({ where: { status: "REJECTED" } }),
    prisma.ruleProposal.count({ where: { status: "WITHDRAWN" } }),
  ]);

  const rows: RuleProposalRow[] = proposals.map((proposal) => ({
    id: proposal.id,
    name: proposal.name,
    confidenceScoreSnapshot: proposal.confidenceScoreSnapshot,
    status: proposal.status,
    createdAtLabel: formatDateTime(proposal.createdAt),
  }));

  return (
    <div>
      <PageHeader
        title="Rule Proposals"
        description="Automation rule drafts generated from recurring conversation patterns. Approving one creates a real rule — still inactive until you separately switch it on from the Rules page."
        actions={
          <HelpButton moduleTitle="Rule Proposals">
            <HelpSection title="What happens on Approve">
              <p>
                Approving copies this proposal into a real AutomationRule row, but it&apos;s created
                as a Draft — it has zero effect on live WhatsApp automation until you separately
                switch it to Active on the Rules page. This gives you one more chance to review the
                exact wording before it goes live.
              </p>
            </HelpSection>
            <HelpSection title="Reject / Withdraw">
              <p>
                Both close this proposal for good — a rejected or withdrawn proposal is never
                automatically replaced. If the same pattern keeps recurring, its evidence keeps
                accumulating on the source Pattern Candidate, and a human can create a fresh
                proposal from it whenever they choose.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        <FilterChip href={buildHref("all")} active={filter === "all"} label={`All (${allCount})`} />
        <FilterChip href={buildHref("pending")} active={filter === "pending"} label={`Pending Review (${pendingCount})`} />
        <FilterChip href={buildHref("approved")} active={filter === "approved"} label={`Approved (${approvedCount})`} />
        <FilterChip href={buildHref("rejected")} active={filter === "rejected"} label={`Rejected (${rejectedCount})`} />
        <FilterChip href={buildHref("withdrawn")} active={filter === "withdrawn"} label={`Withdrawn (${withdrawnCount})`} />
      </div>

      {rows.length === 0 ? (
        <EmptyState>No rule proposals match this filter yet.</EmptyState>
      ) : (
        <>
          <RuleProposalsTable proposals={rows} />
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} buildHref={(p) => buildHref(filter, p)} />
        </>
      )}
    </div>
  );
}

function isFilterKey(value: string | undefined): value is FilterKey {
  return value === "all" || value === "pending" || value === "approved" || value === "rejected" || value === "withdrawn";
}

function buildHref(filter: FilterKey, page = 1): string {
  const qs = new URLSearchParams();
  qs.set("filter", filter);
  if (page !== 1) qs.set("page", String(page));
  return `/conversation-learning/rule-proposals?${qs.toString()}`;
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
