/**
 * One message's journey, step by step, from the rows that already exist (P1-07, docs/get-assist-ultimate/20 O4):
 * the customer's send → stored → AI (when it ran) → decision recorded → each reply queued → sent → WhatsApp's echo, and each
 * alert raised about it. Nothing new is recorded; the rows are already linked by the message's database id.
 *
 * Pure, so "where did this message stop?" is answered the same way everywhere and is tested without a
 * database. It shows times, durations, decisions and statuses: the page already shows the text to those
 * allowed to read it.
 */

export type StepState = "done" | "waiting" | "failed" | "skipped";

export interface TimelineStep {
  label: string;
  at: Date | null;
  /** Milliseconds since the previous step that has a time; null for the first, or when this step has none. */
  sincePreviousMs: number | null;
  state: StepState;
  detail?: string;
}

export interface MessageTimeline {
  steps: TimelineStep[];
  /** The first step still waiting or failed; null when every step finished. */
  stoppedAt: string | null;
  /** Customer's send → the last finished step. */
  totalMs: number | null;
}

export interface TimelineInput {
  receivedAt: Date;
  storedAt: Date;
  processingStatus: "PENDING" | "PROCESSED" | "IGNORED" | "FAILED";
  direction: string;
  decision: { at: Date; decision: string } | null;
  ai: { at: Date; outcome: string; latencyMs: number | null } | null;
  replies: Array<{
    actionType: string;
    status: string;
    createdAt: Date;
    scheduledAt: Date;
    sentAt: Date | null;
    attemptCount: number;
    failureReason: string | null;
    /** When WhatsApp's copy of the sent reply was stored (the echo); null when none has arrived. */
    echoStoredAt: Date | null;
  }>;
  alerts: Array<{ type: string; event: string | null; status: string; createdAt: Date; sentAt: Date | null; attemptCount: number; failureReason: string | null }>;
}

const REPLY_WAITING = new Set(["PENDING", "PROCESSING", "RATE_LIMITED"]);
const REPLY_FAILED = new Set(["FAILED", "CANCELLED", "SKIPPED"]);
const ALERT_WAITING = new Set(["PENDING", "RETRYING"]);

const attempts = (n: number) => `${n} attempt${n === 1 ? "" : "s"}`;

export function buildMessageTimeline(input: TimelineInput): MessageTimeline {
  const raw: Array<Omit<TimelineStep, "sincePreviousMs">> = [];
  raw.push({ label: input.direction === "INCOMING" ? "Sent by the customer" : "Sent", at: input.receivedAt, state: "done" });
  raw.push({ label: "Stored", at: input.storedAt, state: "done" });

  // The AI runs inside processing, before the decision row is written at its end: chronological order.
  if (input.ai) {
    raw.push({
      label: input.ai.outcome === "AI_REPLIED" ? "AI answered" : "AI handed over to a person",
      at: input.ai.at,
      state: "done",
      detail: input.ai.latencyMs != null ? `${(input.ai.latencyMs / 1000).toFixed(1)} s to answer` : undefined,
    });
  }

  if (input.decision) {
    raw.push({ label: "Decision recorded", at: input.decision.at, state: "done", detail: input.decision.decision });
  } else if (input.direction !== "INCOMING" || input.processingStatus === "IGNORED") {
    raw.push({ label: "Rules", at: null, state: "skipped", detail: "Not automated (our own or a team member's message, or ignored)" });
  } else if (input.processingStatus === "FAILED") {
    raw.push({ label: "Rules", at: null, state: "failed", detail: "Processing failed before a decision was recorded" });
  } else if (input.processingStatus === "PENDING") {
    raw.push({ label: "Rules", at: null, state: "waiting", detail: "Not decided yet" });
  }

  for (const reply of [...input.replies].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    raw.push({ label: "Reply queued", at: reply.createdAt, state: "done", detail: reply.actionType });
    if (reply.sentAt) {
      raw.push({ label: "Reply sent", at: reply.sentAt, state: "done", detail: attempts(reply.attemptCount) });
      raw.push(
        reply.echoStoredAt
          ? { label: "WhatsApp confirmed it", at: reply.echoStoredAt, state: "done", detail: "Its copy came back and was stored" }
          : { label: "WhatsApp confirmation", at: null, state: "waiting", detail: "Sent, but WhatsApp's copy has not come back yet" },
      );
    } else if (REPLY_WAITING.has(reply.status)) {
      raw.push({ label: "Reply sent", at: null, state: "waiting", detail: `${reply.status.replace("_", " ").toLowerCase()} · ${attempts(reply.attemptCount)} · due ${reply.scheduledAt.toISOString()}` });
    } else if (REPLY_FAILED.has(reply.status)) {
      raw.push({ label: "Reply not sent", at: null, state: "failed", detail: `${reply.status.toLowerCase()}${reply.failureReason ? `: ${reply.failureReason}` : ""}` });
    }
  }

  for (const alert of [...input.alerts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const what = alert.event ? `${alert.type} alert (${alert.event})` : `${alert.type} alert`;
    if (alert.sentAt) raw.push({ label: `${what} delivered`, at: alert.sentAt, state: "done", detail: attempts(alert.attemptCount) });
    else if (ALERT_WAITING.has(alert.status)) raw.push({ label: `${what} waiting`, at: null, state: "waiting", detail: attempts(alert.attemptCount) });
    else raw.push({ label: `${what} not delivered`, at: null, state: "failed", detail: alert.failureReason ?? undefined });
  }

  let previous: Date | null = null;
  const steps: TimelineStep[] = raw.map((step) => {
    const sincePreviousMs = step.at && previous ? Math.max(0, step.at.getTime() - previous.getTime()) : null;
    if (step.at) previous = step.at;
    return { ...step, sincePreviousMs };
  });
  const lastDone = [...steps].reverse().find((s) => s.state === "done" && s.at);
  return {
    steps,
    stoppedAt: steps.find((s) => s.state === "waiting" || s.state === "failed")?.label ?? null,
    totalMs: lastDone?.at ? Math.max(0, lastDone.at.getTime() - input.receivedAt.getTime()) : null,
  };
}

/** "850 ms", "4.2 s", "3 min", "2.5 h". */
export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 2 * 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
