import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { GoogleApiError, listDriveSpreadsheets, type DriveSpreadsheet, type FetchImpl } from "@/server/google/api";
import { getAccessToken, GoogleAccountUnavailableError } from "@/server/google/accounts";
import type { GoogleOAuthConfig } from "@/server/google/oauth";

/**
 * The project's Google spreadsheets (GOOGLE_SHEETS.md, Phase 2) — METADATA ONLY. The list is built
 * from Drive's file metadata; no sheet is opened to list it and nothing from inside one is stored.
 *
 * One `GoogleSpreadsheet` row per Google file per project, however many connected accounts reach
 * it; each path is a `GoogleSpreadsheetAccess` row. Rows are never deleted: a file no connected
 * account sees any more is marked `removedAt`, and seeing it again clears the mark — so whatever
 * later phases record against a sheet keeps pointing at the same row.
 *
 * Every query goes through the project-scoped client.
 */

/** Rows written per round trip while refreshing a long list. */
const CHUNK = 500;

export interface SpreadsheetSyncResult {
  /** Spreadsheets Google listed for the account this time. */
  listed: number;
  /** Sheets the project had never seen before. */
  added: number;
  /** Known sheets whose name, dates, owner or sharing changed (or that came back). */
  updated: number;
  /** Sheets this account no longer reaches. */
  removed: number;
  /** Google listed more than the cap: nothing was marked unreachable, since the rest is unknown. */
  capped: boolean;
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The sheet columns Google decides, from one listing entry. */
function sheetFields(file: DriveSpreadsheet) {
  return {
    name: file.name,
    webViewLink: file.webViewLink,
    modifiedTime: file.modifiedTime,
    ownerEmail: file.ownerEmail,
    ownerName: file.ownerName,
    lastModifiedByName: file.lastModifiedByName,
    lastModifiedByEmail: file.lastModifiedByEmail,
    sharedInGoogle: file.shared,
  };
}

type SheetFields = ReturnType<typeof sheetFields>;

/**
 * What a listing says about a sheet we already know. Accounts see a file differently: Google leaves
 * out a person's email for an account it is not visible to, and a shared drive file has no owner.
 * So a listing that OMITS a detail does not erase one already known — for the owner always, and for
 * the last modifier as long as it is still the same version of the file. Without this, two accounts
 * reaching one sheet would overwrite each other on every refresh.
 */
function mergeFields(row: SheetFields, next: SheetFields): SheetFields {
  const sameVersion = (row.modifiedTime?.getTime() ?? null) === (next.modifiedTime?.getTime() ?? null);
  return {
    ...next,
    ownerEmail: next.ownerEmail ?? row.ownerEmail,
    ownerName: next.ownerName ?? row.ownerName,
    lastModifiedByName: next.lastModifiedByName ?? (sameVersion ? row.lastModifiedByName : null),
    lastModifiedByEmail: next.lastModifiedByEmail ?? (sameVersion ? row.lastModifiedByEmail : null),
  };
}

function sameFields(row: SheetFields, next: SheetFields): boolean {
  return (
    row.name === next.name &&
    row.webViewLink === next.webViewLink &&
    (row.modifiedTime?.getTime() ?? null) === (next.modifiedTime?.getTime() ?? null) &&
    row.ownerEmail === next.ownerEmail &&
    row.ownerName === next.ownerName &&
    row.lastModifiedByName === next.lastModifiedByName &&
    row.lastModifiedByEmail === next.lastModifiedByEmail &&
    row.sharedInGoogle === next.sharedInGoogle
  );
}

/**
 * Refresh one connected account's spreadsheet list from Google, and remember how many it can reach.
 *
 * Idempotent and convergent: a second refresh with the same answer writes nothing but the
 * "last seen" stamps, a sheet listed by two accounts stays one sheet, and an unchanged sheet is
 * never rewritten. A sheet the account no longer lists loses this account's path — only when the
 * listing was complete; a capped listing marks nothing, because what it left out is unknown.
 *
 * Throws `GoogleAccountUnavailableError` when the account cannot be used, and Google's error when
 * the listing fails (recorded on the account first, so the page says what went wrong).
 */
export async function syncAccountSpreadsheets(
  accountId: string,
  options: { config: GoogleOAuthConfig; fetchImpl?: FetchImpl; now?: Date },
): Promise<SpreadsheetSyncResult> {
  let listing: Awaited<ReturnType<typeof listDriveSpreadsheets>>;
  try {
    try {
      listing = await listDriveSpreadsheets(await getAccessToken(accountId, options), options.fetchImpl);
    } catch (err) {
      // The cached access token can die before its expiry (access removed in the Google account).
      // Refresh once and retry: a refused refresh then marks the account NEEDS_RECONNECT, instead of
      // every refresh failing with 401 until the dead token happens to expire.
      if (!(err instanceof GoogleApiError) || err.status !== 401) throw err;
      listing = await listDriveSpreadsheets(await getAccessToken(accountId, { ...options, forceRefresh: true }), options.fetchImpl);
    }
  } catch (err) {
    if (err instanceof GoogleAccountUnavailableError) throw err;
    await prisma.googleIntegrationAccount.update({
      where: { id: accountId },
      data: { lastError: `Could not read the spreadsheet list: ${(err as Error).message}` },
    });
    throw err;
  }

  const now = options.now ?? new Date();
  // Google's listing can name a file twice across pages while it changes; one entry per file.
  const files = [...new Map(listing.files.map((f) => [f.id, f])).values()];
  let added = 0;
  let updated = 0;
  const seenSheetIds: string[] = [];

  for (const batch of chunks(files)) {
    const fileIds = batch.map((f) => f.id);
    const existing = await prisma.googleSpreadsheet.findMany({
      where: { googleFileId: { in: fileIds } },
      select: {
        id: true,
        googleFileId: true,
        removedAt: true,
        name: true,
        webViewLink: true,
        modifiedTime: true,
        ownerEmail: true,
        ownerName: true,
        lastModifiedByName: true,
        lastModifiedByEmail: true,
        sharedInGoogle: true,
      },
    });
    const byFileId = new Map(existing.map((row) => [row.googleFileId, row]));

    const fresh = batch.filter((f) => !byFileId.has(f.id));
    if (fresh.length > 0) {
      const created = await prisma.googleSpreadsheet.createMany({
        data: fresh.map((f) => ({ googleFileId: f.id, firstSeenAt: now, ...sheetFields(f) })),
        skipDuplicates: true,
      });
      added += created.count;
    }
    for (const file of batch) {
      const row = byFileId.get(file.id);
      if (!row) continue;
      const next = mergeFields(row, sheetFields(file));
      if (row.removedAt === null && sameFields(row, next)) continue;
      await prisma.googleSpreadsheet.update({ where: { id: row.id }, data: { ...next, removedAt: null } });
      updated += 1;
    }

    const sheets = await prisma.googleSpreadsheet.findMany({ where: { googleFileId: { in: fileIds } }, select: { id: true, googleFileId: true } });
    const sheetIdByFile = new Map(sheets.map((s) => [s.googleFileId, s.id]));
    const sheetIds = sheets.map((s) => s.id);
    seenSheetIds.push(...sheetIds);

    const paths = await prisma.googleSpreadsheetAccess.findMany({
      where: { googleAccountId: accountId, spreadsheetId: { in: sheetIds } },
      select: { id: true, spreadsheetId: true, canEdit: true, canShare: true, removedAt: true },
    });
    const pathBySheet = new Map(paths.map((p) => [p.spreadsheetId, p]));
    const newPaths: Prisma.GoogleSpreadsheetAccessCreateManyInput[] = [];
    for (const file of batch) {
      const spreadsheetId = sheetIdByFile.get(file.id);
      if (!spreadsheetId) continue;
      const path = pathBySheet.get(spreadsheetId);
      if (!path) {
        newPaths.push({ spreadsheetId, googleAccountId: accountId, canEdit: file.canEdit, canShare: file.canShare, firstSeenAt: now, lastSeenAt: now });
      } else if (path.canEdit !== file.canEdit || path.canShare !== file.canShare || path.removedAt !== null) {
        await prisma.googleSpreadsheetAccess.update({
          where: { id: path.id },
          data: { canEdit: file.canEdit, canShare: file.canShare, removedAt: null },
        });
      }
    }
    if (newPaths.length > 0) await prisma.googleSpreadsheetAccess.createMany({ data: newPaths, skipDuplicates: true });
    await prisma.googleSpreadsheetAccess.updateMany({
      where: { googleAccountId: accountId, spreadsheetId: { in: sheetIds } },
      data: { lastSeenAt: now },
    });
  }

  let removed = 0;
  if (!listing.capped) {
    // By the set this listing named, not by "last seen" times: two refreshes of one account
    // overlapping must not let the slower one's older stamp read as "not seen".
    const gone = await prisma.googleSpreadsheetAccess.updateMany({
      where: { googleAccountId: accountId, removedAt: null, spreadsheetId: { notIn: seenSheetIds } },
      data: { removedAt: now },
    });
    removed = gone.count;
  }
  await settleSpreadsheetReachability(now);

  await prisma.googleIntegrationAccount.update({
    where: { id: accountId },
    data: { spreadsheetCount: files.length, spreadsheetsCountedAt: now, lastError: null },
  });
  return { listed: files.length, added, updated, removed, capped: listing.capped };
}

/**
 * A sheet is reachable while at least one connected account still lists it. Marks the ones nobody
 * reaches any more, and clears the mark on any that somebody reaches again.
 */
async function settleSpreadsheetReachability(now: Date): Promise<void> {
  await prisma.googleSpreadsheet.updateMany({
    where: { removedAt: null, access: { none: { removedAt: null } } },
    data: { removedAt: now },
  });
  await prisma.googleSpreadsheet.updateMany({
    where: { removedAt: { not: null }, access: { some: { removedAt: null } } },
    data: { removedAt: null },
  });
}

/**
 * After a disconnect: the account no longer reaches anything. Its paths are marked, and a sheet no
 * other account reaches becomes unreachable — listed under "No longer reachable", never deleted.
 */
export async function markAccountSpreadsheetsUnreachable(accountId: string, now = new Date()): Promise<number> {
  const gone = await prisma.googleSpreadsheetAccess.updateMany({
    where: { googleAccountId: accountId, removedAt: null },
    data: { removedAt: now },
  });
  await settleSpreadsheetReachability(now);
  return gone.count;
}

/** Mark (or unmark) one sheet for work tracking. Null when the sheet is not this project's. */
export async function setSpreadsheetMonitoring(
  spreadsheetId: string,
  monitored: boolean,
  username: string,
): Promise<{ id: string; name: string; isMonitored: boolean; changed: boolean } | null> {
  const row = await prisma.googleSpreadsheet.findUnique({ where: { id: spreadsheetId }, select: { id: true, name: true, isMonitored: true } });
  if (!row) return null;
  if (row.isMonitored === monitored) return { ...row, changed: false };
  const saved = await prisma.googleSpreadsheet.update({
    where: { id: row.id },
    data: monitored
      ? { isMonitored: true, monitoredAt: new Date(), monitoredByUsername: username }
      : { isMonitored: false, monitoredAt: null, monitoredByUsername: null },
    select: { id: true, name: true, isMonitored: true },
  });
  return { ...saved, changed: true };
}

// ── The list page ────────────────────────────────────────────────────────────────────────────────

export const SPREADSHEET_VIEWS = ["all", "monitored", "unmonitored", "unreachable"] as const;
export type SpreadsheetView = (typeof SPREADSHEET_VIEWS)[number];

export function isSpreadsheetView(value: unknown): value is SpreadsheetView {
  return typeof value === "string" && (SPREADSHEET_VIEWS as readonly string[]).includes(value);
}

export interface SpreadsheetListFilters {
  /** Matches the name (any part, any case) or the spreadsheet id. */
  search?: string;
  /** Only sheets this connected account reaches now. */
  accountId?: string | null;
  view: SpreadsheetView;
  page: number;
  pageSize: number;
}

export interface SpreadsheetPath {
  accountId: string;
  email: string;
  accountStatus: "CONNECTED" | "NEEDS_RECONNECT" | "DISCONNECTED";
  canEdit: boolean;
}

/** A current member of a sheet, as the list shows it (GOOGLE_SHEETS.md §5). */
export interface SpreadsheetMemberSummary {
  userId: string;
  name: string;
  role: "LEAD" | "EDITOR" | "MONITOR";
}

export interface SpreadsheetRow {
  id: string;
  googleFileId: string;
  name: string;
  webViewLink: string | null;
  modifiedTime: Date | null;
  ownerName: string | null;
  ownerEmail: string | null;
  lastModifiedByName: string | null;
  lastModifiedByEmail: string | null;
  sharedInGoogle: boolean;
  isMonitored: boolean;
  monitoredAt: Date | null;
  monitoredByUsername: string | null;
  removedAt: Date | null;
  paths: SpreadsheetPath[];
  /** Current members, Leads first. */
  members: SpreadsheetMemberSummary[];
}

const MEMBER_ORDER = { LEAD: 0, EDITOR: 1, MONITOR: 2 } as const;

function searchWhere(filters: Pick<SpreadsheetListFilters, "search" | "accountId">): Prisma.GoogleSpreadsheetWhereInput {
  const and: Prisma.GoogleSpreadsheetWhereInput[] = [];
  const term = filters.search?.trim();
  if (term) and.push({ OR: [{ name: { contains: term, mode: "insensitive" } }, { googleFileId: { contains: term } }] });
  if (filters.accountId) and.push({ access: { some: { googleAccountId: filters.accountId, removedAt: null } } });
  return and.length > 0 ? { AND: and } : {};
}

function viewWhere(view: SpreadsheetView): Prisma.GoogleSpreadsheetWhereInput {
  switch (view) {
    case "monitored":
      return { removedAt: null, isMonitored: true };
    case "unmonitored":
      return { removedAt: null, isMonitored: false };
    case "unreachable":
      return { removedAt: { not: null } };
    default:
      return { removedAt: null };
  }
}

/** One page of the list, and the count behind every view chip (within the same search and account). */
export async function listSpreadsheets(filters: SpreadsheetListFilters): Promise<{
  rows: SpreadsheetRow[];
  total: number;
  counts: Record<SpreadsheetView, number>;
}> {
  const base = searchWhere(filters);
  const where: Prisma.GoogleSpreadsheetWhereInput = { AND: [base, viewWhere(filters.view)] };
  const countOf = (view: SpreadsheetView) => prisma.googleSpreadsheet.count({ where: { AND: [base, viewWhere(view)] } });

  const [rows, all, monitored, unmonitored, unreachable] = await Promise.all([
    prisma.googleSpreadsheet.findMany({
      where,
      orderBy: [{ modifiedTime: { sort: "desc", nulls: "last" } }, { name: "asc" }, { id: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        googleFileId: true,
        name: true,
        webViewLink: true,
        modifiedTime: true,
        ownerName: true,
        ownerEmail: true,
        lastModifiedByName: true,
        lastModifiedByEmail: true,
        sharedInGoogle: true,
        isMonitored: true,
        monitoredAt: true,
        monitoredByUsername: true,
        removedAt: true,
        access: {
          where: { removedAt: null },
          orderBy: { firstSeenAt: "asc" },
          select: { canEdit: true, googleAccount: { select: { id: true, email: true, status: true } } },
        },
        members: { where: { endedAt: null }, select: { role: true, user: { select: { id: true, name: true } } } },
      },
    }),
    countOf("all"),
    countOf("monitored"),
    countOf("unmonitored"),
    countOf("unreachable"),
  ]);

  const counts: Record<SpreadsheetView, number> = { all, monitored, unmonitored, unreachable };
  return {
    rows: rows.map(({ access, members, ...row }) => ({
      ...row,
      paths: access.map((a) => ({ accountId: a.googleAccount.id, email: a.googleAccount.email, accountStatus: a.googleAccount.status, canEdit: a.canEdit })),
      members: members
        .map((m) => ({ userId: m.user.id, name: m.user.name, role: m.role }))
        .sort((a, b) => MEMBER_ORDER[a.role] - MEMBER_ORDER[b.role] || a.name.localeCompare(b.name)),
    })),
    total: counts[filters.view],
    counts,
  };
}
