/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";
import { BookOpen, MessagesSquare, PenLine } from "lucide-react";

import { pageAccess } from "@/server/authorize";
import { formatDateTime } from "@/lib/date";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Alert, Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader, ProgressBar, SectionHeader, ViewOnlyNotice } from "@/components/ui";
import { AnalyzeConversationsForm } from "./AnalyzeConversationsForm";
import { CandidateCard } from "./CandidateCard";

/** Runs shown at once — this is a working surface, not an archive. */
const RECENT_RUNS = 5;

export default async function KnowledgeBuilderPage() {
  const { canManage } = await pageAccess("conversation_learning.view", "conversation_learning.manage");

  const [groups, runs, aiSettings] = await Promise.all([
    // Only groups that actually have stored conversation are offered — selecting an empty group
    // would spend an AI call to learn nothing.
    //
    // `some: {}` compiles to EXISTS, which stops at the first matching row and rides the
    // [groupId, timestampWa] index. A per-group message COUNT was the obvious thing to show
    // beside each name and is deliberately not here: that is a full index-range count per group,
    // 300 of them on a Message table with millions of rows, to produce a number nobody chooses
    // groups by. See the note on query cost in CLAUDE.md's Overview section.
    prisma.whatsAppGroup.findMany({
      where: { isActive: true, messages: { some: {} } },
      orderBy: { name: "asc" },
      take: 300,
      select: { id: true, name: true },
    }),
    prisma.conversationAnalysisRun.findMany({
      orderBy: { createdAt: "desc" },
      take: RECENT_RUNS,
      include: {
        candidates: { orderBy: [{ status: "asc" }, { confidence: "desc" }] },
      },
    }),
    prisma.aiSettings.findUnique({ where: { id: "global" }, select: { aiEngineEnabled: true } }),
  ]);

  const running = runs.some((r) => r.status === "QUEUED" || r.status === "RUNNING");

  return (
    <div>
      <PageHeader
        title="Knowledge Builder"
        description="Teach the AI what your team knows — by writing it down yourself, or by learning it from conversations that already happened."
        actions={
          <HelpButton moduleTitle="Knowledge Builder">
            <HelpSection title="Two ways to teach the AI">
              <p>
                <strong>Write it down</strong> when you already know the answer — that goes straight
                into the knowledge base as a verified entry. <strong>Learn from conversations</strong>{" "}
                when the answer is buried in groups your team has already handled: pick the groups
                and a time range, and the AI proposes question-and-answer pairs for you to approve.
              </p>
            </HelpSection>
            <HelpSection title="Nothing is published without you">
              <p>
                An analysis only ever produces candidates. Nothing reaches the knowledge base — and
                so nothing can be said to a customer — until you approve it here. You can edit the
                wording first, and rejected candidates are kept so you can see what was turned down.
              </p>
            </HelpSection>
            <HelpSection title="How this differs from the automatic builder">
              <p>
                There is also a background job that reads monitored groups on its own and files what
                it finds as unverified entries in Pending Review (switched on under AI Settings).
                This page is the manual version: you choose the groups, you choose the window, and
                you get the results back immediately instead of finding them later. The two never
                interfere — this page does not affect where the automatic builder has read up to.
              </p>
            </HelpSection>
            <HelpSection title="What it reads">
              <p>
                Messages this system has already stored for the groups you select, and nothing else.
                Names and phone numbers are stripped before anything reaches the AI — every speaker
                becomes simply "customer" or "support".
              </p>
            </HelpSection>
          </HelpButton>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      {running ? <AutoRefresh intervalMs={4000} /> : null}

      {aiSettings && !aiSettings.aiEngineEnabled ? (
        <div className="mb-5">
          <Alert tone="warning" title="The AI Engine is switched off">
            <p>
              Learning from conversations needs it on.{" "}
              <Link href="/ai-learning/settings" className="font-medium underline underline-offset-2">
                Open AI Settings
              </Link>
            </p>
          </Alert>
        </div>
      ) : null}

      {/* The two ways in. Manual Q&A deliberately links to the existing knowledge form rather than
          duplicating it — one editor, reachable from both places. */}
      <div className="mb-6 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Link
          href="/ai-learning/knowledge-base/new"
          className="group flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-[border-color,box-shadow] duration-[var(--duration-base)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]">
            <PenLine className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-[color:var(--color-foreground)]">
              Write a question &amp; answer
            </span>
            <span className="mt-1 block text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              You already know the answer. Saved as verified knowledge the assistant can use
              straight away.
            </span>
          </span>
        </Link>

        <Link
          href="/ai-learning/knowledge-base"
          className="group flex gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-[border-color,box-shadow] duration-[var(--duration-base)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] text-[color:var(--color-muted-foreground)]">
            <BookOpen className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold text-[color:var(--color-foreground)]">
              Browse the knowledge base
            </span>
            <span className="mt-1 block text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
              Everything the assistant can draw on, plus anything still waiting to be verified.
            </span>
          </span>
        </Link>
      </div>

      <section className="mb-6">
        <SectionHeader
          title="Learn from conversations"
          description="Read real support conversations and turn what the team already answered into reusable knowledge."
        />
        <Card>
          <AnalyzeConversationsForm groups={groups} />
        </Card>
      </section>

      <section>
        <SectionHeader
          title="Learning candidates"
          description="What the AI proposed. Nothing here is in the knowledge base until you approve it."
        />

        {runs.length === 0 ? (
          <Card>
            <EmptyState icon={<MessagesSquare className="size-5" aria-hidden />}>
              No analysis has been run yet. Pick some groups above and press Analyze to see what the
              AI can learn from conversations your team has already handled.
            </EmptyState>
          </Card>
        ) : (
          <div className="space-y-4">
            {runs.map((run) => {
              const waiting = run.candidates.filter((c) => c.status === "WAITING");
              const inProgress = run.status === "QUEUED" || run.status === "RUNNING";
              return (
                <Card key={run.id}>
                  <div className="mb-3.5 flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-border)] pb-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[color:var(--color-foreground)]">
                        {run.label ?? "Conversation analysis"}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                        {describeRange(run.rangeKind, run.messageLimit)} · {run.groupsTotal} group(s) ·{" "}
                        {formatDateTime(run.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {run.status === "COMPLETE" ? (
                        <Badge color="green" dot>
                          {run.candidatesCreated} found
                        </Badge>
                      ) : run.status === "PARTIAL" ? (
                        <Badge color="yellow" dot>
                          Partly finished
                        </Badge>
                      ) : run.status === "FAILED" ? (
                        <Badge color="red" dot>
                          Failed
                        </Badge>
                      ) : (
                        <Badge color="blue" dot pulse>
                          Reading…
                        </Badge>
                      )}
                    </div>
                  </div>

                  {inProgress ? (
                    <div className="mb-3 space-y-1.5">
                      <ProgressBar value={run.groupsDone} max={Math.max(1, run.groupsTotal)} />
                      <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                        {run.groupsDone} of {run.groupsTotal} group(s) read
                      </p>
                    </div>
                  ) : null}

                  {run.status === "FAILED" || (run.status === "PARTIAL" && run.error) ? (
                    <div className="mb-3">
                      <Alert tone={run.status === "FAILED" ? "danger" : "warning"}>
                        <p>{run.error ?? "Some groups could not be read."}</p>
                      </Alert>
                    </div>
                  ) : null}

                  {run.candidates.length === 0 ? (
                    <p className="py-4 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
                      {inProgress
                        ? "Nothing proposed yet."
                        : "Nothing durable came out of these conversations — usually that means the window held mostly chatter rather than questions and answers."}
                    </p>
                  ) : (
                    <>
                      {waiting.length > 0 ? (
                        <p className="mb-2.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                          {waiting.length} waiting for your decision
                        </p>
                      ) : null}
                      <div className="space-y-2.5">
                        {run.candidates.map((candidate) => (
                          <CandidateCard
                            key={candidate.id}
                            candidate={{
                              id: candidate.id,
                              groupName: candidate.groupName,
                              title: candidate.title,
                              category: candidate.category,
                              question: candidate.question,
                              answer: candidate.answer,
                              confidence: candidate.confidence,
                              status: candidate.status,
                              promoted: Boolean(candidate.promotedKnowledgeItemId),
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function describeRange(kind: string, messageLimit: number | null): string {
  switch (kind) {
    case "LAST_24_HOURS":
      return "Last 24 hours";
    case "LAST_7_DAYS":
      return "Last 7 days";
    case "LATEST_MESSAGES":
      return `Most recent ${messageLimit ?? 200} messages`;
    case "CUSTOM":
      return "Custom dates";
    default:
      return kind;
  }
}
