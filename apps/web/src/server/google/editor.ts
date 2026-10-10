import {
  a1Cell,
  a1Range,
  boundingRange,
  cellKey,
  clampWindow,
  columnLetter,
  describeDimensionChange,
  EDITOR_WINDOW_COLUMNS,
  EDITOR_WINDOW_ROWS,
  normalizeValues,
  planSave,
  quoteSheetTitle,
  sameLine,
  SEARCH_CELL_CAP,
  SEARCH_MATCH_CAP,
  validateDimensionChange,
  validateEdits,
  windowRange,
  type CellConflict,
  type CellEdit,
  type DimensionChange,
  type EditorWindow,
  type SheetActionType,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import {
  batchGetValues,
  batchUpdateSpreadsheet,
  batchUpdateValues,
  getSpreadsheetTabs,
  apiDisabledMessage,
  GoogleApiError,
  type FetchImpl,
  type SheetTab,
} from "@/server/google/api";
import { getAccessToken, GoogleAccountUnavailableError } from "@/server/google/accounts";
import { recordAppActivity } from "@/server/google/activity";
import { recordSaveSignal } from "@/server/google/sessions";
import type { GoogleOAuthConfig } from "@/server/google/oauth";

/**
 * The sheet editor's server side (GOOGLE_SHEETS.md §10, Phase 3). Who may open or edit is decided by
 * the caller (`decideEditorAccess` in the actions); this file talks to Google through a connected
 * account and records what was done in the activity log.
 *
 * Writes are careful because Google offers no version check on values:
 *   - Save re-reads the cells first and writes only those still holding what the person loaded
 *     (`planSave`); a cell somebody changed meanwhile is reported, never overwritten.
 *   - Deleting a row or column re-reads it first and refuses when it no longer holds what the person
 *     was looking at — rows are numbered by position, so a row inserted above would otherwise make
 *     "delete row 12" delete a different row.
 * Every change is credited to the signed-in person, never to the Google account that carried it.
 */

export class SheetEditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetEditorError";
  }
}

interface Options {
  config: GoogleOAuthConfig;
  fetchImpl?: FetchImpl;
  now?: Date;
}

interface SheetPath {
  sheet: { id: string; name: string; googleFileId: string };
  accountId: string;
  email: string;
  /** Whether Google lets this account edit the file. */
  canEdit: boolean;
}

/** The connected account to reach the sheet through: one that can edit when a change is needed. */
async function choosePath(spreadsheetId: string, needEdit: boolean): Promise<SheetPath> {
  const sheet = await prisma.googleSpreadsheet.findUnique({
    where: { id: spreadsheetId },
    select: {
      id: true,
      name: true,
      googleFileId: true,
      access: {
        where: { removedAt: null, googleAccount: { status: "CONNECTED" } },
        orderBy: [{ canEdit: "desc" }, { firstSeenAt: "asc" }],
        select: { canEdit: true, googleAccount: { select: { id: true, email: true } } },
      },
    },
  });
  if (!sheet) throw new SheetEditorError("That spreadsheet is not in this project.");
  const path = needEdit ? sheet.access.find((a) => a.canEdit) : sheet.access[0];
  if (!path) {
    throw new SheetEditorError(
      needEdit
        ? "None of the connected Google accounts can edit this spreadsheet in Google. Share it with one of them as an Editor, then refresh the spreadsheet list."
        : "No connected Google account can reach this spreadsheet any more. Reconnect the account it was shared with, or share it again.",
    );
  }
  return { sheet: { id: sheet.id, name: sheet.name, googleFileId: sheet.googleFileId }, accountId: path.googleAccount.id, email: path.googleAccount.email, canEdit: path.canEdit };
}

