/* eslint-disable react/no-unescaped-entities -- long-form Help dialog prose reads better with real apostrophes/quotes than HTML entities */
import Link from "next/link";
import { Download, FlaskConical, ShieldCheck } from "lucide-react";
import { prisma } from "@support-automation/db";
import { pageAccess } from "@/server/authorize";
import { formatDateTime } from "@/lib/date";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Alert, Badge, Card, EmptyState, HelpButton, HelpSection, PageHeader, ViewOnlyNotice } from "@/components/ui";
import { NewSandboxSession } from "./NewSandboxSession";
import { SandboxComposer } from "./SandboxComposer";
import { SandboxAnswer } from "./SandboxAnswer";
import { getGrantedPermissionKeys } from "@/server/permissions";

interface SearchParams {
  session?: string;
}

/** Plain-language gloss for the diagnostic codes the worker records, same vocabulary as the
 *  AI Activity log — the code is what appears in logs, the sentence is what a person reads. */
const REASON_COPY: Record<string, string> = {
  NO_KNOWLEDGE: "Nothing in the verified knowledge base covered this, and the current response mode does not allow answering from general knowledge.",
  NO_BUSINESS_KNOWLEDGE: "The AI judged this a question about your business specifically, and had no verified knowledge to answer it from. This guard is deliberately not configurable.",
  AI_DECLINED: "The AI decided this one needs a person.",
  EMPTY_RESPONSE: "The AI said it would reply but drafted nothing.",
  MALFORMED_RESPONSE: "The AI's answer could not be parsed.",
  LOW_CONFIDENCE: "The AI was less confident than the Auto-response confidence threshold requires.",
  LOW_CONFIDENCE_GENERAL: "An answer with no verified knowledge behind it is held to the higher general-answer threshold, and this fell below it.",
};

function explainReason(reason: string | null): string | null {
  if (!reason) return null;
  const [code] = reason.split(":");
  const known = code ? REASON_COPY[code.trim()] : undefined;
  // An unknown or detail-carrying code (AI_ERROR: ..., AI_UNAVAILABLE: ...) is shown as-is —
  // the detail after the colon is usually the actionable half.
  return known ?? reason;
}

