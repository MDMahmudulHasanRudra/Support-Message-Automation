import { describe, expect, it } from "vitest";
import { containsWholeWord, derivePatternSignature, normalizeText } from "@support-automation/engine";
import { bandByRelevance, rankByBm25, type Bm25Document } from "../aiFallback/bm25.js";
import { rankRelevantKnowledge, selectRelevantKnowledge } from "../aiFallback/knowledgeContext.js";

/**
 * The ranking that decides which verified knowledge is put in front of a customer.
 *
 * Pure — no database, no model. Every test here pairs the new behaviour with the OLD scorer
 * (reimplemented inline at the bottom, because it no longer exists in the codebase and comparing a
 * rewrite against itself proves nothing) and asserts they disagree. That is the point: each case
 * below is a defect the count-based ranker had, not a preference about tuning.
 */

function entry(over: Partial<Candidate> & { id: string }): Candidate {
  return {
    title: "Untitled",
    question: null,
    answer: "Some answer.",
    procedure: null,
    module: null,
    sourceGroupId: null,
    ...over,
  };
}

interface Candidate {
  id: string;
  title: string;
  question: string | null;
  answer: string;
  procedure: string | null;
  module?: string | null;
  sourceGroupId: string | null;
}

const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe("term rarity decides, not raw match count", () => {
  it("prefers the entry matching the RARE word over the one matching the ubiquitous one", () => {
    // Every entry here is about billing, so "billing" tells you nothing about which one to use.
    // "prorated" appears once and is the entire reason the customer is asking.
    //
    // Under the old ranker both candidates matched exactly one keyword, so they tied, and the tie
    // fell through to `id.localeCompare` — which is a comparison of two cuids. The wrong entry won
    // for no reason other than its identifier.
    const candidates = [
      entry({ id: "a-common", title: "Billing overview", answer: "General billing information." }),
      entry({ id: "b-rare", title: "Prorated charges", answer: "How a prorated charge is worked out." }),
      entry({ id: "c", title: "Billing dates", answer: "Billing runs monthly." }),
      entry({ id: "d", title: "Billing contact", answer: "Who to ask about billing." }),
      entry({ id: "e", title: "Billing history", answer: "Where to find past billing records." }),
      entry({ id: "f", title: "Billing export", answer: "Exporting billing data." }),
    ];

    const picked = selectRelevantKnowledge("prorated billing", candidates, null, 1);
    expect(ids(picked)).toEqual(["b-rare"]);

    // And the old scorer really did pick the other one.
    expect(oldRankingIds("prorated billing", candidates)[0]).toBe("a-common");
  });

  it("never lets a word shared by everything push an entry DOWN", () => {
    // Robertson's original IDF turns negative once a term is in more than half the corpus. Summed
    // across terms that means a common word SUBTRACTS, so the entry matching both the common word
    // and the rare one could score below entries matching only the common one — punished for
    // mentioning the customer's subject too popularly. The `1 +` inside the log floors it at zero.
    const candidates = [
      entry({ id: "both", title: "Internet OTP", answer: "Internet OTP delivery." }),
      entry({ id: "common-1", title: "Internet A", answer: "Internet service A." }),
      entry({ id: "common-2", title: "Internet B", answer: "Internet service B." }),
      entry({ id: "common-3", title: "Internet C", answer: "Internet service C." }),
    ];

    expect(selectRelevantKnowledge("internet otp", candidates, null, 1)[0]!.id).toBe("both");
  });
});

