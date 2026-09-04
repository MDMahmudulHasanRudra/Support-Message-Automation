import { describe, expect, it } from "vitest";
import { buildStyleProfilePrompt, parseStyleGuidance } from "../knowledge/communicationStylePrompt.js";
import { redactReply } from "../knowledge/communicationStyleJob.js";
import { buildFallbackPrompt } from "../aiFallback/prompt.js";

/** Pure unit tests — no database, no network, no model. */

describe("parseStyleGuidance — manner only, never fact", () => {
  /**
   * The load-bearing distinction in this feature. Style guidance is injected into EVERY customer
   * reply, and a reviewer reading a list of plausible tone notes will very likely wave through a
   * product claim hiding among them. So a claim must not reach the list in the first place.
   */
  const asLines = (...lines: string[]) => lines.map((line) => `- ${line}`).join("\n");

  it("keeps ordinary guidance about manner", () => {
    const guidance = parseStyleGuidance(
      asLines(
        "Open with a short greeting before answering",
        "Keep replies to two or three sentences",
        "Acknowledge the problem before giving the solution",
      ),
    );
    expect(guidance).toContain("Open with a short greeting");
    expect(guidance?.split("\n")).toHaveLength(3);
  });

  it("drops a line that states a duration or quantity", () => {
    const guidance = parseStyleGuidance(
      asLines("Be warm and direct", "Tell them the issue is resolved within 24 hours"),
    );
    expect(guidance).toBe("- Be warm and direct");
  });

  it("drops a line that names pricing or billing behaviour", () => {
    const guidance = parseStyleGuidance(
      asLines("Use the customer's own words back to them", "Explain that the package price includes VAT"),
    );
    expect(guidance).toBe("- Use the customer's own words back to them");
  });

  it("drops a line that promises a capability", () => {
    const guidance = parseStyleGuidance(
      asLines("Stay polite when a customer is frustrated", "Assure them the system will fix it automatically"),
    );
    expect(guidance).toBe("- Stay polite when a customer is frustrated");
  });

  it("drops a line about support hours, which is policy rather than manner", () => {
    const guidance = parseStyleGuidance(asLines("Close by offering further help", "Say the team is available 24/7"));
    expect(guidance).toBe("- Close by offering further help");
  });

  it("returns null when the model reports too little evidence", () => {
    expect(parseStyleGuidance("NOT ENOUGH EVIDENCE")).toBeNull();
    expect(parseStyleGuidance("")).toBeNull();
    expect(parseStyleGuidance("   ")).toBeNull();
  });

  it("returns null when every line was a product claim", () => {
    // Better no guidance at all than guidance made only of the parts that should not be there.
    expect(parseStyleGuidance(asLines("Refunds take 3 days", "The plan costs 500 taka"))).toBeNull();
  });

  it("ignores prose the model wrapped around the list", () => {
    const guidance = parseStyleGuidance(
      ["Here is what I found:", "- Greet the customer by name", "Hope this helps!"].join("\n"),
    );
    expect(guidance).toBe("- Greet the customer by name");
  });

  it("caps the list at eight lines", () => {
    const guidance = parseStyleGuidance(asLines(...Array.from({ length: 20 }, (_, i) => `Habit number ${i} to follow`)));
    expect(guidance?.split("\n")).toHaveLength(8);
  });
});

describe("redactReply — nobody's details reach the model", () => {
  it("removes phone numbers", () => {
    expect(redactReply("Call me on +880 1896-218186 please")).toBe("Call me on [number] please");
  });

  it("removes emails and links", () => {
    expect(redactReply("Mail rudra@softifybd.com or see https://ispdigital.net/help")).toBe(
      "Mail [email] or see [link]",
    );
  });

  it("leaves ordinary prose untouched", () => {
    const text = "Thank you for contacting us. Please share more detail about the problem.";
    expect(redactReply(text)).toBe(text);
  });
});

describe("buildStyleProfilePrompt", () => {
  const prompt = (replies = ["Thanks for reaching out.", "We will check and update you."]) =>
    buildStyleProfilePrompt({ replies, defaultReplyLanguage: "Bengali (Bangla)" });

  it("asks for manner and forbids content", () => {
    const systemPrompt = prompt().systemPrompt;
    expect(systemPrompt).toMatch(/describing MANNER, never CONTENT/i);
    expect(systemPrompt).toMatch(/Never state anything about the product/i);
  });

  it("permits the honest answer of no discernible style", () => {
    expect(prompt().systemPrompt).toContain("NOT ENOUGH EVIDENCE");
  });

  it("leaves the language decision to the language rules", () => {
    // Two systems deciding the reply language would contradict each other on the first Hindi
    // message; the style profile is explicitly told to stay out of it.
    expect(prompt().userPrompt).toMatch(/do not tell it which language/i);
  });
});

describe("style guidance in the reply prompt", () => {
  const withStyle = (styleGuidance: string | null) =>
    buildFallbackPrompt({ customerMessage: "hello", groupName: null, styleGuidance });

  it("includes approved guidance", () => {
    expect(withStyle("- Greet before answering").systemPrompt).toContain("- Greet before answering");
  });

  it("changes nothing when there is no approved guidance", () => {
    // The three states where guidance is absent — off, unbuilt, unapproved — must all behave
    // exactly as the assistant did before this feature existed.
    const before = buildFallbackPrompt({ customerMessage: "hello", groupName: null }).systemPrompt;
    expect(withStyle(null).systemPrompt).toBe(before);
    expect(withStyle("   ").systemPrompt).toBe(before);
  });

  it("subordinates style to the language, scope and factual rules", () => {
    const systemPrompt = withStyle("- Sound reassuring").systemPrompt;
    expect(systemPrompt).toMatch(/never overrides anything above/i);
    expect(systemPrompt).toMatch(/hand over to a human instead of inventing comfort/i);
    // And the rules it must not override are still present.
    expect(systemPrompt).toContain("BUSINESS_SPECIFIC");
    expect(systemPrompt).toContain("LANGUAGE.");
  });
});
