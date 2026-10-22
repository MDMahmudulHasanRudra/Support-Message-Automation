/**
 * Google Sheets, Phase 6 — the activity log's vocabulary (GOOGLE_SHEETS.md §6). Kept in sync with the
 * Prisma enums `GoogleSheetActionType`, `GoogleSheetActivityKind`, `GoogleSheetActivitySource` and
 * `GoogleSheetAttribution` by convention (packages/engine and the browser cannot depend on
 * @prisma/client), exactly like the other catalogues in this package.
 *
 * Two separations hold everywhere:
 *   - VIEW is not WORK. Opening, reading, paging, searching is viewing. Only a saved change is work.
 *   - APPLICATION is not EXTERNAL_GOOGLE. The app knows exactly who did what through it; Google tells
 *     us only that an edit happened in Google and, sometimes, which Google account did it — never for
 *     how long and never which cells (§3).
 */

export const SHEET_ACTIVITY_KINDS = ["VIEW", "WORK", "OTHER"] as const;
export type SheetActivityKind = (typeof SHEET_ACTIVITY_KINDS)[number];

export const SHEET_ACTIVITY_SOURCES = ["APPLICATION", "EXTERNAL_GOOGLE"] as const;
export type SheetActivitySource = (typeof SHEET_ACTIVITY_SOURCES)[number];

export const SHEET_ACTION_TYPES = [
  // Viewing in the app.
  "SPREADSHEET_OPENED",
  "TAB_OPENED",
  "REFRESHED",
  "SEARCHED",
  // Work in the app.
  "CELLS_EDITED",
  "ROWS_ADDED",
  "ROWS_DELETED",
  "COLUMNS_ADDED",
  "COLUMNS_DELETED",
  // Done in Google directly (Drive Activity, Phase 8).
  "EXTERNAL_EDIT",
  "EXTERNAL_CREATE",
  "EXTERNAL_RENAME",
  "EXTERNAL_DELETE",
  "EXTERNAL_RESTORE",
  "EXTERNAL_COMMENT",
  "EXTERNAL_PERMISSION_CHANGE",
  "EXTERNAL_MOVE",
  "EXTERNAL_OTHER",
] as const;
export type SheetActionType = (typeof SHEET_ACTION_TYPES)[number];

export const SHEET_ACTION_LABELS: Record<SheetActionType, string> = {
  SPREADSHEET_OPENED: "Opened the spreadsheet",
  TAB_OPENED: "Opened a tab",
  REFRESHED: "Refreshed",
  SEARCHED: "Searched",
  CELLS_EDITED: "Changed cells",
  ROWS_ADDED: "Added rows",
  ROWS_DELETED: "Deleted rows",
  COLUMNS_ADDED: "Added columns",
  COLUMNS_DELETED: "Deleted columns",
  EXTERNAL_EDIT: "Edited in Google",
  EXTERNAL_CREATE: "Created in Google",
  EXTERNAL_RENAME: "Renamed in Google",
  EXTERNAL_DELETE: "Deleted in Google",
  EXTERNAL_RESTORE: "Restored in Google",
  EXTERNAL_COMMENT: "Commented in Google",
  EXTERNAL_PERMISSION_CHANGE: "Changed sharing in Google",
  EXTERNAL_MOVE: "Moved in Google",
  EXTERNAL_OTHER: "Other change in Google",
};

const KIND: Record<SheetActionType, SheetActivityKind> = {
  SPREADSHEET_OPENED: "VIEW",
  TAB_OPENED: "VIEW",
  REFRESHED: "VIEW",
  SEARCHED: "VIEW",
  CELLS_EDITED: "WORK",
  ROWS_ADDED: "WORK",
  ROWS_DELETED: "WORK",
  COLUMNS_ADDED: "WORK",
  COLUMNS_DELETED: "WORK",
  EXTERNAL_EDIT: "WORK",
  EXTERNAL_CREATE: "WORK",
  EXTERNAL_RENAME: "WORK",
  EXTERNAL_DELETE: "WORK",
  EXTERNAL_RESTORE: "WORK",
  // A comment, a sharing change or a move is participation, not a change to the sheet's contents.
  EXTERNAL_COMMENT: "OTHER",
  EXTERNAL_PERMISSION_CHANGE: "OTHER",
  EXTERNAL_MOVE: "OTHER",
  EXTERNAL_OTHER: "OTHER",
};

/** Whether an action is viewing, work, or neither (an external comment or sharing change). */
export function actionKind(action: SheetActionType): SheetActivityKind {
  return KIND[action];
}

export function isSheetActionType(value: unknown): value is SheetActionType {
  return typeof value === "string" && (SHEET_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * How an activity row is credited.
 *   APPLICATION       done in the app: the signed-in person, by construction.
 *   ATTRIBUTED        done in Google, by an actor whose Google identity the person linked themselves.
 *   UNATTRIBUTED      done in Google by someone the module cannot name with certainty (`reason` says why).
 *   APPLICATION_ECHO  Google's own record of a change the app made — already counted as application
 *                     work, so never counted again.
 */
export const SHEET_ATTRIBUTIONS = ["APPLICATION", "ATTRIBUTED", "UNATTRIBUTED", "APPLICATION_ECHO"] as const;
export type SheetAttribution = (typeof SHEET_ATTRIBUTIONS)[number];

export const UNATTRIBUTED_REASONS = {
  SEVERAL_ACTORS: "Google reports several people for this change",
  UNKNOWN_USER: "Google does not say who it was",
  DELETED_USER: "The Google account has been deleted",
  ANONYMOUS: "An anonymous visitor (link sharing)",
  IMPERSONATION: "An administrator acting as someone else",
  ADMINISTRATOR: "A Google Workspace administrator",
  SYSTEM: "Done by Google itself",
  NO_LINKED_IDENTITY: "Nobody has linked this Google account to their login",
  BRIDGE_UNVERIFIED: "Google's account numbers have not been confirmed to match sign-in yet",
  BRIDGE_MISMATCH: "Google's account numbers did not match sign-in, so nothing is credited",
  OTHER: "Google did not identify the actor",
} as const;
export type UnattributedReason = keyof typeof UNATTRIBUTED_REASONS;

export function unattributedReasonLabel(reason: string | null | undefined): string {
  return reason && reason in UNATTRIBUTED_REASONS ? UNATTRIBUTED_REASONS[reason as UnattributedReason] : UNATTRIBUTED_REASONS.OTHER;
}

/** "Edits in Google" in the reports: an external change to the sheet itself, credited or not, never an echo. */
export function countsAsExternalEdit(row: { source: SheetActivitySource; kind: SheetActivityKind; attribution: SheetAttribution }): boolean {
  return row.source === "EXTERNAL_GOOGLE" && row.kind === "WORK" && row.attribution !== "APPLICATION_ECHO";
}
