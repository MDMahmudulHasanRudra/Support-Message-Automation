import { describe, expect, it } from "vitest";
import {
  assessSmartFile,
  autoMapSmart,
  buildSmartRows,
  checkFieldValue,
  columnUsage,
  detectHeaderRow,
  escapeSpreadsheetCell,
  gridToRecords,
  inspectXlsxZip,
  looksLikeText,
  materializeRow,
  sanitizeSmartMapping,
  SMART_IMPORT_LIMITS,
  SMART_SAMPLE_VALUES,
  unsafeTextIssues,
  upgradeMapping,
  type SmartMapping,
} from "../clientSmartImport.js";

const samples = SMART_SAMPLE_VALUES;
const map = (fields: SmartMapping["fields"]): SmartMapping => ({ version: 2, fields });

describe("autoMapSmart", () => {
  it("offers subscription dates without a service as suggestions, never applies them", () => {
    const { mapping, suggestions } = autoMapSmart(["Name", "Connection Date"]);
    expect(mapping.fields.startDate).toBeUndefined();
    expect(suggestions).toEqual([{ field: "startDate", column: "Connection Date", reason: expect.stringMatching(/Service/) }]);
  });

  it("applies exact synonyms, including the extra ones real exports use", () => {
    const { mapping } = autoMapSmart(["Customer Name", "Mobile", "E-mail", "Join Date", "Expiration Date", "Business", "Service"]);
    expect(mapping.fields).toEqual({
      name: { mode: "source", column: "Customer Name" },
      phone: { mode: "source", column: "Mobile" },
      email: { mode: "source", column: "E-mail" },
      company: { mode: "source", column: "Business" },
      service: { mode: "source", column: "Service" },
      startDate: { mode: "source", column: "Join Date" },
      expiryDate: { mode: "source", column: "Expiration Date" },
    });
  });

  it("offers a 'looks like' match as a suggestion and never applies it", () => {
    const { mapping, suggestions } = autoMapSmart(["Primary Mobile Number", "Full Name"]);
    expect(mapping.fields.phone).toBeUndefined();
    expect(suggestions).toEqual([{ field: "phone", column: "Primary Mobile Number", reason: expect.stringContaining("Phone") }]);
  });

  it("does not suggest a header two fields could claim", () => {
    // "whatsapp" (WhatsApp) and "phone" both occur in it: a guess either way.
    const { suggestions } = autoMapSmart(["Name", "WhatsApp Phone"]);
    expect(suggestions.find((s) => s.column === "WhatsApp Phone")).toBeUndefined();
  });

  it("maps a column to at most one field by itself", () => {
    const { mapping } = autoMapSmart(["Mobile Number"]);
    expect(Object.keys(mapping.fields)).toEqual(["phone"]);
  });
});

describe("materializeRow — every mode", () => {
  const source = { "Mobile Number": "01712345678", "Customer": "", "Alt": "Rahim" };

  it("one column feeds several fields (Scenario B)", () => {
    const out = materializeRow(source, map({ name: { mode: "source", column: "Mobile Number" }, phone: { mode: "source", column: "Mobile Number" } }), samples);
    expect(out.name).toBe("01712345678");
    expect(out.phone).toBe("01712345678");
  });

  it("uses the fallback column only when the first is blank", () => {
    expect(materializeRow(source, map({ name: { mode: "source", column: "Customer", fallback: "Alt" } }), samples).name).toBe("Rahim");
    expect(materializeRow({ ...source, Customer: "Karim" }, map({ name: { mode: "source", column: "Customer", fallback: "Alt" } }), samples).name).toBe("Karim");
  });

  it("constant, sample and empty", () => {
    const out = materializeRow(source, map({ status: { mode: "constant", value: "INACTIVE" }, category: { mode: "sample" } }), samples);
    expect(out.status).toBe("INACTIVE");
    expect(out.category).toBe(SMART_SAMPLE_VALUES.category);
    expect(out.email).toBe("");
  });

  it("a person's correction wins over the mapping, including a correction to blank", () => {
    const m = map({ name: { mode: "source", column: "Alt" }, email: { mode: "constant", value: "x@example.com" } });
    expect(materializeRow(source, m, samples, { name: "Rahim Uddin", email: "" })).toMatchObject({ name: "Rahim Uddin", email: "" });
  });
});

