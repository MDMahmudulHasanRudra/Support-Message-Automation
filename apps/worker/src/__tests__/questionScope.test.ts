import { describe, expect, it } from "vitest";
import {
  AUTO_REPLY_LANGUAGE,
  AUTO_TIEBREAK_LANGUAGE,
  FALLBACK_REPLY_LANGUAGE,
  describeReplyLanguage,
} from "@support-automation/shared";
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
      knowledge: [{ id: "k", title: "t", question: null, answer: "a", module: null, fromSameGroup: false, version: 1, scope: "GLOBAL" as const, procedure: null }],
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

  it("does not let the Bengali-script rule contradict the other-script rule", () => {
    // Both lines can claim a Bengali-script message, and they give different answers whenever the
    // configured language is not itself Bengali script — which is exactly what picking Banglish
    // does. The narrowing on line 3 is what keeps them from disagreeing.
    const systemPrompt = prompt({ defaultReplyLanguage: "Banglish (Bengali written in Latin letters)" })
      .systemPrompt;
    expect(systemPrompt).toMatch(/non-Latin script other than Bengali/i);
  });
});

/**
 * Automatic detection: mirror the customer instead of leaning on a configured language.
 *
 * Worth its own block because it is a different checklist, not the same one with a value swapped
 * in — the two modes disagree about what an ambiguous message means, so every ordering assumption
 * has to be re-pinned rather than inherited.
 */
describe("buildFallbackPrompt — automatic language detection", () => {
  const auto = (overrides: Partial<Parameters<typeof buildFallbackPrompt>[0]> = {}) =>
    buildFallbackPrompt({
      customerMessage: "hello",
      groupName: null,
      defaultReplyLanguage: AUTO_REPLY_LANGUAGE,
      ...overrides,
    });

  it("never prints the sentinel into the prompt", () => {
    // The failure this guards is silent and total: the model is politely told to answer in a
    // language called "__auto__", and picks something.
    expect(auto().systemPrompt).not.toContain(AUTO_REPLY_LANGUAGE);
  });

  it("tells the model to mirror the customer rather than naming a default", () => {
    const systemPrompt = auto().systemPrompt;
    expect(systemPrompt).toMatch(/Automatic detection is on/i);
    expect(systemPrompt).toMatch(/same language AND the same script/i);
  });

  it("still checks greetings before fluent English", () => {
    // The one ordering both modes must share. Without it "hello" reads as an English sentence,
    // which is the original bug — and it would come back unnoticed in this mode alone.
    const systemPrompt = auto().systemPrompt;
    const greeting = systemPrompt.indexOf("A greeting or a single word");
    const english = systemPrompt.indexOf("complete, fluent sentence or question in English");
    expect(greeting).toBeGreaterThan(-1);
    expect(english).toBeGreaterThan(-1);
    expect(greeting).toBeLessThan(english);
  });

  it("checks script before anything script-blind", () => {
    // Bengali script is an unambiguous signal; the greeting rule is not. Reading the greeting
    // rule first would answer a Bengali-script "হ্যালো" in Latin letters.
    const systemPrompt = auto().systemPrompt;
    const bengaliScript = systemPrompt.indexOf("Written in Bengali script?");
    const greeting = systemPrompt.indexOf("A greeting or a single word");
    expect(bengaliScript).toBeGreaterThan(-1);
    expect(bengaliScript).toBeLessThan(greeting);
  });

  it("keeps Banglish in Latin letters instead of converting it", () => {
    // The specific thing asked for: a customer writing Banglish gets Banglish back — not Bengali
    // script, and not English.
    const systemPrompt = auto().systemPrompt;
    expect(systemPrompt).toContain("bill kivabe generate korbo");
    expect(systemPrompt).toMatch(/Do NOT switch to Bengali script/i);
    expect(systemPrompt).toMatch(/do NOT answer in English/i);
  });

  it("resolves a signal-free message rather than leaving it open", () => {
    const systemPrompt = auto().systemPrompt;
    expect(systemPrompt).toContain(AUTO_TIEBREAK_LANGUAGE);
    expect(systemPrompt).toMatch(/carry no language signal/i);
  });

  it("keeps the scope rules and the response format intact", () => {
    // A second checklist must not cost the guard that stops the model inventing company policy.
    const built = auto();
    expect(built.systemPrompt).toContain("BUSINESS_SPECIFIC");
    expect(built.userPrompt).toContain("LANGUAGE:");
    expect(built.userPrompt).toContain("six lines");
  });

  it("is not triggered by an ordinary language name", () => {
    expect(buildFallbackPrompt({ customerMessage: "hi", groupName: null, defaultReplyLanguage: "English" })
      .systemPrompt).not.toMatch(/Automatic detection is on/i);
  });
});

