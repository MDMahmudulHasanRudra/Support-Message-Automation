import { describe, expect, it } from "vitest";
import { currencyMinorUnits, currencyOfHeader, fitsCurrencyDecimals, ISO_CURRENCY_CODES, readCurrencyName, readMoneyText } from "../currencyCatalog.js";

describe("currency catalogue", () => {
  it("has every current ISO currency, far past the old 30-currency limit, with its own decimals", () => {
    expect(ISO_CURRENCY_CODES.length).toBeGreaterThan(150);
    for (const code of ["SAR", "AED", "OMR", "KWD", "BHD", "QAR", "ZAR", "BDT", "KES", "USD", "JOD"]) expect(ISO_CURRENCY_CODES).toContain(code);
    expect(currencyMinorUnits("KWD")).toBe(3);
    expect(currencyMinorUnits("OMR")).toBe(3);
    expect(currencyMinorUnits("BHD")).toBe(3);
    expect(currencyMinorUnits("JOD")).toBe(3);
    expect(currencyMinorUnits("JPY")).toBe(0);
    expect(currencyMinorUnits("BDT")).toBe(2);
    // No funds, metals or testing codes.
    for (const code of ["XAU", "XDR", "XTS", "XXX", "BOV"]) expect(ISO_CURRENCY_CODES).not.toContain(code);
  });

  it("reads the customer's own column names, and never guesses an ambiguous one", () => {
    expect(readCurrencyName("RAND")).toEqual({ code: "ZAR" });
    expect(readCurrencyName("TK")).toEqual({ code: "BDT" });
    expect(readCurrencyName("KSH")).toEqual({ code: "KES" });
    expect(readCurrencyName("USA")).toEqual({ code: "USD" });
    expect(readCurrencyName("sar")).toEqual({ code: "SAR" });
    expect(readCurrencyName("din")).toEqual({ ambiguous: expect.arrayContaining(["KWD", "BHD", "JOD"]) });
    expect(readCurrencyName("Rial")).toEqual({ ambiguous: expect.arrayContaining(["OMR"]) });
    expect(readCurrencyName("dh")).toEqual({ ambiguous: ["AED", "MAD"] });
    expect(readCurrencyName("$")).toEqual({ ambiguous: expect.arrayContaining(["USD", "CAD"]) });
    expect(readCurrencyName("Name")).toBeNull();
  });

  it("finds the currency in a header only when exactly one currency word is there", () => {
    for (const [header, code] of [["SAR", "SAR"], ["AED", "AED"], ["OMR", "OMR"], ["KWD", "KWD"], ["BHD", "BHD"], ["QAR", "QAR"], ["RAND", "ZAR"], ["TK", "BDT"], ["KSH", "KES"], ["USA", "USD"], ["JOD", "JOD"], ["Amount (AED)", "AED"], ["Paid KWD", "KWD"]] as const) {
      expect(currencyOfHeader(header), header).toEqual({ code });
    }
    expect(currencyOfHeader("Name")).toBeNull();
    expect(currencyOfHeader("Remarks")).toBeNull();
    expect(currencyOfHeader("Order no")).toBeNull(); // "OR" inside a longer header is not Omani rials
    expect(currencyOfHeader("SAR or AED")).toBeNull(); // two currencies: the person decides
  });
});

describe("reading money written as text", () => {
  it("keeps the amount exactly as written, with the currency it names", () => {
    expect(readMoneyText("SAR30.00")).toMatchObject({ kind: "AMOUNT", amount: "30.00", decimals: 2, currency: "SAR", zero: false });
    expect(readMoneyText("dh30.00")).toMatchObject({ kind: "AMOUNT", amount: "30.00", currency: null, ambiguousCurrencies: ["AED", "MAD"] });
    expect(readMoneyText("Rial4.000")).toMatchObject({ kind: "AMOUNT", amount: "4.000", decimals: 3, currency: null });
    expect(readMoneyText("din8.000")).toMatchObject({ kind: "AMOUNT", amount: "8.000", decimals: 3 });
    expect(readMoneyText("din2.550")).toMatchObject({ kind: "AMOUNT", amount: "2.550", decimals: 3 });
    expect(readMoneyText("7.35")).toMatchObject({ kind: "AMOUNT", amount: "7.35", currency: null, ambiguousCurrencies: null });
    expect(readMoneyText("30 KWD")).toMatchObject({ amount: "30", currency: "KWD" });
    expect(readMoneyText("1,250.50")).toMatchObject({ amount: "1250.50" });
    expect(readMoneyText("1,25,000")).toMatchObject({ amount: "125000" });
    expect(readMoneyText("500/-")).toMatchObject({ amount: "500" });
  });

  it("says zero is zero and blank is blank, and never turns words into a number", () => {
    expect(readMoneyText("")).toEqual({ kind: "BLANK" });
    expect(readMoneyText("0.00")).toMatchObject({ kind: "AMOUNT", zero: true });
    expect(readMoneyText("SAR0")).toMatchObject({ kind: "AMOUNT", zero: true });
    expect(readMoneyText("Paid")).toMatchObject({ kind: "INVALID" });
    expect(readMoneyText("30,50")).toMatchObject({ kind: "INVALID" }); // comma as decimal point: not guessed
    expect(readMoneyText("-30")).toMatchObject({ kind: "INVALID" });
    expect(readMoneyText("abc 30")).toMatchObject({ kind: "INVALID" });
  });

  it("knows when an amount needs more decimals than its currency has", () => {
    expect(fitsCurrencyDecimals("8.000", "KWD")).toBe(true);
    expect(fitsCurrencyDecimals("2.555", "KWD")).toBe(true);
    expect(fitsCurrencyDecimals("7.355", "USD")).toBe(false);
    expect(fitsCurrencyDecimals("30.50", "USD")).toBe(true);
    expect(fitsCurrencyDecimals("30.0", "JPY")).toBe(true);
    expect(fitsCurrencyDecimals("30.5", "JPY")).toBe(false);
  });
});
