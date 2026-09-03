import { describe, expect, it } from "vitest";
import { buildFallbackPrompt, parseFallbackResponse } from "../aiFallback/prompt.js";

/**
 * Pure unit test — no database, no network.
 *
 * These cover the boundary the whole response-mode design rests on: the model knowing an answer
 * is not the same as this software having the authority to give it. Everything here is about
 * making sure an unparseable or evasive response can never be read as permission to speak for
 * the business.
 */

describe("parseFallbackResponse — question scope", () => {
  it("reads an explicit GENERAL scope", () => {
    const result = parseFallbackResponse(
      "INTENT: definition\nSCOPE: GENERAL\nCONFIDENCE: 95\nSHOULD_REPLY: YES\nRESPONSE: PPPoE is a protocol…",
    );
    expect(result.scope).toBe("GENERAL");
  });

  it("reads an explicit BUSINESS_SPECIFIC scope", () => {
    const result = parseFallbackResponse(
      "INTENT: refund policy\nSCOPE: BUSINESS_SPECIFIC\nCONFIDENCE: 88\nSHOULD_REPLY: YES\nRESPONSE: …",
    );
    expect(result.scope).toBe("BUSINESS_SPECIFIC");
  });

  it("falls back to BUSINESS_SPECIFIC when the scope line is missing entirely", () => {
    // An older model, a truncated reply, or a format slip must not silently grant permission
    // to answer for the business.
    const result = parseFallbackResponse(
      "INTENT: refund policy\nCONFIDENCE: 99\nSHOULD_REPLY: YES\nRESPONSE: We refund within 14 days.",
    );
    expect(result.scope).toBe("BUSINESS_SPECIFIC");
  });

  it("falls back to BUSINESS_SPECIFIC for an unrecognised scope value", () => {
    const result = parseFallbackResponse(
      "INTENT: x\nSCOPE: PROBABLY_FINE\nCONFIDENCE: 99\nSHOULD_REPLY: YES\nRESPONSE: y",
    );
    expect(result.scope).toBe("BUSINESS_SPECIFIC");
  });

  it("falls back to BUSINESS_SPECIFIC on an empty scope value", () => {
    const result = parseFallbackResponse("INTENT: x\nSCOPE:\nCONFIDENCE: 99\nSHOULD_REPLY: YES\nRESPONSE: y");
    expect(result.scope).toBe("BUSINESS_SPECIFIC");
  });

  it("accepts a lowercase scope, since only the value's meaning matters", () => {
    const result = parseFallbackResponse(
      "INTENT: x\nscope: general\nCONFIDENCE: 95\nSHOULD_REPLY: YES\nRESPONSE: y",
    );
    expect(result.scope).toBe("GENERAL");
  });

  it("does not let the word GENERAL elsewhere in the reply flip the scope", () => {
    // "GENERAL" appearing inside the drafted answer must not be mistaken for the field.
    const result = parseFallbackResponse(
      "INTENT: x\nSCOPE: BUSINESS_SPECIFIC\nCONFIDENCE: 95\nSHOULD_REPLY: YES\nRESPONSE: In general, contact support.",
    );
    expect(result.scope).toBe("BUSINESS_SPECIFIC");
  });

  it("still parses every other field alongside the new one", () => {
    const result = parseFallbackResponse(
      "INTENT: package change\nSCOPE: GENERAL\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?",
    );
    expect(result).toMatchObject({
      intent: "package change",
      scope: "GENERAL",
      confidence: 96,
      shouldReply: true,
      responseText: "Sure, which package?",
    });
  });
});

describe("buildFallbackPrompt — scope instruction", () => {
  it("asks for the scope and defines both values", () => {
    const prompt = buildFallbackPrompt({ customerMessage: "hello", groupName: "G" });
    expect(prompt.userPrompt).toContain("SCOPE:");
    expect(prompt.systemPrompt).toContain("BUSINESS_SPECIFIC");
    expect(prompt.systemPrompt).toContain("GENERAL");
  });

  it("tells the model to resolve any doubt toward BUSINESS_SPECIFIC", () => {
    // The asymmetry is the point: erring one way costs a short wait, the other way invents
    // company policy in front of a customer.
    const prompt = buildFallbackPrompt({ customerMessage: "hello", groupName: null });
    expect(prompt.systemPrompt).toMatch(/in any doubt.*BUSINESS_SPECIFIC/is);
  });

  it("names account-level questions as business-specific, not just product behaviour", () => {
    const prompt = buildFallbackPrompt({ customerMessage: "hello", groupName: null });
    expect(prompt.systemPrompt).toMatch(/account|invoice/i);
  });

  it("asks for the scope whether or not knowledge was found", () => {
    // The classification decides whether an ungrounded answer is allowed at all, so it is
    // needed precisely when there is no knowledge to fall back on.
    const withKnowledge = buildFallbackPrompt({
      customerMessage: "q",
      groupName: null,
      knowledge: [{ id: "k", title: "t", question: null, answer: "a", fromSameGroup: false }],
    });
    const without = buildFallbackPrompt({ customerMessage: "q", groupName: null });
    expect(withKnowledge.userPrompt).toContain("SCOPE:");
    expect(without.userPrompt).toContain("SCOPE:");
  });
});

