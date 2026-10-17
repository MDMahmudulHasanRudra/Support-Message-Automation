import { deflateRawSync } from "node:zlib";

/**
 * A small .xlsx writer for files people FILL IN (the client import template, CLIENTS_V3.md §Import).
 *
 * SheetJS community edition — already used for reading and plain exports — cannot write the parts a
 * good template needs: drop-down lists, a tip when a cell is selected, a frozen header, column formats
 * (phones as text so a leading 0 survives, dates as yyyy-mm-dd) and styled headers. Rather than add a
 * heavy dependency for that, this writes the Office Open XML parts itself and zips them with the
 * platform's own deflate. Every string is XML-escaped and no CELL holds a formula, so nothing a
 * person types can run. The only formulas are conditional-formatting rules (`highlights`), which
 * colour a cell and compute nothing into the sheet.
 */

export type CellValue = string | number | null;
/** Named cell styles (indices into styles.xml below). */
export type CellStyle = "default" | "header" | "headerRequired" | "text" | "date" | "title" | "wrap" | "muted" | "example" | "bold";

const STYLE_INDEX: Record<CellStyle, number> = { default: 0, header: 1, headerRequired: 2, text: 3, date: 4, title: 5, wrap: 6, muted: 7, example: 8, bold: 9 };

export interface Cell {
  value: CellValue;
  style?: CellStyle;
}

export interface Validation {
  /** e.g. "L2:L2001". */
  range: string;
  /** A list source such as `'Lists'!$A$2:$A$5`; omitted for a tip-only rule. */
  list?: string;
  /** A whole number or a date between `min` and `max` (a date as YYYY-MM-DD), instead of a list. */
  between?: { kind: "whole" | "date"; min: number | string; max: number | string; error: string };
  /** "stop" refuses other values; "warning" lets the person keep theirs after a warning. */
  errorStyle?: "stop" | "warning";
  promptTitle?: string;
  prompt?: string;
}

export interface SheetSpec {
  name: string;
  rows: Array<Array<Cell | CellValue>>;
  /** Width in characters, per column from A. */
  widths?: number[];
  /** Style applied to a whole column (format for empty cells too), per column from A. */
  columnStyles?: Array<CellStyle | undefined>;
  freezeRows?: number;
  freezeCols?: number;
  validations?: Validation[];
  /** Height of row 1 in points (a wrapped header). */
  headerHeight?: number;
  /** Filter arrows on the header row, over this range (e.g. "A1:Y2001"). */
  autoFilter?: string;
  /** Live checks: a cell turns red (`error`) or amber (`warning`) while the formula is true for it. */
  highlights?: Highlight[];
}

export interface Highlight {
  /** e.g. "A2:A2001". */
  range: string;
  /** Written for the range's FIRST cell, relative references (e.g. `AND(A2="",COUNTA($B2:$Y2)>0)`). */
  formula: string;
  tone: "error" | "warning";
}

/** Excel's own serial for a calendar day (days from 1899-12-30), as a validation bound. */
function serial(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000) + 25569;
}

