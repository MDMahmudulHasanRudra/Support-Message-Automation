import { describe, expect, it } from "vitest";
import {
  clampRepeatMinutes,
  DEFAULT_UNABLE_TO_UNDERSTAND_REPLY,
  isAcknowledgementOnly,
  isUnableToUnderstandReason,
  resolveUnableToUnderstandReply,
  validateUnableToUnderstandReply,
} from "../unableToUnderstand.js";

describe("which handovers send the holding reply", () => {
  it.each([
    "MEDIA_ONLY_MESSAGE",
    "NO_KNOWLEDGE",
    "NO_KNOWLEDGE: forge integration disabled",
    "NO_BUSINESS_KNOWLEDGE",
    "AI_DECLINED",
    "EMPTY_RESPONSE",
    "LOW_CONFIDENCE",
    "LOW_CONFIDENCE_GENERAL",
    "INVENTED_PROCEDURE",
  ])("%s — the AI had no reliable answer", (reason) => {
    expect(isUnableToUnderstandReason(reason)).toBe(true);
  });

  it.each([
    "SAFETY_BLOCKED: Per-client hourly reply limit reached (60/60).",
    "SAFETY_BLOCKED: Auto-reply cooldown is active for this client and rule (300s).",
    "AI_UNAVAILABLE",
    "AI_ERROR: 529 overloaded",
    "MALFORMED_RESPONSE",
    "TRUNCATED_RESPONSE",
    "SOMETHING_ADDED_LATER",
    "NO_KNOWLEDGEABLE", // a prefix match must stop at a word boundary
  ])("%s — the system stopped it, so the customer is not told they were not understood", (reason) => {
    expect(isUnableToUnderstandReason(reason)).toBe(false);
  });
});

describe("the wording", () => {
  it("falls back to the default when nothing (or only whitespace) is saved", () => {
    expect(resolveUnableToUnderstandReply(null)).toBe(DEFAULT_UNABLE_TO_UNDERSTAND_REPLY);
    expect(resolveUnableToUnderstandReply("   \n ")).toBe(DEFAULT_UNABLE_TO_UNDERSTAND_REPLY);
    expect(resolveUnableToUnderstandReply("  Please wait, our team will reply.  ")).toBe("Please wait, our team will reply.");
  });

  it("stores blank and the default itself as null, so it keeps tracking the default", () => {
    expect(validateUnableToUnderstandReply("  ")).toEqual({ ok: true, value: null });
    expect(validateUnableToUnderstandReply(` ${DEFAULT_UNABLE_TO_UNDERSTAND_REPLY} `)).toEqual({ ok: true, value: null });
  });

  it("keeps a custom message, line breaks included", () => {
    expect(validateUnableToUnderstandReply("Sorry!\r\nA colleague will reply shortly.")).toEqual({
      ok: true,
      value: "Sorry!\nA colleague will reply shortly.",
    });
  });

  it("refuses an over-long message and a placeholder that would reach the customer literally", () => {
    expect(validateUnableToUnderstandReply("x".repeat(1001)).ok).toBe(false);
    expect(validateUnableToUnderstandReply("Hi {{name}}, please wait").ok).toBe(false);
  });

  it("clamps the repeat window", () => {
    expect(clampRepeatMinutes(-5)).toBe(0);
    expect(clampRepeatMinutes(99999)).toBe(1440);
    expect(clampRepeatMinutes(Number.NaN)).toBe(30);
  });
});

describe("messages that are not a question at all", () => {
  it.each(["ok", "Ok vai", "thanks!", "Thank you bhai 🙏", "ধন্যবাদ ভাইয়া", "ঠিক আছে", "জি", "👍👍", "Assalamualaikum", "hello?", "  "])(
    "%s — a holding reply would be wrong",
    (body) => {
      expect(isAcknowledgementOnly(body)).toBe(true);
    },
  );

  it.each(["ok but my internet is down", "bill kivabe dibo", "আমার লাইন কাজ করছে না", "thanks, why is my speed slow?", "router"])(
    "%s — a real message",
    (body) => {
      expect(isAcknowledgementOnly(body)).toBe(false);
    },
  );
});