describe("describeReplyLanguage — prompts that talk about the setting", () => {
  it("renders the sentinel as a phrase, never as a language name", () => {
    // The communication-style prompt says "The assistant writes in X"; X must be a sentence
    // fragment that reads correctly, not "__auto__".
    expect(describeReplyLanguage(AUTO_REPLY_LANGUAGE)).toBe("whichever language the customer used");
    expect(describeReplyLanguage(AUTO_REPLY_LANGUAGE)).not.toContain("_");
  });

  it("passes a real language through unchanged", () => {
    expect(describeReplyLanguage("English")).toBe("English");
  });

  it("falls back rather than returning an empty phrase", () => {
    expect(describeReplyLanguage("")).toBe(FALLBACK_REPLY_LANGUAGE);
    expect(describeReplyLanguage(null)).toBe(FALLBACK_REPLY_LANGUAGE);
    expect(describeReplyLanguage(undefined)).toBe(FALLBACK_REPLY_LANGUAGE);
  });
});

/**
 * How the answer is written, as opposed to what it may be drawn from.
 *
 * Worth pinning separately because the two are independent and get confused: the response mode
 * decides which sources are allowed, this decides the shape of the reply. A procedure answered
 * from verified knowledge alone should read exactly the same as one answered with the product
 * source behind it — making the formatting depend on the mode would mean the same question got a
 * worse-written answer under a stricter setting, which is incoherent.
 */
describe("buildFallbackPrompt — answering with steps", () => {
  const prompt = (overrides: Partial<Parameters<typeof buildFallbackPrompt>[0]> = {}) =>
    buildFallbackPrompt({ customerMessage: "kivabe payment korbo?", groupName: null, ...overrides });

  it("asks for the steps in the order they are done, naming what to click", () => {
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toMatch(/steps in the order they are/i);
    expect(systemPrompt).toMatch(/opens or clicks/i);
  });

  it("refuses invented steps in the strongest terms it uses anywhere", () => {
    // The risk this instruction creates. Asked for confident navigation, a model will happily
    // invent a screen — the Forge work already caught it producing five confident answers about a
    // module from zero bytes of source. A wrong click sends somebody hunting through software they
    // already find confusing.
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toContain("NEVER INVENT A STEP");
    expect(systemPrompt).toMatch(/hand over for the rest/i);
  });

  it("does not let the friendly tone outrank the language or scope rules", () => {
    // Style is subordinate everywhere else in this prompt; it has to stay subordinate here too.
    const systemPrompt = prompt().systemPrompt;
    const language = systemPrompt.indexOf("LANGUAGE.");
    const howToWrite = systemPrompt.indexOf("HOW TO WRITE THE ANSWER");
    const scope = systemPrompt.indexOf("You must also decide the SCOPE");
    expect(language).toBeGreaterThan(-1);
    expect(howToWrite).toBeGreaterThan(language);
    expect(scope).toBeGreaterThan(howToWrite);
  });

  it("puts a stored procedure in front of the model", () => {
    // AiKnowledgeItem.procedure was editable on the knowledge form and read by nothing — steps
    // typed into it reached no customer. This is the assertion that it now arrives.
    const built = prompt({
      knowledge: [
        {
          id: "k1",
          title: "Taking a payment",
          question: null,
          answer: "Payments are recorded against the customer's bill.",
          procedure: "Billing list → Payment → Pay → enter amount → choose account → Submit",
          module: null, fromSameGroup: false, version: 1, scope: "GLOBAL" as const
        },
      ],
    });

    expect(built.userPrompt).toContain("Steps:");
    expect(built.userPrompt).toContain("Billing list → Payment → Pay");
  });

  it("omits the steps line entirely when no procedure was written", () => {
    const built = prompt({
      knowledge: [
        { id: "k1", title: "T", question: null, answer: "A", procedure: null, module: null, fromSameGroup: false, version: 1, scope: "GLOBAL" as const },
      ],
    });
    expect(built.userPrompt).not.toContain("Steps:");
  });
});

