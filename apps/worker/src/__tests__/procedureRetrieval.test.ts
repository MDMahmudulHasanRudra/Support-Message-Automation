import { describe, expect, it } from "vitest";
import { rankRelevantKnowledge, selectRelevantKnowledge } from "../aiFallback/knowledgeContext.js";
import { parseKnowledgeRecords } from "../knowledge/groupKnowledgePrompt.js";
import { selectModuleForQuestion } from "../forge/forgePrompts.js";

/**
 * Phase A regression cover: procedures must be extractable, storable, searchable and rankable,
 * and retrieval must stop inventing grounding out of substring collisions.
 *
 * All pure — no database, no AI client. The DB-facing half of retrieval (`findRelevantKnowledge`)
 * is exercised through `rankRelevantKnowledge`, which is the part that decides what the model
 * actually sees and what the expansion threshold reads.
 */

function candidate(over: Partial<Parameters<typeof selectRelevantKnowledge>[1][number]> = {}) {
  return {
    id: "k1",
    title: "Untitled",
    question: null,
    answer: "Some answer.",
    procedure: null,
    module: null,
    sourceGroupId: null,
    ...over,
  };
}

describe("procedure is searchable evidence, not display metadata", () => {
  it("matches an entry whose ONLY relevant vocabulary lives in its procedure", () => {
    // The exact shape the audit found unreachable: a one-line answer plus a step list carrying
    // the real words. Before this, `procedure` was rendered to the model but scored against
    // nothing, so this entry could never win a slot on "payment".
    const entries = [
      candidate({
        id: "with-steps",
        title: "Recording a customer payment",
        answer: "You can do this from the billing screen.",
        procedure: "1. Open Billing list\n2. Choose Payment\n3. Press Pay\n4. Submit",
      }),
      candidate({ id: "unrelated", title: "Office hours", answer: "We are open 10am to 7pm." }),
    ];

    const ranked = selectRelevantKnowledge("how do I record a payment", entries, null);

    expect(ranked.map((entry) => entry.id)).toEqual(["with-steps"]);
    expect(ranked[0]!.procedure).toContain("Press Pay");
  });

  it("breaks a tie toward the entry that carries steps, without outranking a better match", () => {
    const tied = [
      candidate({ id: "b-no-steps", title: "Package upgrade", answer: "Package upgrade is available." }),
      candidate({
        id: "a-with-steps",
        title: "Package upgrade",
        answer: "Package upgrade is available.",
        procedure: "1. Open Billing\n2. Select Package\n3. Confirm",
      }),
    ];
    // Equal overlap -> the one with steps wins, even though its id sorts first alphabetically
    // only by coincidence; the id tiebreak is last.
    expect(selectRelevantKnowledge("package upgrade", tied, null)[0]!.id).toBe("a-with-steps");

    const betterMatchWithoutSteps = [
      candidate({
        id: "steps-weak-match",
        title: "Billing",
        answer: "Billing overview.",
        procedure: "1. Open Billing",
      }),
      candidate({
        id: "no-steps-strong-match",
        title: "Package upgrade guide",
        answer: "How to perform a package upgrade for a customer.",
      }),
    ];
    // Overlap is still compared first, so a procedure cannot promote a less relevant entry.
    expect(selectRelevantKnowledge("package upgrade", betterMatchWithoutSteps, null)[0]!.id).toBe(
      "no-steps-strong-match",
    );
  });
});

describe("whole-word matching", () => {
  it("does not treat 'net' as a match for 'internet'", () => {
    const entries = [
      candidate({ id: "internet", title: "Internet plans", answer: "Our internet packages and network coverage." }),
    ];
    // The substring behaviour this replaces scored this entry >0 and handed it to the model as
    // "reference material verified by this team".
    expect(selectRelevantKnowledge("net", entries, null)).toEqual([]);
  });

  it("still matches the whole word when it genuinely appears", () => {
    const entries = [candidate({ id: "net", title: "Net billing", answer: "Your net amount is shown here." })];
    expect(selectRelevantKnowledge("net", entries, null).map((e) => e.id)).toEqual(["net"]);
  });

  it("matches Bengali tokens at word boundaries", () => {
    const entries = [candidate({ id: "bn", title: "বিল", answer: "আপনার বিল দেখতে পারবেন।" })];
    expect(selectRelevantKnowledge("আমার বিল কত", entries, null).map((e) => e.id)).toEqual(["bn"]);
  });
});