describe("buildSmartRows — the existing rules, unchanged", () => {
  it("accepts Bangla and international names and keeps each row's own number", () => {
    const m = map({ name: { mode: "source", column: "N" }, phone: { mode: "source", column: "P" } });
    const r = buildSmartRows(
      [
        { rowNumber: 2, source: { N: "রহিম উদ্দিন", P: "+8801712345678" } },
        { rowNumber: 3, source: { N: "José Ñúñez", P: "+447700900123" } },
        { rowNumber: 9, source: { N: "Zhang Wěi" } },
      ],
      m,
      samples,
    );
    expect(r.invalid).toEqual([]);
    expect(r.valid.map((v) => [v.rowNumber, v.fields.name])).toEqual([[2, "রহিম উদ্দিন"], [3, "José Ñúñez"], [9, "Zhang Wěi"]]);
  });

  it("refuses invalid phones, emails, dates and statuses with a reason", () => {
    const m = map({ name: { mode: "constant", value: "A" }, phone: { mode: "source", column: "P" }, email: { mode: "source", column: "E" }, startDate: { mode: "source", column: "S" }, service: { mode: "constant", value: "Net" }, status: { mode: "source", column: "St" } });
    const r = buildSmartRows(
      [
        { rowNumber: 2, source: { P: "12" } },
        { rowNumber: 3, source: { E: "not-an-email" } },
        { rowNumber: 4, source: { S: "31/02/2026" } },
        { rowNumber: 5, source: { St: "MAYBE" } },
      ],
      m,
      samples,
    );
    expect(r.invalid.map((i) => i.rowNumber)).toEqual([2, 3, 4, 5]);
    for (const i of r.invalid) expect(i.errors.length).toBeGreaterThan(0);
  });

  it("refuses formula-looking and link-only names, and control characters", () => {
    const m = map({ name: { mode: "source", column: "N" } });
    const r = buildSmartRows(
      [
        { rowNumber: 2, source: { N: '=HYPERLINK("http://x","click")' } },
        { rowNumber: 3, source: { N: "https://evil.example/login" } },
        { rowNumber: 4, source: { N: "Ra\u0007him" } },
        { rowNumber: 5, source: { N: "+cmd|' /C calc'!A0" } },
        { rowNumber: 6, source: { N: "O'Brien & Sons (Pvt.) Ltd." } },
      ],
      m,
      samples,
    );
    expect(r.invalid.map((i) => i.rowNumber)).toEqual([2, 3, 4, 5]);
    expect(r.valid.map((v) => v.rowNumber)).toEqual([6]);
  });

  it("keeps SQL- and script-looking text as inert text where text is allowed", () => {
    const m = map({ name: { mode: "source", column: "N" }, address: { mode: "source", column: "A" } });
    const r = buildSmartRows([{ rowNumber: 2, source: { N: "Robert'); DROP TABLE Client;--", A: "<script>alert(1)</script>" } }], m, samples);
    expect(r.valid[0]?.fields.address).toBe("<script>alert(1)</script>");
  });

  it("reports ignored and blank rows separately", () => {
    const r = buildSmartRows([{ rowNumber: 2, source: { N: "A" }, ignored: true }, { rowNumber: 3, source: {} }, { rowNumber: 4, source: { X: "y" } }], map({ name: { mode: "source", column: "N" } }), samples);
    expect(r.ignored).toEqual([2]);
    expect(r.blank).toEqual([3]);
    // A row with data that nothing maps is reported, never skipped quietly.
    expect(r.invalid).toEqual([{ rowNumber: 4, errors: [expect.stringMatching(/Nothing in this row is mapped/)] }]);
  });
});

