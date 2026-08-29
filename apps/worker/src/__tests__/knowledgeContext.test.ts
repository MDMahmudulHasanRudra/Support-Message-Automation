import { describe, expect, it } from "vitest";
import { selectRelevantKnowledge } from "../aiFallback/knowledgeContext.js";
import { buildFallbackPrompt } from "../aiFallback/prompt.js";

/**
 * Pure unit test — no database. `selectRelevantKnowledge` is the ranking half of the retrieval,
 * split out from the query precisely so it can be exercised here; `buildFallbackPrompt` is
 * likewise pure string assembly.
 */

const PRINTER = {
  id: "k1",
  title: "Receipt printer offline after an update",
  question: "Why did my receipt printer stop working after updating?",
  answer: "Reinstall the printer driver from Settings, then restart the terminal.",
  sourceGroupId: "group-a",
};
const STOCK = {
  id: "k2",
  title: "Stock sync schedule",
  question: "When does inventory sync?",
  answer: "Inventory syncs nightly at 2am; same-day edits appear the next morning.",
  sourceGroupId: "group-b",
};
const REFUND = {
  id: "k3",
  title: "Refund window",
  question: "How long do customers have to request a refund?",
  answer: "Refunds can be requested within fourteen days of purchase.",
  sourceGroupId: null,
};

describe("selectRelevantKnowledge", () => {
  it("returns the entry that shares distinctive words with the question", () => {
    const picked = selectRelevantKnowledge(
      "my receipt printer stopped working after the update",
      [PRINTER, STOCK, REFUND],
      null,
    );

    expect(picked.map((entry) => entry.id)).toEqual(["k1"]);
  });

  it("returns nothing when no entry shares a distinctive word", () => {
    // Nothing in the knowledge base is about delivery vans; an entry that shares no
    // distinctive word is not evidence, and padding the prompt with it would only dilute
    // the entries that do matter.
    const picked = selectRelevantKnowledge("where is my delivery van", [PRINTER, STOCK, REFUND], null);
    expect(picked).toEqual([]);
  });

  it("returns nothing for a message with no distinctive words at all", () => {
    expect(selectRelevantKnowledge("ok thanks", [PRINTER, STOCK, REFUND], null)).toEqual([]);
  });

  it("prefers an entry learned from the same group when relevance ties", () => {
    const sameText = { title: "Sync question", question: null, answer: "Inventory syncs nightly." };
    const fromThisGroup = { ...sameText, id: "a-here", sourceGroupId: "group-x" };
    const fromElsewhere = { ...sameText, id: "b-elsewhere", sourceGroupId: "group-y" };

    const picked = selectRelevantKnowledge("inventory syncs question", [fromElsewhere, fromThisGroup], "group-x");

    expect(picked[0]!.id).toBe("a-here");
    expect(picked[0]!.fromSameGroup).toBe(true);
  });

  it("ranks a stronger keyword overlap above a same-group entry", () => {
    // Relevance is the primary signal; group provenance only breaks ties.
    const weakButLocal = {
      id: "local",
      title: "Printer",
      question: null,
      answer: "Printer notes.",
      sourceGroupId: "group-x",
    };
    const picked = selectRelevantKnowledge(
      "receipt printer offline after updating the terminal",
      [weakButLocal, PRINTER],
      "group-x",
    );

    expect(picked[0]!.id).toBe("k1");
  });

  it("caps how many entries reach the prompt", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `k${i}`,
      title: "Printer driver reinstall",
      question: null,
      answer: "Reinstall the printer driver.",
      sourceGroupId: null,
    }));

    expect(selectRelevantKnowledge("printer driver reinstall", many, null)).toHaveLength(3);
  });

  it("is deterministic when everything ties, so the same question builds the same prompt", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `k${i}`,
      title: "Printer driver reinstall",
      question: null,
      answer: "Reinstall the printer driver.",
      sourceGroupId: null,
    }));

    const first = selectRelevantKnowledge("printer driver reinstall", many, null);
    const second = selectRelevantKnowledge("printer driver reinstall", [...many].reverse(), null);
    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
  });

  it("truncates a very long answer rather than dropping the entry", () => {
    const longAnswer = {
      id: "long",
      title: "Printer driver reinstall",
      question: null,
      answer: `Reinstall the printer driver. ${"x".repeat(2000)}`,
      sourceGroupId: null,
    };

    const picked = selectRelevantKnowledge("printer driver reinstall", [longAnswer], null);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.answer.length).toBeLessThan(800);
    expect(picked[0]!.answer.endsWith("…")).toBe(true);
  });
});

describe("buildFallbackPrompt with knowledge", () => {
  it("is unchanged when there is no relevant knowledge", () => {
    const prompt = buildFallbackPrompt({ customerMessage: "hello", groupName: "Retail POS" });
    expect(prompt.userPrompt).not.toContain("Reference material");
    expect(prompt.systemPrompt).not.toContain("knowledge base");
  });

  it("includes the entries and tells the model to prefer them over its own knowledge", () => {
    const prompt = buildFallbackPrompt({
      customerMessage: "printer offline",
      groupName: "Retail POS",
      knowledge: [
        {
          id: "k1",
          title: "Receipt printer offline",
          question: "Why is it offline?",
          answer: "Reinstall the driver.",
          fromSameGroup: true,
        },
      ],
    });

    expect(prompt.userPrompt).toContain("Reference material");
    expect(prompt.userPrompt).toContain("Receipt printer offline");
    expect(prompt.userPrompt).toContain("Reinstall the driver.");
    expect(prompt.systemPrompt).toContain("Prefer it over your general knowledge");
  });

  it("instructs the model to decline rather than guess past the reference material", () => {
    // The point of grounding: a confident wrong answer is worse for this team than no answer.
    const prompt = buildFallbackPrompt({
      customerMessage: "printer offline",
      groupName: null,
      knowledge: [{ id: "k1", title: "T", question: null, answer: "A", fromSameGroup: false }],
    });

    expect(prompt.systemPrompt).toContain("SHOULD_REPLY");
    expect(prompt.systemPrompt).toMatch(/does not cover the question/i);
  });

  it("still asks for the same four-line answer format", () => {
    const prompt = buildFallbackPrompt({
      customerMessage: "printer offline",
      groupName: null,
      knowledge: [{ id: "k1", title: "T", question: null, answer: "A", fromSameGroup: false }],
    });

    for (const field of ["INTENT:", "CONFIDENCE:", "SHOULD_REPLY:", "RESPONSE:"]) {
      expect(prompt.userPrompt).toContain(field);
    }
  });
});
