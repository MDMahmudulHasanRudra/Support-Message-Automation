
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { Prisma, type NotificationStatus, type PatternCandidateStatus } from "@prisma/client";
import { pageAccess } from "@/server/authorize";
import { EmptyState, HelpButton, HelpSection, PageHeader, Pagination, ViewOnlyNotice } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { UnknownPatternsTable, type UnknownPatternRow } from "./UnknownPatternsTable";

const PAGE_SIZE = 20;
/** A candidate in any of these has already been resolved one way or another — see
 * patternDetectionJob.ts's UNKNOWN_PATTERN_TERMINAL_STATUSES for the matching alert-side gate. */
const RESOLVED_STATUSES: PatternCandidateStatus[] = ["APPROVED", "REJECTED", "MERGED", "EXPIRED"];

interface SearchParams {
  page?: string;
}

/** The two per-candidate previews this page renders, and all it reads from either table. */
type EvidencePreview = { patternCandidateId: string; body: string };
type NotificationPreview = { patternCandidateId: string; status: NotificationStatus };

export default async function UnknownPatternsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { canManage } = await pageAccess("conversation_learning.view", "conversation_learning.manage");
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
  // Two `DISTINCT ON`s rather than two unbounded findMany calls: only the newest row per candidate
  // is ever rendered, and the previous shape fetched every evidence row with its whole joined
  // Message — tens of megabytes deserialised to produce one preview string per candidate. Postgres
  // walks the index once per candidate and stops, and only the two displayed columns come back.
  const [latestEvidence, latestNotifications]: [EvidencePreview[], NotificationPreview[]] = candidateIds.length
    ? await Promise.all([
        prisma.$queryRaw<EvidencePreview[]>`
          SELECT DISTINCT ON (e."patternCandidateId") e."patternCandidateId", m."body"
          FROM "PatternCandidateEvidence" e
          JOIN "Message" m ON m."id" = e."matchedMessageId"
          WHERE e."patternCandidateId" IN (${Prisma.join(candidateIds)})
            AND e."projectId" = ${await activeProjectId()}
          ORDER BY e."patternCandidateId", e."createdAt" DESC
        `,
        prisma.$queryRaw<NotificationPreview[]>`
          SELECT DISTINCT ON (n."relatedPatternCandidateId")
            n."relatedPatternCandidateId" AS "patternCandidateId", n."status"::text AS status
          FROM "Notification" n
          WHERE n."relatedPatternCandidateId" IN (${Prisma.join(candidateIds)})
            AND n."projectId" = ${await activeProjectId()}
          ORDER BY n."relatedPatternCandidateId", n."createdAt" DESC
        `,
      ])
    : [[], []];

  const latestMessageByCandidateId = new Map(latestEvidence.map((row) => [row.patternCandidateId, row.body]));
  const latestNotificationStatusByCandidateId = new Map(
    latestNotifications.map((row) => [row.patternCandidateId, row.status]),
  );

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
    notificationStatus: latestNotificationStatusByCandidateId.get(candidate.id) ?? null,
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
                distinct clients — all configurable in Conversation Settings), applied to the subset of
                occurrences where no existing AutomationRule fired. A pattern an existing rule
                already handles well never appears here, no matter how often it recurs — and once a
                pattern is Approved, Rejected, Merged, or Expired it drops off this list too.
              </p>
            </HelpSection>
            <HelpSection title="Notification column">
              <p>
                If Unknown Pattern Alerts are enabled in Conversation Settings, one WhatsApp alert is
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

      {canManage ? null : <ViewOnlyNotice />}

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