/** Words for a refusal from Google, never Google's raw text (it can carry internal detail). */
function explain(err: unknown, email: string): SheetEditorError {
  if (err instanceof SheetEditorError) return err;
  if (err instanceof GoogleAccountUnavailableError) return new SheetEditorError(err.message);
  if (err instanceof GoogleApiError) {
    if (err.apiDisabled) return new SheetEditorError(apiDisabledMessage("Google Sheets API"));
    if (err.status === 404) return new SheetEditorError("Google no longer has this spreadsheet for this account — it was deleted, or moved out of reach.");
    if (err.status === 403) return new SheetEditorError(`Google refused: ${email} can no longer open or change this spreadsheet. Check how it is shared in Google.`);
    if (err.status === 429) return new SheetEditorError("Google is limiting requests just now. Wait a minute and try again.");
    if (err.status === 400) return new SheetEditorError("Google could not find that part of the spreadsheet — a tab may have been renamed or removed. Refresh and try again.");
  }
  return new SheetEditorError("Google could not be reached just now. Try again in a minute.");
}

/** Run Google calls with the account's token; a token Google just refused is refreshed once. */
async function withToken<T>(path: SheetPath, options: Options, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    try {
      return await fn(await getAccessToken(path.accountId, options));
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 401) return await fn(await getAccessToken(path.accountId, { ...options, forceRefresh: true }));
      throw err;
    }
  } catch (err) {
    throw explain(err, path.email);
  }
}

function findTab(tabs: SheetTab[], tabId: number | null | undefined): SheetTab {
  const grids = tabs.filter((t) => t.isGrid);
  if (tabId !== null && tabId !== undefined) {
    const tab = grids.find((t) => t.sheetId === tabId);
    if (!tab) throw new SheetEditorError("That tab is no longer in the spreadsheet — it was removed or is not a grid. Refresh to see the current tabs.");
    return tab;
  }
  const first = grids.find((t) => !t.hidden) ?? grids[0];
  if (!first) throw new SheetEditorError("This spreadsheet has no tabs with cells to show. Open it in Google Sheets.");
  return first;
}

export type WindowPurpose = "OPEN" | "TAB" | "PAGE" | "REFRESH";

const PURPOSE_ACTIVITY: Record<WindowPurpose, SheetActionType | null> = {
  OPEN: "SPREADSHEET_OPENED",
  TAB: "TAB_OPENED",
  PAGE: null,
  REFRESH: "REFRESHED",
};

export interface SheetWindowData {
  tabs: Array<Pick<SheetTab, "sheetId" | "title" | "hidden" | "isGrid" | "rowCount" | "columnCount">>;
  tab: Pick<SheetTab, "sheetId" | "title" | "rowCount" | "columnCount">;
  window: EditorWindow;
  /** What Google shows in each cell. */
  display: string[][];
  /** What is typed in each cell (value or formula) — only for someone who may edit. */
  raw: string[][] | null;
  via: string;
  /** Whether the account the sheet is reached through may edit it in Google. */
  googleCanEdit: boolean;
  loadedAt: string;
}

/** Read the bounded window of one tab. Records the viewing activity that opening, switching tab or refreshing is. */
export async function loadSheetWindow(
  input: { spreadsheetId: string; tabId?: number | null; startRow?: number; startCol?: number; purpose: WindowPurpose; userId: string; withRaw: boolean; sessionKey?: string | null },
  options: Options,
): Promise<SheetWindowData> {
  const path = await choosePath(input.spreadsheetId, false);
  const data = await withToken(path, options, async (token) => {
    const { tabs } = await getSpreadsheetTabs(token, path.sheet.googleFileId, options.fetchImpl);
    const tab = findTab(tabs, input.tabId);
    const window = clampWindow({ startRow: input.startRow, startCol: input.startCol }, tab);
    const range = windowRange(tab.title, window);
    const [display, raw] = await Promise.all([
      batchGetValues(token, path.sheet.googleFileId, [range], "FORMATTED_VALUE", options.fetchImpl),
      input.withRaw ? batchGetValues(token, path.sheet.googleFileId, [range], "FORMULA", options.fetchImpl) : Promise.resolve(null),
    ]);
    return {
      tabs: tabs.map((t) => ({ sheetId: t.sheetId, title: t.title, hidden: t.hidden, isGrid: t.isGrid, rowCount: t.rowCount, columnCount: t.columnCount })),
      tab: { sheetId: tab.sheetId, title: tab.title, rowCount: tab.rowCount, columnCount: tab.columnCount },
      window,
      display: normalizeValues(display[0], window.rows, window.cols),
      raw: raw ? normalizeValues(raw[0], window.rows, window.cols) : null,
      via: path.email,
      googleCanEdit: path.canEdit,
      loadedAt: (options.now ?? new Date()).toISOString(),
    } satisfies SheetWindowData;
  });
  const action = PURPOSE_ACTIVITY[input.purpose];
  if (action) {
    await recordAppActivity({
      spreadsheetId: path.sheet.id,
      actionType: action,
      userId: input.userId,
      googleAccountId: path.accountId,
      sessionId: await sessionIdFor(input.sessionKey ?? null, path.sheet.id, input.userId),
      tab: { sheetId: data.tab.sheetId, title: data.tab.title },
      at: options.now,
    });
  }
  return data;
}

