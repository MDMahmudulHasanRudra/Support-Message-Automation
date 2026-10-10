import type { GoogleOAuthConfig } from "@/server/google/oauth";

/**
 * The Google HTTP calls the module makes, with plain `fetch` (the same choice as packages/
 * forge-client: no SDK, nothing beyond what is called). Server-only — tokens pass through here and
 * nowhere else. `fetchImpl` is injectable so tests never touch the network.
 */

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
export const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
export const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";

/** The most spreadsheets one account's list holds; past it the list is reported as "at least". */
export const SPREADSHEET_LIST_CAP = 10_000;

export type FetchImpl = typeof fetch;

/** A refusal from Google, kept apart from a network failure so callers can react to each. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    /** Google's own error code (`invalid_grant`, `insufficientPermissions`, …) when it gave one. */
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }

  /** The refresh token is dead (revoked, expired, password changed): only a reconnect helps. */
  get needsReconnect(): boolean {
    return this.code === "invalid_grant" || this.status === 401;
  }
}

async function readError(response: Response): Promise<GoogleApiError> {
  let code: string | null = null;
  let detail = "";
  try {
    const body = (await response.json()) as { error?: string | { message?: string; status?: string; errors?: Array<{ reason?: string }> }; error_description?: string };
    if (typeof body.error === "string") {
      code = body.error;
      detail = body.error_description ?? "";
    } else if (body.error) {
      code = body.error.errors?.[0]?.reason ?? body.error.status ?? null;
      detail = body.error.message ?? "";
    }
  } catch {
    /* not JSON: the status says enough */
  }
  return new GoogleApiError(`Google answered ${response.status}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`, code, response.status);
}

export interface TokenResponse {
  accessToken: string;
  /** Present on the first exchange (with prompt=consent); absent on a refresh. */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

function toTokenResponse(body: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }, now: number): TokenResponse {
  if (!body.access_token) throw new GoogleApiError("Google returned no access token.", null, 200);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    // A minute early, so a token is never used in its last seconds.
    expiresAt: new Date(now + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000),
    scopes: (body.scope ?? "").split(" ").filter(Boolean),
  };
}

/** Redeem the authorization code Google sent back (with the PKCE verifier). */
export async function exchangeCode(config: GoogleOAuthConfig, code: string, verifier: string, fetchImpl: FetchImpl = fetch): Promise<TokenResponse> {
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw await readError(response);
  return toTokenResponse(await response.json(), Date.now());
}

/** A fresh access token from the stored refresh token. */
export async function refreshAccessToken(config: GoogleOAuthConfig, refreshToken: string, fetchImpl: FetchImpl = fetch): Promise<TokenResponse> {
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw await readError(response);
  return toTokenResponse(await response.json(), Date.now());
}

export interface GoogleIdentity {
  /** Google's stable account id — the identity. */
  subject: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export async function fetchIdentity(accessToken: string, fetchImpl: FetchImpl = fetch): Promise<GoogleIdentity> {
  const response = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
  if (!body.sub || !body.email) throw new GoogleApiError("Google did not say which account this is.", null, 200);
  return { subject: body.sub, email: body.email.toLowerCase(), name: body.name ?? null, picture: body.picture ?? null };
}

/** One spreadsheet as Drive describes it — file METADATA only, nothing from inside the sheet. */
export interface DriveSpreadsheet {
  id: string;
  name: string;
  modifiedTime: Date | null;
  webViewLink: string | null;
  /** Whether the file is shared with anyone in Google. */
  shared: boolean;
  ownerName: string | null;
  ownerEmail: string | null;
  /** Google's "last modifying user" for the whole file — display only, never attribution. */
  lastModifiedByName: string | null;
  lastModifiedByEmail: string | null;
  /** What Google lets THIS account do with the file. */
  canEdit: boolean;
  canShare: boolean;
}

/**
 * Exactly the Drive fields the list needs. No `permissions` (only returned to accounts that can
 * share, and not needed to list), and nothing that reads a sheet's contents.
 */
export const DRIVE_SPREADSHEET_FIELDS =
  "nextPageToken,files(id,name,modifiedTime,webViewLink,shared,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),capabilities(canEdit,canShare))";

interface DriveFileJson {
  id?: string;
  name?: string;
  modifiedTime?: string;
  webViewLink?: string;
  shared?: boolean;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  capabilities?: { canEdit?: boolean; canShare?: boolean };
}

/** Only an https link on a Google host is kept: the page renders it as a link people click. */
export function safeGoogleLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "google.com" || url.hostname.endsWith(".google.com")) ? url.toString() : null;
  } catch {
    return null;
  }
}

