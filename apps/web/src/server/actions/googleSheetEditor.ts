"use server";

import { isClientKey } from "@/server/google/sessions";
import { checkPermission } from "@/server/authorize";
import type { GoogleOAuthConfig } from "@/server/google/oauth";
import { resolveProjectGoogleClient } from "@/server/google/clientConfig";
import { sheetEditorAccess, type SheetEditorAccess } from "@/server/google/editorAccess";
import {
  changeSheetDimension,
  loadSheetWindow,
  saveSheetCells,
  searchSheet,
  SheetEditorError,
  type SaveResult,
  type SearchMatch,
  type SeenLines,
  type SheetWindowData,
  type WindowPurpose,
} from "@/server/google/editor";
import type { Session } from "@/server/auth";
import type { CellEdit, DimensionChange } from "@support-automation/shared";

/**
 * The sheet editor (GOOGLE_SHEETS.md §10, Phase 3). Every action is a public endpoint: each decides
 * who is asking — the view key and the feature first, then `sheetEditorAccess` (members open, LEAD /
 * EDITOR members with the edit permission change; managers open read-only) — before anything reaches
 * Google. Nothing here returns a token, and Google's own error text never reaches the browser.
 */

type Refusal = { error: string };

async function asking(spreadsheetId: string, need: "open" | "edit"): Promise<{ session: Session; access: SheetEditorAccess; config: GoogleOAuthConfig } | Refusal> {
  const viewer = await checkPermission("google_sheets.view", "GOOGLE_SHEETS");
  if ("denied" in viewer) return { error: viewer.denied };
  const access = await sheetEditorAccess(spreadsheetId, viewer.session);
  if (!access) return { error: "That spreadsheet is not in this project." };
  if (!access.canOpen) return { error: access.openRefusal ?? "You cannot open this spreadsheet." };
  if (need === "edit" && !access.canEdit) return { error: access.editRefusal ?? "You cannot change this spreadsheet." };
  const client = await resolveProjectGoogleClient();
  if (!client.ok) return { error: client.message };
  const config = client.config;
  return { session: viewer.session, access, config };
}

async function run<T>(work: () => Promise<T>): Promise<T | Refusal> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof SheetEditorError) return { error: err.message };
    console.error("[google-sheets] editor action failed", err);
    return { error: "Something went wrong talking to Google. Try again in a minute." };
  }
}

const sessionKey = (value: unknown) => (isClientKey(value) ? value : null);
const isInt = (v: unknown, min = 0) => typeof v === "number" && Number.isInteger(v) && v >= min;

/** Read one page of one tab. */
export async function loadSheetWindowAction(
  spreadsheetId: string,
  request: { tabId?: number | null; startRow?: number; startCol?: number; purpose: WindowPurpose; clientKey?: string },
): Promise<{ data: SheetWindowData } | Refusal> {
  const who = await asking(spreadsheetId, "open");
  if ("error" in who) return who;
  const purpose: WindowPurpose = ["OPEN", "TAB", "PAGE", "REFRESH"].includes(request.purpose) ? request.purpose : "PAGE";
  return run(async () => ({
    data: await loadSheetWindow(
      {
        spreadsheetId,
        tabId: isInt(request.tabId) ? request.tabId : null,
        startRow: isInt(request.startRow, 1) ? request.startRow : 1,
        startCol: isInt(request.startCol) ? request.startCol : 0,
        purpose,
        userId: who.session.userId,
        withRaw: who.access.canEdit,
        sessionKey: sessionKey(request.clientKey),
      },
      { config: who.config },
    ),
  }));
}

/** Save changed cells. Cells changed in Google meanwhile come back as conflicts, unwritten. */
export async function saveSheetCellsAction(
  spreadsheetId: string,
  request: { tabId: number; edits: CellEdit[]; clientKey?: string },
): Promise<{ result: SaveResult } | Refusal> {
  const who = await asking(spreadsheetId, "edit");
  if ("error" in who) return who;
  if (!isInt(request.tabId) || !Array.isArray(request.edits)) return { error: "Refresh the sheet and try again." };
  const edits: CellEdit[] = request.edits.map((e) => ({ row: Number(e?.row), col: Number(e?.col), value: String(e?.value ?? ""), base: String(e?.base ?? "") }));
  return run(async () => ({
    result: await saveSheetCells({ spreadsheetId, tabId: request.tabId, edits, userId: who.session.userId, clientKey: sessionKey(request.clientKey) }, { config: who.config }),
  }));
}

const DIMENSION_KINDS = new Set(["INSERT_ROWS", "DELETE_ROWS", "INSERT_COLUMNS", "DELETE_COLUMNS", "APPEND_ROWS"]);

/** Insert, append or delete rows or columns. */
export async function changeSheetDimensionAction(
  spreadsheetId: string,
  request: { tabId: number; change: DimensionChange; seen?: SeenLines | null; clientKey?: string },
): Promise<{ description: string } | Refusal> {
  const who = await asking(spreadsheetId, "edit");
  if ("error" in who) return who;
  const change = request.change as DimensionChange | undefined;
  if (!isInt(request.tabId) || !change || !DIMENSION_KINDS.has(change.kind)) return { error: "Refresh the sheet and try again." };
  const seen =
    request.seen && isInt(request.seen.start) && Array.isArray(request.seen.lines)
      ? { start: request.seen.start, lines: request.seen.lines.slice(0, 100).map((line) => (Array.isArray(line) ? line.slice(0, 500).map((v) => String(v ?? "")) : [])) }
      : null;
  return run(async () => {
    const done = await changeSheetDimension(
      { spreadsheetId, tabId: request.tabId, change, seen, userId: who.session.userId, clientKey: sessionKey(request.clientKey) },
      { config: who.config },
    );
    return { description: done.description };
  });
}

/** Find text anywhere in a tab. */
export async function searchSheetAction(
  spreadsheetId: string,
  request: { tabId: number; query: string; clientKey?: string },
): Promise<{ matches: SearchMatch[]; scannedRows: number; partial: boolean; tooMany: boolean } | Refusal> {
  const who = await asking(spreadsheetId, "open");
  if ("error" in who) return who;
  if (!isInt(request.tabId) || typeof request.query !== "string") return { error: "Refresh the sheet and try again." };
  return run(() => searchSheet({ spreadsheetId, tabId: request.tabId, query: request.query, userId: who.session.userId, sessionKey: sessionKey(request.clientKey) }, { config: who.config }));
}
