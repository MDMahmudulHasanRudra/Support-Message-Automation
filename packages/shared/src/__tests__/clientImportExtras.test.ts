import { describe, expect, it } from "vitest";
import { autoMapColumns, buildImportRows, parseDurationUnit, parseImportDate, parseSubscriptionKind, readImportExtras, type ImportExtrasRaw } from "../index.js";

const blank: ImportExtrasRaw = { country: "", currency: "", team: "", soldBy: "", assignedTo: "", service: "", subscriptionType: "", startDate: "", duration: "", durationUnit: "", expiryDate: "" };

describe("parseImportDate", () => {
  it("reads the ways people type a date, day first", () => {
    for (const text of ["2026-10-17", "2026/10/17", "17-10-2026", "17/10/2026", "17.10.2026", "17 Oct 2026", "17-Oct-2026", "Oct 17, 2026", "October 17 2026", "2026-10-17 00:00:00", "46312"]) {
      expect(parseImportDate(text), text).toBe("2026-10-17");
    }
  });
  it("refuses what is not a real date, and never guesses month-first", () => {
    for (const text of ["10/31/2026", "31/02/2026", "2026-13-01", "tomorrow", "Smarch 3 2026", "2026", "123", "99999", "12345"]) {
      expect(parseImportDate(text), text).toBeNull();
    }
    expect(parseImportDate("  ")).toBeNull();
  });
});

describe("units and kinds", () => {
  it("reads units and kinds in any case, and says INVALID rather than guessing", () => {
    expect(parseDurationUnit("Months")).toBe("MONTH");
    expect(parseDurationUnit("yr")).toBe("YEAR");
    expect(parseDurationUnit("DAY")).toBe("DAY");
    expect(parseDurationUnit("")).toBeNull();
    expect(parseDurationUnit("fortnight")).toBe("INVALID");
    expect(parseSubscriptionKind("")).toBe("PAID");
    expect(parseSubscriptionKind("Free trial")).toBe("TRIAL");
    expect(parseSubscriptionKind("COMPLIMENTARY")).toBe("COMPLIMENTARY");
    expect(parseSubscriptionKind("lifetime")).toBe("INVALID");
  });
});

describe("readImportExtras", () => {
  it("no subscription columns = no subscription; roster text is kept for the server", () => {
    const r = readImportExtras({ ...blank, team: " Sales ", soldBy: "Nadia" });
    expect(r).toEqual({ ok: true, value: { country: null, currency: null, team: "Sales", soldBy: "Nadia", assignedTo: null, subscription: null } });
  });
  it("a duration without a unit is months; an expiry date works instead of a duration", () => {
    const a = readImportExtras({ ...blank, service: "Tiger", startDate: "17/10/2026", duration: "3" });
    expect(a.ok && a.value.subscription).toMatchObject({ service: "Tiger", kind: "PAID", startDate: "2026-10-17", endDate: "2027-01-17", durationUnit: "MONTH" });
    const b = readImportExtras({ ...blank, service: "Tiger", subscriptionType: "Trial", startDate: "2026-10-17", expiryDate: "24 Oct 2026" });
    expect(b.ok && b.value.subscription).toMatchObject({ kind: "TRIAL", endDate: "2026-10-24" });
  });
  it("refuses half a term, a bad date or an unknown word — never a partial subscription", () => {
    expect(readImportExtras({ ...blank, service: "Tiger" }).ok).toBe(false); // no start
    expect(readImportExtras({ ...blank, startDate: "2026-10-17", duration: "1" }).ok).toBe(false); // no service
    const bad = readImportExtras({ ...blank, service: "T", startDate: "10/31/2026", duration: "1", durationUnit: "fortnight", subscriptionType: "lifetime" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.join(" ")).toMatch(/Subscription type "lifetime".*Duration unit "fortnight".*Start date "10\/31\/2026"/);
  });
});

describe("the other software's sample headers map themselves", () => {
  it("Mobile, Join.Date, Exp.Date, Assign2Emp. and friends", () => {
    const mapping = autoMapColumns(["Name", "Mobile", "Email", "Address", "Package", "Join.Date", "Exp.Date", "Assign2Emp.", "Zone"]);
    expect(mapping).toMatchObject({ name: "Name", phone: "Mobile", email: "Email", address: "Address", startDate: "Join.Date", expiryDate: "Exp.Date", assignedTo: "Assign2Emp." });
    const rows = buildImportRows([{ Name: "A", Mobile: "01711000000", "Join.Date": "17/10/2026", "Exp.Date": "17/11/2026", Package: "Gold" }], { ...mapping, service: "Package", category: undefined });
    expect(rows.invalid).toEqual([]);
    expect(rows.valid[0]!.extras.subscription).toMatchObject({ service: "Gold", startDate: "2026-10-17", endDate: "2026-11-17" });
  });
});
