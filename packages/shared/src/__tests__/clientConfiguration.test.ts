import { describe, expect, it } from "vitest";
import { cleanCatalogName, matchCatalogEntry, parseAliases, planDefaults, validatePlan } from "../clientConfiguration.js";

describe("catalogue names", () => {
  it("stores a tag the way clients' tags are stored, and keeps a category's case", () => {
    expect(cleanCatalogName("TAG", "  VIP  Customer ")).toEqual({ ok: true, name: "vip customer" });
    expect(cleanCatalogName("CATEGORY", "  Corporate   Accounts ")).toEqual({ ok: true, name: "Corporate Accounts" });
    expect(cleanCatalogName("BUSINESS_TYPE", "Retail")).toEqual({ ok: true, name: "Retail" });
  });

  it("refuses blank names, formulas and control characters", () => {
    expect(cleanCatalogName("TAG", "   ")).toMatchObject({ ok: false });
    expect(cleanCatalogName("CATEGORY", "=HYPERLINK(1)")).toMatchObject({ ok: false });
    expect(cleanCatalogName("CATEGORY", "a\u0007b")).toMatchObject({ ok: false });
    expect(cleanCatalogName("CATEGORY", "x".repeat(81))).toMatchObject({ ok: false });
  });

  it("reads aliases once each, whatever their case", () => {
    expect(parseAliases("Corp, corporate; CORP\nCompany")).toEqual({ ok: true, aliases: ["Corp", "corporate", "Company"] });
  });
});

describe("matching a value to an entry", () => {
  const entries = [
    { id: "1", name: "Corporate", aliases: ["Corp", "Company"] },
    { id: "2", name: "Retail", aliases: ["Shop"] },
    { id: "3", name: "Wholesale", aliases: ["Shop"] },
  ];
  it("matches the name or an alias, ignoring case and spaces", () => {
    expect(matchCatalogEntry("  corporate ", entries)?.id).toBe("1");
    expect(matchCatalogEntry("CORP", entries)?.id).toBe("1");
    expect(matchCatalogEntry("Retail", entries)?.id).toBe("2");
  });
  it("never guesses when two entries claim the same alias", () => {
    expect(matchCatalogEntry("Shop", entries)).toBeNull();
    expect(matchCatalogEntry("Unknown", entries)).toBeNull();
  });
});

describe("service plans", () => {
  it("accepts a plan with defaults and price suggestions in each currency's own decimals", () => {
    const r = validatePlan({
      name: "Home 20 Mbps",
      service: "Internet",
      defaultKind: "PAID",
      defaultDuration: "1",
      defaultUnit: "MONTH",
      prices: [
        { currency: "SAR", amount: "30.00" },
        { currency: "KWD", amount: "2.550" },
        { currency: "JPY", amount: "3000" },
      ],
      aliases: "20M, Home20",
    });
    expect(r).toEqual({
      ok: true,
      plan: {
        name: "Home 20 Mbps",
        service: "Internet",
        defaultKind: "PAID",
        defaultDuration: 1,
        defaultUnit: "MONTH",
        prices: [
          { currency: "SAR", amount: "30.00" },
          { currency: "KWD", amount: "2.550" },
          { currency: "JPY", amount: "3000" },
        ],
        aliases: ["20M", "Home20"],
      },
    });
  });

  it("refuses a price that would lose a digit, a duration without a unit, and a currency twice", () => {
    const r = validatePlan({ name: "X", defaultDuration: "2", prices: [{ currency: "USD", amount: "7.355" }, { currency: "SAR", amount: "1" }, { currency: "SAR", amount: "2" }, { currency: "XYZ", amount: "1" }] });
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors.join(" | ");
    expect(errors).toMatch(/days, weeks, months or years/);
    expect(errors).toMatch(/USD has 2 decimal places/);
    expect(errors).toMatch(/SAR is given twice/);
    expect(errors).toMatch(/"XYZ" is not a currency code/);
  });

  it("offers the expiry a plan's default duration gives, and nothing more", () => {
    const plan = { id: "p", name: "Monthly", aliases: [], defaultKind: "TRIAL", defaultDuration: 1, defaultUnit: "MONTH" };
    expect(planDefaults(plan, "2026-01-31")).toEqual({ kind: "TRIAL", duration: 1, unit: "MONTH", expiry: "2026-02-28" });
    expect(planDefaults({ ...plan, defaultDuration: null, defaultUnit: null }, "2026-01-31").expiry).toBeNull();
    expect(planDefaults(plan, null).expiry).toBeNull();
  });
});

describe("a client's business type and languages", () => {
  it("keeps a business type as typed, and refuses a formula", async () => {
    const { cleanBusinessType } = await import("../clientConfiguration.js");
    expect(cleanBusinessType("  Retail   shop ")).toEqual({ ok: true, value: "Retail shop" });
    expect(cleanBusinessType("")).toEqual({ ok: true, value: null });
    expect(cleanBusinessType("=1+1")).toMatchObject({ ok: false });
  });
  it("keeps extra languages distinct and never repeats the primary one", async () => {
    const { parseAdditionalLanguages } = await import("../clientConfiguration.js");
    expect(parseAdditionalLanguages("English, arabic, english, Hindi", "Arabic")).toEqual({ ok: true, languages: ["English", "Hindi"] });
    expect(parseAdditionalLanguages("a,b,c,d,e,f", null)).toMatchObject({ ok: false });
  });
});
