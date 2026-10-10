/**
 * Google Sheets, Phase 3 — the sheet editor (GOOGLE_SHEETS.md §10). Pure rules shared by the server
 * (which writes to Google) and the browser (which shows the grid), so the two cannot disagree about
 * which cell is which or what counts as a conflict.
 *
 * The editor is deliberately NOT a spreadsheet clone:
 *   - it shows a bounded window (`EDITOR_WINDOW_ROWS` × `EDITOR_WINDOW_COLUMNS`), paged;
 *   - a person types a value or a formula; formatting, charts and filters stay in Google Sheets;
 *   - Save writes only the cells that changed, and only those still holding what was loaded. Google
 *     offers no version check on values, so the server re-reads the cells first: a cell somebody else
 *     changed meanwhile is reported, never overwritten (`planSave`).
 *
 * Rows are 1-based (as Google numbers them on screen); columns are 0-based indexes (A = 0).
 */

export const EDITOR_WINDOW_ROWS = 200;
export const EDITOR_WINDOW_COLUMNS = 26;
/** The most cells one Save may write: a paste larger than this is split by the person, not by us. */
export const MAX_CELLS_PER_SAVE = 2_000;
/** The most characters one cell may hold (Google's own limit is 50,000). */
export const MAX_CELL_LENGTH = 50_000;
/** The most rows or columns added in one press. */
export const MAX_DIMENSION_INSERT = 100;
/** Search reads at most this many cells of a tab, and reports at most this many matches. */
export const SEARCH_CELL_CAP = 200_000;
export const SEARCH_MATCH_CAP = 200;

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`Not a column index: ${index}`);
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "A" → 0, "AA" → 26. Case-insensitive. */
export function columnIndex(letters: string): number {
  const clean = letters.trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(clean)) throw new RangeError(`Not a column: ${letters}`);
  let n = 0;
  for (const ch of clean) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * A tab title as A1 notation needs it: always single-quoted, with any quote doubled. Always quoting
 * is valid for every title, and it is the only safe choice for a title such as "Q1 2026" or "A1",
 * which unquoted would be read as a cell reference.
 */
export function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** `'Tab'!B3` — one cell. */
export function a1Cell(title: string, row: number, col: number): string {
  return `${quoteSheetTitle(title)}!${columnLetter(col)}${row}`;
}

/** `'Tab'!A1:Z200` — a rectangle, inclusive on both ends. */
export function a1Range(title: string, startRow: number, startCol: number, endRow: number, endCol: number): string {
  return `${quoteSheetTitle(title)}!${columnLetter(startCol)}${startRow}:${columnLetter(endCol)}${endRow}`;
}

/** The bounded window the grid shows: rows [startRow, startRow + rows), columns [startCol, startCol + cols). */
export interface EditorWindow {
  startRow: number;
  startCol: number;
  rows: number;
  cols: number;
}

/**
 * The window to read, clamped to the tab's own size: never past its last row or column (Google
 * would answer with nothing there), never before row 1, never larger than the editor shows.
 */
export function clampWindow(requested: { startRow?: number; startCol?: number }, grid: { rowCount: number; columnCount: number }): EditorWindow {
  const rowCount = Math.max(1, Math.floor(grid.rowCount || 1));
  const columnCount = Math.max(1, Math.floor(grid.columnCount || 1));
  const startRow = Math.min(Math.max(1, Math.floor(requested.startRow ?? 1)), rowCount);
  const startCol = Math.min(Math.max(0, Math.floor(requested.startCol ?? 0)), columnCount - 1);
  return {
    startRow,
    startCol,
    rows: Math.min(EDITOR_WINDOW_ROWS, rowCount - startRow + 1),
    cols: Math.min(EDITOR_WINDOW_COLUMNS, columnCount - startCol),
  };
}

/** The window as an A1 range on a tab. */
export function windowRange(title: string, w: EditorWindow): string {
  return a1Range(title, w.startRow, w.startCol, w.startRow + w.rows - 1, w.startCol + w.cols - 1);
}

/**
 * Google answers `values.get` with ragged rows: trailing empty cells and rows are simply missing,
 * and numbers or booleans come back as JSON numbers or booleans. This is the one place that turns
 * that into a full rectangle of strings, so "empty", "0" and "FALSE" compare the same way on both
 * sides of a save.
 */
export function normalizeValues(values: unknown, rows: number, cols: number): string[][] {
  const source = Array.isArray(values) ? values : [];
  const out: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row = Array.isArray(source[r]) ? (source[r] as unknown[]) : [];
    const line: string[] = [];
    for (let c = 0; c < cols; c++) line.push(cellText(row[c]));
    out.push(line);
  }
  return out;
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** One cell the person changed: where, what they typed, and what it held when they loaded it. */
export interface CellEdit {
  row: number;
  col: number;
  value: string;
  /** The raw content (value or formula) the person saw before editing. */
  base: string;
}

