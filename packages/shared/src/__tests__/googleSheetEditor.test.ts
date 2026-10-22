import { describe, expect, it } from "vitest";
import {
  a1Cell,
  a1Range,
  boundingRange,
  cellKey,
  clampWindow,
  columnIndex,
  columnLetter,
  decideEditorAccess,
  describeDimensionChange,
  EDITOR_WINDOW_COLUMNS,
  EDITOR_WINDOW_ROWS,
  normalizeValues,
  parsePastedGrid,
  planSave,
  quoteSheetTitle,
  sameLine,
  validateDimensionChange,
  validateEdits,
  windowRange,
} from "../googleSheetEditor.js";

/** Google Sheets Phase 3 — the editor's pure rules (GOOGLE_SHEETS.md §10). */

describe("A1 notation", () => {
  it("numbers columns the way Google does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    for (const i of [0, 7, 25, 26, 300, 702, 16383]) expect(columnIndex(columnLetter(i))).toBe(i);
    expect(columnIndex("ab")).toBe(27);
    expect(() => columnLetter(-1)).toThrow();
    expect(() => columnIndex("A1")).toThrow();
  });

  it("always quotes a tab title, doubling quotes — 'Q1 2026' or 'A1' must never read as a cell", () => {
    expect(quoteSheetTitle("Sheet1")).toBe("'Sheet1'");
    expect(quoteSheetTitle("A1")).toBe("'A1'");
    expect(quoteSheetTitle("Rudra's list")).toBe("'Rudra''s list'");
    expect(a1Cell("Daily Follow-up", 3, 1)).toBe("'Daily Follow-up'!B3");
    expect(a1Range("Sheet1", 1, 0, 200, 25)).toBe("'Sheet1'!A1:Z200");
  });

  it("keeps the window inside the tab and never larger than the editor shows", () => {
    expect(clampWindow({}, { rowCount: 1000, columnCount: 26 })).toEqual({ startRow: 1, startCol: 0, rows: EDITOR_WINDOW_ROWS, cols: EDITOR_WINDOW_COLUMNS });
    expect(clampWindow({ startRow: 901, startCol: 0 }, { rowCount: 1000, columnCount: 5 })).toEqual({ startRow: 901, startCol: 0, rows: 100, cols: 5 });
    expect(clampWindow({ startRow: 5000, startCol: 99 }, { rowCount: 10, columnCount: 3 })).toEqual({ startRow: 10, startCol: 2, rows: 1, cols: 1 });
    expect(clampWindow({ startRow: -4, startCol: -1 }, { rowCount: 0, columnCount: 0 })).toEqual({ startRow: 1, startCol: 0, rows: 1, cols: 1 });
    expect(windowRange("T", { startRow: 201, startCol: 26, rows: 200, cols: 26 })).toBe("'T'!AA201:AZ400");
  });

  it("fills Google's ragged answer into a full rectangle of strings", () => {
    expect(normalizeValues([["a", 1], [], [true, null, "x"]], 4, 3)).toEqual([
      ["a", "1", ""],
      ["", "", ""],
      ["true", "", "x"],
      ["", "", ""],
    ]);
    expect(normalizeValues(undefined, 1, 2)).toEqual([["", ""]]);
  });
});

