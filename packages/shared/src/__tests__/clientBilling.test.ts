import { describe, expect, it } from "vitest";
import { dhakaToday, diffDue, normalizeCurrencyCode, parseAmount, parseDueDate, summarizeDues, validateDue } from "../clientBilling.js";

const base = { dueDate: "2026-11-05", amount: "", currency: "", status: "UNPAID", paidAmount: "", note: "" };

describe("amounts and dates", () => {
  it("parses a typed amount to two decimals and treats blank as no amount", () => {
    expect(parseAmount("12,500.5")).toEqual({ ok: true, value: "12500.50" });
    expect(parseAmount("  ")).toEqual({ ok: true, value: null });
  });
  it("refuses negative, zero, non-numeric, over-precise and oversized amounts", () => {
    for (const bad of ["-5", "0", "abc", "1.234", "99999999999"]) expect(parseAmount(bad).ok).toBe(false);
  });
  it("accepts only a real calendar day", () => {
    expect(parseDueDate("2026-02-28")).toBe("2026-02-28");
    expect(parseDueDate("2026-02-30")).toBeNull();
    expect(parseDueDate("05/11/2026")).toBeNull();
  });
  it("normalises a currency code and refuses anything that is not three letters", () => {
    expect(normalizeCurrencyCode(" bdt ")).toBe("BDT");
    expect(normalizeCurrencyCode("TAKA")).toBeNull();
  });
  it("reads today in Dhaka, which is ahead of UTC", () => {
    expect(dhakaToday(new Date("2026-10-13T20:30:00Z"))).toBe("2026-10-14");
  });
});

describe("validateDue", () => {
  it("allows a due with no amount and no currency, even when the currency list is empty", () => {
    expect(validateDue(base, [])).toMatchObject({ ok: true, due: { amount: null, currency: null, status: "UNPAID" } });
  });
  it("requires a currency only when an amount is present, and only from the list", () => {
    expect(validateDue({ ...base, amount: "100" }, ["BDT"]).ok).toBe(false);
    expect(validateDue({ ...base, amount: "100", currency: "usd" }, ["BDT"]).ok).toBe(false);
    expect(validateDue({ ...base, amount: "100", currency: "bdt" }, ["BDT"])).toMatchObject({ ok: true, due: { amount: "100.00", currency: "BDT" } });
  });
  it("tells the person to add a currency when the list is empty and an amount was typed", () => {
    const r = validateDue({ ...base, amount: "100" }, []);
    expect(r.ok === false && r.errors[0]).toMatch(/Add a currency/);
  });
  it("keeps a currency a due already carries even after the list dropped it", () => {
    expect(validateDue({ ...base, amount: "100", currency: "EUR" }, ["BDT"], "EUR").ok).toBe(true);
  });
  it("drops a currency typed without an amount", () => {
    expect(validateDue({ ...base, currency: "BDT" }, ["BDT"])).toMatchObject({ ok: true, due: { currency: null } });
  });
  it("checks the paid amount against the amount and the status", () => {
    expect(validateDue({ ...base, paidAmount: "5" }, []).ok).toBe(false);
    expect(validateDue({ ...base, amount: "100", currency: "BDT", paidAmount: "150" }, ["BDT"]).ok).toBe(false);
    expect(validateDue({ ...base, amount: "100", currency: "BDT", status: "PARTIALLY_PAID" }, ["BDT"]).ok).toBe(false);
    expect(validateDue({ ...base, amount: "100", currency: "BDT", status: "PARTIALLY_PAID", paidAmount: "40" }, ["BDT"]).ok).toBe(true);
    expect(validateDue({ ...base, amount: "100", currency: "BDT", status: "PAID", paidAmount: "40" }, ["BDT"]).ok).toBe(false);
    expect(validateDue({ ...base, status: "PAID" }, []).ok).toBe(true);
  });
  it("refuses a bad date, an unknown status and an over-long note", () => {
    expect(validateDue({ ...base, dueDate: "" }, []).ok).toBe(false);
    expect(validateDue({ ...base, status: "LATE" }, []).ok).toBe(false);
    expect(validateDue({ ...base, note: "x".repeat(1001) }, []).ok).toBe(false);
  });
});

describe("summarizeDues", () => {
  const dues = [
    { dueDate: "2026-10-01", status: "UNPAID" },
    { dueDate: "2026-10-10", status: "PARTIALLY_PAID" },
    { dueDate: "2026-10-20", status: "UNPAID" },
    { dueDate: "2026-11-20", status: "UNPAID" },
    { dueDate: "2026-09-01", status: "PAID" },
    { dueDate: "2026-10-05", status: "CANCELLED" },
    { dueDate: "2026-10-06", status: "WAIVED" },
  ];
  it("counts only open dues, splits overdue from upcoming, and finds the next date", () => {
    expect(summarizeDues(dues, "2026-10-13")).toEqual({ nextDueDate: "2026-10-20", overdueCount: 2, oldestOverdueDate: "2026-10-01", openCount: 4 });
  });
  it("treats a due today as upcoming, not overdue", () => {
    expect(summarizeDues([{ dueDate: "2026-10-13", status: "UNPAID" }], "2026-10-13")).toMatchObject({ overdueCount: 0, nextDueDate: "2026-10-13" });
  });
  it("is empty when nothing is open", () => {
    expect(summarizeDues([{ dueDate: "2026-09-01", status: "PAID" }], "2026-10-13")).toEqual({ nextDueDate: null, overdueCount: 0, oldestOverdueDate: null, openCount: 0 });
  });
});

describe("diffDue", () => {
  it("lists only the fields that changed", () => {
    expect(diffDue({ status: "UNPAID", note: null }, { status: "PAID", note: null })).toEqual({ status: { from: "UNPAID", to: "PAID" } });
  });
});
