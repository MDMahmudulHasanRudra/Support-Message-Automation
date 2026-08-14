import { prisma } from "@support-automation/db";
import type { PatternCandidateStatus } from "@prisma/client";
import { requireSession } from "@/server/auth";
import { EmptyState, HelpButton, HelpSection, PageHeader, Pagination } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { UnknownPatternsTable, type UnknownPatternRow } from "./UnknownPatternsTable";

const PAGE_SIZE = 20;
/** A candidate in any of these has already been resolved one way or another — see
 * patternDetectionJob.ts's UNKNOWN_PATTERN_TERMINAL_STATUSES for the matching alert-side gate. */
const RESOLVED_STATUSES: PatternCandidateStatus[] = ["APPROVED", "REJECTED", "MERGED", "EXPIRED"];

interface SearchParams {
  page?: string;
}

export default async function UnknownPatternsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireSession();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const learningSettings = await prisma.learningSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const where = {
    unhandledCount: { gte: learningSettings.minOccurrenceForCandidate },
    distinctGroupCount: { gte: learningSettings.minDistinctGroupsForCandidate },
    distinctClientCount: { gte: learningSettings.minDistinctClientsForCandidate },
    status: { notIn: RESOLVED_STATUSES },
  };

  const [candidates, total] = await Promise.all([
    prisma.patternCandidate.findMany({
      where,
      orderBy: { unhandledCount: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.patternCandidate.count({ where }),
  ]);

  const candidateIds = candidates.map((c) => c.id);
  const [evidenceRows, notifications] = candidateIds.length
    ? await Promise.all([
        prisma.patternCandidateEvidence.findMany({
          where: { patternCandidateId: { in: candidateIds } },
          include: { matchedMessage: true },
          orderBy: { createdAt: "desc" },
        }),
        prisma.notification.findMany({
          where: { relatedPatternCandidateId: { in: candidateIds } },
          orderBy: { createdAt: "desc" },
        }),
      ])
    : [[], []];

  // Both lists are globally sorted newest-first, so the first row seen per candidate id while
  // iterating is already that candidate's most recent — no per-group query needed.
  const latestMessageByCandidateId = new Map<string, string>();
  for (const evidence of evidenceRows) {
    if (latestMessageByCandidateId.has(evidence.patternCandidateId) || !evidence.matchedMessage) continue;
    latestMessageByCandidateId.set(evidence.patternCandidateId, evidence.matchedMessage.body);
  }
  const latestNotificationByCandidateId = new Map<string, (typeof notifications)[number]>();
  for (const notification of notifications) {
    if (!notification.relatedPatternCandidateId || latestNotificationByCandidateId.has(notification.relatedPatternCandidateId)) {
      continue;
    }
    latestNotificationByCandidateId.set(notification.relatedPatternCandidateId, notification);
  }

  const rows: UnknownPatternRow[] = candidates.map((candidate) => ({
    id: candidate.id,
    keywords: candidate.suggestedKeywords,
    status: candidate.status,
    confidenceScore: candidate.confidenceScore,
    unhandledCount: candidate.unhandledCount,
    distinctGroupCount: candidate.distinctGroupCount,
    distinctClientCount: candidate.distinctClientCount,
    firstSeenAtLabel: formatDateTime(candidate.firstSeenAt),
    lastSeenAtLabel: formatDateTime(candidate.lastSeenAt),
    latestExample: latestMessageByCandidateId.get(candidate.id) ?? null,
    notificationStatus: latestNotificationByCandidateId.get(candidate.id)?.status ?? null,
  }));

  return (
    <div>
      <PageHeader
        title="Unknown Patterns"
        description="Recurring questions that no existing automation rule currently handles — accumulated from real conversations, never auto-replied to."
        actions={
          <HelpButton moduleTitle="Unknown Patterns">
            <HelpSection title="Why a pattern shows up here">
              <p>
                Same three floors as Pattern Candidates (minimum occurrences, distinct groups,
                distinct clients — all configurable in Learning Settings), applied to the subset of
                occurrences where no existing AutomationRule fired. A pattern an existing rule
                already handles well never appears here, no matter how often it recurs — and once a
                pattern is Approved, Rejected, Merged, or Expired it drops off this list too.
              </p>
            </HelpSection>
            <HelpSection title="Notification column">
              <p>
                If Unknown Pattern Alerts are enabled in Learning Settings, one WhatsApp alert is
                sent per pattern (never per message) once it clears the floor above, then cooled
                down for a configurable period — this reflects that alert&apos;s real delivery
                status. Blank means alerts are off, or none has been sent for this pattern yet.
              </p>
            </HelpSection>
            <HelpSection title="Reviewing one">
              <p>
                Click a pattern to open the same Pattern Candidate detail page used everywhere else
                in Conversation Learning. Approve, Reject, and Create Proposal there are the real
                review actions — this list is a filtered view of Pattern Candidates, not a separate
                workflow.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {rows.length === 0 ? (
        <EmptyState>
          No unresolved unknown patterns right now — either nothing has cleared the floor yet, or
          every pattern that has is already handled by a rule or already reviewed.
        </EmptyState>
      ) : (
        <>
          <UnknownPatternsTable patterns={rows} />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            buildHref={(p) => `/conversation-learning/unknown-patterns?page=${p}`}
          />
        </>
      )}
    </div>
  );
}
