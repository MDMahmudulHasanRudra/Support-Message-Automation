/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { AutoRefresh } from "@/components/AutoRefresh";
import {
  Badge,
  Card,
  EmptyState,
  HelpButton,
  HelpSection,
  PageHeader,
  ProgressBar,
  SectionHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { ImportForm } from "./ImportForm";
import { RetryImportButton } from "./RetryImportButton";

export const metadata = { title: "Import Knowledge" };

const STATUS_COLOR = {
  PENDING: "gray",
  PROCESSING: "blue",
  COMPLETED: "green",
  PARTIAL: "yellow",
  FAILED: "red",
} as const;

/**
 * Feeds the knowledge base from your own documentation, rather than waiting for it to be learned
 * from customer conversations. On a fresh install this is the only way the AI can know anything
 * about your software at all.
 */
export default async function KnowledgeImportPage() {
  await requireSession();

  const [imports, moduleRows] = await Promise.all([
    prisma.knowledgeImport.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { createdBy: { select: { name: true } } },
    }),
    // Existing module names, offered as autocomplete so the same area does not end up spelled
    // three different ways across imports.
    prisma.aiKnowledgeItem.findMany({
      where: { module: { not: null } },
      distinct: ["module"],
      select: { module: true },
      take: 100,
    }),
  ]);

  const knownModules = moduleRows.map((row) => row.module).filter((m): m is string => Boolean(m)).sort();
  const hasActiveImport = imports.some((job) => job.status === "PENDING" || job.status === "PROCESSING");

  return (
    <div>
      {/* Only while something is actually running — no point polling an idle page. */}
      {hasActiveImport ? <AutoRefresh intervalMs={4000} /> : null}

      <PageHeader
        title="Import Knowledge"
        description="Teach the system about your software by giving it your own documentation."
        actions={
          <HelpButton moduleTitle="Import Knowledge">
            <HelpSection title="What this page is for">
              <p>
                The knowledge base has two sources. This one is you telling the system what your
                software does; the other is the system working it out from real support
                conversations. Both end up in the same place, and both wait for your review before
                anything reaches a customer.
              </p>
              <p>
                On a brand new install the knowledge base is empty, so the AI knows nothing about
                your product specifically. This is how you fix that in an afternoon rather than
                waiting months for it to be learned.
              </p>
            </HelpSection>
            <HelpSection title="What happens after you submit">
              <p>
                Your text is split into sections and each one is read separately, so a long manual
                does not have to fit in a single request. Each section produces a handful of
                self-contained entries. Progress is shown below as it runs.
              </p>
              <p>
                Nothing is sent to a customer from this. Every entry lands unverified in Pending
                Review, and only entries you have verified are ever used to answer anyone.
              </p>
            </HelpSection>
            <HelpSection title="What makes a good import">
              <p>
                One module at a time works far better than the whole manual at once — the entries
                come out more specific, and the review queue stays a size you can actually work
                through. Setting the Module field is worth it: it groups everything the import
                produces and overrides the AI's own guess.
              </p>
            </HelpSection>
            <HelpSection title="File formats">
              <p>
                Plain text only for now — .txt and .md. PDF and Word would need a document-parsing
                library this app doesn't carry yet; until then, copy the text out and paste it. The
                result is identical, because the first thing a parser would do is extract that same
                text.
              </p>
            </HelpSection>
            <HelpSection title="If an import fails">
              <p>
                Sections are processed independently, so one failure does not discard what the
                others produced — the import is marked partial and keeps its entries. The original
                text is stored, so Retry re-runs it without you finding the file again.
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <ImportForm knownModules={knownModules} />

        <div>
          <SectionHeader title="Recent imports" description="Newest first." />
          {imports.length === 0 ? (
            <Card>
              <EmptyState>Nothing imported yet.</EmptyState>
            </Card>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Source</Th>
                  <Th>Status</Th>
                  <Th>Entries</Th>
                </tr>
              </thead>
              <tbody>
                {imports.map((job) => (
                  <tr key={job.id}>
                    <Td>
                      <span className="block truncate text-[13px] font-medium">{job.label}</span>
                      <span className="mt-0.5 block text-[10px] text-[color:var(--color-muted-foreground)]">
                        {job.module ? `${job.module} · ` : ""}
                        {formatDateTime(job.createdAt)}
                        {job.createdBy ? ` · ${job.createdBy.name}` : ""}
                      </span>
                      {job.status === "PROCESSING" && job.chunksTotal > 0 ? (
                        <span className="mt-2 block">
                          <ProgressBar value={job.chunksDone} max={job.chunksTotal} />
                          <span className="tabular mt-1 block text-[10px] text-[color:var(--color-muted-foreground)]">
                            section {job.chunksDone} of {job.chunksTotal}
                          </span>
                        </span>
                      ) : null}
                      {job.error ? (
                        <span className="mt-1 block text-[10px] leading-relaxed text-[color:var(--color-danger-fg)]">
                          {job.error}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge color={STATUS_COLOR[job.status]} dot>
                        {job.status}
                      </Badge>
                      {job.status === "FAILED" || job.status === "PARTIAL" ? (
                        <span className="mt-1 block">
                          <RetryImportButton importId={job.id} />
                        </span>
                      ) : null}
                    </Td>
                    <Td className="tabular">
                      {job.entriesCreated > 0 ? (
                        <Link href="/ai-learning/knowledge-base/review" className="link">
                          {job.entriesCreated}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