const esc = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetXml(sheet: SheetSpec): string {
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((raw, c) => {
          const cell: Cell = raw !== null && typeof raw === "object" ? raw : { value: raw };
          const ref = `${columnLetter(c)}${r + 1}`;
          const s = cell.style ? ` s="${STYLE_INDEX[cell.style]}"` : "";
          if (cell.value === null || cell.value === "") return cell.style ? `<c r="${ref}"${s}/>` : "";
          if (typeof cell.value === "number" && Number.isFinite(cell.value)) return `<c r="${ref}"${s}><v>${cell.value}</v></c>`;
          return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.value))}</t></is></c>`;
        })
        .join("");
      const ht = r === 0 && sheet.headerHeight ? ` ht="${sheet.headerHeight}" customHeight="1"` : "";
      return `<row r="${r + 1}"${ht}>${cells}</row>`;
    })
    .join("");
  const frozenRows = sheet.freezeRows ?? 0;
  const frozenCols = sheet.freezeCols ?? 0;
  const pane =
    frozenRows || frozenCols
      ? `<pane${frozenCols ? ` xSplit="${frozenCols}"` : ""}${frozenRows ? ` ySplit="${frozenRows}"` : ""} topLeftCell="${columnLetter(frozenCols)}${frozenRows + 1}" activePane="${frozenRows && frozenCols ? "bottomRight" : frozenRows ? "bottomLeft" : "topRight"}" state="frozen"/>`
      : "";
  const count = Math.max(sheet.widths?.length ?? 0, sheet.columnStyles?.length ?? 0);
  const cols = count
    ? `<cols>${Array.from({ length: count }, (_, i) => {
        const width = sheet.widths?.[i] ?? 12;
        const style = sheet.columnStyles?.[i];
        return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"${style ? ` style="${STYLE_INDEX[style]}"` : ""}/>`;
      }).join("")}</cols>`
    : "";
  const validations = sheet.validations?.length
    ? `<dataValidations count="${sheet.validations.length}">${sheet.validations
        .map((v) => {
          const attrs = [
            v.list ? `type="list"` : v.between ? `type="${v.between.kind}" operator="between"` : "",
            `allowBlank="1"`,
            v.prompt ? `showInputMessage="1"` : "",
            v.list || v.between ? `showErrorMessage="1"` : "",
            (v.list || v.between) && v.errorStyle === "warning" ? `errorStyle="warning"` : "",
            v.promptTitle ? `promptTitle="${esc(v.promptTitle.slice(0, 32))}"` : "",
            v.prompt ? `prompt="${esc(v.prompt.slice(0, 255))}"` : "",
            v.list ? `errorTitle="Not on the list"` : v.between ? `errorTitle="Check this value"` : "",
            v.list
              ? `error="${esc(v.errorStyle === "warning" ? "This is not on the list. Keep it only if you are sure it is right." : "Choose a value from the drop-down list.")}"`
              : v.between
                ? `error="${esc(v.between.error.slice(0, 255))}"`
                : "",
            `sqref="${v.range}"`,
          ]
            .filter(Boolean)
            .join(" ");
          const bound = (x: number | string) => (v.between!.kind === "date" && typeof x === "string" ? serial(x) : x);
          const formulas = v.list ? `<formula1>${esc(v.list)}</formula1>` : v.between ? `<formula1>${bound(v.between.min)}</formula1><formula2>${bound(v.between.max)}</formula2>` : "";
          return `<dataValidation ${attrs}>${formulas}</dataValidation>`;
        })
        .join("")}</dataValidations>`
    : "";
  const autoFilter = sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : "";
  // dxf 0 = error (red), 1 = warning (amber) — see STYLES_XML.
  const highlights = (sheet.highlights ?? [])
    .map((h, i) => `<conditionalFormatting sqref="${h.range}"><cfRule type="expression" dxfId="${h.tone === "error" ? 0 : 1}" priority="${i + 1}"><formula>${esc(h.formula)}</formula></cfRule></conditionalFormatting>`)
    .join("");
  // Schema order: sheetData, autoFilter, conditionalFormatting, dataValidations, pageMargins.
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="16"/>${cols}<sheetData>${rows}</sheetData>${autoFilter}${highlights}${validations}` +
    `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  );
}

/** Fonts, fills, borders and the ten named styles. Order must match STYLE_INDEX. */
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>` +
  `<fonts count="5">` +
  `<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="16"/><color rgb="FF0F172A"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><i/><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `</fonts>` +
  `<fills count="5">` +
  `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="10">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="49" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="49" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1"/></xf>` +
  `<xf numFmtId="49" fontId="0" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1"/>` +
  `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  // Conditional-format looks: 0 = a problem (red), 1 = worth a look (amber).
  `<dxfs count="2">` +
  `<dxf><font><color rgb="FF9F1239"/></font><fill><patternFill patternType="solid"><bgColor rgb="FFFEE2E2"/></patternFill></fill></dxf>` +
  `<dxf><font><color rgb="FF92400E"/></font><fill><patternFill patternType="solid"><bgColor rgb="FFFEF3C7"/></patternFill></fill></dxf>` +
  `</dxfs>` +
  `</styleSheet>`;

// ── Zip (deflate), enough for a workbook ────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.data, "utf8");
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += 30 + name.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/** The workbook as .xlsx bytes. The first sheet opens first (and is the one an import reads). */
export function buildWorkbook(sheets: SheetSpec[], title: string): Buffer {
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("")}</sheets>${(() => {
      // Excel keeps a sheet's filter range as a hidden defined name; without it some versions repair the file.
      const names = sheets
        .map((s, i) => (s.autoFilter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name.slice(0, 31))}'!${s.autoFilter.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}</definedName>` : ""))
        .join("");
      return names ? `<definedNames>${names}</definedNames>` : "";
    })()}</workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`;
  return zip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "docProps/core.xml", data: core },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}
