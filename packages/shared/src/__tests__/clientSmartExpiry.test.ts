import { describe, expect, it } from "vitest";
import { parseMonthYear, resolveSmartExpiry, type ExpiryParts, type SmartExpiryOptions } from "../clientSmartExpiry.js";
import { autoMapSmart, buildSmartRows, fieldIssues, sanitizeSmartMapping, SMART_FIELD_KEYS, SMART_REVIEW_ORDER, SMART_SAMPLE_VALUES, type SmartMapping } from "../clientSmartImport.js";
import type { ClientImportFieldKey } from "../clients.js";

const row = (values: Partial<Record<ClientImportFieldKey, string>>) =>
  Object.fromEntries(SMART_FIELD_KEYS.map((k) => [k, values[k] ?? ""])) as Record<ClientImportFieldKey, string>;
const parts = (year: string, month: string, day: string): ExpiryParts => ({ year, month, day, mapped: true });
const resolve = (values: Partial<Record<ClientImportFieldKey, string>>, options: SmartExpiryOptions = {}, p: ExpiryParts | null = null) =>
  resolveSmartExpiry(row({ name: "A", ...values }), p, options);
const errorsOf = (r: ReturnType<typeof resolve>) => r.issues.filter((i) => i.severity === "error");

describe("Method A — a complete expiry date", () => {
  it.each([
    ["2027-07-24", "2027-07-24"],
    ["24/07/2027", "2027-07-24"],
    ["24 Jul 2027", "2027-07-24"],
    ["46592", "2027-07-24"], // Excel date serial
  ])("%s → %s", (text, iso) => {
    const r = resolve({ service: "IPTV", startDate: "2026-07-24", expiryDate: text });
    expect(errorsOf(r)).toEqual([]);
    expect(r.finalExpiry).toBe(iso);
    expect(r.output.expiryDate).toBe(iso);
  });

  it.each(["31/02/2027", "2027-13-01", "next july", "07/24/2027"])("refuses %s rather than guessing", (text) => {
    const r = resolve({ service: "IPTV", startDate: "2026-07-24", expiryDate: text });
    expect(errorsOf(r)).toEqual([expect.objectContaining({ field: "expiryDate", message: expect.stringMatching(/not a date/) })]);
    expect(r.finalExpiry).toBeNull();
  });
});

describe("Method B — separate year, month and day", () => {
  it("composes the canonical date, month names included", () => {
    expect(resolve({ service: "IPTV", startDate: "2026-07-24" }, {}, parts("2027", "07", "24")).finalExpiry).toBe("2027-07-24");
    expect(resolve({ service: "IPTV", startDate: "2026-07-24" }, {}, parts("2027", "July", "4")).finalExpiry).toBe("2027-07-04");
  });

  it("handles leap years and refuses a day the month does not have", () => {
    expect(resolve({ service: "S", startDate: "2027-01-01" }, {}, parts("2028", "2", "29")).finalExpiry).toBe("2028-02-29");
    const r = resolve({ service: "S", startDate: "2026-01-01" }, {}, parts("2027", "2", "29"));
    expect(errorsOf(r)[0]?.message).toMatch(/has no day 29/);
  });

  it("never invents a missing year, and refuses a two-digit or out-of-range one", () => {
    expect(errorsOf(resolve({}, {}, parts("", "07", "24")))[0]?.message).toMatch(/year is missing/);
    expect(errorsOf(resolve({}, {}, parts("27", "07", "24")))[0]?.message).toMatch(/four-digit year/);
    expect(errorsOf(resolve({}, {}, parts("2500", "07", "24")))[0]?.message).toMatch(/four-digit year/);
    expect(errorsOf(resolve({}, {}, parts("2027", "13", "24")))[0]?.message).toMatch(/not a month/);
  });

  it("a person's corrected expiry wins over the parts", () => {
    const r = resolveSmartExpiry(row({ name: "A", service: "S", startDate: "2026-01-01", expiryDate: "2027-01-01" }), parts("2027", "07", "24"), {}, true);
    expect(r.finalExpiry).toBe("2027-01-01");
  });
});

describe("Method C — start date + duration (calendar-aware)", () => {
  it.each([
    ["1", "Month", "2026-11-24"],
    ["3", "Months", "2027-01-24"],
    ["6", "Months", "2027-04-24"],
    ["9", "Months", "2027-07-24"],
    ["12", "Months", "2027-10-24"],
    ["1", "Year", "2027-10-24"],
    ["15", "Days", "2026-11-08"],
  ])("%s %s from 2026-10-24 → %s", (duration, unit, expiry) => {
    const r = resolve({ service: "IPTV", startDate: "2026-10-24", duration, durationUnit: unit });
    expect(r.finalExpiry).toBe(expiry);
    expect(r.basis).toMatch(/Calculated from Start date/);
  });

  it("keeps month-end and leap-year semantics", () => {
    expect(resolve({ service: "S", startDate: "2027-01-31", duration: "1", durationUnit: "Month" }).finalExpiry).toBe("2027-02-28");
    expect(resolve({ service: "S", startDate: "2028-01-31", duration: "1", durationUnit: "Month" }).finalExpiry).toBe("2028-02-29");
    expect(resolve({ service: "S", startDate: "2028-02-29", duration: "1", durationUnit: "Year" }).finalExpiry).toBe("2029-02-28");
    expect(resolve({ service: "S", startDate: "2026-12-15", duration: "1", durationUnit: "Month" }).finalExpiry).toBe("2027-01-15");
  });
});

