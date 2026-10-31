import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseUpload } from "@/server/smartImport";

/**
 * Smart Import V5 §11, the "0 rows" report: many customer workbooks open on a cover or instructions sheet,
 * and the import always read the FIRST sheet. Without a choice from the person, the sheet whose columns look
 * like a client list is opened; a file whose first sheet is the list behaves exactly as before.
 */
function workbook(sheets: Array<[string, unknown[][]]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const clients = [
  ["Customer", "Mobile", "Email", "Country"],
  ["Ahmed Saleh", "966551234567", "ahmed@example.com", "Saudi Arabia"],
  ["Rina Akter", "8801712345678", "rina@example.com", "Bangladesh"],
];
const cover = [["How to use this workbook"], ["Purpose", "Fill the Clients sheet, then upload it"], ["Owner", "Accounts team"]];

describe("which sheet an upload opens", () => {
  it("skips an instructions sheet to the one holding the client list", () => {
    const r = parseUpload(workbook([["START HERE", cover], ["Clients", clients]]), "book.xlsx");
    if ("error" in r) throw new Error(r.error);
    expect(r.sheetName).toBe("Clients");
    expect(r.records.rows).toHaveLength(2);
    expect(r.sheetReason).toContain('"Clients"');
    expect(r.sheetNames).toEqual(["START HERE", "Clients"]);
  });

  it("keeps the first sheet when it is the list (no change for files that worked)", () => {
    const r = parseUpload(workbook([["Clients", clients], ["Notes", cover]]), "book.xlsx");
    if ("error" in r) throw new Error(r.error);
    expect(r.sheetName).toBe("Clients");
    expect(r.sheetReason).toBeNull();
  });

  it("always opens the sheet the person chose", () => {
    const r = parseUpload(workbook([["START HERE", cover], ["Clients", clients]]), "book.xlsx", { sheet: "START HERE" });
    if ("error" in r) throw new Error(r.error);
    expect(r.sheetName).toBe("START HERE");
    expect(r.sheetReason).toBeNull();
  });

  it("keeps a phone typed as a number, and a leading-zero phone typed as text", () => {
    const r = parseUpload(workbook([["Clients", [["Name", "Phone"], ["A", 966551234567], ["B", "01712345678"]]]]), "book.xlsx");
    if ("error" in r) throw new Error(r.error);
    expect(r.records.rows.map((x) => x.cells.Phone)).toEqual(["966551234567", "01712345678"]);
  });
});