describe("parseFallbackResponse — metadata must never reach the customer", () => {
  it("stops the reply at the first metadata line that follows it", () => {
    // The model is asked for six lines in a fixed order, and at temperature 0 it almost always
    // obliges. `RESPONSE:` was extracted with `[\s\S]+` — everything to the end of the string — so
    // the one time it does not oblige, the leftover metadata is sent to the customer verbatim.
    // Nothing else in the pipeline inspects the reply text before it is queued.
    const parsed = parseFallbackResponse(
      ["INTENT: greeting", "SCOPE: GENERAL", "RESPONSE: hello there", "CONFIDENCE: 95", "SHOULD_REPLY: YES"].join("\n"),
    );

    expect(parsed.responseText).toBe("hello there");
    // The metadata is still read from wherever it appears — cutting the reply short must not cost
    // us the fields the gates depend on.
    expect(parsed.confidence).toBe(95);
    expect(parsed.shouldReply).toBe(true);
  });

  it("stops at every one of the five markers", () => {
    for (const marker of ["INTENT", "SCOPE", "LANGUAGE", "CONFIDENCE", "SHOULD_REPLY"]) {
      const parsed = parseFallbackResponse(
        ["CONFIDENCE: 95", "SHOULD_REPLY: YES", "RESPONSE: the real answer", `${marker}: leaked`].join("\n"),
      );
      expect(parsed.responseText, marker).toBe("the real answer");
    }
  });

  it("keeps a multi-line reply intact", () => {
    // The cut must be at a metadata LINE, never at the first colon — ordinary replies contain
    // colons, arrows and numbered steps, and truncating one mid-procedure would be worse than the
    // leak it is guarding against.
    const reply = "Here is how:\n1. Open Billing\n2. Press Pay\nThat is all.";
    const parsed = parseFallbackResponse(
      ["CONFIDENCE: 95", "SHOULD_REPLY: YES", `RESPONSE: ${reply}`].join("\n"),
    );
    expect(parsed.responseText).toBe(reply);
  });
});

describe("parseFallbackResponse — confidence must be a real percentage", () => {
  it("accepts the whole valid range", () => {
    for (const value of [0, 1, 50, 95, 100]) {
      const parsed = parseFallbackResponse(
        [`CONFIDENCE: ${value}`, "SHOULD_REPLY: YES", "RESPONSE: hi"].join("\n"),
      );
      expect(parsed.confidence, String(value)).toBe(value);
    }
  });

  it("treats a value outside 0-100 as malformed rather than clamping it", () => {
    // Clamping turned a garbled line into MAXIMUM confidence, which then cleared the 90% threshold
    // and sent the reply. A number the model could not have meant is evidence the format broke,
    // and a broken format is exactly what MALFORMED_RESPONSE exists to catch — null is what
    // runAiFallback reads as that.
    for (const value of ["900", "101", "-1", "-50"]) {
      const parsed = parseFallbackResponse(
        [`CONFIDENCE: ${value}`, "SHOULD_REPLY: YES", "RESPONSE: hi"].join("\n"),
      );
      expect(parsed.confidence, value).toBeNull();
    }
  });

  it("still reports a missing confidence line as null", () => {
    expect(parseFallbackResponse("SHOULD_REPLY: YES\nRESPONSE: hi").confidence).toBeNull();
  });
});