export interface CellConflict {
  row: number;
  col: number;
  /** What the person typed — kept so they can save again on purpose. */
  value: string;
  /** What the cell holds now in Google. */
  now: string;
}

export const cellKey = (row: number, col: number) => `${row}:${col}`;

/**
 * Which edits may be written. `current` is what each cell holds in Google RIGHT NOW (re-read just
 * before writing). A cell whose content is no longer what the person loaded was changed by someone
 * else meanwhile: it is reported, never overwritten. An edit that already matches the cell (somebody
 * typed the same thing) needs no write. Duplicate edits of one cell keep the last.
 */
export function planSave(edits: readonly CellEdit[], current: ReadonlyMap<string, string>): { write: CellEdit[]; conflicts: CellConflict[]; unchanged: number } {
  const last = new Map<string, CellEdit>();
  for (const edit of edits) last.set(cellKey(edit.row, edit.col), edit);
  const write: CellEdit[] = [];
  const conflicts: CellConflict[] = [];
  let unchanged = 0;
  for (const [key, edit] of last) {
    const now = current.get(key) ?? "";
    if (now === edit.value) {
      unchanged++;
      continue;
    }
    if (now !== edit.base) {
      conflicts.push({ row: edit.row, col: edit.col, value: edit.value, now });
      continue;
    }
    write.push(edit);
  }
  write.sort((a, b) => a.row - b.row || a.col - b.col);
  conflicts.sort((a, b) => a.row - b.row || a.col - b.col);
  return { write, conflicts, unchanged };
}

/** Why an edit list is refused before anything is read from Google, or null when it is fine. */
export function validateEdits(edits: readonly CellEdit[]): string | null {
  if (edits.length === 0) return "There are no changes to save.";
  if (edits.length > MAX_CELLS_PER_SAVE) return `One save can change at most ${MAX_CELLS_PER_SAVE.toLocaleString("en-US")} cells. Save part of it first.`;
  for (const edit of edits) {
    if (!Number.isInteger(edit.row) || edit.row < 1 || !Number.isInteger(edit.col) || edit.col < 0) return "A changed cell is outside the sheet. Refresh and try again.";
    if (typeof edit.value !== "string" || typeof edit.base !== "string") return "A changed cell could not be read. Refresh and try again.";
    if (edit.value.length > MAX_CELL_LENGTH) return `A cell can hold at most ${MAX_CELL_LENGTH.toLocaleString("en-US")} characters.`;
  }
  return null;
}

/** The smallest rectangle holding every edited cell — what the activity log records as the range. */
export function boundingRange(title: string, cells: ReadonlyArray<{ row: number; col: number }>): string | null {
  if (cells.length === 0) return null;
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const cell of cells) {
    minRow = Math.min(minRow, cell.row);
    maxRow = Math.max(maxRow, cell.row);
    minCol = Math.min(minCol, cell.col);
    maxCol = Math.max(maxCol, cell.col);
  }
  return minRow === maxRow && minCol === maxCol ? a1Cell(title, minRow, minCol) : a1Range(title, minRow, minCol, maxRow, maxCol);
}

/**
 * Pasted text (tab-separated rows, as every spreadsheet copies) as a grid of strings. A trailing
 * newline does not make an extra empty row; Windows line endings are accepted.
 */
export function parsePastedGrid(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
  return lines.map((line) => line.split("\t"));
}

/** A structural change made from the editor. */
export type DimensionChange =
  | { kind: "INSERT_ROWS"; at: number; count: number }
  | { kind: "DELETE_ROWS"; from: number; count: number }
  | { kind: "INSERT_COLUMNS"; at: number; count: number }
  | { kind: "DELETE_COLUMNS"; from: number; count: number }
  | { kind: "APPEND_ROWS"; count: number };

/**
 * Why a structural change is refused before anything is sent to Google, or null. `at` and `from`
 * are 1-based rows or 0-based columns as everywhere else here; `at` is where the NEW rows begin, so
 * inserting below row 5 is `at: 6`.
 */