async function sessionIdFor(clientKey: string | null, spreadsheetId: string, userId: string): Promise<string | null> {
  if (!clientKey) return null;
  const row = await prisma.googleSheetWorkSession.findFirst({ where: { clientKey, spreadsheetId, userId }, select: { id: true } });
  return row?.id ?? null;
}

export interface SaveResult {
  written: number;
  conflicts: CellConflict[];
  unchanged: number;
  tabTitle: string;
}

/**
 * Save the person's changed cells. Only cells still holding what they loaded are written; the rest
 * come back as conflicts with what each holds now, so the person decides. One `values.batchUpdate`,
 * one cell per range, so nothing they did not change is touched.
 */
export async function saveSheetCells(
  input: { spreadsheetId: string; tabId: number; edits: CellEdit[]; userId: string; clientKey?: string | null },
  options: Options,
): Promise<SaveResult> {
  const invalid = validateEdits(input.edits);
  if (invalid) throw new SheetEditorError(invalid);
  const path = await choosePath(input.spreadsheetId, true);
  const rows = input.edits.map((e) => e.row);
  const cols = input.edits.map((e) => e.col);
  const top = Math.min(...rows);
  const bottom = Math.max(...rows);
  const left = Math.min(...cols);
  const right = Math.max(...cols);
  if (bottom - top + 1 > EDITOR_WINDOW_ROWS || right - left + 1 > EDITOR_WINDOW_COLUMNS) {
    throw new SheetEditorError("Save the changes on one page at a time.");
  }

  const result = await withToken(path, options, async (token) => {
    const { tabs } = await getSpreadsheetTabs(token, path.sheet.googleFileId, options.fetchImpl);
    const tab = findTab(tabs, input.tabId);
    if (bottom > tab.rowCount || right >= tab.columnCount) throw new SheetEditorError("Some changed cells are outside the tab now — rows or columns were removed. Refresh and try again.");
    const [current] = await batchGetValues(token, path.sheet.googleFileId, [a1Range(tab.title, top, left, bottom, right)], "FORMULA", options.fetchImpl);
    const grid = normalizeValues(current, bottom - top + 1, right - left + 1);
    const now = new Map<string, string>();
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) now.set(cellKey(r, c), grid[r - top]![c - left]!);
    const plan = planSave(input.edits, now);
    if (plan.write.length > 0) {
      await batchUpdateValues(
        token,
        path.sheet.googleFileId,
        plan.write.map((e) => ({ range: a1Cell(tab.title, e.row, e.col), value: e.value })),
        options.fetchImpl,
      );
    }
    return { plan, tab };
  });

  if (result.plan.write.length > 0) {
    const sessionId = await recordSaveSignal({ clientKey: input.clientKey ?? null, spreadsheetId: path.sheet.id, userId: input.userId, now: options.now });
    await recordAppActivity({
      spreadsheetId: path.sheet.id,
      actionType: "CELLS_EDITED",
      userId: input.userId,
      googleAccountId: path.accountId,
      sessionId,
      tab: { sheetId: result.tab.sheetId, title: result.tab.title },
      range: boundingRange(result.tab.title, result.plan.write),
      itemCount: result.plan.write.length,
      at: options.now,
    });
  }
  return { written: result.plan.write.length, conflicts: result.plan.conflicts, unchanged: result.plan.unchanged, tabTitle: result.tab.title };
}