describe("length no longer buys relevance", () => {
  it("prefers the short exact entry over the long rambling one that matches the same words", () => {
    // Both match both query terms. The long one matches them because it is long.
    const shortPrecise = entry({
      id: "z-short",
      title: "Reset router",
      answer: "Hold the reset button for ten seconds.",
    });
    const longRambling = entry({
      id: "a-long",
      title: "Everything about our services",
      answer: [
        "We cover many topics in this article including account setup, moving house, adding a",
        "second line, holiday suspensions, paper statements, direct debit changes, complaints",
        "handling, referral credit, engineer visits, and how you might reset a router if needed.",
        "There is also guidance on speed tests, cabling, wall sockets, filters, extenders and",
        "quite a lot of other equipment that is not relevant to most people most of the time.",
      ].join(" "),
    });

    expect(selectRelevantKnowledge("reset router", [longRambling, shortPrecise], null, 1)[0]!.id).toBe("z-short");
    // The old ranker tied them at one keyword each and picked by cuid, which favours "a-long".
    expect(oldRankingIds("reset router", [longRambling, shortPrecise])[0]).toBe("a-long");
  });

  it("does not penalise an entry for carrying a step list", () => {
    // The regression that flat BM25 introduced and BM25F removes. Concatenating every field into
    // one document makes the entry WITH a procedure longer, so length normalisation demotes it for
    // holding exactly the content that makes it the better answer to a "how do I" question.
    // BM25F measures each field against others of its own kind, so the steps add signal instead.
    const withSteps = entry({
      id: "z-steps",
      title: "Package upgrade",
      answer: "Package upgrade is available.",
      procedure: "1. Open Billing\n2. Select Package\n3. Confirm",
    });
    const withoutSteps = entry({
      id: "a-plain",
      title: "Package upgrade",
      answer: "Package upgrade is available.",
    });

    expect(selectRelevantKnowledge("package upgrade", [withoutSteps, withSteps], null, 1)[0]!.id).toBe("z-steps");
  });
});

describe("repetition saturates", () => {
  it("counts ten mentions as more than one, but nothing like ten times more", () => {
    const once: Bm25Document = {
      id: "once",
      fields: { title: "", question: "", answer: normalizeText("invoice padding padding padding padding"), procedure: "" },
    };
    const tenTimes: Bm25Document = {
      id: "ten",
      fields: { title: "", question: "", answer: normalizeText("invoice ".repeat(10).trim()), procedure: "" },
    };
    // A third document so "invoice" is not in literally every document, which would floor its IDF.
    const neither: Bm25Document = {
      id: "none",
      fields: { title: "", question: "", answer: normalizeText("something else entirely here"), procedure: "" },
    };

    const scored = rankByBm25([once, tenTimes, neither], ["invoice"]);
    const scoreOf = (id: string) => scored.find((row) => row.id === id)!.score;

    expect(scoreOf("ten")).toBeGreaterThan(scoreOf("once"));
    // The whole point of k1: a keyword-stuffed entry cannot simply out-shout a good one.
    expect(scoreOf("ten")).toBeLessThan(scoreOf("once") * 10);
  });
});

describe("where a term appears matters", () => {
  it("weighs a match in the customer-phrased question above one buried in prose", () => {
    const inQuestion = entry({
      id: "z-question",
      title: "Article",
      question: "How do I change my wifi password?",
      answer: "Details follow in the sections below for various settings.",
    });
    const inAnswer = entry({
      id: "a-answer",
      title: "Article",
      question: null,
      answer: "Somewhere in here we mention that you can change your wifi password among other things.",
    });

    expect(selectRelevantKnowledge("change wifi password", [inAnswer, inQuestion], null, 1)[0]!.id).toBe("z-question");
  });
});

