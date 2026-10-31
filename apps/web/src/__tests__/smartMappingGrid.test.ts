import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sanitizeSmartMapping, SMART_FIELD_GROUPS, SMART_SAMPLE_VALUES, upgradeMapping, type SmartMapping } from "@support-automation/shared";
import { MappingGrid, type MappingGridProps } from "@/app/p/[project]/(dashboard)/clients/import/smart/MappingGrid";
import { MAPPING_VIEW_KEY, mappingToSave, readMappingView } from "@/app/p/[project]/(dashboard)/clients/import/smart/mappingView";
import { previewRow, type PreviewSourceRow } from "@/lib/smartMappingPreview";

/**
 * Smart Import V5 §1 — the approved Visual Mapping grid is the permanent DEFAULT Advanced Mapping screen.
 * These tests pin its shape: Get Assist's fields across the TOP, the Excel-column picker directly BELOW each,
 * and the file's real rows BELOW that, aligned row by row, recomputed from the mapping on every change.
 */

const headers = ["Customer", "Mobile", "Alt mobile", "Country", "SAR", "Start"];
const rows: PreviewSourceRow[] = [
  { rowNumber: 2, cells: { Customer: "Ahmed Saleh", Mobile: "966551234567", Country: "Saudi Arabia", SAR: "30.00", Start: "17/10/2026" } },
  // Row 3 has NO mobile: its preview must be empty, never the next client's number.
  { rowNumber: 3, cells: { Customer: "Rina Akter", "Alt mobile": "01712345678", Start: "2026-10-18" } },
  { rowNumber: 4, cells: { Customer: "Omar Ali", Mobile: "+971501234567" } },
];
const mapping: SmartMapping = { version: 2, fields: { name: { mode: "source", column: "Customer" }, phone: { mode: "source", column: "Mobile" }, startDate: { mode: "source", column: "Start" } } };

function props(over: Partial<MappingGridProps> = {}): MappingGridProps {
  return {
    groups: SMART_FIELD_GROUPS,
    headers,
    columnFilled: { Customer: 3, Mobile: 2, "Alt mobile": 1, Country: 1, SAR: 1, Start: 2 },
    mapping,
    samples: SMART_SAMPLE_VALUES,
    previewRows: rows,
    defaultCountry: "BD",
    suggestions: [],
    choices: {},
    onRule: () => {},
    ...over,
  };
}
const render = (p: MappingGridProps) => renderToStaticMarkup(createElement(MappingGrid, p));

describe("Visual Mapping grid: the approved layout", () => {
  const html = render(props());

  it("puts Get Assist's fields across the top, the Excel picker below them, and the rows below that", () => {
    const groups = html.indexOf('data-row="groups"');
    const fields = html.indexOf('data-row="fields"');
    const sources = html.indexOf('data-row="sources"');
    const firstRow = html.indexOf('data-row="preview"');
    expect(groups).toBeGreaterThan(-1);
    expect(groups).toBeLessThan(fields);
    expect(fields).toBeLessThan(sources);
    expect(sources).toBeLessThan(firstRow);
    expect(html.indexOf("<thead")).toBeLessThan(sources);
    expect(html.indexOf("</thead>")).toBeLessThan(firstRow);
  });

  it("has one heading and one picker per field, in the same order, and the file's headers are never the top row", () => {
    const fieldOrder = SMART_FIELD_GROUPS.flatMap((g) => g.fields);
    const headingRow = html.slice(html.indexOf('data-row="fields"'), html.indexOf('data-row="sources"'));
    const pickerRow = html.slice(html.indexOf('data-row="sources"'), html.indexOf("</thead>"));
    const order = (chunk: string, attr: string) => [...chunk.matchAll(new RegExp(`${attr}="([a-zA-Z]+)"`, "g"))].map((m) => m[1]);
    expect(order(headingRow, "data-field")).toEqual(fieldOrder);
    expect(order(pickerRow, "data-picker")).toEqual(fieldOrder);
    for (const label of ["Name", "Phone", "Email", "WhatsApp number", "Country", "Preferred currency", "Category", "Service / plan", "Start date", "Expiry date"]) expect(headingRow).toContain(`>${label}`);
    // The Excel headers appear as choices (in pickers), never as the grid's own column headings.
    expect(headingRow).not.toContain(">Mobile<");
  });

  it("shows each file row as one client, aligned, with the normalized value under the original", () => {
    const rowHtml = (n: number) => html.slice(html.indexOf(`data-row-number="${n}"`), html.indexOf("</tr>", html.indexOf(`data-row-number="${n}"`)));
    expect(rowHtml(2)).toContain("Ahmed Saleh");
    expect(rowHtml(2)).toContain("966551234567");
    expect(rowHtml(2)).toContain("+966551234567"); // normalized under the original
    expect(rowHtml(2)).toContain("2026-10-17");
    expect(rowHtml(3)).toContain("Rina Akter");
    expect(rowHtml(3)).not.toContain("971501234567"); // never another client's phone
    expect(rowHtml(4)).toContain("+971501234567");
    expect([...html.matchAll(/data-row="preview"/g)].length).toBe(3);
  });

  it("marks a required field that is not mapped", () => {
    const unmapped = render(props({ mapping: { version: 2, fields: {} } }));
    expect(unmapped).toContain("Not mapped — every client needs this");
  });
});

