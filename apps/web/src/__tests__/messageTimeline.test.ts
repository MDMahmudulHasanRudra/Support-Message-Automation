import { describe, expect, it } from "vitest";
import { buildMessageTimeline, formatStepDuration, type TimelineInput } from "@/lib/messageTimeline";

/**
 * The message page's timeline (P1-07, doc 20 O4): one message's journey from rows that already exist, and
 * the step where it stopped. Pure.
 */

const t = (seconds: number) => new Date(Date.UTC(2026, 10, 5, 10, 0, 0) + seconds * 1000);

function base(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    receivedAt: t(0),
    storedAt: t(2),
    processingStatus: "PROCESSED",
    direction: "INCOMING",
    decision: { at: t(9), decision: "NO_MATCH" },
    ai: { at: t(8), outcome: "AI_REPLIED", latencyMs: 4200 },
    replies: [],
    alerts: [],
    ...over,
  };
}

const sentReply = (over: Partial<TimelineInput["replies"][number]> = {}): TimelineInput["replies"][number] => ({
  actionType: "AUTO_REPLY",
  status: "SENT",
  createdAt: t(9),
  scheduledAt: t(12),
  sentAt: t(14),
  attemptCount: 1,
  failureReason: null,
  echoStoredAt: t(15),
  ...over,
});

describe("buildMessageTimeline", () => {
  it("walks a complete answer in the order it happened, with the time each step took", () => {
    const timeline = buildMessageTimeline(base({ replies: [sentReply()] }));
    expect(timeline.steps.map((s) => s.label)).toEqual([
      "Sent by the customer",
      "Stored",
      "AI answered",
      "Decision recorded",
      "Reply queued",
      "Reply sent",
      "WhatsApp confirmed it",
    ]);
    expect(timeline.steps.map((s) => s.sincePreviousMs)).toEqual([null, 2000, 6000, 1000, 0, 5000, 1000]);
    expect(timeline.stoppedAt).toBeNull();
    expect(timeline.totalMs).toBe(15_000);
    expect(timeline.steps[2]!.detail).toBe("4.2 s to answer");
  });

  it("names a reply still waiting to go out, and why", () => {
    const timeline = buildMessageTimeline(base({ replies: [sentReply({ status: "RATE_LIMITED", sentAt: null, echoStoredAt: null, attemptCount: 3 })] }));
    expect(timeline.stoppedAt).toBe("Reply sent");
    expect(timeline.steps.at(-1)!.detail).toMatch(/^rate limited · 3 attempts · due /);
    expect(timeline.totalMs).toBe(9000); // up to the reply being queued
  });

  it("names a reply that failed, with its reason", () => {
    const timeline = buildMessageTimeline(base({ replies: [sentReply({ status: "FAILED", sentAt: null, echoStoredAt: null, failureReason: "Group membership verification failed." })] }));
    expect(timeline.stoppedAt).toBe("Reply not sent");
    expect(timeline.steps.at(-1)).toMatchObject({ state: "failed", detail: "failed: Group membership verification failed." });
  });

  it("a reply sent but never echoed back stops at WhatsApp's confirmation", () => {
    expect(buildMessageTimeline(base({ replies: [sentReply({ echoStoredAt: null })] })).stoppedAt).toBe("WhatsApp confirmation");
  });

  it("a message that was never meant to be automated is not reported as stuck", () => {
    const timeline = buildMessageTimeline(base({ direction: "OUTGOING", decision: null, ai: null }));
    expect(timeline.steps.at(-1)).toMatchObject({ label: "Rules", state: "skipped" });
    expect(timeline.stoppedAt).toBeNull();
  });

  it("a message still being processed waits at the rules; one that failed says so", () => {
    expect(buildMessageTimeline(base({ processingStatus: "PENDING", decision: null, ai: null })).stoppedAt).toBe("Rules");
    expect(buildMessageTimeline(base({ processingStatus: "FAILED", decision: null, ai: null })).steps.at(-1)!.state).toBe("failed");
  });

  it("reports alerts raised about the message", () => {
    const timeline = buildMessageTimeline(
      base({
        alerts: [
          { type: "WHATSAPP", event: "AI_HUMAN_FALLBACK", status: "SENT", createdAt: t(10), sentAt: t(11), attemptCount: 1, failureReason: null },
          { type: "TEAMS", event: null, status: "FAILED", createdAt: t(10), sentAt: null, attemptCount: 5, failureReason: "Webhook returned 410" },
        ],
      }),
    );
    expect(timeline.steps.slice(-2).map((s) => [s.label, s.state])).toEqual([
      ["WHATSAPP alert (AI_HUMAN_FALLBACK) delivered", "done"],
      ["TEAMS alert not delivered", "failed"],
    ]);
    expect(timeline.stoppedAt).toBe("TEAMS alert not delivered");
  });
});

describe("formatStepDuration", () => {
  it.each([
    [850, "850 ms"],
    [4200, "4.2 s"],
    [180_000, "3 min"],
    [9_000_000, "2.5 h"],
  ])("%d ms -> %s", (ms: number, text: string) => {
    expect(formatStepDuration(ms)).toBe(text);
  });
});
