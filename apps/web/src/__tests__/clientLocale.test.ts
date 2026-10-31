import { describe, expect, it } from "vitest";
import { cleanPhoneText, languageCodeForCountry, normalizePhone, resolveClientLocale, splitPhoneCell } from "@/lib/clientLocale";

/** Smart Import V5 §4–5: one phone and locale rule for the form, both imports and the review. Pure, no DB. */
describe("phone normalization", () => {
  it("adds the + to an international number written without it, and changes nothing else", () => {
    expect(normalizePhone("966551234567")).toMatchObject({ status: "VALID", e164: "+966551234567", country: "SA" });
    expect(normalizePhone("971501234567")).toMatchObject({ status: "VALID", e164: "+971501234567", country: "AE" });
    expect(normalizePhone("8801712345678")).toMatchObject({ status: "VALID", e164: "+8801712345678", country: "BD" });
    expect(normalizePhone("+966551234567")).toMatchObject({ status: "VALID", e164: "+966551234567" });
    expect(normalizePhone("00966551234567")).toMatchObject({ status: "VALID", e164: "+966551234567" });
  });

  it("never writes ++ or the country code twice", () => {
    expect(normalizePhone("++966551234567").e164).toBe("+966551234567");
    expect(normalizePhone("+966 55 123 4567").e164).toBe("+966551234567");
    expect(normalizePhone("8801712345678", "BD").e164).toBe("+8801712345678");
    for (const raw of ["966551234567", "+966551234567", "00966551234567", "++966551234567"]) expect(normalizePhone(raw, "SA").e164).not.toMatch(/^\+\+|\+966966/);
  });

  it("reads a local number in the given country, and asks when there is none", () => {
    expect(normalizePhone("01712345678", "BD")).toMatchObject({ status: "VALID", e164: "+8801712345678" });
    expect(normalizePhone("0551234567", "SA")).toMatchObject({ status: "VALID", e164: "+966551234567" });
    expect(normalizePhone("01712345678")).toMatchObject({ status: "NEEDS_COUNTRY", e164: null });
  });

  it("does not choose between two valid readings", () => {
    // 4698853614 is a valid US number and also valid as +46 98853614 (Sweden): neither is chosen.
    const r = normalizePhone("4698853614", "US");
    expect(r).toMatchObject({ status: "AMBIGUOUS", e164: null });
    expect(r.candidates).toEqual(["+14698853614", "+4698853614"]);
    // Without a country only the international reading exists, so it is used.
    expect(normalizePhone("4698853614")).toMatchObject({ status: "VALID", e164: "+4698853614" });
  });

  it("handles what Excel does to numbers", () => {
    expect(normalizePhone("9.66551E+11")).toMatchObject({ status: "DAMAGED", e164: null });
    expect(normalizePhone("966551234567.0").e164).toBe("+966551234567");
    expect(cleanPhoneText("'01712345678")).toBe("01712345678");
    expect(cleanPhoneText("tel:+966551234567")).toBe("+966551234567");
    expect(normalizePhone("call me")).toMatchObject({ status: "INVALID" });
  });

  it("splits several numbers in one cell but never one number at its spaces", () => {
    expect(splitPhoneCell("01711000000; 01811000000")).toEqual(["01711000000", "01811000000"]);
    expect(splitPhoneCell("966551234567, 971501234567")).toEqual(["966551234567", "971501234567"]);
    expect(splitPhoneCell("+880 1711-000000")).toEqual(["+880 1711-000000"]);
    expect(splitPhoneCell("+966551234567 / +971501234567")).toEqual(["+966551234567", "+971501234567"]);
  });
});

describe("country, currency and language", () => {
  const sa = normalizePhone("+966551234567");
  const bd = normalizePhone("+8801712345678");

  it("suggests from a valid number: Saudi → SAR, Arabic; Bangladesh → BDT, Bangla", () => {
    expect(resolveClientLocale({ file: {}, phones: [sa] })).toEqual({
      country: { value: "SA", source: "PHONE" },
      currency: { value: "SAR", source: "SUGGESTED" },
      language: { value: "Arabic", source: "SUGGESTED" },
    });
    const b = resolveClientLocale({ file: {}, phones: [bd] });
    expect(b.country.value).toBe("BD");
    expect(b.currency.value).toBe("BDT");
    expect(["Bangla", "Bengali"]).toContain(b.language.value);
    expect(languageCodeForCountry("BD")).toBe("bn");
  });

  it("puts the file and a person first, and never replaces a chosen currency or language", () => {
    const r = resolveClientLocale({ file: { country: "AE", currency: "USD" }, phones: [sa] });
    expect(r.country).toEqual({ value: "AE", source: "FILE" });
    expect(r.currency).toEqual({ value: "USD", source: "FILE" });
    expect(r.language.source).toBe("SUGGESTED");
    const m = resolveClientLocale({ file: { country: "AE" }, manual: { country: "SA", language: "English" }, phones: [] });
    expect(m.country).toEqual({ value: "SA", source: "MANUAL" });
    expect(m.language).toEqual({ value: "English", source: "MANUAL" });
    expect(m.currency).toEqual({ value: "SAR", source: "SUGGESTED" });
  });

  it("asks when numbers disagree, and falls back to the project's default country", () => {
    const r = resolveClientLocale({ file: {}, phones: [sa, bd] });
    expect(r.country.source).toBe("REVIEW");
    expect(r.country.value).toBeNull();
    expect(r.currency.value).toBeNull();
    expect(resolveClientLocale({ file: {}, phones: [], projectCountry: "BD" }).country).toEqual({ value: "BD", source: "DEFAULT" });
  });

  it("uses the project's own country → currency choice over the general one", () => {
    expect(resolveClientLocale({ file: {}, phones: [sa], overrides: { currencyByCountry: { SA: "USD" } } }).currency).toEqual({ value: "USD", source: "SUGGESTED" });
  });
});
