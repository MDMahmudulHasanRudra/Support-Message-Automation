import { describe, expect, it } from "vitest";
import { expandQueryTerms, parseExpandedTerms } from "../aiFallback/queryExpansion.js";
import { selectRelevantKnowledge } from "../aiFallback/knowledgeContext.js";
import { MockAiClient } from "./mockAiClient.js";
import type { AiClient, AiCompletionRequest, AiCompletionResult } from "@support-automation/ai-client";

/**
 * Pure unit tests — no database, no provider. `parseExpandedTerms` is the half that has to survive
 * whatever shape the model replies in, and `selectRelevantKnowledge` is exercised here for the one
 * thing expansion changes about it: ranking on terms the customer never typed.
 */

describe("parseExpandedTerms", () => {
  it("reads the comma-separated list the model was asked for", () => {
    expect(parseExpandedTerms("bill, invoice, generate, billing")).toEqual([
      "bill",
      "invoice",
      "generate",
      "billing",
    ]);
  });

  it("survives a numbered list, newlines and a preamble", () => {
    // Asking for commas does not guarantee commas; a model that formats its answer as a list is
    // still telling us the right terms, and rejecting it would drop a usable expansion.
    expect(parseExpandedTerms("Keywords:\n1. bkash\n2. payment\n3. delete")).toEqual([
      "bkash",
      "payment",
      "delete",
    ]);
  });

  it("strips quotes and stray punctuation without losing the word", () => {
    expect(parseExpandedTerms('"refund", \'invoice\'.')).toEqual(["refund", "invoice"]);
  });

  it("drops prose that slipped through instead of keywords", () => {
    // A substring search would almost never match a sentence, so keeping it costs a query slot
    // and gains nothing.
    const terms = parseExpandedTerms("the customer wants to know how billing works, invoice");
    expect(terms).toEqual(["invoice"]);
  });

  it("deduplicates and caps the list", () => {
    const terms = parseExpandedTerms("a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a1");
    expect(terms).toHaveLength(8);
    expect(new Set(terms).size).toBe(8);
  });

  it("returns nothing for an empty or contentless reply", () => {
    expect(parseExpandedTerms("")).toEqual([]);
    expect(parseExpandedTerms("   \n  ")).toEqual([]);
  });
});

describe("expandQueryTerms", () => {
  it("asks the model with the customer's question and parses what comes back", async () => {
    const client = new MockAiClient();
    client.nextText = "bill, invoice, generate, billing";

    const terms = await expandQueryTerms(client, "bill kivabe generate korbo");

    expect(terms).toEqual(["bill", "invoice", "generate", "billing"]);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.userPrompt).toBe("bill kivabe generate korbo");
    // Deterministic, or the same question could search for different things on different days.
    expect(client.requests[0]?.temperature).toBe(0);
  });

  it("returns nothing rather than throwing when the provider fails", async () => {
    // The caller is mid-conversation and only reached here because retrieval was already empty:
    // a failure has to degrade to the behaviour that existed before expansion, not to an error.
    const failing: AiClient = {
      async complete(_request: AiCompletionRequest): Promise<AiCompletionResult> {
        throw new Error("provider exploded");
      },
    };

    await expect(expandQueryTerms(failing, "bkash payment delete korbo kivabe")).resolves.toEqual([]);
  });

  it("does not call the provider for a message with nothing to search for", async () => {
    const client = new MockAiClient();
    await expandQueryTerms(client, " ");
    expect(client.requests).toHaveLength(0);
  });
});

describe("selectRelevantKnowledge with expanded terms", () => {
  const BKASH = {
    id: "k1",
    title: "Deleting a bKash payment",
    question: "How do I remove a bKash payment entry?",
    answer: "Open the customer's payment list, select the bKash entry and choose Delete.",
    sourceGroupId: null,
    procedure: null,
  };
  const ROUTER = {
    id: "k2",
    title: "Router provisioning",
    question: "How is a new router provisioned?",
    answer: "Add the device under Network, then push the profile.",
    sourceGroupId: null,
    procedure: null,
  };

  it("ranks an English entry for a Banglish question once the terms are supplied", () => {
    // This is the whole point: the question shares "bkash" and nothing else with the entry, and
    // the words carrying the intent — korbo, kivabe — appear in no English manual.
    const withoutExpansion = selectRelevantKnowledge(
      "Bkash Payment delete korbo kivabe",
      [BKASH, ROUTER],
      null,
    );
    const withExpansion = selectRelevantKnowledge(
      "Bkash Payment delete korbo kivabe",
      [BKASH, ROUTER],
      null,
      3,
      ["bkash", "payment", "delete", "remove"],
    );

    expect(withExpansion.map((entry) => entry.id)).toEqual(["k1"]);
    // The expansion must strictly improve the ranking signal, never reorder away a real match.
    expect(withExpansion[0]?.id).toBe(withoutExpansion[0]?.id ?? "k1");
  });

  it("still returns nothing when the expanded terms match no entry", () => {
    const picked = selectRelevantKnowledge("kono kichu", [BKASH, ROUTER], null, 3, ["delivery", "van"]);
    expect(picked).toEqual([]);
  });
});
