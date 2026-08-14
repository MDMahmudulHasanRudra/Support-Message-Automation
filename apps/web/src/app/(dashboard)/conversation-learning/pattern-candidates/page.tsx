import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { EmptyState, HelpButton, HelpSection, PageHeader, Pagination } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { PatternCandidatesTable, type PatternCandidateRow } from "./PatternCandidatesTable";

const PAGE_SIZE = 20;

interface SearchParams {
  page?: string;
}

export default async function PatternCandidatesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireSession();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const learningSettings = await prisma.learningSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const where = {
    occurrenceCount: { gte: learningSettings.minOccurrenceForCandidate },
    distinctGroupCount: { gte: learningSettings.minDistinctGroupsForCandidate },
    distinctClientCount: { gte: learningSettings.minDistinctClientsForCandidate },
  };

  const [candidates, total] = await Promise.all([
    prisma.patternCandidate.findMany({
      where,
      orderBy: { confidenceScore: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.patternCandidate.count({ where }),
  ]);

  const rows: PatternCandidateRow[] = candidates.map((candidate) => ({
    id: candidate.id,
    keywords: candidate.suggestedKeywords,
    occurrenceCount: candidate.occurrenceCount,
    distinctGroupCount: candidate.distinctGroupCount,
    distinctClientCount: candidate.distinctClientCount,
    confidenceScore: candidate.confidenceScore,
    status: candidate.status,
    lastSeenAtLabel: formatDateTime(candidate.lastSeenAt),
  }));

  return (
    <div>
      <PageHeader
        title="Pattern Candidates"
        description="Recurring conversation patterns detected across enough different groups and clients to be worth a human's attention. Nothing here is actionable yet."
        actions={
          <HelpButton moduleTitle="Pattern Candidates">
            <HelpSection title="Why a pattern shows up here">
              <p>
                A pattern only appears once it clears three independent floors, all configurable in
                Learning Settings: minimum occurrence count, minimum distinct groups, and minimum
                distinct clients. A single conversation — no matter how it scores — can never appear
                in this list.
              </p>
            </HelpSection>
            <HelpSection title="Confidence score">
              <p>
                A blended 0-100 score across frequency, group/client diversity, response
                consistency, resolution signal, and recency. It&apos;s a ranking aid, not a decision —
                approving a pattern into a real automation rule is a later phase.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {rows.length === 0 ? (
        <EmptyState>
          No patterns have cleared the review floor yet. They&apos;ll appear here automatically as
          more conversations accumulate.
        </EmptyState>
      ) : (
        <>
          <PatternCandidatesTable candidates={rows} />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            buildHref={(p) => `/conversation-learning/pattern-candidates?page=${p}`}
          />
        </>
      )}
    </div>
  );
}