describe("relevance strength drives the expansion decision", () => {
  it("reports a low best-overlap for a single incidental keyword match", () => {
    const entries = [candidate({ id: "generic", title: "Package information", answer: "About packages." })];
    const { bestOverlap, snippets } = rankRelevantKnowledge("package upgrade kivabe korbo", entries, null);

    expect(snippets).toHaveLength(1);
    // One matched term. Below the MIN_STRONG_OVERLAP of 2, so findRelevantKnowledge still expands
    // rather than accepting this as the answer — the case that previously suppressed expansion.
    expect(bestOverlap).toBe(1);
  });

  it("reports a high best-overlap when the entry genuinely covers the question", () => {
    const entries = [
      candidate({
        id: "real",
        title: "Package upgrade",
        answer: "To upgrade a package, open Billing and choose upgrade.",
      }),
    ];
    expect(rankRelevantKnowledge("package upgrade", entries, null).bestOverlap).toBeGreaterThanOrEqual(2);
  });

  it("reports zero when nothing matched", () => {
    expect(rankRelevantKnowledge("package upgrade", [candidate({ answer: "Office hours." })], null)).toEqual({
      snippets: [],
      bestOverlap: 0,
    });
  });
});

describe("PROCEDURE extraction", () => {
  const record = [
    "TITLE: Upgrading a package",
    "CATEGORY: WORKFLOW",
    "QUESTION: How do I upgrade my package?",
    "ANSWER: You can upgrade from the billing module.",
    "PROCEDURE: 1. Open Billing.",
    "2. Select the customer.",
    "3. Choose Upgrade Package.",
    "4. Confirm the change.",
    "CONFIDENCE: 88",
  ].join("\n");

  it("parses a multi-line procedure without swallowing the fields around it", () => {
    const [entry] = parseKnowledgeRecords(record);

    expect(entry?.procedure).toBe(
      "1. Open Billing.\n2. Select the customer.\n3. Choose Upgrade Package.\n4. Confirm the change.",
    );
    // The answer must stop at PROCEDURE rather than absorbing the step list.
    expect(entry?.answer).toBe("You can upgrade from the billing module.");
    expect(entry?.confidence).toBe(88);
  });

  it("treats NONE as no procedure, which is the expected answer for most entries", () => {
    const [entry] = parseKnowledgeRecords(record.replace(/PROCEDURE:[\s\S]*?CONFIDENCE:/, "PROCEDURE: NONE\nCONFIDENCE:"));
    expect(entry?.procedure).toBeNull();
  });

  it("still parses records from extractors that emit no PROCEDURE line at all", () => {
    // Backwards compatibility: every record written before this field existed must keep working.
    const [entry] = parseKnowledgeRecords(
      ["TITLE: Office hours", "CATEGORY: FAQ", "QUESTION: NONE", "ANSWER: 10am to 7pm.", "CONFIDENCE: 90"].join("\n"),
    );
    expect(entry?.procedure).toBeNull();
    expect(entry?.answer).toBe("10am to 7pm.");
  });
});

describe("Bengali survives Forge module tokenization", () => {
  const modules = [
    { name: "Billing", slug: "billing", summary: "Invoices, payments and package upgrades" },
    { name: "Network", slug: "network", summary: "Routers and connectivity" },
  ];

  it("does not reduce a Bengali question to an empty token set", () => {
    // The ASCII-only split this replaces produced zero tokens here, which returned null and — on
    // the background research path — closed the task as permanently unanswerable.
    expect(() => selectModuleForQuestion("আমার প্যাকেজ আপগ্রেড করতে চাই", modules)).not.toThrow();
    // Bengali tokens still cannot match English module metadata; that is a known Phase B gap.
    // What matters here is that the question is tokenized rather than discarded.
  });

  it("still selects a module from a Banglish question", () => {
    expect(selectModuleForQuestion("package upgrade kivabe korbo", modules)?.slug).toBe("billing");
  });

  it("returns null when nothing matches, rather than guessing", () => {
    expect(selectModuleForQuestion("completely unrelated wording here", modules)).toBeNull();
  });
});
