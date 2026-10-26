import { describe, expect, it } from "vitest";
import { aiDisclosureText, decideAiDisclosure, DEFAULT_AI_DISCLOSURE_TEXT, isAiDisclosureChannel, validateAiDisclosureIdleHours, validateAiDisclosureText, withAiDisclosure } from "../aiDisclosure.js";

const at = (h: number) => new Date(Date.UTC(2026, 9, 25, 0, 0, 0) + h * 3_600_000);
const base = { enabled: true, lastDisclosedAt: at(0), humanRepliedSince: false, previousMessageAt: at(1), answeringAt: at(1.1), idleHours: 24 };

describe("decideAiDisclosure", () => {
  it("never discloses while switched off — the original behaviour", () => {
    expect(decideAiDisclosure({ ...base, enabled: false, lastDisclosedAt: null })).toBeNull();
  });
  it("discloses on the first AI reply of a conversation", () => {
    expect(decideAiDisclosure({ ...base, lastDisclosedAt: null, previousMessageAt: null })).toBe("FIRST");
  });
  it("does not repeat itself inside a live conversation", () => {
    expect(decideAiDisclosure(base)).toBeNull();
  });
  it("discloses again when automation takes over after a person replied", () => {
    expect(decideAiDisclosure({ ...base, humanRepliedSince: true })).toBe("AFTER_HUMAN");
  });
  it("discloses again after the connection's quiet spell, and not just short of it", () => {
    expect(decideAiDisclosure({ ...base, previousMessageAt: at(2), answeringAt: at(26) })).toBe("AFTER_IDLE");
    expect(decideAiDisclosure({ ...base, previousMessageAt: at(2), answeringAt: at(25.9) })).toBeNull();
    expect(decideAiDisclosure({ ...base, idleHours: 6, previousMessageAt: at(2), answeringAt: at(8) })).toBe("AFTER_IDLE");
  });
  it("has no quiet-spell rule at all when the connection sets 0 (Meta gives no number)", () => {
    expect(decideAiDisclosure({ ...base, idleHours: 0, previousMessageAt: at(2), answeringAt: at(2 + 24 * 30) })).toBeNull();
  });
  it("applies to Messenger and Instagram only", () => {
    expect(isAiDisclosureChannel("MESSENGER")).toBe(true);
    expect(isAiDisclosureChannel("INSTAGRAM")).toBe(true);
    expect(isAiDisclosureChannel("TELEGRAM")).toBe(false);
    expect(isAiDisclosureChannel("WHATSAPP")).toBe(false);
  });
});

describe("wording", () => {
  it("uses the built-in text unless the connection has its own", () => {
    expect(aiDisclosureText(null)).toBe(DEFAULT_AI_DISCLOSURE_TEXT);
    expect(aiDisclosureText("   ")).toBe(DEFAULT_AI_DISCLOSURE_TEXT);
    expect(aiDisclosureText(" এটি একটি স্বয়ংক্রিয় উত্তর। ")).toBe("এটি একটি স্বয়ংক্রিয় উত্তর।");
  });
  it("puts the disclosure on its own line above the answer", () => {
    expect(withAiDisclosure("Automated.", "Restart the router.")).toBe("Automated.\n\nRestart the router.");
  });
  it("accepts 0-720 whole hours for the quiet spell", () => {
    expect(validateAiDisclosureIdleHours(0)).toBeNull();
    expect(validateAiDisclosureIdleHours(720)).toBeNull();
    expect(validateAiDisclosureIdleHours(721)).toMatch(/to 720/);
    expect(validateAiDisclosureIdleHours(1.5)).toBeTruthy();
  });
  it("refuses a disclosure too long to sit above a reply", () => {
    expect(validateAiDisclosureText("x".repeat(301))).toMatch(/under 300/);
    expect(validateAiDisclosureText("")).toBeNull();
  });
});
