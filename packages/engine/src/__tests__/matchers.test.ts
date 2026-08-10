import { describe, expect, it } from "vitest";
import { matchRuleText } from "../matchers.js";
import { normalizeText } from "../normalize.js";

describe("matchRuleText", () => {
  it("EXACT matches a Bangla greeting exactly", () => {
    const rule = { matchType: "EXACT" as const, matchValue: "হ্যালো", keywords: [] };
    expect(matchRuleText(rule, normalizeText("হ্যালো")).matched).toBe(true);
    expect(matchRuleText(rule, normalizeText("হ্যালো!")).matched).toBe(false);
  });

  it("CONTAINS matches an English default message anywhere in the text", () => {
    const rule = { matchType: "CONTAINS" as const, matchValue: "payment successful", keywords: [] };
    expect(
      matchRuleText(rule, normalizeText("Your Payment Successful. Thank you.")).matched,
    ).toBe(true);
    expect(matchRuleText(rule, normalizeText("recharge successful")).matched).toBe(false);
  });

  it("CONTAINS matches a Bangla default confirmation message", () => {
    const rule = {
      matchType: "CONTAINS" as const,
      matchValue: "আপনার পেমেন্ট সফলভাবে গ্রহণ করা হয়েছে",
      keywords: [],
    };
    expect(
      matchRuleText(
        rule,
        normalizeText("সম্মানিত গ্রাহক, আপনার পেমেন্ট সফলভাবে গ্রহণ করা হয়েছে। ধন্যবাদ।"),
      ).matched,
    ).toBe(true);
  });

  it("KEYWORDS matches any of multiple keywords across languages (Banglish included)", () => {
    const rule = {
      matchType: "KEYWORDS" as const,
      matchValue: null,
      keywords: ["হ্যালো", "hello", "hi", "assalamu"],
    };
    expect(matchRuleText(rule, normalizeText("Hi, ami সমস্যায় আছি")).matched).toBe(true);
    expect(matchRuleText(rule, normalizeText("Assalamu Alaikum")).matched).toBe(true);
    expect(matchRuleText(rule, normalizeText("internet not working")).matched).toBe(false);
  });

  it("KEYWORDS does not match a short keyword as a substring of an unrelated word", () => {
    // Regression: "hi" must not match inside "this", nor "or" inside "worker".
    const rule = { matchType: "KEYWORDS" as const, matchValue: null, keywords: ["hi", "or"] };
    expect(matchRuleText(rule, normalizeText("this is a totally unrelated message")).matched).toBe(false);
    expect(matchRuleText(rule, normalizeText("the worker restarted")).matched).toBe(false);
    expect(matchRuleText(rule, normalizeText("hi there")).matched).toBe(true);
    expect(matchRuleText(rule, normalizeText("pay now or later")).matched).toBe(true);
  });

  it("REGEX matches a safe pattern covering PPPoE/OLT support keywords", () => {
    const rule = { matchType: "REGEX" as const, matchValue: "(pppoe|olt) (disconnect|issue|down)", keywords: [] };
    expect(matchRuleText(rule, normalizeText("PPPoE disconnect হচ্ছে")).matched).toBe(true);
    expect(matchRuleText(rule, normalizeText("OLT কাজ করছে না")).matched).toBe(false);
  });

  it("REGEX treats an unsafe pattern as no-match rather than throwing", () => {
    const rule = { matchType: "REGEX" as const, matchValue: "(a+)+$", keywords: [] };
    expect(() => matchRuleText(rule, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).not.toThrow();
    expect(matchRuleText(rule, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!").matched).toBe(false);
  });

  it("ALWAYS matches unconditionally regardless of body", () => {
    const rule = { matchType: "ALWAYS" as const, matchValue: null, keywords: [] };
    expect(matchRuleText(rule, normalizeText("anything at all")).matched).toBe(true);
  });

  it("returns no-match (not a throw) when a rule is missing its configured value", () => {
    expect(
      matchRuleText({ matchType: "EXACT", matchValue: null, keywords: [] }, "text").matched,
    ).toBe(false);
    expect(
      matchRuleText({ matchType: "KEYWORDS", matchValue: null, keywords: [] }, "text").matched,
    ).toBe(false);
  });
});
