import { prisma } from "@/server/db";
import Link from "@/components/ProjectLink";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";

import { requireAccess } from "@/server/authorize";
import { Badge, type BadgeColor, Card, PageHeader, SectionHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { buildMessageTimeline, formatStepDuration } from "@/lib/messageTimeline";
import type { ReactNode } from "react";

interface DecisionTraceEntry {
  ruleId: string | null;
  ruleName: string;
  priority: number | null;
  matched: boolean;
  applied: boolean;
  reason: string;
}

export default async function MessageDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess("messages.view");
  const { id } = await params;

  const message = await prisma.message.findUnique({
    where: { id },
    include: {
      account: { select: { label: true } },
      group: { select: { name: true, whatsappGroupId: true } },
      executions: {
        orderBy: { matchedAt: "desc" },
        include: { rule: { select: { name: true, type: true } } },
      },
      outboundReplies: { orderBy: { createdAt: "desc" } },
      notifications: { orderBy: { createdAt: "desc" } },
      aiFallbackDecision: {
        include: {
          aiProvider: { select: { name: true } },
          outboundMessage: { select: { status: true } },
        },
      },
    },
  });
  if (!message) notFound();

  // The message's journey, from the rows above (P1-07, lib/messageTimeline.ts). One extra lookup: WhatsApp's
  // own copy of each sent reply (the echo), which is what confirms the reply really went out.
  const sentIds = message.outboundReplies.map((r) => r.providerMessageId).filter((id): id is string => Boolean(id));
  const echoes = sentIds.length
    ? await prisma.message.findMany({ where: { whatsappMessageId: { in: sentIds } }, select: { accountId: true, whatsappMessageId: true, createdAt: true } })
    : [];
  const echoAt = new Map(echoes.map((e) => [`${e.accountId}:${e.whatsappMessageId}`, e.createdAt]));
  const latestExecution = message.executions[0] ?? null;
  const timeline = buildMessageTimeline({
    receivedAt: message.timestampWa,
    storedAt: message.createdAt,
    processingStatus: message.processingStatus,
    direction: message.direction,
    decision: latestExecution ? { at: latestExecution.matchedAt, decision: latestExecution.decision } : null,
    ai: message.aiFallbackDecision
      ? { at: message.aiFallbackDecision.createdAt, outcome: message.aiFallbackDecision.outcome, latencyMs: message.aiFallbackDecision.latencyMs }
      : null,
    replies: message.outboundReplies.map((r) => ({
      actionType: r.actionType,
      status: r.status,
      createdAt: r.createdAt,
      scheduledAt: r.scheduledAt,
      sentAt: r.sentAt,
      attemptCount: r.attemptCount,
      failureReason: r.failureReason,
      echoStoredAt: r.providerMessageId ? (echoAt.get(`${r.accountId}:${r.providerMessageId}`) ?? null) : null,
    })),
    alerts: message.notifications.map((n) => ({
      type: n.type,
      event: n.event,
      status: n.status,
      createdAt: n.createdAt,
      sentAt: n.sentAt,
      attemptCount: n.attemptCount,
      failureReason: n.failureReason,
    })),
  });

  const execution = message.executions[0] ?? null;
  const trace = (execution?.reasonTrace as unknown as DecisionTraceEntry[] | null) ?? [];
  const actionsExecuted =
    (execution?.actionsExecuted as unknown as Array<{ type: string; executed: boolean; reason: string }> | null) ?? [];

  // Real (not fabricated) Conversation Learning linkage — evidence-linking runs on a batch cadence,
  // so a just-arrived message legitimately may not have an evidence row yet; that's shown honestly
  // below rather than implying it never will.
  const evidence = await prisma.patternCandidateEvidence.findFirst({
    where: { matchedMessageId: message.id },
    include: { patternCandidate: { include: { proposal: { include: { createdRule: { select: { status: true } } } } } } },
  });

  return (
    <div>
      <PageHeader title="Message Detail" description={message.id} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <SectionHeader
              title="Timeline"
              description={
                timeline.stoppedAt
                  ? `Stopped at: ${timeline.stoppedAt}.`
                  : `Every step finished${timeline.totalMs != null ? `, ${formatStepDuration(timeline.totalMs)} after the customer sent it` : ""}.`
              }
            />
            <ol className="space-y-2 text-sm">
              {timeline.steps.map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <Badge color={step.state === "done" ? "green" : step.state === "waiting" ? "yellow" : step.state === "failed" ? "red" : "gray"} dot>
                    {step.state}
                  </Badge>
                  <div className="min-w-0">
                    <div className="font-medium">
                      {step.label}
                      {step.sincePreviousMs != null ? (
                        <span className="ml-2 text-xs font-normal text-[color:var(--color-muted-foreground)]">+{formatStepDuration(step.sincePreviousMs)}</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-[color:var(--color-muted-foreground)]">
                      {step.at ? formatDateTime(step.at) : null}
                      {step.at && step.detail ? " · " : null}
                      {step.detail}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <Card>
            <SectionHeader title="Message" />
            <dl className="grid grid-cols-1 gap-x-4 gap-y-4 text-sm sm:grid-cols-2">
              <Field label="Database Message ID" value={<Mono>{message.id}</Mono>} />
              <Field label="WhatsApp Message ID" value={<Mono>{message.whatsappMessageId}</Mono>} />
              <Field label="Account" value={message.account.label} />
              <Field label="Group" value={message.group?.name ?? "—"} />
              <Field label="Group WhatsApp ID" value={<Mono>{message.group?.whatsappGroupId ?? "—"}</Mono>} />
              <Field label="Sender" value={message.senderName ?? "—"} />
              <Field
                label="Sender Phone/Identifier"
                value={
                  <>
                    <Mono>{message.senderPhone}</Mono>
                    {message.isFromTeamMember ? (
                      <span className="ml-1.5">
                        <Badge color="blue">Team Member</Badge>
                      </span>
                    ) : null}
                  </>
                }
              />
              <Field label="Direction" value={message.direction} />
              <Field label="WhatsApp Timestamp" value={formatDateTime(message.timestampWa)} />
              <Field label="Received At" value={formatDateTime(message.receivedAt)} />
              <Field
                label="Processing Status"
                value={
                  <Badge color={message.processingStatus === "IGNORED" ? "gray" : "green"} dot>
                    {message.processingStatus}
                  </Badge>
                }
              />
            </dl>
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">Message Body</p>
              <p className="whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]">
                {message.body}
              </p>
            </div>
          </Card>

          <Card>
            <SectionHeader title="Rule Evaluation & Decision" />
            {execution ? (
              <>
                <dl className="mb-4 grid grid-cols-1 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
                  <Field label="Decision" value={<Badge color={decisionColor(execution.decision)}>{execution.decision}</Badge>} />
                  <Field label="Matched Rule" value={execution.rule?.name ?? "None (NO_MATCH)"} />
                  <Field label="Evaluated At" value={formatDateTime(execution.matchedAt)} />
                </dl>
                <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">
                  Actions Executed
                </p>
                <ul className="mb-4 space-y-1 text-sm text-[color:var(--color-foreground)]">
                  {actionsExecuted.length === 0 ? <li className="text-[color:var(--color-muted-foreground)]">None</li> : null}
                  {actionsExecuted.map((a, i) => (
                    <li key={i}>
                      <span className="font-medium">{a.type}</span> —{" "}
                      {a.executed ? "executed" : "not executed"}: {a.reason}
                    </li>
                  ))}
                </ul>
                <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">
                  Full Rule Trace
                </p>
                <ul className="space-y-1.5 text-sm">
                  {trace.map((t, i) => (
                    <li
                      key={i}
                      className={
                        t.applied
                          ? "rounded-[var(--radius-md)] border border-[var(--color-success-border)] bg-[var(--color-success-bg)] p-2.5 font-medium text-[color:var(--color-success-fg)] shadow-[var(--shadow-xs)]"
                          : "p-2.5 text-[color:var(--color-muted-foreground)]"
                      }
                    >
                      {t.ruleName} (priority {t.priority ?? "—"}) — {t.matched ? "matched" : "not matched"}
                      {t.applied ? " (applied)" : ""}: {t.reason}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No rule evaluation recorded for this message.
              </p>
            )}
          </Card>

          {message.aiFallbackDecision ? (
            <Card>
              <SectionHeader
                title="AI Fallback"
                description="Only reachable after a genuine rule-engine miss — see apps/worker/src/aiFallback/."
              />
              <dl className="grid grid-cols-1 gap-x-4 gap-y-4 text-sm sm:grid-cols-2">
                <Field
                  label="Outcome"
                  value={
                    <Badge color={message.aiFallbackDecision.outcome === "AI_REPLIED" ? "green" : "yellow"} dot>
                      {message.aiFallbackDecision.outcome}
                    </Badge>
                  }
                />
                <Field label="Provider" value={message.aiFallbackDecision.aiProvider?.name ?? "—"} />
                <Field label="Model" value={<Mono>{message.aiFallbackDecision.modelId ?? "—"}</Mono>} />
                <Field label="Intent" value={message.aiFallbackDecision.intent ?? "—"} />
                <Field
                  label="Confidence"
                  value={message.aiFallbackDecision.confidenceScore != null ? `${message.aiFallbackDecision.confidenceScore}%` : "—"}
                />
                <Field label="Reason" value={message.aiFallbackDecision.reason ?? "—"} />
                <Field
                  label="Outbound"
                  value={
                    message.aiFallbackDecision.outboundMessage ? (
                      <Badge color={outboundStatusColor(message.aiFallbackDecision.outboundMessage.status)} dot>
                        {message.aiFallbackDecision.outboundMessage.status}
                      </Badge>
                    ) : (
                      "Not sent (human fallback)"
                    )
                  }
                />
              </dl>
              {message.aiFallbackDecision.responseText ? (
                <div className="mt-4">
                  <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">Response</p>
                  <p className="whitespace-pre-wrap rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 text-sm text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]">
                    {message.aiFallbackDecision.responseText}
                  </p>
                </div>
              ) : null}
              <div className="mt-4">
                <p className="mb-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)]">Learning</p>
                {evidence ? (
                  <p className="text-sm text-[color:var(--color-foreground)]">
                    Recorded as{" "}
                    <Badge color="blue">{evidence.responseSource}</Badge>-sourced evidence on{" "}
                    <Link href={`/conversation-learning/pattern-candidates/${evidence.patternCandidate.id}`} className="underline">
                      this pattern candidate
                    </Link>
                    .{" "}
                    {evidence.patternCandidate.proposal
                      ? `Rule proposal: ${evidence.patternCandidate.proposal.status}.`
                      : "No rule proposal yet."}
                    {evidence.patternCandidate.proposal?.createdRule
                      ? ` Resulting rule status: ${evidence.patternCandidate.proposal.createdRule.status}${
                          evidence.patternCandidate.proposal.createdRule.status === "ACTIVE"
                            ? " — future matching messages are now handled without AI."
                            : " (not yet activated)."
                        }`
                      : ""}
                  </p>
                ) : (
                  <p className="text-sm text-[color:var(--color-muted-foreground)]">
                    Not yet processed by Conversation Learning (evidence-linking runs on a background
                    batch cadence).
                  </p>
                )}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <SectionHeader title="Auto-Reply" />
            {message.outboundReplies.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No outbound message was created for this incoming message.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {message.outboundReplies.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 shadow-[var(--shadow-xs)]"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge color={outboundStatusColor(r.status)} dot>
                        {r.status}
                      </Badge>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">{r.actionType}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-[color:var(--color-foreground)]">{r.body}</p>
                    <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">
                      Attempts: {r.attemptCount} · Sent: {r.sentAt ? formatDateTime(r.sentAt) : "—"}
                      {r.failureReason ? ` · Failure: ${r.failureReason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <SectionHeader title="Notifications" />
            {message.notifications.length === 0 ? (
              <p className="text-sm text-[color:var(--color-muted-foreground)]">
                No notification was triggered for this message.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {message.notifications.map((n) => (
                  <li
                    key={n.id}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 shadow-[var(--shadow-xs)]"
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <Badge color={outboundStatusColor(n.status)} dot>
                        {n.status}
                      </Badge>
                      <span className="text-xs text-[color:var(--color-muted-foreground)]">
                        {n.type} → {n.destination}
                      </span>
                    </div>
                    <p className="text-xs text-[color:var(--color-muted-foreground)]">
                      Attempts: {n.attemptCount} · Sent: {n.sentAt ? formatDateTime(n.sentAt) : "—"}
                      {n.failureReason ? ` · Failure: ${n.failureReason}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <p className="mt-4 text-xs">
        <Link
          href="/messages"
          className="inline-flex items-center gap-1 text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)] hover:underline"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to All Messages
        </Link>
      </p>
    </div>
  );
}

function decisionColor(decision: string): BadgeColor {
  if (decision === "SUPPORT_REQUIRED") return "red";
  if (decision === "AUTO_REPLY" || decision === "ACTIONED") return "green";
  if (decision === "IGNORE" || decision === "STOPPED") return "gray";
  return "yellow"; // NO_MATCH
}

function outboundStatusColor(status: string): BadgeColor {
  if (status === "SENT") return "green";
  if (status === "FAILED") return "red";
  return "yellow";
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-[family-name:var(--font-mono)] text-xs">{children}</span>;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 text-[color:var(--color-foreground)]">{value}</dd>
    </div>
  );
}