describe("planSave — nobody's change in Google is silently overwritten", () => {
  const now = new Map([
    [cellKey(2, 0), "Rahim"],
    [cellKey(2, 1), "500"],
    [cellKey(3, 1), "=SUM(B1:B2)"],
  ]);

  it("writes a cell still holding what the person loaded", () => {
    const plan = planSave([{ row: 2, col: 1, value: "650", base: "500" }], now);
    expect(plan.write).toEqual([{ row: 2, col: 1, value: "650", base: "500" }]);
    expect(plan.conflicts).toEqual([]);
  });

  it("reports — and does not write — a cell changed in Google since it was loaded", () => {
    const plan = planSave([{ row: 2, col: 0, value: "Karim", base: "Rahima" }], now);
    expect(plan.write).toEqual([]);
    expect(plan.conflicts).toEqual([{ row: 2, col: 0, value: "Karim", now: "Rahim" }]);
  });

  it("needs no write when Google already holds the value; an empty cell is ''", () => {
    const plan = planSave(
      [
        { row: 3, col: 1, value: "=SUM(B1:B2)", base: "5" },
        { row: 9, col: 9, value: "new", base: "" },
      ],
      now,
    );
    expect(plan.unchanged).toBe(1);
    expect(plan.write).toEqual([{ row: 9, col: 9, value: "new", base: "" }]);
  });

  it("keeps the last of two edits to one cell, and orders writes by position", () => {
    const plan = planSave(
      [
        { row: 9, col: 2, value: "first", base: "" },
        { row: 1, col: 0, value: "top", base: "" },
        { row: 9, col: 2, value: "second", base: "" },
      ],
      new Map(),
    );
    expect(plan.write.map((e) => e.value)).toEqual(["top", "second"]);
  });

  it("refuses an empty save, a huge one, and a cell outside the sheet before Google is asked", () => {
    expect(validateEdits([])).toMatch(/no changes/);
    expect(validateEdits(Array.from({ length: 2001 }, (_, i) => ({ row: i + 1, col: 0, value: "x", base: "" })))).toMatch(/at most 2,000/);
    expect(validateEdits([{ row: 0, col: 0, value: "x", base: "" }])).toMatch(/outside/);
    expect(validateEdits([{ row: 1, col: -1, value: "x", base: "" }])).toMatch(/outside/);
    expect(validateEdits([{ row: 1, col: 0, value: "x".repeat(50_001), base: "" }])).toMatch(/50,000/);
    expect(validateEdits([{ row: 1, col: 0, value: "ok", base: "" }])).toBeNull();
  });

  it("records the range touched, never the values", () => {
    expect(boundingRange("T", [{ row: 4, col: 2 }])).toBe("'T'!C4");
    expect(boundingRange("T", [{ row: 4, col: 2 }, { row: 2, col: 5 }])).toBe("'T'!C2:F4");
    expect(boundingRange("T", [])).toBeNull();
  });

  it("reads pasted rows the way every spreadsheet copies them", () => {
    expect(parsePastedGrid("a\tb\r\nc\td\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parsePastedGrid("one")).toEqual([["one"]]);
  });
});

describe("rows and columns", () => {
  const grid = { rowCount: 100, columnCount: 10 };
  it("refuses anything outside the tab, and never deletes the last row or column", () => {
    expect(validateDimensionChange({ kind: "INSERT_ROWS", at: 101, count: 1 }, grid)).toBeNull();
    expect(validateDimensionChange({ kind: "INSERT_ROWS", at: 102, count: 1 }, grid)).toMatch(/outside/);
    expect(validateDimensionChange({ kind: "DELETE_ROWS", from: 100, count: 1 }, grid)).toBeNull();
    expect(validateDimensionChange({ kind: "DELETE_ROWS", from: 100, count: 2 }, grid)).toMatch(/outside/);
    expect(validateDimensionChange({ kind: "DELETE_ROWS", from: 1, count: 100 }, grid)).toMatch(/at least one row/);
    expect(validateDimensionChange({ kind: "DELETE_COLUMNS", from: 9, count: 1 }, grid)).toBeNull();
    expect(validateDimensionChange({ kind: "DELETE_COLUMNS", from: 0, count: 10 }, grid)).toMatch(/at least one column/);
    expect(validateDimensionChange({ kind: "APPEND_ROWS", count: 0 }, grid)).toMatch(/between 1 and 100/);
    expect(validateDimensionChange({ kind: "APPEND_ROWS", count: 101 }, grid)).toMatch(/between 1 and 100/);
  });
  it("words each change for the log and the toast", () => {
    expect(describeDimensionChange({ kind: "DELETE_ROWS", from: 12, count: 1 })).toBe("Deleted row 12");
    expect(describeDimensionChange({ kind: "DELETE_COLUMNS", from: 2, count: 2 })).toBe("Deleted columns C–D");
    expect(describeDimensionChange({ kind: "INSERT_ROWS", at: 6, count: 3 })).toBe("Inserted 3 rows at row 6");
    expect(describeDimensionChange({ kind: "APPEND_ROWS", count: 10 })).toBe("Added 10 rows at the end");
  });
  it("compares a line as shown, treating missing trailing cells as empty", () => {
    expect(sameLine(["a", "b", ""], ["a", "b"])).toBe(true);
    expect(sameLine(["a", "b"], ["a", "c"])).toBe(false);
  });
});

describe("decideEditorAccess — who opens and who changes a sheet", () => {
  const base = { hasView: true, hasEdit: true, hasManage: false, projectReadOnly: false };
  it("a Lead or Editor with the edit permission changes it", () => {
    expect(decideEditorAccess({ ...base, role: "LEAD" })).toMatchObject({ canOpen: true, canEdit: true });
    expect(decideEditorAccess({ ...base, role: "EDITOR" })).toMatchObject({ canOpen: true, canEdit: true });
  });
  it("a monitor opens it read-only, whatever their permissions", () => {
    expect(decideEditorAccess({ ...base, role: "MONITOR", hasManage: true })).toMatchObject({ canOpen: true, canEdit: false });
  });
  it("an Editor without the edit permission opens it read-only", () => {
    expect(decideEditorAccess({ ...base, role: "EDITOR", hasEdit: false })).toMatchObject({ canOpen: true, canEdit: false });
  });
  it("somebody who is not a member does not open it — unless a manager, who opens it read-only", () => {
    expect(decideEditorAccess({ ...base, role: null })).toMatchObject({ canOpen: false, canEdit: false });
    const manager = decideEditorAccess({ ...base, role: null, hasManage: true });
    expect(manager).toMatchObject({ canOpen: true, canEdit: false });
    expect(manager.editRefusal).toMatch(/add yourself as an Editor/);
  });
  it("a read-only project changes nothing; without the view key nothing opens", () => {
    expect(decideEditorAccess({ ...base, role: "LEAD", projectReadOnly: true })).toMatchObject({ canOpen: true, canEdit: false });
    expect(decideEditorAccess({ ...base, role: "LEAD", hasView: false })).toMatchObject({ canOpen: false, canEdit: false });
  });
});