/** What the person was looking at in the row(s) or column(s) they asked to delete. */
export interface SeenLines {
  /** For rows: the first column shown. For columns: the first row shown. */
  start: number;
  /** One entry per row (or column) being deleted, in order: its values as shown. */
  lines: string[][];
}

function dimensionRange(title: string, change: DimensionChange): string | null {
  const t = quoteSheetTitle(title);
  switch (change.kind) {
    case "INSERT_ROWS":
      return `${t}!${change.at}:${change.at + change.count - 1}`;
    case "DELETE_ROWS":
      return `${t}!${change.from}:${change.from + change.count - 1}`;
    case "INSERT_COLUMNS":
      return `${t}!${columnLetter(change.at)}:${columnLetter(change.at + change.count - 1)}`;
    case "DELETE_COLUMNS":
      return `${t}!${columnLetter(change.from)}:${columnLetter(change.from + change.count - 1)}`;
    case "APPEND_ROWS":
      return null;
  }
}

/** Insert, append or delete rows or columns. A delete is refused when the line changed since it was loaded. */
export async function changeSheetDimension(
  input: { spreadsheetId: string; tabId: number; change: DimensionChange; seen?: SeenLines | null; userId: string; clientKey?: string | null },
  options: Options,
): Promise<{ description: string; tabTitle: string }> {
  const path = await choosePath(input.spreadsheetId, true);
  const change = input.change;
  const tab = await withToken(path, options, async (token) => {
    const { tabs } = await getSpreadsheetTabs(token, path.sheet.googleFileId, options.fetchImpl);
    const tab = findTab(tabs, input.tabId);
    const invalid = validateDimensionChange(change, tab);
    if (invalid) throw new SheetEditorError(invalid);

    if (change.kind === "DELETE_ROWS" || change.kind === "DELETE_COLUMNS") {
      const seen = input.seen;
      if (!seen || seen.lines.length !== change.count) throw new SheetEditorError("Refresh the sheet before deleting, so it is clear what is being deleted.");
      const span = Math.max(1, ...seen.lines.map((l) => l.length));
      const range =
        change.kind === "DELETE_ROWS"
          ? a1Range(tab.title, change.from, seen.start, change.from + change.count - 1, seen.start + span - 1)
          : a1Range(tab.title, seen.start, change.from, seen.start + span - 1, change.from + change.count - 1);
      const [current] = await batchGetValues(token, path.sheet.googleFileId, [range], "FORMULA", options.fetchImpl);
      const grid = change.kind === "DELETE_ROWS" ? normalizeValues(current, change.count, span) : normalizeValues(current, span, change.count);
      for (let i = 0; i < change.count; i++) {
        const now = change.kind === "DELETE_ROWS" ? grid[i]! : grid.map((row) => row[i]!);
        if (!sameLine(seen.lines[i]!, now)) {
          throw new SheetEditorError(
            change.kind === "DELETE_ROWS"
              ? `Row ${change.from + i} changed in Google since you loaded it (someone edited it, or added or removed rows above). Nothing was deleted — refresh and check.`
              : `Column ${columnLetter(change.from + i)} changed in Google since you loaded it. Nothing was deleted — refresh and check.`,
          );
        }
      }
    }

    const request =
      change.kind === "APPEND_ROWS"
        ? { appendDimension: { sheetId: tab.sheetId, dimension: "ROWS", length: change.count } }
        : change.kind === "INSERT_ROWS"
          ? { insertDimension: { range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: change.at - 1, endIndex: change.at - 1 + change.count }, inheritFromBefore: change.at > 1 } }
          : change.kind === "INSERT_COLUMNS"
            ? { insertDimension: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: change.at, endIndex: change.at + change.count }, inheritFromBefore: change.at > 0 } }
            : change.kind === "DELETE_ROWS"
              ? { deleteDimension: { range: { sheetId: tab.sheetId, dimension: "ROWS", startIndex: change.from - 1, endIndex: change.from - 1 + change.count } } }
              : { deleteDimension: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: change.from, endIndex: change.from + change.count } } };
    await batchUpdateSpreadsheet(token, path.sheet.googleFileId, [request], options.fetchImpl);
    return tab;
  });

  const description = describeDimensionChange(change);
  const actionType: SheetActionType =
    change.kind === "DELETE_ROWS" ? "ROWS_DELETED" : change.kind === "DELETE_COLUMNS" ? "COLUMNS_DELETED" : change.kind === "INSERT_COLUMNS" ? "COLUMNS_ADDED" : "ROWS_ADDED";
  const sessionId = await recordSaveSignal({ clientKey: input.clientKey ?? null, spreadsheetId: path.sheet.id, userId: input.userId, now: options.now });
  await recordAppActivity({
    spreadsheetId: path.sheet.id,
    actionType,
    userId: input.userId,
    googleAccountId: path.accountId,
    sessionId,
    tab: { sheetId: tab.sheetId, title: tab.title },
    range: dimensionRange(tab.title, change),
    itemCount: change.count,
    detail: description,
    at: options.now,
  });
  return { description, tabTitle: tab.title };
}