describe("buildFallbackPrompt — reply language", () => {
  /**
   * Live customers were answered in Portuguese and transliterated Hindi. The prompt said only "in
   * the customer's own language", so a one-word "Hello" — which carries almost no signal — got
   * whatever the model guessed.
   *
   * Two later attempts failed in the opposite direction, which is why the shape here is what it
   * is. Stating a default and demanding "no doubt" before switching made the model answer clear
   * English and clear Devanagari Hindi in Bengali too. What works is making the model DECIDE the
   * language on its own output line before drafting, against an ordered checklist — the same
   * trick that makes SCOPE reliable. Verified against the real model on all eleven cases below.
   */
  const prompt = (overrides: Partial<Parameters<typeof buildFallbackPrompt>[0]> = {}) =>
    buildFallbackPrompt({ customerMessage: "hello", groupName: null, ...overrides });

  it("names the configured language as the default", () => {
    expect(prompt({ defaultReplyLanguage: "Bengali (Bangla)" }).systemPrompt).toContain("Bengali (Bangla)");
  });

  it("falls back to Bengali when no language is configured", () => {
    // A caller that forgets the setting must still get the safe behaviour, not the model's guess.
    expect(prompt().systemPrompt).toContain("Bengali (Bangla)");
    expect(prompt({ defaultReplyLanguage: "   " }).systemPrompt).toContain("Bengali (Bangla)");
  });

  it("honours a different configured language", () => {
    const systemPrompt = prompt({ defaultReplyLanguage: "Spanish" }).systemPrompt;
    expect(systemPrompt).toContain("Answer in Spanish");
    // The Bengali detection rules stay coherent for any default. Phrasing them in terms of the
    // configured language once produced the line "That is English, not English."
    expect(systemPrompt).not.toMatch(/That is (\w+) rather than English, so answer in \./);
  });

  it("makes the model state the language before drafting", () => {
    // The load-bearing part: without an explicit decision the model just follows the default and
    // answers a Hindi question in Bengali.
    const built = prompt();
    expect(built.systemPrompt).toMatch(/decide which language the customer wrote in/i);
    expect(built.userPrompt).toContain("LANGUAGE:");
    expect(built.userPrompt).toContain("six lines");
  });

  it("checks the ambiguous cases before the English case", () => {
    // Order decides the outcome. With the English rule first, "Hello" was answered in English
    // while "hi" was answered in Bengali — same kind of message, different language.
    const systemPrompt = prompt().systemPrompt;
    const greeting = systemPrompt.indexOf("A greeting or a single word");
    const english = systemPrompt.indexOf("complete, fluent sentence or question in English");
    expect(greeting).toBeGreaterThan(-1);
    expect(english).toBeGreaterThan(-1);
    expect(greeting).toBeLessThan(english);
  });

  it("keeps greetings on the default language", () => {
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toContain("hello");
    expect(systemPrompt).toMatch(/NOT a fluent English sentence/i);
  });

  it("says romanised Bengali is Bengali, not English", () => {
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toContain("bill kivabe generate korbo");
    expect(systemPrompt).toMatch(/Bengali rather than English/i);
  });

  it("allows a real switch for another script and for fluent English", () => {
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toMatch(/non-Latin script/i);
    expect(systemPrompt).toMatch(/Devanagari/i);
    expect(systemPrompt).toMatch(/complete, fluent sentence or question in English/i);
  });

  it("sends numbers, links and mixed messages to the default", () => {
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toMatch(/only a number, a link, an invoice reference/i);
    expect(systemPrompt).toMatch(/mixed languages/i);
  });

  it("keeps the language rules alongside the scope rules rather than replacing them", () => {
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toContain("BUSINESS_SPECIFIC");
    expect(systemPrompt).toContain("LANGUAGE.");
  });
});
