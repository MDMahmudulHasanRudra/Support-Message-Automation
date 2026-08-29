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