describe("Visual Mapping grid: the preview follows the mapping at once", () => {
  it("re-renders a column from the newly chosen Excel column", () => {
    const before = render(props());
    const after = render(props({ mapping: { ...mapping, fields: { ...mapping.fields, phone: { mode: "source", column: "Alt mobile" } } } }));
    const row3 = (h: string) => h.slice(h.indexOf('data-row-number="3"'), h.indexOf("</tr>", h.indexOf('data-row-number="3"')));
    expect(row3(before)).not.toContain("01712345678");
    expect(row3(after)).toContain("01712345678");
    expect(row3(after)).toContain("+8801712345678"); // read in the project's default country
  });

  it("derives country, currency and language from a valid number, marked as derived", () => {
    const cells = previewRow(rows[2]!, mapping, SMART_SAMPLE_VALUES, ["country", "currency", "language"], {});
    expect(cells.country).toMatchObject({ tone: "derived", value: "United Arab Emirates (AE)" });
    expect(cells.currency).toMatchObject({ tone: "derived", value: "AED" });
    expect(cells.language).toMatchObject({ tone: "derived", value: "Arabic" });
  });

  it("uses the if-empty column only for that row, and says so", () => {
    const m: SmartMapping = { version: 2, fields: { phone: { mode: "source", column: "Mobile", fallback: "Alt mobile" } } };
    expect(previewRow(rows[1]!, m, SMART_SAMPLE_VALUES, ["phone"], { defaultCountry: "BD" }).phone).toMatchObject({ original: "01712345678", fromFallback: true });
    expect(previewRow(rows[0]!, m, SMART_SAMPLE_VALUES, ["phone"], {}).phone).toMatchObject({ original: "966551234567" });
  });
});

describe("the grid is the default view and keeps saved mappings working", () => {
  it("opens the grid unless this browser explicitly chose the Detailed view", () => {
    const store = (v: string | null) => ({ getItem: (k: string) => (k === MAPPING_VIEW_KEY ? v : null) });
    expect(readMappingView(null)).toBe("grid");
    expect(readMappingView(store(null))).toBe("grid");
    expect(readMappingView(store("something-old"))).toBe("grid");
    expect(readMappingView(store("detailed"))).toBe("detailed");
    expect(readMappingView({ getItem: () => { throw new Error("private mode"); } })).toBe("grid");
  });

  it("renders a v1 saved mapping, and every rule the grid can set is one the server accepts", () => {
    const v1 = upgradeMapping({ name: "Customer", phone: "Mobile" });
    expect(render(props({ mapping: v1 }))).toContain("Ahmed Saleh");
    const fromGrid: SmartMapping = {
      version: 2,
      fields: {
        name: { mode: "source", column: "Customer" },
        phone: { mode: "source", column: "Mobile", fallback: "Alt mobile" },
        status: { mode: "constant", value: "ACTIVE" },
        language: { mode: "sample" },
      },
    };
    const clean = sanitizeSmartMapping(fromGrid, headers);
    expect(clean).toEqual({ ok: true, mapping: fromGrid });
  });
});

describe("what the editor saves", () => {
  it("sends every part of the mapping, and never an unchosen column", () => {
    const edited: SmartMapping = {
      version: 2,
      fields: { name: { mode: "source", column: "Customer" }, phone: { mode: "source", column: "" } },
      fillLocale: false,
      money: { mode: "MULTI", columns: [{ column: "SAR", currency: "SAR" }, { column: "", currency: "" }] },
      keepColumns: ["Alt mobile"],
    };
    const saved = mappingToSave(edited);
    expect(saved).toEqual({
      version: 2,
      fields: { name: { mode: "source", column: "Customer" } },
      fillLocale: false,
      money: { mode: "MULTI", columns: [{ column: "SAR", currency: "SAR" }] },
      keepColumns: ["Alt mobile"],
    });
    expect(sanitizeSmartMapping(saved, headers)).toEqual({ ok: true, mapping: saved });
  });
});
