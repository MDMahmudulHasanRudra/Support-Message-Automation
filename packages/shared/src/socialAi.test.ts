import { describe, expect, it } from "vitest";
import { buildSocialAiPrompt, parseSocialAiOptions, SOCIAL_AI_SEPARATOR, validateSocialAiInput } from "./socialAi.js";

describe("AI Content Studio requests", () => {
  it("validates what each kind needs", () => {
    expect(validateSocialAiInput({ kind: "NOPE" }).ok).toBe(false);
    expect(validateSocialAiInput({ kind: "CAPTION" }).ok).toBe(false);
    expect(validateSocialAiInput({ kind: "REWRITE", brief: "x" }).ok).toBe(false);
    expect(validateSocialAiInput({ kind: "ADAPT", text: "Hello" }).ok).toBe(false);
    const ok = validateSocialAiInput({ kind: "CAPTION", brief: "Eid sale", count: 99, tone: "nonsense", productIds: ["clx0000000001", "bad id"] });
    expect(ok.ok && ok.value).toMatchObject({ count: 5, tone: "friendly", language: "same", productIds: ["clx0000000001"] });
    const review = validateSocialAiInput({ kind: "EVALUATE", text: "Draft", count: 4 });
    expect(review.ok && review.value.count).toBe(1);
  });

  it("forbids inventing facts, and gives only the chosen products' facts", () => {
    const input = validateSocialAiInput({ kind: "CAPTION", brief: "New arrivals", platform: "INSTAGRAM", count: 2 });
    if (!input.ok) throw new Error("invalid");
    const prompt = buildSocialAiPrompt(input.value, [{ name: "Blue Shirt", price: "BDT 1,200.00", description: "Cotton" }], "Shop");
    expect(prompt.systemPrompt).toMatch(/NEVER invent a fact/);
    expect(prompt.systemPrompt).toMatch(/at most 30 hashtags/);
    expect(prompt.systemPrompt).toContain(SOCIAL_AI_SEPARATOR);
    expect(prompt.userPrompt).toContain("PRODUCT FACTS");
    expect(prompt.userPrompt).toContain("Blue Shirt — price BDT 1,200.00");
    const none = buildSocialAiPrompt(input.value, [], null);
    expect(none.userPrompt).not.toContain("PRODUCT FACTS");
  });

  it("reads the options, and a review stays one answer", () => {
    const text = `Option 1: "First caption"\n===\nSecond caption\n\n===\nThird`;
    expect(parseSocialAiOptions(text, "CAPTION", 2)).toEqual(["First caption", "Second caption"]);
    expect(parseSocialAiOptions("Looks good.\n===\nStill one", "EVALUATE", 3)).toEqual(["Looks good.\n===\nStill one"]);
    expect(parseSocialAiOptions("   ", "CAPTION", 3)).toEqual([]);
  });
});
