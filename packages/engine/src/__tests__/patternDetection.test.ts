import { describe, expect, it } from "vitest";
import {
  computeConfidenceScore,
  derivePatternSignature,
  meetsCandidateFloor,
  scoreConsistency,
  scoreDiversity,
  scoreFrequency,
  scoreRecency,
  scoreResolution,
  scorePatternCandidate,
} from "../patternDetection.js";

describe("derivePatternSignature", () => {
  it("produces the same key regardless of word order", () => {
    const a = derivePatternSignature("internet is very slow today");
    const b = derivePatternSignature("today internet very slow is");
    expect(a.patternKey).toBe(b.patternKey);
  });

  it("drops stopwords and short tokens from the signature", () => {
    const signature = derivePatternSignature("hi please the internet is slow");
    expect(signature.keywords).not.toContain("the");
    expect(signature.keywords).not.toContain("hi");
    expect(signature.keywords).not.toContain("is");
  });

  it("is case/whitespace insensitive via normalizeText", () => {
    const a = derivePatternSignature("  Internet   SLOW  ");
    const b = derivePatternSignature("internet slow");
    expect(a.patternKey).toBe(b.patternKey);
  });

  it("caps the signature at the top 5 distinctive tokens", () => {
    const signature = derivePatternSignature("internet connection speed router modem cable signal disconnected");
    expect(signature.keywords.length).toBeLessThanOrEqual(5);
  });
});

describe("meetsCandidateFloor", () => {
  const thresholds = { minOccurrenceForCandidate: 3, minDistinctGroupsForCandidate: 2, minDistinctClientsForCandidate: 2 };

  it("rejects a single isolated conversation even with high occurrence count elsewhere", () => {
    expect(meetsCandidateFloor({ occurrenceCount: 1, distinctGroupCount: 1, distinctClientCount: 1 }, thresholds)).toBe(false);
  });

  it("rejects when occurrence count clears the floor but group/client diversity does not", () => {
    expect(meetsCandidateFloor({ occurrenceCount: 10, distinctGroupCount: 1, distinctClientCount: 1 }, thresholds)).toBe(false);
  });

  it("accepts once every floor is cleared", () => {
    expect(meetsCandidateFloor({ occurrenceCount: 3, distinctGroupCount: 2, distinctClientCount: 2 }, thresholds)).toBe(true);
  });
});

describe("scoreFrequency", () => {
  it("scores exactly at the floor around the midpoint, not near 100", () => {
    const score = scoreFrequency(3, 3);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(70);
  });

  it("saturates toward 100 well past the floor", () => {
    expect(scoreFrequency(30, 3)).toBeGreaterThan(90);
  });

  it("never exceeds 100", () => {
    expect(scoreFrequency(10_000, 3)).toBeLessThanOrEqual(100);
  });
});

describe("scoreDiversity", () => {
  it("scores low when one dimension is diverse but the other is not", () => {
    // 10 groups (way past the floor of 2) but only 1 client — should still score low.
    const score = scoreDiversity(10, 1, 2, 2);
    expect(score).toBeLessThan(50);
  });

  it("scores higher when both dimensions clear their floors comfortably", () => {
    expect(scoreDiversity(6, 6, 2, 2)).toBeGreaterThan(70);
  });
});

describe("scoreConsistency", () => {
  it("returns 100 for a single piece of evidence (nothing to compare yet)", () => {
    expect(scoreConsistency([["internet", "slow"]])).toBe(100);
  });

  it("scores 100 for identical keyword sets", () => {
    expect(scoreConsistency([["internet", "slow"], ["internet", "slow"]])).toBe(100);
  });

  it("scores low for entirely disjoint keyword sets", () => {
    expect(scoreConsistency([["internet", "slow"], ["payment", "failed"]])).toBe(0);
  });
});

describe("scoreResolution", () => {
  it("returns 0 (not a penalty signal) when no evidence exists", () => {
    expect(scoreResolution(0, 0)).toBe(0);
  });

  it("scores the resolved fraction", () => {
    expect(scoreResolution(3, 6)).toBe(50);
  });
});

describe("scoreRecency", () => {
  it("scores 100 for a pattern seen right now", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    expect(scoreRecency(now, now)).toBe(100);
  });

  it("decays for a pattern not seen in a long time", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const lastSeen = new Date("2025-12-01T00:00:00Z"); // 45 days earlier
    expect(scoreRecency(lastSeen, now)).toBeLessThan(20);
  });
});

describe("computeConfidenceScore", () => {
  const weights = {
    weightFrequency: 25,
    weightDiversity: 20,
    weightConsistency: 20,
    weightResolution: 15,
    weightRecency: 10,
    weightAiConfidence: 10,
  };

  it("falls back to frequencyScore for the AI component when aiConfidenceScore is null (AI-off mode)", () => {
    const withNullAi = computeConfidenceScore(
      { frequencyScore: 80, diversityScore: 80, consistencyScore: 80, resolutionScore: 80, recencyScore: 80, aiConfidenceScore: null, humanVerifiedBoost: 0 },
      weights,
    );
    const withMatchingAi = computeConfidenceScore(
      { frequencyScore: 80, diversityScore: 80, consistencyScore: 80, resolutionScore: 80, recencyScore: 80, aiConfidenceScore: 80, humanVerifiedBoost: 0 },
      weights,
    );
    expect(withNullAi).toBe(withMatchingAi);
  });

  it("never degrades to zero purely because AI never ran", () => {
    const score = computeConfidenceScore(
      { frequencyScore: 90, diversityScore: 90, consistencyScore: 90, resolutionScore: 90, recencyScore: 90, aiConfidenceScore: null, humanVerifiedBoost: 0 },
      weights,
    );
    expect(score).toBeGreaterThan(80);
  });

  it("caps the final score at 100 even with a large humanVerifiedBoost", () => {
    const score = computeConfidenceScore(
      { frequencyScore: 100, diversityScore: 100, consistencyScore: 100, resolutionScore: 100, recencyScore: 100, aiConfidenceScore: 100, humanVerifiedBoost: 50 },
      weights,
    );
    expect(score).toBe(100);
  });
});

describe("scorePatternCandidate", () => {
  it("computes every sub-score and a final confidence score in one call", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const result = scorePatternCandidate(
      {
        occurrenceCount: 6,
        distinctGroupCount: 3,
        distinctClientCount: 3,
        resolvedCount: 4,
        keywordSets: [
          ["internet", "slow"],
          ["internet", "slow"],
          ["internet", "connection"],
        ],
        lastSeenAt: now,
        aiConfidenceScore: null,
        humanVerifiedBoost: 0,
      },
      {
        minOccurrenceForCandidate: 3,
        minDistinctGroupsForCandidate: 2,
        minDistinctClientsForCandidate: 2,
        weightFrequency: 25,
        weightDiversity: 20,
        weightConsistency: 20,
        weightResolution: 15,
        weightRecency: 10,
        weightAiConfidence: 10,
      },
      now,
    );
    expect(result.confidenceScore).toBeGreaterThan(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(100);
  });
});
