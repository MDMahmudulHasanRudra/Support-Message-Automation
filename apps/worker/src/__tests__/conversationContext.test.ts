import { describe, expect, it } from "vitest";
import { formatConversationTranscript, type ConversationTurn } from "../aiFallback/conversationContext.js";
import { buildFallbackPrompt } from "../aiFallback/prompt.js";
import { expandQueryTerms } from "../aiFallback/queryExpansion.js";
import { MockAiClient } from "./mockAiClient.js";

/** Pure unit tests — no database. The loader's query is exercised by the integration suite. */

const THREAD: ConversationTurn[] = [
  { role: "CUSTOMER", body: "Ekta notun client add korte চাই" },
  { role: "SUPPORT", body: "Customer List theke Add New Customer e jan, tarpor package select korun." },
  { role: "CUSTOMER", body: "Rudra name er client er khetreo ki same process follow hobe?" },
];

describe("formatConversationTranscript", () => {
  it("labels each turn by role and keeps conversation order", () => {
    const transcript = formatConversationTranscript(THREAD);
    expect(transcript.split("\n")).toEqual([
      "[CUSTOMER] Ekta notun client add korte চাই",
      "[SUPPORT] Customer List theke Add New Customer e jan, tarpor package select korun.",
      "[CUSTOMER] Rudra name er client er khetreo ki same process follow hobe?",
    ]);
  });

  it("returns nothing for an empty conversation", () => {
    expect(formatConversationTranscript([])).toBe("");
  });

  it("drops the OLDEST turns when the character cap bites", () => {
    // The newest turns are what the question refers to. Trimming the end would throw away the
    // message being answered and keep small talk from twenty minutes ago.
    const long: ConversationTurn[] = [
      { role: "CUSTOMER", body: "x".repeat(1600) },
      { role: "SUPPORT", body: "the reply that matters" },
      { role: "CUSTOMER", body: "and the question about it" },
    ];
    const transcript = formatConversationTranscript(long);
    expect(transcript).toContain("the reply that matters");
    expect(transcript).toContain("and the question about it");
    expect(transcript).not.toContain("x".repeat(1600));
  });

  it("collapses whitespace so a multi-line paste stays one turn", () => {
    const transcript = formatConversationTranscript([{ role: "CUSTOMER", body: "line one\n\n  line two" }]);
    expect(transcript).toBe("[CUSTOMER] line one line two");
  });
});

describe("buildFallbackPrompt with a conversation", () => {
  it("includes the transcript and marks who said what", () => {
    const prompt = buildFallbackPrompt({
      customerMessage: "Rudra name er client er khetreo ki same process follow hobe?",
      groupName: "Test Group",
      conversation: THREAD,
    });
    expect(prompt.userPrompt).toContain("[SUPPORT] Customer List theke Add New Customer");
    expect(prompt.userPrompt).toContain("Conversation so far");
  });

  it("states that the transcript explains the question but never establishes a fact", () => {
    // The whole risk of giving a model its own past output back: it starts agreeing with itself.
    const system = buildFallbackPrompt({
      customerMessage: "does the same apply?",
      groupName: null,
      conversation: THREAD,
    }).systemPrompt.toLowerCase();

    expect(system).toContain("what is being asked");
    expect(system).toContain("never use it to work out what is true");
    expect(system).toContain("including this system's own");
  });

  it("says nothing about a conversation when there is none", () => {
    const prompt = buildFallbackPrompt({ customerMessage: "hello", groupName: null });
    expect(prompt.userPrompt).not.toContain("Conversation so far");
    expect(prompt.systemPrompt).not.toContain("CONVERSATION SO FAR");
  });
});

describe("expandQueryTerms with a conversation", () => {
  it("sends the earlier turns so a pronoun can be resolved to a subject", () => {
    const client = new MockAiClient();
    client.nextText = "customer, add, create, package";

    return expandQueryTerms(client, "Rudra name er client er khetreo ki same process follow hobe?", THREAD).then(
      (terms) => {
        expect(terms).toEqual(["customer", "add", "create", "package"]);
        const sent = client.requests[0]?.userPrompt ?? "";
        expect(sent).toContain("Conversation so far");
        expect(sent).toContain("Add New Customer");
        expect(sent).toContain("Latest message to search for");
      },
    );
  });

  it("sends the message alone when there is no conversation", () => {
    const client = new MockAiClient();
    client.nextText = "bill, invoice";
    return expandQueryTerms(client, "bill kivabe generate korbo").then(() => {
      expect(client.requests[0]?.userPrompt).toBe("bill kivabe generate korbo");
    });
  });
});
