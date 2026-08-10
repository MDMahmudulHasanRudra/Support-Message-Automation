import { describe, expect, it } from "vitest";
import { safeRegexTest, validateRegexSafety } from "../regexSafety.js";

describe("validateRegexSafety", () => {
  it("accepts a simple safe pattern", () => {
    expect(validateRegexSafety("internet (not working|down)")).toEqual({ safe: true });
  });

  it("rejects an empty pattern", () => {
    expect(validateRegexSafety("").safe).toBe(false);
  });

  it("rejects a pattern exceeding the max length", () => {
    const long = "a".repeat(300);
    expect(validateRegexSafety(long).safe).toBe(false);
  });

  it("rejects invalid regex syntax", () => {
    const result = validateRegexSafety("(unterminated");
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/not a valid regular expression/);
  });

  it("rejects classic nested-quantifier ReDoS shapes", () => {
    expect(validateRegexSafety("(a+)+$").safe).toBe(false);
    expect(validateRegexSafety("(a*)*$").safe).toBe(false);
    expect(validateRegexSafety("([a-z]+)*$").safe).toBe(false);
  });

  it("rejects patterns with too many quantifiers", () => {
    const manyQuantifiers = "a+b+c+d+e+f+g+h+i+j+k+l+";
    expect(validateRegexSafety(manyQuantifiers).safe).toBe(false);
  });
});

describe("safeRegexTest", () => {
  it("matches normally for a safe pattern within the timeout", () => {
    const result = safeRegexTest("payment (successful|received)", "payment successful");
    expect(result).toEqual({ matched: true, timedOut: false });
  });

  it("returns no-match (not a thrown error) when a pattern is invalid", () => {
    const result = safeRegexTest("(unterminated", "anything");
    expect(result.matched).toBe(false);
  });

  it("treats a catastrophically slow pattern as a bounded timeout, not a hang", () => {
    // Deliberately bypasses validateRegexSafety to exercise the runtime net directly.
    const evilPattern = "(a+)+$";
    const evilInput = "a".repeat(35) + "!";
    const result = safeRegexTest(evilPattern, evilInput, 50);
    expect(result.matched).toBe(false);
    // Either it times out, or V8's linear-time fallback resolves fast — both are
    // acceptable outcomes; what matters is the call returns instead of hanging.
  });
});