describe("sanitizeSmartMapping", () => {
  const headers = ["Name", "Mobile"];

  it("keeps a valid mapping and drops empty fields", () => {
    const r = sanitizeSmartMapping({ fields: { name: { mode: "source", column: "Name", fallback: "Mobile" }, phone: { mode: "source", column: "Mobile" }, email: { mode: "empty" }, status: { mode: "constant", value: "ACTIVE" }, category: { mode: "sample" } } }, headers);
    expect(r).toEqual({ ok: true, mapping: { version: 2, fields: { name: { mode: "source", column: "Name", fallback: "Mobile" }, phone: { mode: "source", column: "Mobile" }, status: { mode: "constant", value: "ACTIVE" }, category: { mode: "sample" } } } });
  });

  it.each([
    [{ fields: { password: { mode: "constant", value: "x" } } }, /not a client field/],
    [{ fields: { name: { mode: "source", column: "Nope" } } }, /no column called/],
    [{ fields: { name: { mode: "source", column: "Name", fallback: "Nope" } } }, /no column called/],
    [{ fields: { status: { mode: "constant", value: "ARCHIVED" } } }, /archive/i],
    [{ fields: { email: { mode: "constant", value: "bad" } } }, /Email/],
    [{ fields: { name: { mode: "constant", value: "" } } }, /type the value/],
    [{ fields: { name: { mode: "script", value: "x" } } }, /choose where/],
    [{ fields: { __proto__: { mode: "empty" }, constructor: { mode: "empty" } } }, /not a client field/],
    [null, /could not be read/],
  ])("refuses %j", (raw, error) => {
    const r = sanitizeSmartMapping(raw, headers);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it("checks a constant with the field's own rules", () => {
    expect(checkFieldValue("phone", "12")).not.toEqual([]);
    expect(checkFieldValue("phone", "+8801712345678")).toEqual([]);
    expect(checkFieldValue("name", "=1+1")).not.toEqual([]);
  });
});

describe("compatibility and usage", () => {
  it("reads an old v1 mapping as v2", () => {
    expect(upgradeMapping({ name: "Client", phone: "Mobile", bogus: "X" })).toEqual(map({ name: { mode: "source", column: "Client" }, phone: { mode: "source", column: "Mobile" } }));
    expect(upgradeMapping(null)).toEqual(map({}));
  });

  it("reports one column feeding several fields", () => {
    expect(columnUsage(map({ name: { mode: "source", column: "M" }, phone: { mode: "source", column: "M" } })).get("M")).toEqual(["name", "phone"]);
  });

  it("never lets unsafe text pass through the unsafe-text rule's blind spots", () => {
    expect(unsafeTextIssues({ name: "@SUM(A1)" })).toHaveLength(1);
    expect(unsafeTextIssues({ name: "-2+3" })).toEqual([]); // a number-like name is a choice, not a formula
  });
});

describe("assessSmartFile — the wrong-file guard", () => {
  const base = { headers: ["Name"], blankHeaders: 0, duplicateHeaders: 0, mapping: map({ name: { mode: "source", column: "Name" } }), recognisedColumns: 1, totalRows: 10, readyRows: 10, invalidRows: 0 };

  it("passes a sensible file", () => {
    expect(assessSmartFile(base)).toEqual({ blocks: [], warnings: [] });
  });

  it("blocks a file with no name, no rows or nothing importable", () => {
    expect(assessSmartFile({ ...base, mapping: map({}) }).blocks.map((b) => b.code)).toContain("NAME_UNSET");
    expect(assessSmartFile({ ...base, totalRows: 0, readyRows: 0 }).blocks.map((b) => b.code)).toContain("NO_ROWS");
    expect(assessSmartFile({ ...base, readyRows: 0, invalidRows: 10 }).blocks.map((b) => b.code)).toContain("NOTHING_READY");
  });

  it("warns about an unrecognised, mostly-invalid or oddly-headed file, and one value on an identifier", () => {
    const codes = assessSmartFile({ ...base, recognisedColumns: 0, readyRows: 4, invalidRows: 6, blankHeaders: 1, mapping: map({ name: { mode: "source", column: "Name" }, phone: { mode: "sample" } }) }).warnings.map((w) => w.code);
    expect(codes).toEqual(["NO_RECOGNISED_COLUMNS", "MOSTLY_INVALID", "IDENTITY_SAME_VALUE", "ODD_HEADERS"]);
  });
});

describe("reading a sheet", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [`Client ${i}`, `0171${String(i).padStart(7, "0")}`]);

  it("takes exactly the row limit and refuses one more", () => {
    const ok = gridToRecords([["Name", "Phone"], ...rows(SMART_IMPORT_LIMITS.maxRows)], 0);
    expect("rows" in ok && ok.rows.length).toBe(SMART_IMPORT_LIMITS.maxRows);
    const over = gridToRecords([["Name", "Phone"], ...rows(SMART_IMPORT_LIMITS.maxRows + 1)], 0);
    expect(over).toEqual({ error: expect.stringMatching(/more than 5,000/) });
  });

  it("keeps leading zeros, skips blank lines, numbers rows as the sheet does", () => {
    const r = gridToRecords([["", "x"], ["Name", "Phone"], ["A", "01712345678"], ["", ""], ["B", "0099"]], 1);
    if (!("rows" in r)) throw new Error(r.error);
    expect(r.rows).toEqual([
      { rowNumber: 3, cells: { Name: "A", Phone: "01712345678" } },
      { rowNumber: 5, cells: { Name: "B", Phone: "0099" } },
    ]);
  });

  it("names blank and repeated headers and counts them", () => {
    const r = gridToRecords([["Name", "", "Name"], ["A", "b", "c"]], 0);
    if (!("rows" in r)) throw new Error(r.error);
    expect(r.headers).toEqual(["Name", "Column 2", "Name (2)"]);
    expect([r.blankHeaders, r.duplicateHeaders]).toEqual([1, 1]);
  });

  it("refuses too many columns and an oversized cell instead of cutting them", () => {
    expect(gridToRecords([Array.from({ length: SMART_IMPORT_LIMITS.maxColumns + 1 }, (_, i) => `C${i}`)], 0)).toEqual({ error: expect.stringMatching(/columns/) });
    expect(gridToRecords([["Name"], ["x".repeat(SMART_IMPORT_LIMITS.maxCellChars + 1)]], 0)).toEqual({ error: expect.stringMatching(/at most 5,000/) });
  });

  it("finds the header row below a title", () => {
    expect(detectHeaderRow([["Client list — October"], [], ["Name", "Mobile", "Email"], ["A", "017", "a@b.c"]])).toBe(2);
    expect(detectHeaderRow([["Name", "Mobile"]])).toBe(0);
  });
});