function toDriveSpreadsheet(file: DriveFileJson): DriveSpreadsheet | null {
  if (!file.id) return null;
  const modified = file.modifiedTime ? new Date(file.modifiedTime) : null;
  const owner = file.owners?.[0];
  return {
    id: file.id,
    name: file.name?.trim() || "Untitled spreadsheet",
    modifiedTime: modified && !Number.isNaN(modified.getTime()) ? modified : null,
    webViewLink: safeGoogleLink(file.webViewLink),
    shared: file.shared === true,
    ownerName: owner?.displayName ?? null,
    ownerEmail: owner?.emailAddress?.toLowerCase() ?? null,
    lastModifiedByName: file.lastModifyingUser?.displayName ?? null,
    // Google omits it when the person has not made their email visible to this account.
    lastModifiedByEmail: file.lastModifyingUser?.emailAddress?.toLowerCase() ?? null,
    canEdit: file.capabilities?.canEdit === true,
    canShare: file.capabilities?.canShare === true,
  };
}

/**
 * Every spreadsheet the account can see, newest first, from Drive METADATA (`files.list`) — the
 * list is built without opening a single sheet. Shared drives included. Stops at
 * `SPREADSHEET_LIST_CAP`; a capped list is reported as such, because what it left out is unknown.
 */
export async function listDriveSpreadsheets(accessToken: string, fetchImpl: FetchImpl = fetch): Promise<{ files: DriveSpreadsheet[]; capped: boolean }> {
  const files: DriveSpreadsheet[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(DRIVE_FILES_ENDPOINT);
    url.searchParams.set("q", `mimeType='${SPREADSHEET_MIME}' and trashed=false`);
    url.searchParams.set("fields", DRIVE_SPREADSHEET_FIELDS);
    url.searchParams.set("orderBy", "modifiedTime desc");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    url.searchParams.set("corpora", "allDrives");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw await readError(response);
    const body = (await response.json()) as { files?: DriveFileJson[]; nextPageToken?: string };
    for (const file of body.files ?? []) {
      const sheet = toDriveSpreadsheet(file);
      if (sheet) files.push(sheet);
    }
    pageToken = body.nextPageToken;
    if (files.length >= SPREADSHEET_LIST_CAP) return { files: files.slice(0, SPREADSHEET_LIST_CAP), capped: true };
  } while (pageToken);
  return { files, capped: false };
}

/** One entry of a file's sharing in Google Drive — Google's permission, never the app's. */
export interface DrivePermissionEntry {
  /** `user`, `group`, `domain` or `anyone`. */
  type: string;
  /** Google's role: `owner`, `organizer`, `fileOrganizer`, `writer`, `commenter` or `reader`. */
  role: string;
  emailAddress: string | null;
  displayName: string | null;
  domain: string | null;
  deleted: boolean;
}

/** The most sharing entries read for one file; a file shared wider than this is listed as "at least". */
export const SHARING_LIST_CAP = 500;

/**
 * A file's sharing list (Drive `permissions.list`). Google returns it only to an account that can
 * share the file; any other account is refused, which the caller treats as "not visible", not as an
 * error. Read for display only: nothing here is ever turned into app membership.
 */
export async function listDrivePermissions(accessToken: string, fileId: string, fetchImpl: FetchImpl = fetch): Promise<{ entries: DrivePermissionEntry[]; capped: boolean }> {
  const entries: DrivePermissionEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/permissions`);
    url.searchParams.set("fields", "nextPageToken,permissions(type,role,emailAddress,displayName,domain,deleted)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw await readError(response);
    const body = (await response.json()) as {
      permissions?: Array<{ type?: string; role?: string; emailAddress?: string; displayName?: string; domain?: string; deleted?: boolean }>;
      nextPageToken?: string;
    };
    for (const p of body.permissions ?? []) {
      entries.push({
        type: p.type ?? "unknown",
        role: p.role ?? "unknown",
        emailAddress: p.emailAddress?.toLowerCase() ?? null,
        displayName: p.displayName ?? null,
        domain: p.domain ?? null,
        deleted: p.deleted === true,
      });
    }
    pageToken = body.nextPageToken;
    if (entries.length >= SHARING_LIST_CAP) return { entries: entries.slice(0, SHARING_LIST_CAP), capped: true };
  } while (pageToken);
  return { entries, capped: false };
}

/** Tell Google to forget the grant. Best effort: a token already dead is already forgotten. */
export async function revokeToken(token: string, fetchImpl: FetchImpl = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── Sheets API v4 (Phase 3, the editor) ──────────────────────────────────────────────────────────────

export const SHEETS_ENDPOINT = "https://sheets.googleapis.com/v4/spreadsheets";

/** One tab of a spreadsheet, from its properties only (no cell data). */
export interface SheetTab {
  /** Google's numeric id of the tab — stable across renames. */
  sheetId: number;
  title: string;
  index: number;
  hidden: boolean;
  /** Only a GRID tab has cells; a chart tab ("OBJECT") is opened in Google. */
  isGrid: boolean;
  rowCount: number;
  columnCount: number;
}

/** The spreadsheet's tabs (`spreadsheets.get` with `sheets.properties` only — no grid data). */
export async function getSpreadsheetTabs(accessToken: string, fileId: string, fetchImpl: FetchImpl = fetch): Promise<{ title: string; tabs: SheetTab[] }> {
  const url = new URL(`${SHEETS_ENDPOINT}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "properties.title,sheets.properties(sheetId,title,index,hidden,sheetType,gridProperties(rowCount,columnCount))");
  const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as {
    properties?: { title?: string };
    sheets?: Array<{
      properties?: { sheetId?: number; title?: string; index?: number; hidden?: boolean; sheetType?: string; gridProperties?: { rowCount?: number; columnCount?: number } };
    }>;
  };
  const tabs = (body.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is NonNullable<typeof p> => Boolean(p) && typeof p!.sheetId === "number")
    .map((p) => ({
      sheetId: p.sheetId as number,
      title: p.title ?? "Sheet",
      index: p.index ?? 0,
      hidden: p.hidden === true,
      isGrid: (p.sheetType ?? "GRID") === "GRID",
      rowCount: p.gridProperties?.rowCount ?? 0,
      columnCount: p.gridProperties?.columnCount ?? 0,
    }))
    .sort((a, b) => a.index - b.index);
  return { title: body.properties?.title ?? "", tabs };
}

