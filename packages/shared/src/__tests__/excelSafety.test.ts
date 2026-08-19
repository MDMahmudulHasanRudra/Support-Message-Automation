import { describe, expect, it } from "vitest";
import { sanitizeExcelCell, sanitizeExcelRow } from "../excelSafety.js";

describe("sanitizeExcelCell", () => {
  it("leaves an ordinary string untouched", () => {
    expect(sanitizeExcelCell("Greeting Rule")).toBe("Greeting Rule");
  });

  it("leaves an empty string untouched", () => {
    expect(sanitizeExcelCell("")).toBe("");
  });

  for (const dangerous of ["=SUM(A1:A9)", "+1+1", "-1+1", "@SUM(1,2)", "\ttab", "\rcr"]) {
    it(`prefixes a leading quote for a value starting with a dangerous character (${JSON.stringify(dangerous)})`, () => {
      const result = sanitizeExcelCell(dangerous);
      expect(result).toBe(`'${dangerous}`);
      // The neutralized value must never be interpretable as a formula/command on reopen.
      expect(result.startsWith("'")).toBe(true);
    });
  }

  it("does not neutralize a dangerous character that isn't the first one", () => {
    expect(sanitizeExcelCell("a=b")).toBe("a=b");
  });
});

describe("sanitizeExcelRow", () => {
  it("sanitizes only string fields, leaving numbers/booleans/null untouched", () => {
    const row = { name: "=cmd", priority: 10, active: true, note: null as unknown as string };
    const sanitized = sanitizeExcelRow(row);
    expect(sanitized.name).toBe("'=cmd");
    expect(sanitized.priority).toBe(10);
    expect(sanitized.active).toBe(true);
    expect(sanitized.note).toBeNull();
  });

  it("does not mutate the original row object", () => {
    const row = { name: "=cmd" };
    const sanitized = sanitizeExcelRow(row);
    expect(row.name).toBe("=cmd");
    expect(sanitized.name).toBe("'=cmd");
  });
});
