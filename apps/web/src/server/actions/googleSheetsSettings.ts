"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { saveGoogleSheetsSettings } from "@/server/google/settings";
import { unlinkMyGoogleIdentity } from "@/server/google/identity";

/**
 * Google Sheets settings (Phase 7–8) and a person's own Google identity (Phase 4). Public endpoints:
 * settings need `google_sheets.manage`; an identity can only ever be unlinked by the person it
 * belongs to.
 */

export interface SettingsActionResult {
  error?: string;
  success?: string;
}

export async function saveGoogleSheetsSettingsAction(_prev: SettingsActionResult, formData: FormData): Promise<SettingsActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  const saved = await saveGoogleSheetsSettings({
    inactivityMinutes: formData.get("inactivityMinutes"),
    externalActivityEnabled: formData.get("externalActivityEnabled") === "on",
    username: access.session.username,
  });
  await logSystemEvent(
    "INFO",
    "google-sheets",
    "Google Sheets settings changed",
    { inactivityMinutes: saved.inactivityMinutes, externalActivityEnabled: saved.externalActivityEnabled },
    { actorUserId: access.session.userId },
  );
  revalidatePath(await projectPath("/settings/google-sheets"));
  return { success: `Saved. A gap of more than ${saved.inactivityMinutes} minute${saved.inactivityMinutes === 1 ? "" : "s"} is now a pause.` };
}

export async function unlinkMyGoogleIdentityAction(identityId: string): Promise<SettingsActionResult> {
  const access = await checkPermission("google_sheets.view", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  const removed = await unlinkMyGoogleIdentity(access.session.userId, identityId);
  if (!removed) return { error: "That Google account is not linked to your login." };
  await logSystemEvent("INFO", "google-sheets", `${access.session.username} unlinked their Google identity ${removed.email}`, {}, { actorUserId: access.session.userId });
  revalidatePath(await projectPath("/google-sheets/identity"));
  return { success: `${removed.email} is unlinked. Edits it makes in Google from now on are not credited to you.` };
}
