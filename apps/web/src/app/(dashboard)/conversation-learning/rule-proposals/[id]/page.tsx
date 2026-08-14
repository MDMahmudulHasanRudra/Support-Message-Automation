import { notFound } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { RuleAction } from "@support-automation/shared";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { Badge, type BadgeColor, Card, PageHeader, SectionHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { RuleProposalActions } from "./RuleProposalActions";

export default async function RuleProposalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const proposal = await prisma.ruleProposal.findUnique({
    where: { id },
    include: {
      reviewedBy: { select: { name: true, email: true } },
      createdRule: { select: { id: true, name: true, status: true } },
    },
  });
  if (!proposal) notFound();

  const actions = Array.isArray(proposal.actions) ? (proposal.actions as unknown as RuleAction[]) : [];

  return (
    <div>
      <PageHeader
        title={proposal.name}
        description={proposal.description ?? undefined}
        actions={
          <Badge color={statusColor(proposal.status)} dot>
            {proposal.status.replace(/_/g, " ")}
          </Badge>
        }
      />

      {proposal.status === "PENDING_REVIEW" ? (
        <Card className="mb-6">
          <RuleProposalActions proposalId={proposal.id} />
        </Card>
      ) : null}

      {proposal.createdRule ? (
        <Card className="mb-6">
          <p className="text-sm text-[color:var(--color-foreground)]">
            Converted into{" "}
            <Link href={`/rules/${proposal.createdRule.id}/edit`} className="underline">
              {proposal.createdRule.name}
            </Link>{" "}
            — currently{" "}
            <Badge color={proposal.createdRule.status === "ACTIVE" ? "green" : "gray"} dot>
              {proposal.createdRule.status}
            </Badge>
            . Activating it is a separate step on the Rules page.
          </p>
        </Card>
      ) : null}

      <Card className="mb-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[color:var(--color-foreground)]">Proposed Rule</h2>
          <Link
            href={`/conversation-learning/pattern-candidates/${proposal.patternCandidateId}`}
            className="shrink-0 text-xs text-[color:var(--color-muted-foreground)] underline decoration-dotted decoration-[var(--color-border-strong)] underline-offset-2 hover:text-[color:var(--color-primary)]"
          >
            View source pattern
          </Link>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Field label="Type" value={proposal.type} />
          <Field label="Match Type" value={proposal.matchType} />
          <Field label="Keywords" value={proposal.keywords.join(", ") || "—"} />
          <Field label="Priority" value={proposal.priority} />
          <Field label="Confidence Snapshot" value={proposal.confidenceScoreSnapshot} />
          <Field label="Cooldown" value={proposal.cooldownSeconds ? `${proposal.cooldownSeconds}s` : "—"} />
        </dl>
        <div className="mt-4">
          <p className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Actions</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {actions.map((action, index) => (
              <Badge key={index} color="blue">
                {action.type}
              </Badge>
            ))}
          </div>
        </div>
        {proposal.replyMessage ? (
          <div className="mt-4">
            <p className="text-xs font-medium text-[color:var(--color-muted-foreground)]">Reply Message</p>
            <p className="mt-1 whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-neutral-bg)]/40 p-3 text-sm text-[color:var(--color-foreground)]">
              {proposal.replyMessage}
            </p>
          </div>
        ) : null}
      </Card>

      {proposal.reviewedAt ? (
        <Card className="mb-6">
          <SectionHeader title="Review" />
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
            <Field label="Reviewed By" value={proposal.reviewedBy?.name ?? proposal.reviewedBy?.email ?? "—"} />
            <Field label="Reviewed At" value={formatDateTime(proposal.reviewedAt)} />
            <Field label="Note" value={proposal.reviewNote ?? "—"} />
          </dl>
        </Card>
      ) : null}

      <p className="mt-4">
        <Link
          href="/conversation-learning/rule-proposals"
          className="inline-flex items-center gap-1 text-sm text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to Rule Proposals
        </Link>
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-foreground)]">{value}</dd>
    </div>
  );
}

function statusColor(status: string): BadgeColor {
  if (status === "APPROVED" || status === "CONVERTED") return "green";
  if (status === "REJECTED") return "red";
  if (status === "WITHDRAWN") return "gray";
  return "blue";
}
