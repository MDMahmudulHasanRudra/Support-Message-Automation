import { notFound } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { prisma } from "@support-automation/db";
import { meetsCandidateFloor } from "@support-automation/engine";
import { requireSession } from "@/server/auth";
import { Badge, type BadgeColor, Button, Card, PageHeader, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { PatternCandidateActions } from "./PatternCandidateActions";

export default async function PatternCandidateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  const [candidate, learningSettings] = await Promise.all([
    prisma.patternCandidate.findUnique({
      where: { id },
      include: {
        proposal: true,
        evidence: {
          orderBy: { createdAt: "desc" },
          include: { conversationSession: { include: { group: true } }, matchedMessage: true },
        },
      },
    }),
    prisma.learningSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
  ]);
  if (!candidate) notFound();

  const floorMet = meetsCandidateFloor(
    {
      occurrenceCount: candidate.occurrenceCount,
      distinctGroupCount: candidate.distinctGroupCount,
      distinctClientCount: candidate.distinctClientCount,
    },
    learningSettings,
  );

  return (
    <div>
      <PageHeader
        title={candidate.suggestedKeywords.join(", ") || "(no distinctive keywords)"}
        description={`Pattern signature "${candidate.patternKey}" — ${candidate.evidence.length} supporting conversation${
          candidate.evidence.length === 1 ? "" : "s"
        }.`}
        actions={
          <div className="flex items-center gap-2">
            <Badge color={statusColor(candidate.status)} dot>
              {candidate.status.replace(/_/g, " ")}
            </Badge>
            {candidate.proposal ? (
              <Link href={`/conversation-learning/rule-proposals/${candidate.proposal.id}`}>
                <Button variant="secondary" size="sm">
                  View Proposal
                </Button>
              </Link>
            ) : floorMet ? (
              <PatternCandidateActions candidateId={candidate.id} />
            ) : null}
          </div>
        }
      />

      {!floorMet ? (
        <p className="mb-6 text-sm text-[color:var(--color-muted-foreground)]">
          This pattern hasn&apos;t cleared the review floor yet (occurrence/group/client minimums
          in Learning Settings), so it isn&apos;t eligible for a proposal yet — it&apos;ll become
          actionable automatically once more evidence accumulates.
        </p>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Confidence" value={candidate.confidenceScore} />
        <StatTile label="Frequency" value={candidate.frequencyScore} />
        <StatTile label="Diversity" value={candidate.diversityScore} />
        <StatTile label="Consistency" value={candidate.consistencyScore} />
        <StatTile label="Resolution" value={candidate.resolutionScore} />
        <StatTile label="Recency" value={candidate.recencyScore} />
      </div>

      <Card className="mb-6">
        <SectionHeader title="Evidence Summary" />
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Field label="Occurrences" value={candidate.occurrenceCount} />
          <Field label="Distinct Groups" value={candidate.distinctGroupCount} />
          <Field label="Distinct Clients" value={candidate.distinctClientCount} />
          <Field label="Suggested Match Type" value={candidate.suggestedMatchType} />
        </dl>
        {candidate.suggestedReplyMessage ? (
          <div className="mt-4">
            <p className="text-xs font-medium text-[color:var(--color-muted-foreground)]">
              Suggested reply (from an observed team-member response — evidence, not binding)
            </p>
            <p className="mt-1 whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-neutral-bg)]/40 p-3 text-sm text-[color:var(--color-foreground)]">
              {candidate.suggestedReplyMessage}
            </p>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionHeader
          title="Supporting Conversations"
          description="One row per conversation session contributing evidence to this pattern."
        />
        <Table>
          <thead>
            <tr>
              <Th>Group</Th>
              <Th>Resolved</Th>
              <Th>Matched Message</Th>
              <Th>When</Th>
            </tr>
          </thead>
          <tbody>
            {candidate.evidence.map((evidence) => (
              <tr key={evidence.id}>
                <Td>{evidence.conversationSession.group?.name ?? "(direct message)"}</Td>
                <Td>
                  <Badge color={evidence.wasResolved ? "green" : "gray"} dot>
                    {evidence.wasResolved ? "Resolved" : "No reply seen"}
                  </Badge>
                </Td>
                <Td className="max-w-md truncate">{evidence.matchedMessage?.body ?? "—"}</Td>
                <Td>{formatDateTime(evidence.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <p className="mt-4">
        <Link
          href="/conversation-learning/pattern-candidates"
          className="inline-flex items-center gap-1 text-sm text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to Pattern Candidates
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
  if (status === "PENDING_REVIEW") return "blue";
  if (status === "APPROVED") return "green";
  if (status === "REJECTED") return "red";
  if (status === "MERGED" || status === "EXPIRED") return "gray";
  return "yellow";
}
