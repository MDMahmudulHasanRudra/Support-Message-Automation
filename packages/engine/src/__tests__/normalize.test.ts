import { describe, expect, it } from "vitest";
import { normalizeText } from "../normalize.js";

describe("normalizeText", () => {
  it("lowercases and trims English text", () => {
    expect(normalizeText("  Hello World  ")).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeText("Payment   successful")).toBe("payment successful");
  });

  it("leaves Bangla text unaffected by case folding", () => {
    expect(normalizeText("ইন্টারনেট চলছে না")).toBe("ইন্টারনেট চলছে না");
  });

  it("normalizes mixed Banglish/English casing", () => {
    expect(normalizeText("Payment করেছি কিন্তু Balance Update হয়নি")).toBe(
      "payment করেছি কিন্তু balance update হয়নি",
    );
  });

  it("strips zero-width characters that break exact matching", () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const withZeroWidth = `হ্যালো${zeroWidthSpace}`;
    expect(normalizeText(withZeroWidth)).toBe("হ্যালো");
  });
});
