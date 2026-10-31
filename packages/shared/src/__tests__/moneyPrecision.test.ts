import { describe, expect, it } from "vitest";
import { parseAmount } from "../clientBilling.js";
import { parsePaymentAmount, toMinor } from "../clientPayments.js";
import { storedPrecisionRefusal } from "../currencyCatalog.js";

/**
 * V5 §8: invoices and payments are stored to two decimals. An amount is either stored exactly or refused with
 * the reason — never rounded, never through floating point. Three-decimal currencies (KWD, OMR, BHD, JOD) can be
 * recorded when the third decimal is zero; a real third decimal stays closed for posting.
 */
describe("money is stored exactly or refused", () => {
  it("accepts zeros past the second decimal as the same value, and refuses a real third decimal", () => {
    expect(toMinor("2.550")).toBe(255n);
    expect(toMinor("2.5")).toBe(250n);
    expect(toMinor("1,250.50")).toBe(125050n);
    expect(toMinor("2.555")).toBeNull();
    expect(toMinor("2.5551")).toBeNull();
  });

  it("explains a three-decimal currency's limit instead of rounding", () => {
    expect(parsePaymentAmount("2.550", "KWD")).toEqual({ ok: true, minor: 255n });
    const r = parsePaymentAmount("2.555", "KWD");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/KWD has 3 decimal places.*stored to 2.*nothing is rounded/);
    expect(storedPrecisionRefusal("7.355", "USD")).toMatch(/USD has at most 2 decimal places/);
    expect(storedPrecisionRefusal("7.35", "KWD")).toBeNull();
  });

  it("parses a due amount with string arithmetic only", () => {
    expect(parseAmount("1,250.5")).toEqual({ ok: true, value: "1250.50" });
    expect(parseAmount("0012.30")).toEqual({ ok: true, value: "12.30" });
    expect(parseAmount("9999999999.99")).toEqual({ ok: true, value: "9999999999.99" });
    expect(parseAmount("10000000000")).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
    expect(parseAmount("0.00")).toMatchObject({ ok: false, error: expect.stringMatching(/more than zero/) });
    expect(parseAmount("2.555")).toMatchObject({ ok: false });
    expect(parseAmount("")).toEqual({ ok: true, value: null });
  });
});