export type ValueRender = "FORMATTED_VALUE" | "FORMULA";

/**
 * The values of several A1 ranges (`values.batchGet`), in the order asked. FORMATTED_VALUE is what
 * a person sees in Google; FORMULA is what is typed in the cell (the formula itself, or the plain
 * value) — the editor shows the first and edits the second. Dates come back as formatted text.
 */
export async function batchGetValues(accessToken: string, fileId: string, ranges: string[], render: ValueRender, fetchImpl: FetchImpl = fetch): Promise<unknown[][][]> {
  const url = new URL(`${SHEETS_ENDPOINT}/${encodeURIComponent(fileId)}/values:batchGet`);
  for (const range of ranges) url.searchParams.append("ranges", range);
  url.searchParams.set("valueRenderOption", render);
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
  url.searchParams.set("majorDimension", "ROWS");
  const response = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as { valueRanges?: Array<{ values?: unknown[][] }> };
  return ranges.map((_, i) => body.valueRanges?.[i]?.values ?? []);
}

/**
 * Write cells (`values.batchUpdate`, USER_ENTERED — exactly as if typed into Google: a leading "="
 * is a formula, "12" is a number). One range per cell, so cells never written are never touched.
 */
export async function batchUpdateValues(
  accessToken: string,
  fileId: string,
  data: Array<{ range: string; value: string }>,
  fetchImpl: FetchImpl = fetch,
): Promise<{ updatedCells: number }> {
  const response = await fetchImpl(`${SHEETS_ENDPOINT}/${encodeURIComponent(fileId)}/values:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: data.map((d) => ({ range: d.range, majorDimension: "ROWS", values: [[d.value]] })) }),
  });
  if (!response.ok) throw await readError(response);
  const body = (await response.json()) as { totalUpdatedCells?: number };
  return { updatedCells: body.totalUpdatedCells ?? 0 };
}

/** Structural changes (`spreadsheets.batchUpdate`): insert, append and delete rows or columns. */
export async function batchUpdateSpreadsheet(accessToken: string, fileId: string, requests: unknown[], fetchImpl: FetchImpl = fetch): Promise<void> {
  const response = await fetchImpl(`${SHEETS_ENDPOINT}/${encodeURIComponent(fileId)}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!response.ok) throw await readError(response);
}

// ── Checking a project's OAuth client (§22) ──────────────────────────────────────────────────────────

export type ClientCheck = { result: "VALID" } | { result: "INVALID"; message: string } | { result: "UNREACHABLE"; message: string };

/**
 * Ask Google whether a client ID + secret pair is real, WITHOUT a person signing in: redeem a code
 * that cannot exist. Google authenticates the client before it looks at the code, so
 *   - `invalid_grant` means the client ID and secret were accepted (only the dummy code was refused);
 *   - `invalid_client` / `unauthorized_client` means they were not;
 *   - `redirect_uri_mismatch` means the client is real but this server's callback is not registered.
 * Whether the redirect URI is registered is otherwise only known when somebody first presses Connect —
 * Google shows that error on its own page. Nothing here is stored, and Google's text is never shown.
 */
export async function checkGoogleClient(clientId: string, clientSecret: string, redirectUri: string, fetchImpl: FetchImpl = fetch): Promise<ClientCheck> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: "softify-assist-credential-check",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    return { result: "UNREACHABLE", message: "Google could not be reached to check these credentials. They were saved; press Validate again later." };
  }
  let code = "";
  try {
    code = String(((await response.json()) as { error?: unknown }).error ?? "");
  } catch {
    /* not JSON */
  }
  if (code === "invalid_grant") return { result: "VALID" };
  if (code === "invalid_client" || code === "unauthorized_client") {
    return { result: "INVALID", message: "Google did not accept this client ID and secret. Copy both again from Google Cloud → Google Auth Platform → Clients." };
  }
  if (code === "redirect_uri_mismatch") {
    return { result: "INVALID", message: `Google accepted the client, but this server's redirect URI is not registered on it. Add ${redirectUri} under Authorized redirect URIs.` };
  }
  return { result: "UNREACHABLE", message: `Google answered unexpectedly (${response.status}) when checking these credentials. They were saved; press Validate again later.` };
}