describe("what must not change", () => {
  const candidates = [
    entry({ id: "k1", title: "Receipt printer offline", answer: "Reinstall the printer driver." }),
    entry({ id: "k2", title: "Stock sync schedule", answer: "Inventory syncs nightly at 2am." }),
    entry({ id: "k3", title: "Refund window", answer: "Refunds within fourteen days." }),
  ];

  it("returns the same SET of relevant entries as the old ranker, only in a better order", () => {
    // The guarantee this change is confined by: recall is untouched. The relevance test is still
    // whole-word over the same pattern-signature vocabulary; only the ordering vocabulary is wider.
    for (const question of ["receipt printer stopped working", "when does inventory sync", "refund window please"]) {
      const now = new Set(ids(selectRelevantKnowledge(question, candidates, null, 10)));
      const before = new Set(oldRankingIds(question, candidates));
      expect(now).toEqual(before);
    }
  });

  it("keeps bestOverlap an integer count of matched signature keywords", () => {
    // `isStrongEnough` compares this against 2 to decide whether to spend a completion on query
    // expansion. If ranking had started reporting a BM25 score here, or the count over the wider
    // ranking vocabulary, that threshold would have moved silently.
    const result = rankRelevantKnowledge("receipt printer stopped working", candidates, null, 10);
    expect(Number.isInteger(result.bestOverlap)).toBe(true);

    const { keywords } = derivePatternSignature("receipt printer stopped working");
    const maxByHand = Math.max(
      ...candidates.map(
        (candidate) =>
          keywords.filter((keyword) =>
            containsWholeWord(
              normalizeText(`${candidate.title} ${candidate.question ?? ""} ${candidate.answer} ${candidate.procedure ?? ""}`),
              keyword,
            ),
          ).length,
      ),
    );
    expect(result.bestOverlap).toBe(maxByHand);
  });

  it("returns nothing when no entry shares a distinctive word", () => {
    expect(selectRelevantKnowledge("where is my delivery van", candidates, null)).toEqual([]);
  });

  it("is deterministic regardless of the order candidates arrive in", () => {
    // The same question must always build the same prompt, or an unexpected AI answer cannot be
    // reproduced.
    const forwards = ids(selectRelevantKnowledge("printer driver reinstall", candidates, null, 3));
    const backwards = ids(selectRelevantKnowledge("printer driver reinstall", [...candidates].reverse(), null, 3));
    expect(backwards).toEqual(forwards);
  });
});

describe("relevance bands", () => {
  it("treats near-equal scores as one band and a real gap as a new one", () => {
    const bands = bandByRelevance([
      { id: "a", score: 10, matchedTerms: 2 },
      { id: "b", score: 9.9, matchedTerms: 2 },
      { id: "c", score: 5, matchedTerms: 1 },
    ]);
    expect(bands.get("a")).toBe(0);
    expect(bands.get("b")).toBe(0);
    expect(bands.get("c")).toBe(1);
  });

  it("does not let a long gentle slope chain into one enormous band", () => {
    // Each step is within the epsilon of the one before it, but the run as a whole is not — which
    // is exactly why "within 2%" cannot be used as a sort comparator (it is not transitive) and is
    // measured from each band's own leader instead.
    const bands = bandByRelevance(
      [10, 9.9, 9.79, 9.68, 9.57].map((score, index) => ({ id: `s${index}`, score, matchedTerms: 1 })),
    );
    expect(bands.get("s0")).toBe(0);
    expect(bands.get("s1")).toBe(0);
    expect(bands.get("s4")).toBeGreaterThan(0);
  });
});

/**
 * The scorer this replaces: count how many of at most five pattern-signature keywords appear
 * whole-word anywhere in the flattened entry, sort by that count, break ties on procedure, then
 * same-group, then cuid.
 *
 * Reimplemented here rather than imported because it is gone. A test that compared the new ranking
 * against itself would pass no matter what the new ranking did.
 */
function oldRankingIds(customerMessage: string, candidates: Candidate[]): string[] {
  const { keywords } = derivePatternSignature(customerMessage);
  if (keywords.length === 0) return [];
  return candidates
    .map((candidate) => {
      const haystack = normalizeText(
        `${candidate.title} ${candidate.question ?? ""} ${candidate.answer} ${candidate.procedure ?? ""}`,
      );
      return {
        candidate,
        overlap: keywords.filter((keyword) => containsWholeWord(haystack, keyword)).length,
        hasProcedure: Boolean(candidate.procedure?.trim()),
      };
    })
    .filter((row) => row.overlap > 0)
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      if (a.hasProcedure !== b.hasProcedure) return a.hasProcedure ? -1 : 1;
      return a.candidate.id.localeCompare(b.candidate.id);
    })
    .map((row) => row.candidate.id);
}
