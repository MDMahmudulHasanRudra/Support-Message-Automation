"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { prisma } from "@/server/db";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { disconnectGoogleAccount, GoogleAccountUnavailableError } from "@/server/google/accounts";
import { googleOAuthConfig } from "@/server/google/oauth";
import { markAccountSpreadsheetsUnreachable, setSpreadsheetMonitoring, syncAccountSpreadsheets, type SpreadsheetSyncResult } from "@/server/google/spreadsheets";

/**
 * Google Sheets actions (GOOGLE_SHEETS.md, Phases 1–2): disconnecting an account, refreshing what it
 * can reach, and marking spreadsheets for work tracking. Every one needs `google_sheets.manage` in
 * this project with the Google Sheets feature on — checked here, since a Server Action is a public
 * endpoint. None returns a token.
 */

export interface GoogleAccountActionResult {
  error?: string;
  success?: string;
}

async function revalidateModule() {
  revalidatePath(await projectPath("/settings/google-sheets"));
  revalidatePath(await projectPath("/google-sheets"));
}

const NOT_CONFIGURED = "Google sign-in is not set up on this server yet (see Settings → Google Sheets → Google Accounts).";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function describeSync(result: SpreadsheetSyncResult): string {
  const parts = [`${plural(result.listed, "spreadsheet")}${result.capped ? "+" : ""} accessible`];
  if (result.added > 0) parts.push(`${result.added.toLocaleString("en-US")} new`);
  if (result.removed > 0) parts.push(`${result.removed.toLocaleString("en-US")} no longer reachable`);
  return parts.join(", ");
}

export async function disconnectGoogleAccountAction(accountId: string): Promise<GoogleAccountActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  const account = await disconnectGoogleAccount(accountId, access.session.username);
  if (!account) return { error: "That Google account is not connected to this project." };
  const unreachable = await markAccountSpreadsheetsUnreachable(account.id);
  await logSystemEvent(
    "INFO",
    "google-sheets",
    `Google account ${account.email} disconnected`,
    { disconnectedBy: access.session.username, spreadsheetPathsClosed: unreachable },
    { actorUserId: access.session.userId, targetType: "GoogleIntegrationAccount", targetId: account.id },
  );
  await revalidateModule();
  return { success: `${account.email} is disconnected. Its history is kept; connect it again any time.` };
}

/** Read one account's spreadsheet list from Google again (metadata only). */
export async function refreshGoogleSpreadsheetsAction(accountId: string): Promise<GoogleAccountActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  const config = googleOAuthConfig();
  if (!config) return { error: NOT_CONFIGURED };
  try {
    const result = await syncAccountSpreadsheets(accountId, { config });
    await revalidateModule();
    return { success: `${describeSync(result)}.` };
  } catch (err) {
    await revalidateModule();
    if (err instanceof GoogleAccountUnavailableError) return { error: err.message };
    return { error: "Google could not be asked for the spreadsheet list just now. Try again in a minute." };
  }
}

/**
 * "Refresh from Google" on the Spreadsheets page: every connected account, one after another. One
 * account failing does not stop the others, and the answer says which failed.
 */
export async function refreshAllGoogleSpreadsheetsAction(): Promise<GoogleAccountActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  const config = googleOAuthConfig();
  if (!config) return { error: NOT_CONFIGURED };
  const accounts = await prisma.googleIntegrationAccount.findMany({ where: { status: "CONNECTED" }, select: { id: true, email: true }, orderBy: { email: "asc" } });
  if (accounts.length === 0) return { error: "No Google account is connected. Connect one on Settings → Google Sheets → Google Accounts." };

  const failed: string[] = [];
  let added = 0;
  let removed = 0;
  for (const account of accounts) {
    try {
      const result = await syncAccountSpreadsheets(account.id, { config });
      added += result.added;
      removed += result.removed;
    } catch {
      failed.push(account.email);
    }
  }
  await revalidateModule();
  const read = accounts.length - failed.length;
  const summary = `Checked ${plural(read, "account")}: ${added.toLocaleString("en-US")} new, ${removed.toLocaleString("en-US")} no longer reachable.`;
  if (failed.length > 0) {
    return { error: `${failed.join(", ")} could not be read — see Settings → Google Sheets → Google Accounts.${read > 0 ? ` ${summary}` : ""}` };
  }
  return { success: summary };
}

/** Mark a spreadsheet for work tracking, or stop. */
export async function setSpreadsheetMonitoringAction(spreadsheetId: string, monitored: boolean): Promise<GoogleAccountActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  const result = await setSpreadsheetMonitoring(spreadsheetId, monitored, access.session.username);
  if (!result) return { error: "That spreadsheet is not in this project." };
  if (result.changed) {
    await logSystemEvent(
      "INFO",
      "google-sheets",
      monitored ? `Spreadsheet "${result.name}" is monitored` : `Spreadsheet "${result.name}" is no longer monitored`,
      { by: access.session.username },
      { actorUserId: access.session.userId, targetType: "GoogleSpreadsheet", targetId: result.id },
    );
    await revalidateModule();
  }
  return { success: monitored ? `"${result.name}" is monitored.` : `"${result.name}" is no longer monitored.` };
}
