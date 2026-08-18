import { describe, expect, it } from "vitest";
import { matchSupportKeyword } from "../supportKeywordMatch.js";

describe("matchSupportKeyword", () => {
  it("matches case-insensitively by default (CONTAINS)", () => {
    expect(matchSupportKeyword("Issue is Done now", { value: "done", mode: "CONTAINS", caseSensitive: false })).toBe(
      true,
    );
    expect(matchSupportKeyword("DONE", { value: "done", mode: "CONTAINS", caseSensitive: false })).toBe(true);
    expect(matchSupportKeyword("dOnE", { value: "done", mode: "CONTAINS", caseSensitive: false })).toBe(true);
  });

  it("does not match when case-sensitive and casing differs", () => {
    expect(matchSupportKeyword("Done", { value: "done", mode: "CONTAINS", caseSensitive: true })).toBe(false);
    expect(matchSupportKeyword("done", { value: "done", mode: "CONTAINS", caseSensitive: true })).toBe(true);
  });

  it("requires a whole-word match for CONTAINS, not a bare substring", () => {
    expect(matchSupportKeyword("this is fine", { value: "hi", mode: "CONTAINS", caseSensitive: false })).toBe(false);
    expect(matchSupportKeyword("hi there", { value: "hi", mode: "CONTAINS", caseSensitive: false })).toBe(true);
  });

  it("EXACT requires the whole (trimmed) message to equal the keyword", () => {
    expect(matchSupportKeyword("solved", { value: "solved", mode: "EXACT", caseSensitive: false })).toBe(true);
    expect(matchSupportKeyword("  Solved  ", { value: "solved", mode: "EXACT", caseSensitive: false })).toBe(true);
    expect(matchSupportKeyword("problem solved", { value: "solved", mode: "EXACT", caseSensitive: false })).toBe(
      false,
    );
  });

  it("does not match unrelated text", () => {
    expect(matchSupportKeyword("random text here", { value: "done", mode: "CONTAINS", caseSensitive: false })).toBe(
      false,
    );
  });

  it("never matches an empty/blank keyword value", () => {
    expect(matchSupportKeyword("done", { value: "", mode: "CONTAINS", caseSensitive: false })).toBe(false);
    expect(matchSupportKeyword("done", { value: "   ", mode: "CONTAINS", caseSensitive: false })).toBe(false);
  });
});
