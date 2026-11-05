import { describe, expect, it } from "vitest";
import {
  allowedInBulkRetry,
  canTransition,
  classifyReplyFailure,
  decideFailedReplyRetry,
  failedReplyState,
  FAILED_REPLY_MAX_MANUAL_RETRIES,
  type RetryFacts,
} from "../failedReplies.js";

const facts = (over: Partial<RetryFacts> = {}): RetryFacts => ({
  source: "WHATSAPP",
  state: "FAILED",
  category: "PROVIDER_REFUSED",
  manualRetryCount: 0,
  connectionStatus: "CONNECTED",
  automationPausedForThis: false,
  echoSeen: false,
  confirmedUncertain: false,
  ...over,
});

describe("failedReplyState", () => {
  it("lists only failed or retried rows; a resolution applies within those", () => {
    expect(failedReplyState({ source: "WHATSAPP", status: "SENT", resolution: null, manualRetryCount: 0 })).toBeNull();
    expect(failedReplyState({ source: "WHATSAPP", status: "SENT", resolution: "RESOLVED", manualRetryCount: 0 })).toBeNull();
    expect(failedReplyState({ source: "WHATSAPP", status: "CANCELLED", resolution: null, manualRetryCount: 0 })).toBeNull();
    expect(failedReplyState({ source: "WHATSAPP", status: "FAILED", resolution: null, manualRetryCount: 0 })).toBe("FAILED");
    expect(failedReplyState({ source: "WHATSAPP", status: "SKIPPED", resolution: "CLOSED", manualRetryCount: 0 })).toBe("CLOSED");
    expect(failedReplyState({ source: "WHATSAPP", status: "PENDING", resolution: null, manualRetryCount: 1 })).toBe("RETRYING");
    expect(failedReplyState({ source: "WHATSAPP", status: "SENT", resolution: null, manualRetryCount: 1 })).toBe("RESOLVED");
    expect(failedReplyState({ source: "WHATSAPP", status: "CANCELLED", resolution: null, manualRetryCount: 1 })).toBe("FAILED");
    expect(failedReplyState({ source: "CHANNEL", status: "UNKNOWN", resolution: null, manualRetryCount: 0 })).toBe("FAILED");
    expect(failedReplyState({ source: "CHANNEL", status: "READ", resolution: null, manualRetryCount: 2 })).toBe("RESOLVED");
    expect(failedReplyState({ source: "CHANNEL", status: "SENDING", resolution: null, manualRetryCount: 1 })).toBe("RETRYING");
  });
});

describe("classifyReplyFailure", () => {
  it("names delivery uncertainty first, then the recorded reason", () => {
    expect(classifyReplyFailure({ source: "WHATSAPP", status: "FAILED", failureReason: "Provider is not connected.", deliveryUncertain: true })).toBe("DELIVERY_UNCERTAIN");
    expect(classifyReplyFailure({ source: "WHATSAPP", status: "FAILED", failureReason: "Provider is not connected.", deliveryUncertain: false })).toBe("NOT_CONNECTED");
    expect(classifyReplyFailure({ source: "WHATSAPP", status: "SKIPPED", failureReason: "Membership could not be verified.", deliveryUncertain: false })).toBe("NOT_IN_CHAT");
    expect(classifyReplyFailure({ source: "WHATSAPP", status: "RATE_LIMITED", failureReason: null, deliveryUncertain: false })).toBe("RATE_LIMITED");
    expect(classifyReplyFailure({ source: "WHATSAPP", status: "FAILED", failureReason: "The sending WhatsApp account belongs to a different project, so the message was not sent.", deliveryUncertain: false })).toBe("WRONG_ACCOUNT");
    expect(classifyReplyFailure({ source: "CHANNEL", status: "UNKNOWN", failureReason: "timeout", deliveryUncertain: true })).toBe("DELIVERY_UNCERTAIN");
    expect(classifyReplyFailure({ source: "CHANNEL", status: "FAILED", failureReason: "The access token expired", deliveryUncertain: false })).toBe("CHANNEL_CREDENTIAL");
  });
});

describe("decideFailedReplyRetry", () => {
  it("allows a certain failure on a connected account", () => {
    expect(decideFailedReplyRetry(facts())).toEqual({ ok: true });
  });

  it("an uncertain one needs confirmation, and is refused outright when the chat shows it arrived", () => {
    expect(decideFailedReplyRetry(facts({ category: "DELIVERY_UNCERTAIN" }))).toMatchObject({ ok: false, needsConfirmation: true });
    expect(decideFailedReplyRetry(facts({ category: "DELIVERY_UNCERTAIN", confirmedUncertain: true }))).toEqual({ ok: true });
    const echoed = decideFailedReplyRetry(facts({ category: "DELIVERY_UNCERTAIN", confirmedUncertain: true, echoSeen: true }));
    expect(echoed.ok).toBe(false);
    expect(echoed).not.toHaveProperty("needsConfirmation", true);
  });

  it("refuses every state but FAILED, a disconnected or missing account, paused automation, another workspace's account, and the retry limit", () => {
    for (const state of ["RETRYING", "RESOLVED", "CLOSED", null] as const) expect(decideFailedReplyRetry(facts({ state })).ok).toBe(false);
    expect(decideFailedReplyRetry(facts({ connectionStatus: "DISCONNECTED" })).ok).toBe(false);
    expect(decideFailedReplyRetry(facts({ connectionStatus: null })).ok).toBe(false);
    expect(decideFailedReplyRetry(facts({ automationPausedForThis: true })).ok).toBe(false);
    expect(decideFailedReplyRetry(facts({ category: "WRONG_ACCOUNT" })).ok).toBe(false);
    expect(decideFailedReplyRetry(facts({ manualRetryCount: FAILED_REPLY_MAX_MANUAL_RETRIES })).ok).toBe(false);
    expect(decideFailedReplyRetry(facts({ manualRetryCount: FAILED_REPLY_MAX_MANUAL_RETRIES - 1 })).ok).toBe(true);
  });

  it("bulk retry never includes an uncertain reply, even one a person would be allowed to confirm", () => {
    expect(allowedInBulkRetry(facts())).toBe(true);
    expect(allowedInBulkRetry(facts({ category: "DELIVERY_UNCERTAIN", confirmedUncertain: true }))).toBe(false);
  });
});

describe("canTransition", () => {
  it("resolve and close from FAILED only; reopen from RESOLVED or CLOSED only", () => {
    expect(canTransition("FAILED", "RESOLVE")).toBe(true);
    expect(canTransition("RETRYING", "CLOSE")).toBe(false);
    expect(canTransition("CLOSED", "REOPEN")).toBe(true);
    expect(canTransition("FAILED", "REOPEN")).toBe(false);
  });
});