/** A zip whose central directory declares the given entries (no real data: inspection reads sizes only). */
function fakeZip(entries: Array<{ name: string; compressed: number; size: number; flags?: number }>): Uint8Array {
  const enc = new TextEncoder();
  const local = new Uint8Array(30);
  new DataView(local.buffer).setUint32(0, 0x04034b50, true);
  const dirs = entries.map((e) => {
    const name = enc.encode(e.name);
    const d = new Uint8Array(46 + name.length);
    const v = new DataView(d.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(8, e.flags ?? 0, true);
    v.setUint32(20, e.compressed, true);
    v.setUint32(24, e.size, true);
    v.setUint16(28, name.length, true);
    d.set(name, 46);
    return d;
  });
  const dirSize = dirs.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + dirSize + end.length);
  out.set(local, 0);
  let p = local.length;
  for (const d of dirs) {
    out.set(d, p);
    p += d.length;
  }
  out.set(end, p);
  return out;
}

describe("inspectXlsxZip — before anything is inflated", () => {
  const ct = { name: "[Content_Types].xml", compressed: 400, size: 1200 };

  it("accepts an ordinary workbook", () => {
    expect(inspectXlsxZip(fakeZip([ct, { name: "xl/worksheets/sheet1.xml", compressed: 300_000, size: 4_000_000 }]))).toMatchObject({ ok: true, entries: 2 });
  });

  it.each([
    ["a zip bomb (huge ratio)", [ct, { name: "xl/worksheets/sheet1.xml", compressed: 10_000, size: 50_000_000 }], /expands/],
    ["too much data in all", [ct, ...Array.from({ length: 5 }, (_, i) => ({ name: `xl/media/${i}.bin`, compressed: 20_000_000, size: 30_000_000 }))], /too much data/],
    ["macros", [ct, { name: "xl/vbaProject.bin", compressed: 10, size: 10 }], /macros/],
    ["encryption", [ct, { name: "xl/workbook.xml", compressed: 10, size: 10, flags: 1 }], /encrypted/],
    ["zip64 sizes", [ct, { name: "xl/workbook.xml", compressed: 0xffffffff, size: 0xffffffff }], /too large/],
    ["no content types (any other zip)", [{ name: "evil.sh", compressed: 10, size: 10 }], /not an Excel/],
  ])("refuses %s", (_label, entries, error) => {
    expect(inspectXlsxZip(fakeZip(entries))).toEqual({ ok: false, error: expect.stringMatching(error) });
  });

  it("refuses a non-zip, an old/encrypted OLE file and a truncated zip", () => {
    expect(inspectXlsxZip(new TextEncoder().encode("Name,Phone\nA,1"))).toMatchObject({ ok: false });
    expect(inspectXlsxZip(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toEqual({ ok: false, error: expect.stringMatching(/password/) });
    expect(inspectXlsxZip(fakeZip([ct]).subarray(0, 40))).toMatchObject({ ok: false });
  });
});

describe("small helpers", () => {
  it("escapes formula-looking cells on export", () => {
    expect(["=1+1", "+88017", "-5", "@x", "Rahim"].map(escapeSpreadsheetCell)).toEqual(["'=1+1", "'+88017", "'-5", "'@x", "Rahim"]);
  });
  it("tells text from binary", () => {
    expect(looksLikeText(new TextEncoder().encode("a,b\n1,2"))).toBe(true);
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 0, 1]))).toBe(false);
  });
});
