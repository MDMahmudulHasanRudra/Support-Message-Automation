import { prisma } from "@/server/db";
import { GoogleApiError, listDrivePermissions, type DrivePermissionEntry, type FetchImpl } from "@/server/google/api";
import { getAccessToken, GoogleAccountUnavailableError } from "@/server/google/accounts";
import type { GoogleOAuthConfig } from "@/server/google/oauth";

/**
 * Google Drive's own sharing for a spreadsheet (GOOGLE_SHEETS.md §3, §5) — shown beside the app's
 * members FOR REFERENCE ONLY. Read live, never stored, and never turned into membership: Google
 * saying someone is an Editor does not make them one in the app, and the app's Monitor role does
 * not change anything in Google.
 *
 * Google returns the list only to an account that can share the file, so only those paths are
 * tried; when none can (or Google refuses), the answer is "not visible", worded for the page.
 */
export type GoogleSharing =
  | { visible: true; via: string; entries: DrivePermissionEntry[]; capped: boolean }
  | { visible: false; reason: string };

export async function readGoogleSharing(spreadsheetId: string, options: { config: GoogleOAuthConfig; fetchImpl?: FetchImpl }): Promise<GoogleSharing | null> {
  const sheet = await prisma.googleSpreadsheet.findUnique({
    where: { id: spreadsheetId },
    select: {
      googleFileId: true,
      access: {
        where: { removedAt: null, canShare: true, googleAccount: { status: "CONNECTED" } },
        orderBy: { firstSeenAt: "asc" },
        select: { googleAccount: { select: { id: true, email: true } } },
      },
    },
  });
  if (!sheet) return null;
  if (sheet.access.length === 0) {
    return {
      visible: false,
      reason: "None of the connected Google accounts can share this spreadsheet, and Google shows its sharing list only to an account that can.",
    };
  }
  for (const path of sheet.access) {
    try {
      const token = await getAccessToken(path.googleAccount.id, options);
      const { entries, capped } = await listDrivePermissions(token, sheet.googleFileId, options.fetchImpl);
      return { visible: true, via: path.googleAccount.email, entries, capped };
    } catch (err) {
      // This account cannot show it (refused, needs reconnecting): try the next one.
      if (err instanceof GoogleAccountUnavailableError || err instanceof GoogleApiError) continue;
      throw err;
    }
  }
  return { visible: false, reason: "Google would not show this spreadsheet's sharing list to any connected account just now. Try again later." };
}
