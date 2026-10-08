import { describe, expect, it } from "vitest";
import { DUPLICATE_QUESTION_THRESHOLD, questionSimilarity } from "../patternDetection.js";

/**
 * The duplicate-knowledge warning in the AI Sandbox. It only ever WARNS — the admin decides — so
 * the cost of a miss is a duplicate entry and the cost of a false alarm is one extra click. The
 * cases below are the spec's own example plus the two ways a naive check goes wrong.
 */
describe("questionSimilarity", () => {
  it("the spec's example: a reworded question is flagged", () => {
    expect(questionSimilarity("How can I pay my bill?", "How to pay my bill?")).toBeGreaterThanOrEqual(
      DUPLICATE_QUESTION_THRESHOLD,
    );
  });

  it("extra words in one question do not hide the match", () => {
    expect(
      questionSimilarity("How to pay my bill?", "How can I pay my monthly internet bill online?"),
    ).toBeGreaterThanOrEqual(DUPLICATE_QUESTION_THRESHOLD);
  });

  it("a different question sharing one word is not flagged", () => {
    expect(questionSimilarity("How to pay my bill?", "How to add a Mikrotik router?")).toBeLessThan(
      DUPLICATE_QUESTION_THRESHOLD,
    );
    expect(questionSimilarity("How to pay my bill?", "Why is my bill higher this month?")).toBeLessThan(
      DUPLICATE_QUESTION_THRESHOLD,
    );
  });

  it("a one-word question matches nothing — too little to call a duplicate", () => {
    expect(questionSimilarity("bill?", "How to pay my bill?")).toBe(0);
  });

  it("is symmetric", () => {
    const a = "How do I reset my router password?";
    const b = "Router password reset steps";
    expect(questionSimilarity(a, b)).toBe(questionSimilarity(b, a));
  });
});