export default async function AiSandboxPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { canManage, session } = await pageAccess("conversation_learning.view", "conversation_learning.manage");
  // Saving straight as VERIFIED knowledge needs the right that verifies knowledge anywhere else.
  const canSaveVerified = new Set(await getGrantedPermissionKeys(session)).has("ai_learning.manage");
  const { session: sessionId } = await searchParams;

  const [sessions, groups, aiSettings] = await Promise.all([
    prisma.sandboxSession.findMany({
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        label: true,
        createdAt: true,
        group: { select: { name: true } },
        _count: { select: { turns: true } },
      },
    }),
    prisma.whatsAppGroup.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      take: 300,
      select: { id: true, name: true },
    }),
    prisma.aiSettings.findUnique({ where: { id: "global" }, select: { aiEngineEnabled: true } }),
  ]);

  // Default to the most recent conversation so the page is never an empty shell when there is
  // something to show.
  const activeId = sessionId ?? sessions[0]?.id ?? null;
  const active = activeId
    ? await prisma.sandboxSession.findUnique({
        where: { id: activeId },
        include: {
          group: { select: { name: true } },
          turns: { orderBy: { createdAt: "asc" } },
        },
      })
    : null;

  const waiting = active?.turns.some((t) => t.status === "PENDING" || t.status === "PROCESSING") ?? false;
  const editorIds = [...new Set((active?.turns ?? []).map((t) => t.editedById).filter((id): id is string => Boolean(id)))];
  const editors = editorIds.length
    ? await prisma.user.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true } })
    : [];
  const editorName = new Map(editors.map((u) => [u.id, u.name]));
  const verifiedCount = active?.turns.filter((t) => t.review === "APPROVED").length ?? 0;

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            AI Sandbox
            <Badge color="cyan" dot>
              Isolated
            </Badge>
          </span>
        }
        description="Ask the AI a question the way a customer would, and see exactly what production would have done with it — without a customer being involved."
        actions={
          <>
            <NewSandboxSession groups={groups} />
            <HelpButton moduleTitle="AI Sandbox">
              <HelpSection title="What this is">
                <p>
                  A safe place to test the AI. It runs the same knowledge lookup, the same prompt,
                  the same business-question guard and the same confidence threshold production
                  uses — so what you see here is what a real customer would have got.
                </p>
              </HelpSection>
              <HelpSection title="What it never does">
                <p>
                  Nothing here sends a WhatsApp message, alerts anyone, appears in the AI Activity
                  log, counts toward anybody's support figures, or drafts an automation rule. It
                  writes only to its own tables. You cannot affect a customer from this page.
                </p>
              </HelpSection>
              <HelpSection title="Edit, verify, make knowledge">
                <p>
                  Correct any answer with <strong>Edit answer</strong> — or write one where the AI
                  handed over. The original AI answer is always kept ("Show the original AI answer").
                  <strong> Verify answer</strong> confirms the answer as it now reads; changing a
                  verified answer puts it back to Waiting so it is verified again. Only a verified
                  answer can become knowledge, and <strong>Make knowledge</strong> saves exactly the
                  question and final answer you see, which you can still adjust in the form.
                </p>
              </HelpSection>
              <HelpSection title="Verified or Pending Review">
                <p>
                  If your role can verify knowledge, you can save it as <strong>Verified</strong> and
                  the AI may use it straight away — the same as verifying it in the knowledge base.
                  Otherwise it goes to Pending Review for someone who can. Before saving, similar
                  existing entries are shown; nothing existing is ever changed.
                </p>
              </HelpSection>
              <HelpSection title="Export">
                <p>
                  Verified answers export as CSV, Excel or JSON in the Knowledge Base import format
                  (Question, Answer, Title, Category), so a file can be imported straight back.
                </p>
              </HelpSection>
              <HelpSection title="Handovers are not failures">
                <p>
                  A "Would hand to a person" result usually means the safety rules worked. The
                  reason shown beneath it tells you which gate stopped the reply — most often that
                  nothing verified covered the question, which is a gap in the knowledge base
                  rather than a fault in the AI.
                </p>
              </HelpSection>
            </HelpButton>
          </>
        }
      />

      {canManage ? null : <ViewOnlyNotice />}

      {/* Only while something is actually in flight — there is nothing to poll for otherwise. */}
      {waiting ? <AutoRefresh intervalMs={2500} /> : null}

      {aiSettings && !aiSettings.aiEngineEnabled ? (
        <div className="mb-5">
          <Alert tone="warning" title="The AI Engine is switched off">
            <p>
              Test messages will be queued and answered with "AI unavailable" until the master
              switch is on.{" "}
              <Link href="/ai-learning/settings" className="font-medium underline underline-offset-2">
                Open AI Settings
              </Link>
            </p>
          </Alert>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        {/* Past test conversations */}
        <Card className="h-fit p-3">
          <p className="px-2 pb-2 text-[11px] font-semibold tracking-[0.06em] text-[color:var(--color-subtle-foreground)] uppercase">
            Test conversations
          </p>
          {sessions.length === 0 ? (
            <p className="px-2 pb-1 text-[13px] text-[color:var(--color-muted-foreground)]">
              None yet.
            </p>
          ) : (
            <ul className="space-y-px">
              {sessions.map((s) => {
                const isActive = s.id === activeId;
                return (
                  <li key={s.id}>
                    <Link
                      href={`/conversation-learning/sandbox?session=${s.id}`}
                      className={`block rounded-[var(--radius-md)] px-2.5 py-2 text-[13px] transition-colors duration-[var(--duration-fast)] ${
                        isActive
                          ? "bg-[var(--color-neutral-bg)] font-medium text-[color:var(--color-foreground)]"
                          : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]/60"
                      }`}
                    >
                      <span className="block truncate">{s.label ?? "Untitled test"}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-[color:var(--color-subtle-foreground)]">
                        {s._count.turns} message(s)
                        {s.group ? ` · ${s.group.name}` : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* The conversation itself */}
        <div className="min-w-0">
          {!active ? (
            <Card>
              <EmptyState icon={<FlaskConical className="size-5" aria-hidden />}>
                No test conversation open. Start one to ask the AI a question the way a customer
                would — nothing you type here can reach a customer.
              </EmptyState>
            </Card>
          ) : (
            <Card className="flex flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-border)] pb-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[color:var(--color-foreground)]">
                    {active.label ?? "Untitled test"}
                  </p>
                  <p className="mt-0.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                    {active.group ? `As if in ${active.group.name}` : "As a direct message"} ·
                    started {formatDateTime(active.createdAt)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-muted-foreground)]">
                    <ShieldCheck className="size-3.5 text-[color:var(--color-secondary)]" aria-hidden />
                    Nothing here is sent to anyone
                  </span>
                  {verifiedCount > 0 ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-muted-foreground)]">
                      <Download className="size-3.5" aria-hidden />
                      Export {verifiedCount} verified answer(s):
                      {(["csv", "xlsx", "json"] as const).map((format) => (
                        <a
                          key={format}
                          href={`/api/sandbox/export?session=${encodeURIComponent(active.id)}&format=${format}`}
                          className="rounded px-1 font-medium text-[color:var(--color-foreground)] hover:bg-[var(--color-neutral-bg)]"
                        >
                          {format === "xlsx" ? "Excel" : format.toUpperCase()}
                        </a>
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>

              {active.turns.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
                  Send the first message to begin.
                </p>
              ) : (
                <ol className="space-y-5">
                  {active.turns.map((turn) => (
                    <li key={turn.id} className="space-y-2.5">
                      {/* The admin's message, standing in for a customer */}
                      <div className="flex justify-end">
                        <p className="max-w-[80%] rounded-[var(--radius-lg)] bg-[var(--color-neutral-bg)] px-3.5 py-2.5 text-[13px] whitespace-pre-wrap text-[color:var(--color-foreground)]">
                          {turn.userMessage}
                        </p>
                      </div>

                      {turn.status === "PENDING" || turn.status === "PROCESSING" ? (
                        <p className="text-[13px] text-[color:var(--color-muted-foreground)]">
                          Thinking…
                        </p>
                      ) : turn.status === "FAILED" ? (
                        <Alert tone="danger" title="This test failed">
                          <p>{turn.error ?? "Something went wrong running this turn."}</p>
                        </Alert>
                      ) : (
                        <div className="space-y-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            {turn.outcome === "AI_REPLIED" ? (
                              <Badge color="green" dot>
                                Would reply
                              </Badge>
                            ) : (
                              <Badge color="yellow" dot>
                                Would hand to a person
                              </Badge>
                            )}
                            {turn.confidenceScore !== null ? (
                              <span className="tabular text-[11px] text-[color:var(--color-muted-foreground)]">
                                {turn.confidenceScore}% confidence
                              </span>
                            ) : null}
                            {turn.scope ? (
                              <span className="text-[11px] text-[color:var(--color-muted-foreground)]">
                                {turn.scope === "BUSINESS_SPECIFIC" ? "Business-specific" : "General"}
                              </span>
                            ) : null}
                          </div>

                          {turn.outcome === "HUMAN_FALLBACK" ? (
                            <p className="text-[12px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                              {explainReason(turn.reason)}
                            </p>
                          ) : null}

                          {turn.knowledgeTitles.length > 0 ? (
                            <p className="text-[11px] text-[color:var(--color-muted-foreground)]">
                              Grounded in: {turn.knowledgeTitles.join(" · ")}
                            </p>
                          ) : null}

                          <SandboxAnswer
                            turnId={turn.id}
                            sessionId={active.id}
                            question={turn.userMessage}
                            aiAnswer={turn.responseText}
                            editedAnswer={turn.editedResponseText}
                            editedByName={turn.editedById ? (editorName.get(turn.editedById) ?? null) : null}
                            review={turn.review}
                            savedKnowledgeId={turn.promotedKnowledgeItemId}
                            suggestedTitle={turn.intent ?? turn.userMessage.slice(0, 60)}
                            scope={turn.scope}
                            canManage={canManage}
                            canSaveVerified={canSaveVerified}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              <div className="border-t border-[var(--color-border)] pt-3.5">
                <SandboxComposer sessionId={active.id} waiting={waiting} />
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
