/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { HelpButton, HelpSection, PageHeader, Pagination, StatTile } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { ReviewQueue, type ReviewRow } from "./ReviewQueue";

export const metadata = { title: "Pending Review" };

const PAGE_SIZE = 20;

interface ReviewSearchParams {
  page?: string;
}

/**
 * The trust boundary of the knowledge system. Everything the importer and the conversation
 * builder produce lands here unverified, and only a verified entry is ever retrieved to answer a
 * customer — so nothing a model wrote reaches a customer without a person having read it.
 */
export default async function KnowledgeReviewPage({
  searchParams,
}: {
  searchParams: Promise<ReviewSearchParams>;
}) {
  await requireSession();
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  // ARCHIVED is excluded: discarding from this queue archives rather than deletes, and a
  // discarded entry must not come straight back.
  const where = { humanVerified: false, status: { not: "ARCHIVED" as const } };

  const [items, total, verifiedCount] = await Promise.all([
    prisma.aiKnowledgeItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.aiKnowledgeItem.count({ where }),
    prisma.aiKnowledgeItem.count({ where: { humanVerified: true, status: "ACTIVE" } }),
  ]);

  const rows: ReviewRow[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    module: item.module,
    question: item.question,
    answer: item.answer,
    confidence: item.confidence,
    sourceLabel: item.sourceLabel,
    createdAtLabel: formatDateTime(item.createdAt),
  }));

  return (
    <div>
      <PageHeader
        title="Pending Review"
        description="Knowledge the AI has structured, waiting for a person to confirm it before it can be used."
        actions={
          <HelpButton moduleTitle="Pending Review">
            <HelpSection title="Why this queue exists">
              <p>
                Two things write knowledge automatically: the importer, which structures your own
                documentation, and the conversation builder, which works out answers from real
                support chats. Both are useful and both are readings by a model, not statements of
                fact.
              </p>
              <p>
                Only a verified entry is ever retrieved to answer a customer. That single rule is
                what stops a mistaken entry being quoted back to customers with growing apparent
                authority, so nothing skips this page.
              </p>
            </HelpSection>
            <HelpSection title="Verify or discard">
              <p>
                "Verify" makes the entry available to the AI immediately. "Discard" archives it —
                nothing is deleted, because what the AI got wrong is itself worth keeping. If an
                entry is nearly right, edit it first and then verify.
              </p>
            </HelpSection>
            <HelpSection title="What to check for">
              <p>
                Read the answer as though you were the customer receiving it. The common failure is
                not an invented fact but an over-generalised one: a support member's one-off
                workaround written up as standing policy, or a step that only applies when some
                other setting is on. If it needs a condition to be true, say so in the entry.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3.5 sm:grid-cols-3">
        <StatTile label="Waiting for review" value={total} tone={total > 0 ? "warning" : "neutral"} />
        <StatTile label="Verified and in use" value={verifiedCount} tone={verifiedCount > 0 ? "success" : "neutral"} />
        <StatTile
          label="Add more"
          value={
            <Link href="/ai-learning/knowledge-base/import" className="link text-base">
              Import
            </Link>
          }
          hint="Feed the system your own documentation"
        />
      </div>

      <ReviewQueue rows={rows} />
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        buildHref={(next) => `/ai-learning/knowledge-base/review?page=${next}`}
      />
    </div>
  );
}