describe("Method D — an expiry without a duration, or without a start date", () => {
  it("with a start date, the explicit expiry is the term's end", () => {
    const r = resolve({ service: "IPTV", startDate: "2026-07-24", expiryDate: "2027-07-24" });
    expect(r).toMatchObject({ finalExpiry: "2027-07-24", recordedExpiry: null });
    expect(errorsOf(r)).toEqual([]);
  });

  it("without a start date, it is RECORDED on the client — never a term, never an invented start", () => {
    const r = resolve({ service: "IPTV", expiryDate: "2027-07-24" });
    expect(r.recordedExpiry).toEqual({ date: "2027-07-24", service: "IPTV" });
    expect(r.output).toMatchObject({ service: "", expiryDate: "", startDate: "" });
    expect(r.issues).toEqual([expect.objectContaining({ field: "expiryDate", severity: "warning" })]);
  });

  it("also without a service", () => {
    expect(resolve({ expiryDate: "24/07/2027" }).recordedExpiry).toEqual({ date: "2027-07-24", service: null });
  });
});

describe("Method E — month and year only", () => {
  it.each([["July 2027"], ["Jul-2027"], ["2027-07"], ["07/2027"]])("%s is read as a month", (text) => {
    expect(parseMonthYear(text)).toEqual({ year: 2027, month: 7 });
  });

  it("keeps the row in review unless the last-day policy was chosen", () => {
    const strict = resolve({ service: "S", startDate: "2026-07-01", expiryDate: "July 2027" });
    expect(errorsOf(strict)[0]?.message).toMatch(/no day/);
    expect(strict.output.expiryDate).toBe("July 2027"); // the original is kept until resolved
    const lastDay = resolve({ service: "S", startDate: "2026-07-01", expiryDate: "February 2028" }, { monthYearPolicy: "LAST_DAY" });
    expect(lastDay.finalExpiry).toBe("2028-02-29");
    expect(lastDay.issues).toEqual([expect.objectContaining({ severity: "warning", message: expect.stringMatching(/last day/) })]);
  });

  it("applies the same policy to year + month parts with no day", () => {
    expect(errorsOf(resolve({}, {}, parts("2027", "06", ""))).length).toBe(1);
    expect(resolve({ service: "S", startDate: "2026-06-01" }, { monthYearPolicy: "LAST_DAY" }, parts("2027", "06", "")).finalExpiry).toBe("2027-06-30");
  });
});

describe("conflicts", () => {
  const both = { service: "IPTV", startDate: "2026-10-24", duration: "9", durationUnit: "Months" };

  it("agreeing values are accepted as one", () => {
    const r = resolve({ ...both, expiryDate: "2027-07-24" });
    expect(errorsOf(r)).toEqual([]);
    expect(r.finalExpiry).toBe("2027-07-24");
  });

  it("disagreeing values are never silently reconciled", () => {
    const r = resolve({ ...both, expiryDate: "2027-08-24" });
    expect(r.finalExpiry).toBeNull();
    expect(errorsOf(r).map((i) => i.field)).toEqual(["expiryDate", "duration"]);
    expect(errorsOf(r)[0]?.message).toMatch(/2027-08-24 differs from Start date \+ 9 months = 2027-07-24/i);
  });

  it("an explicit choice resolves them consistently", () => {
    const source = resolve({ ...both, expiryDate: "2027-08-24" }, { expiryConflict: "SOURCE" });
    expect(source).toMatchObject({ finalExpiry: "2027-08-24", output: { duration: "", durationUnit: "", expiryDate: "2027-08-24" } });
    const calculated = resolve({ ...both, expiryDate: "2027-08-24" }, { expiryConflict: "CALCULATED" });
    expect(calculated).toMatchObject({ finalExpiry: "2027-07-24", output: { duration: "9", expiryDate: "" } });
  });
});

