"use server";

import { revalidatePath } from "next/cache";
import { isReadOnlyProjectStatus, isSheetMemberRole, SHEET_MEMBER_ROLE_LABELS, type SheetMemberRole } from "@support-automation/shared";
import { checkPermission, projectReadOnlyError } from "@/server/authorize";
import { requireActiveProject } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import {
  addSheetMember,
  canStaffSheet,
  changeSheetMemberRole,
  removeSheetMember,
  SheetMemberError,
  type MemberActorInput,
} from "@/server/google/members";
import { readGoogleSharing, type GoogleSharing } from "@/server/google/sharing";
import { googleOAuthConfig } from "@/server/google/oauth";

/**
 * Sheet members (GOOGLE_SHEETS.md §5, Phase 5). Every action is a public endpoint, so each decides
 * here who is asking — `google_sheets.manage`, or `google_sheets.edit` for a sheet's Lead, both after
 * the project's access level, status and feature — and the store (`server/google/members.ts`)
 * applies the rules. Every change is recorded in System Logs with who made it.
 */

export interface SheetMemberActionResult {
  error?: string;
  success?: string;
}

type Actor = { actor: MemberActorInput } | { error: string };

async function whoIsAsking(): Promise<Actor> {
  const viewer = await checkPermission("google_sheets.view", "GOOGLE_SHEETS");
  if ("denied" in viewer) return { error: viewer.denied };
  // A suspended or archived project changes nothing: said in its own words, not as "no permission".
  const project = await requireActiveProject();
  if (isReadOnlyProjectStatus(project.status)) return { error: projectReadOnlyError(project) };
  const [manage, edit] = await Promise.all([checkPermission("google_sheets.manage", "GOOGLE_SHEETS"), checkPermission("google_sheets.edit", "GOOGLE_SHEETS")]);
  return { actor: { userId: viewer.session.userId, hasManage: !("denied" in manage), hasEdit: !("denied" in edit) } };
}

async function revalidateSheet(spreadsheetId: string) {
  revalidatePath(await projectPath(`/google-sheets/${spreadsheetId}`));
  revalidatePath(await projectPath("/google-sheets"));
}

function label(role: SheetMemberRole): string {
  return SHEET_MEMBER_ROLE_LABELS[role].toLowerCase();
}

async function run(work: () => Promise<SheetMemberActionResult>): Promise<SheetMemberActionResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof SheetMemberError) return { error: err.message };
    throw err;
  }
}

/** Add a person to a spreadsheet in a role (form action). */
export async function addSheetMemberAction(spreadsheetId: string, _prev: SheetMemberActionResult, formData: FormData): Promise<SheetMemberActionResult> {
  const asking = await whoIsAsking();
  if ("error" in asking) return { error: asking.error };
  const userId = String(formData.get("userId") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  if (!userId) return { error: "Choose the person to add." };
  if (!isSheetMemberRole(role)) return { error: "Choose a role: Lead, Editor or Monitor." };
  return run(async () => {
    const added = await addSheetMember({ spreadsheetId, userId, role, actor: asking.actor });
    await logSystemEvent(
      "INFO",
      "google-sheets",
      `${added.member.name} added to spreadsheet "${added.sheet.name}" as ${label(role)}`,
      { memberUserId: userId, role },
      { actorUserId: asking.actor.userId, targetType: "GoogleSpreadsheet", targetId: added.sheet.id },
    );
    await revalidateSheet(spreadsheetId);
    return { success: `${added.member.name} is now ${label(role)} on this spreadsheet.` };
  });
}

/** Change a member's role. Their earlier role stays in the history. */
export async function changeSheetMemberRoleAction(spreadsheetId: string, userId: string, role: string): Promise<SheetMemberActionResult> {
  const asking = await whoIsAsking();
  if ("error" in asking) return { error: asking.error };
  if (!isSheetMemberRole(role)) return { error: "Choose a role: Lead, Editor or Monitor." };
  return run(async () => {
    const changed = await changeSheetMemberRole({ spreadsheetId, userId, role, actor: asking.actor });
    if (!changed.changed) return { success: `${changed.name} is already ${label(role)}.` };
    await logSystemEvent(
      "INFO",
      "google-sheets",
      `${changed.name} changed from ${label(changed.fromRole)} to ${label(role)} on spreadsheet "${changed.sheet.name}"`,
      { memberUserId: userId, fromRole: changed.fromRole, role },
      { actorUserId: asking.actor.userId, targetType: "GoogleSpreadsheet", targetId: changed.sheet.id },
    );
    await revalidateSheet(spreadsheetId);
    return { success: `${changed.name} is now ${label(role)}.` };
  });
}

/** Take a person off a spreadsheet. Their history stays. */
export async function removeSheetMemberAction(spreadsheetId: string, userId: string): Promise<SheetMemberActionResult> {
  const asking = await whoIsAsking();
  if ("error" in asking) return { error: asking.error };
  return run(async () => {
    const removed = await removeSheetMember({ spreadsheetId, userId, actor: asking.actor });
    await logSystemEvent(
      "INFO",
      "google-sheets",
      `${removed.name} removed from spreadsheet "${removed.sheet.name}" (was ${label(removed.fromRole)})`,
      { memberUserId: userId, fromRole: removed.fromRole },
      { actorUserId: asking.actor.userId, targetType: "GoogleSpreadsheet", targetId: removed.sheet.id },
    );
    await revalidateSheet(spreadsheetId);
    return { success: `${removed.name} is no longer a member. Their history is kept.` };
  });
}

/**
 * Google Drive's sharing list for a spreadsheet, for the people who staff it (a manager, or its Lead).
 * Read live for reference and never stored or turned into members. No token leaves the server.
 */
export async function readGoogleSharingAction(spreadsheetId: string): Promise<{ error: string } | { sharing: GoogleSharing }> {
  const asking = await whoIsAsking();
  if ("error" in asking) return { error: asking.error };
  if (!(await canStaffSheet(spreadsheetId, asking.actor))) {
    return { error: "Google's sharing list is shown to the people who manage this spreadsheet's members." };
  }
  const config = googleOAuthConfig();
  if (!config) return { error: "Google sign-in is not set up on this server yet." };
  try {
    const sharing = await readGoogleSharing(spreadsheetId, { config });
    if (!sharing) return { error: "That spreadsheet is not in this project." };
    return { sharing };
  } catch {
    return { error: "Google could not be reached just now. Try again in a minute." };
  }
}