export interface SearchMatch {
  row: number;
  col: number;
  text: string;
}

/**
 * Find text in a whole tab (what Google shows, case-insensitive). Reads at most `SEARCH_CELL_CAP`
 * cells and returns at most `SEARCH_MATCH_CAP` matches, and says when it stopped short. The search
 * term is never stored — the activity log records only that a search happened.
 */
export async function searchSheet(
  input: { spreadsheetId: string; tabId: number; query: string; userId: string; sessionKey?: string | null },
  options: Options,
): Promise<{ matches: SearchMatch[]; scannedRows: number; partial: boolean; tooMany: boolean }> {
  const query = input.query.trim().toLowerCase();
  if (query.length < 1 || query.length > 200) throw new SheetEditorError("Type between 1 and 200 characters to search for.");
  const path = await choosePath(input.spreadsheetId, false);
  const result = await withToken(path, options, async (token) => {
    const { tabs } = await getSpreadsheetTabs(token, path.sheet.googleFileId, options.fetchImpl);
    const tab = findTab(tabs, input.tabId);
    const cols = Math.max(1, tab.columnCount);
    const scannedRows = Math.max(1, Math.min(tab.rowCount, Math.floor(SEARCH_CELL_CAP / cols)));
    const [values] = await batchGetValues(token, path.sheet.googleFileId, [a1Range(tab.title, 1, 0, scannedRows, cols - 1)], "FORMATTED_VALUE", options.fetchImpl);
    const matches: SearchMatch[] = [];
    let tooMany = false;
    const source = Array.isArray(values) ? values : [];
    outer: for (let r = 0; r < source.length; r++) {
      const row = Array.isArray(source[r]) ? (source[r] as unknown[]) : [];
      for (let c = 0; c < row.length; c++) {
        const text = typeof row[c] === "string" ? (row[c] as string) : row[c] === null || row[c] === undefined ? "" : String(row[c]);
        if (text && text.toLowerCase().includes(query)) {
          if (matches.length >= SEARCH_MATCH_CAP) {
            tooMany = true;
            break outer;
          }
          matches.push({ row: r + 1, col: c, text: text.length > 160 ? `${text.slice(0, 160)}…` : text });
        }
      }
    }
    return { tab, matches, scannedRows, partial: scannedRows < tab.rowCount, tooMany };
  });
  await recordAppActivity({
    spreadsheetId: path.sheet.id,
    actionType: "SEARCHED",
    userId: input.userId,
    googleAccountId: path.accountId,
    sessionId: await sessionIdFor(input.sessionKey ?? null, path.sheet.id, input.userId),
    tab: { sheetId: result.tab.sheetId, title: result.tab.title },
    at: options.now,
  });
  return { matches: result.matches, scannedRows: result.scannedRows, partial: result.partial, tooMany: result.tooMany };
}