describe("through the import's own rules", () => {
  const map = (fields: SmartMapping["fields"], options?: SmartMapping["options"]): SmartMapping => ({ version: 2, fields, ...(options ? { options } : {}) });

  it("an expiry before the start is refused, on the expiry field", () => {
    const r = buildSmartRows([{ rowNumber: 2, source: { N: "A", S: "IPTV", St: "2027-07-24", E: "2027-01-01" } }], map({ name: { mode: "source", column: "N" }, service: { mode: "source", column: "S" }, startDate: { mode: "source", column: "St" }, expiryDate: { mode: "source", column: "E" } }), SMART_SAMPLE_VALUES);
    expect(r.valid).toEqual([]);
    expect(r.issues.get(2)).toEqual([expect.objectContaining({ field: "expiryDate", severity: "error", message: expect.stringMatching(/after the start/) })]);
  });

  it("a duration with no service is refused on the service field", () => {
    const r = buildSmartRows([{ rowNumber: 2, source: { N: "A", St: "2026-10-24", D: "1" } }], map({ name: { mode: "source", column: "N" }, startDate: { mode: "source", column: "St" }, duration: { mode: "source", column: "D" } }), SMART_SAMPLE_VALUES);
    expect(r.issues.get(2)!.filter((i) => i.severity === "error").map((i) => i.field)).toEqual(["service"]);
  });

  it("an expiry-only row is valid and carries its recorded expiry; separate parts compose", () => {
    const r = buildSmartRows(
      [{ rowNumber: 2, source: { N: "ABC Network", S: "IPTV", Y: "2027", M: "07", D: "24" } }],
      map({ name: { mode: "source", column: "N" }, service: { mode: "source", column: "S" }, expiryYear: { mode: "source", column: "Y" }, expiryMonth: { mode: "source", column: "M" }, expiryDay: { mode: "source", column: "D" } }),
      SMART_SAMPLE_VALUES,
    );
    expect(r.invalid).toEqual([]);
    expect(r.valid[0]).toMatchObject({ recordedExpiry: { date: "2027-07-24", service: "IPTV" }, extras: { subscription: null } });
    expect(r.outputs.get(2)?.expiryDate).toBe("2027-07-24");
  });

  it("a valid row has no red cell: an expiry from parts with a start date needs no duration", () => {
    const r = buildSmartRows(
      [{ rowNumber: 2, source: { N: "Leap Day Ltd", S: "IPTV", St: "2027-03-01", Y: "2028", M: "02", D: "29" } }],
      map({ name: { mode: "source", column: "N" }, service: { mode: "source", column: "S" }, startDate: { mode: "source", column: "St" }, expiryYear: { mode: "source", column: "Y" }, expiryMonth: { mode: "source", column: "M" }, expiryDay: { mode: "source", column: "D" } }),
      SMART_SAMPLE_VALUES,
    );
    expect(r.valid[0]?.extras.subscription).toMatchObject({ endDate: "2028-02-29" });
    expect(r.issues.get(2)).toEqual([]);
  });

  it("a 9-month term from 2026-10-24 becomes a subscription ending 2027-07-24", () => {
    const r = buildSmartRows([{ rowNumber: 2, source: { N: "A", S: "IPTV", St: "2026-10-24", D: "9", U: "Months" } }], map({ name: { mode: "source", column: "N" }, service: { mode: "source", column: "S" }, startDate: { mode: "source", column: "St" }, duration: { mode: "source", column: "D" }, durationUnit: { mode: "source", column: "U" } }), SMART_SAMPLE_VALUES);
    expect(r.valid[0]?.extras.subscription).toMatchObject({ startDate: "2026-10-24", endDate: "2027-07-24", durationValue: 9, durationUnit: "MONTH" });
  });

  it("field issues name the field, so one bad cell is not the whole row", () => {
    const issues = fieldIssues({ ...row({ name: "Rahim", phone: "12", email: "rahim@example.com" }) }, [], ["\"12\" is not a valid phone."]);
    expect(issues.map((i) => [i.field, i.severity])).toEqual([["phone", "error"]]);
  });
});

describe("mapping", () => {
  it("auto-matches separate expiry columns without confusing them with a complete date", () => {
    const { mapping } = autoMapSmart(["Client", "Expiry Date", "Expire Year", "Exp Month", "Expiry Day"]);
    expect(mapping.fields).toMatchObject({
      expiryDate: { column: "Expiry Date" },
      expiryYear: { column: "Expire Year" },
      expiryMonth: { column: "Exp Month" },
      expiryDay: { column: "Expiry Day" },
    });
  });

  it("an expiry alone is applied, not held back as a suggestion", () => {
    expect(autoMapSmart(["Name", "Expiry Date"]).mapping.fields.expiryDate).toEqual({ mode: "source", column: "Expiry Date" });
  });

  it("sanitises parts and options", () => {
    expect(sanitizeSmartMapping({ fields: { expiryYear: { mode: "constant", value: "2027" } }, options: { monthYearPolicy: "LAST_DAY", expiryConflict: "SOURCE", expiryMode: "PARTS" } }, [])).toMatchObject({ ok: true });
    expect(sanitizeSmartMapping({ fields: { expiryYear: { mode: "sample" } } }, [])).toMatchObject({ ok: false });
    expect(sanitizeSmartMapping({ fields: { expiryMonth: { mode: "constant", value: "13" } } }, [])).toMatchObject({ ok: false });
    expect(sanitizeSmartMapping({ fields: {}, options: { expiryConflict: "WHATEVER" } }, [])).toMatchObject({ ok: false });
  });

  it("the review order holds every field exactly once", () => {
    expect([...SMART_REVIEW_ORDER].sort()).toEqual([...SMART_FIELD_KEYS].sort());
  });
});
