import { ClipboardCheck, EyeOff, Fingerprint, Layers, ArrowRight, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { prisma } from "@support-automation/db";
import type { PatternCandidateStatus } from "@prisma/client";
import type { BadgeColor } from "@/components/ui";
import { requireSession } from "@/server/auth";
import { Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader, SectionHeader, StatTile, Table, Td, Th } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { RunAiAnalysisButton } from "./RunAiAnalysisButton";

export default async function ConversationLearningPage() {
  await requireSession();

  const [learningSettings, aiSettings, learningModelConfig] = await Promise.all([
    prisma.learningSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } }),
    prisma.aiModelConfig.findUnique({ where: { job: "LEARNING" }, include: { provider: true } }),
  ]);
  const aiAnalysisAvailable =
    aiSettings.aiEngineEnabled && aiSettings.learningEnabled && learningModelConfig?.provider.status === "ACTIVE";

  const resolvedStatuses: PatternCandidateStatus[] = ["APPROVED", "REJECTED", "MERGED", "EXPIRED"];

  const [
    sessionCount,
    openSessionCount,
    totalCandidateCount,
    surfacedCandidateCount,
    unknownPatternCount,
    pendingProposalCount,
    aiAnalyzedCount,
    recentJobs,
  ] = await Promise.all([
    prisma.conversationSession.count(),
    prisma.conversationSession.count({ where: { status: "OPEN" } }),
    prisma.patternCandidate.count(),
    prisma.patternCandidate.count({
      where: {
        occurrenceCount: { gte: learningSettings.minOccurrenceForCandidate },
        distinctGroupCount: { gte: learningSettings.minDistinctGroupsForCandidate },
        distinctClientCount: { gte: learningSettings.minDistinctClientsForCandidate },
      },
    }),
    prisma.patternCandidate.count({
      where: {
        unhandledCount: { gte: learningSettings.minOccurrenceForCandidate },
        distinctGroupCount: { gte: learningSettings.minDistinctGroupsForCandidate },
        distinctClientCount: { gte: learningSettings.minDistinctClientsForCandidate },
        status: { notIn: resolvedStatuses },
      },
    }),
    prisma.ruleProposal.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.patternCandidate.count({ where: { aiConfidenceScore: { not: null } } }),
    prisma.learningBatchJob.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  return (
    <div>
      <PageHeader
        title="Conversation Learning"
        description="Background pattern discovery over real conversations. Deterministic pattern detection is always AI-free; AI-assisted analysis is a fully optional, separately-gated add-on. Nothing on this page sends or changes a customer message."
        actions={
          <HelpButton moduleTitle="Conversation Learning">
            <HelpSection title="What this does">
              <p>
                Three background jobs run on the worker: one groups incoming messages into
                conversation sessions by chat and inactivity gap, one looks for recurring intents
                across closed sessions (both off by default, entirely deterministic, zero AI
                calls), and an optional third one that sends surfaced-eligible patterns to a
                configured AI provider for a second opinion — gated on both the AI Engine and
                Learning switches in AI Settings being on, and only ever a bounded, per-pattern
                batch call, never per-message.
              </p>
            </HelpSection>
            <HelpSection title="Pattern Candidates">
              <p>
                A pattern only appears in the Pattern Candidates list once it&apos;s been seen
                enough times, across enough different groups and clients (configurable in Learning
                Settings) — a single conversation can never produce a visible candidate, with or
                without AI. Nothing here is auto-approved; turning a candidate into a real
                automation rule always requires an explicit human action.
              </p>
            </HelpSection>
            <HelpSection title="Turning it on">
              <p>
                Conversation learning is currently{" "}
                <strong>{learningSettings.conversationLearningEnabled ? "ENABLED" : "DISABLED"}</strong>,
                and AI-assisted analysis is currently{" "}
                <strong>{aiAnalysisAvailable ? "AVAILABLE" : "NOT CONFIGURED"}</strong>. Existing
                WhatsApp automation — rules, replies, notifications — is completely unaffected
                either way.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge color={learningSettings.conversationLearningEnabled ? "green" : "gray"} dot>
          Conversation Learning: {learningSettings.conversationLearningEnabled ? "ENABLED" : "DISABLED"}
        </Badge>
        <Badge color={aiAnalysisAvailable ? "blue" : "gray"} dot>
          AI Analysis: {aiAnalysisAvailable ? "AVAILABLE" : "NOT CONFIGURED"}
        </Badge>
        <Badge color={learningSettings.autoApprovalEnabled ? "yellow" : "gray"} dot>
          Auto-Approval: {learningSettings.autoApprovalEnabled ? "ENABLED" : "OFF"}
        </Badge>
        <RunAiAnalysisButton enabled={Boolean(aiAnalysisAvailable)} />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
        <StatTile label="Conversation Sessions" value={sessionCount} hint={`${openSessionCount} currently open`} />
        <StatTile
          label="Patterns Surfaced"
          value={surfacedCandidateCount}
          tone={surfacedCandidateCount > 0 ? "success" : "neutral"}
        />
        <StatTile
          label="Unknown Patterns"
          value={unknownPatternCount}
          tone={unknownPatternCount > 0 ? "warning" : "neutral"}
          hint="No existing rule handles these yet"
        />
        <StatTile
          label="Patterns Accumulating"
          value={Math.max(0, totalCandidateCount - surfacedCandidateCount)}
          hint="Below the review floor"
        />
        <StatTile label="AI-Analyzed Patterns" value={aiAnalyzedCount} hint="Have received an AI confidence pass" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HubLink
          href="/conversation-learning/pattern-candidates"
          icon={Fingerprint}
          label="Pattern Candidates"
          description={`${surfacedCandidateCount} surfaced pattern${surfacedCandidateCount === 1 ? "" : "s"}`}
        />
        <HubLink
          href="/conversation-learning/unknown-patterns"
          icon={EyeOff}
          label="Unknown Patterns"
          description={`${unknownPatternCount} unhandled pattern${unknownPatternCount === 1 ? "" : "s"}`}
        />
        <HubLink
          href="/conversation-learning/rule-proposals"
          icon={ClipboardCheck}
          label="Rule Proposals"
          description={`${pendingProposalCount} pending review`}
        />
        <HubLink
          href="/conversation-learning/settings"
          icon={SettingsIcon}
          label="Learning Settings"
          description={learningSettings.autoApprovalEnabled ? "Auto-approval enabled" : "Thresholds & weights"}
        />
      </div>

      <Card>
        <SectionHeader
          title="Recent Background Runs"
          description="Last 5 segmentation/pattern-detection batch runs, for visibility."
        />
        {recentJobs.length === 0 ? (
          <EmptyState icon={<Layers className="size-5" aria-hidden />}>
            No batch runs yet — nothing happens until Conversation Learning is enabled.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Job</Th>
                <Th>Trigger</Th>
                <Th>Status</Th>
                <Th>Considered</Th>
                <Th>Updated</Th>
                <Th>Ran</Th>
              </tr>
            </thead>
            <tbody>
              {recentJobs.map((job) => (
                <tr key={job.id}>
                  <Td>{job.jobType.replace(/_/g, " ")}</Td>
                  <Td>{job.trigger}</Td>
                  <Td>
                    <Badge color={jobStatusColor(job.status)} dot>
                      {job.status}
                    </Badge>
                  </Td>
                  <Td className="tabular-nums">{job.candidatesConsidered}</Td>
                  <Td className="tabular-nums">{job.candidatesUpdated}</Td>
                  <Td>{formatDateTime(job.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function jobStatusColor(status: string): BadgeColor {
  if (status === "COMPLETED") return "green";
  if (status === "FAILED") return "red";
  if (status === "RUNNING") return "blue";
  return "gray";
}

function HubLink({
  href,
  icon: Icon,
  label,
  description,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  description: string;
}) {
  return (
    <Link href={href} className="group block h-full">
      <Card className="flex h-full items-start gap-3 transition-shadow duration-200 hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-md)]">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-primary-soft)] text-[color:var(--color-primary)]">
          <Icon className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[color:var(--color-foreground)]">{label}</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">{description}</p>
        </div>
        <ArrowRight
          className="mt-1 size-4 shrink-0 text-[color:var(--color-muted-foreground)] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[color:var(--color-primary)]"
          aria-hidden
        />
      </Card>
    </Link>
  );
}