export function validateDimensionChange(change: DimensionChange, grid: { rowCount: number; columnCount: number }): string | null {
  const count = change.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_DIMENSION_INSERT) return `Add or delete between 1 and ${MAX_DIMENSION_INSERT} at a time.`;
  switch (change.kind) {
    case "APPEND_ROWS":
      return null;
    case "INSERT_ROWS":
      return Number.isInteger(change.at) && change.at >= 1 && change.at <= grid.rowCount + 1 ? null : "That row is outside the sheet. Refresh and try again.";
    case "INSERT_COLUMNS":
      return Number.isInteger(change.at) && change.at >= 0 && change.at <= grid.columnCount ? null : "That column is outside the sheet. Refresh and try again.";
    case "DELETE_ROWS":
      if (!Number.isInteger(change.from) || change.from < 1 || change.from + count - 1 > grid.rowCount) return "That row is outside the sheet. Refresh and try again.";
      return count >= grid.rowCount ? "A tab must keep at least one row." : null;
    case "DELETE_COLUMNS":
      if (!Number.isInteger(change.from) || change.from < 0 || change.from + count > grid.columnCount) return "That column is outside the sheet. Refresh and try again.";
      return count >= grid.columnCount ? "A tab must keep at least one column." : null;
  }
}

/** Plain words for a structural change — the confirmation, the toast and the activity log. */
export function describeDimensionChange(change: DimensionChange): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  switch (change.kind) {
    case "APPEND_ROWS":
      return `Added ${n(change.count, "row", "rows")} at the end`;
    case "INSERT_ROWS":
      return `Inserted ${n(change.count, "row", "rows")} at row ${change.at}`;
    case "INSERT_COLUMNS":
      return `Inserted ${n(change.count, "column", "columns")} at column ${columnLetter(change.at)}`;
    case "DELETE_ROWS":
      return change.count === 1 ? `Deleted row ${change.from}` : `Deleted rows ${change.from}–${change.from + change.count - 1}`;
    case "DELETE_COLUMNS":
      return change.count === 1
        ? `Deleted column ${columnLetter(change.from)}`
        : `Deleted columns ${columnLetter(change.from)}–${columnLetter(change.from + change.count - 1)}`;
  }
}

/**
 * Before deleting, the row (or column) is re-read and compared with what the person was looking at.
 * Google numbers rows by position, so a row inserted above by somebody else meanwhile would make
 * "delete row 12" delete a different row. Compared over the columns (or rows) the person saw.
 */
export function sameLine(seen: readonly string[], now: readonly string[]): boolean {
  const length = Math.max(seen.length, now.length);
  for (let i = 0; i < length; i++) if ((seen[i] ?? "") !== (now[i] ?? "")) return false;
  return true;
}

/** What the person opening a sheet may do in the app's editor, decided from facts the server checked. */
export interface EditorAccessInput {
  /** Their CURRENT role on this sheet, or null when they are not a member. */
  role: "LEAD" | "EDITOR" | "MONITOR" | null;
  /** `google_sheets.view` / `.edit` / `.manage` in this project, after the project's access level. */
  hasView: boolean;
  hasEdit: boolean;
  hasManage: boolean;
  /** A suspended or archived project changes nothing. */
  projectReadOnly: boolean;
}

export interface EditorAccess {
  canOpen: boolean;
  canEdit: boolean;
  openRefusal: string | null;
  editRefusal: string | null;
}

/**
 * Who sees a sheet's contents through the app, and who changes them (GOOGLE_SHEETS.md §5, §8):
 *   - contents are opened by the sheet's members, or by a Google Sheets manager;
 *   - changes are made only by a LEAD or EDITOR member who holds the edit permission, in a writable
 *     project. A manager who is not a member opens the sheet read-only: work is credited to a member
 *     role, so a manager who wants to work on it adds themselves as an Editor first. A monitor never
 *     edits, whatever their permissions.
 */
export function decideEditorAccess(input: EditorAccessInput): EditorAccess {
  if (!input.hasView) return { canOpen: false, canEdit: false, openRefusal: "Opening spreadsheets needs the “View Google Sheets” permission.", editRefusal: null };
  if (input.role === null && !input.hasManage) {
    return {
      canOpen: false,
      canEdit: false,
      openRefusal: "Only this spreadsheet's members open it in the app. Ask its Lead or a Google Sheets manager to add you.",
      editRefusal: null,
    };
  }
  const refuse = (editRefusal: string): EditorAccess => ({ canOpen: true, canEdit: false, openRefusal: null, editRefusal });
  if (input.projectReadOnly) return refuse("This project is read-only, so nothing can be changed.");
  if (input.role === null) return refuse("You are not a member of this spreadsheet, so it opens read-only. To work on it, add yourself as an Editor — work is credited to members.");
  if (input.role === "MONITOR") return refuse("You monitor this spreadsheet, so it opens read-only.");
  if (!input.hasEdit) return refuse("Your role does not include “Edit Google Sheets” in this project, so it opens read-only.");
  return { canOpen: true, canEdit: true, openRefusal: null, editRefusal: null };
}
