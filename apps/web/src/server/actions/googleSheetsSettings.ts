"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { saveGoogleSheetsSettings } from "@/server/google/settings";
import { unlinkMyGoogleIdentity } from "@/server/google/identity";
import { GoogleClientConfigError, revalidateProjectGoogleClient, saveProjectGoogleClient, setProjectGoogleIntegrationEnabled } from "@/server/google/clientConfig";

/**
 * Google Sheets settings (Phase 7–8), the project's own OAuth client and on/off switch (§22), and a
 * person's own Google identity (Phase 4). Public endpoints: settings and the client need
 * `google_sheets.manage`; an identity can only ever be unlinked by the person it belongs to. No action
 * returns or logs a client secret.
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

const revalidateSettings = async () => {
  revalidatePath(await projectPath("/settings/google-sheets"));
  revalidatePath(await projectPath("/google-sheets"));
};

/** Save the project's own OAuth client (checked with Google first). A blank secret keeps the stored one. */
export async function saveGoogleClientAction(_prev: SettingsActionResult, formData: FormData): Promise<SettingsActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await saveProjectGoogleClient({
      clientId: String(formData.get("clientId") ?? ""),
      clientSecret: String(formData.get("clientSecret") ?? ""),
      username: access.session.username,
    });
    await logSystemEvent(
      "WARN",
      "google-sheets",
      `Google OAuth client ${result.clientChanged ? "changed" : "saved"} for this project`,
      { validation: result.status, accountsToReconnect: result.accountsToReconnect, changedBy: access.session.username },
      { actorUserId: access.session.userId, targetType: "GoogleIntegrationConfig" },
    );
    await revalidateSettings();
    const reconnect = result.accountsToReconnect > 0 ? ` ${result.accountsToReconnect} connected account${result.accountsToReconnect === 1 ? " needs" : "s need"} to be connected again, because the client changed.` : "";
    if (result.warning) return { success: `Saved, but not yet confirmed by Google. ${result.warning}${reconnect}` };
    return { success: `Saved. Google accepted this client ID and secret.${reconnect}` };
  } catch (err) {
    if (err instanceof GoogleClientConfigError) {
      await logSystemEvent("WARN", "google-sheets", "Google OAuth client not saved", { reason: err.message }, { actorUserId: access.session.userId });
      return { error: err.message };
    }
    throw err;
  }
}

/** Ask Google again whether the saved client is accepted. */
export async function revalidateGoogleClientAction(): Promise<SettingsActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await revalidateProjectGoogleClient();
    await logSystemEvent("INFO", "google-sheets", `Google OAuth client validated: ${result.status}`, {}, { actorUserId: access.session.userId, targetType: "GoogleIntegrationConfig" });
    await revalidateSettings();
    return result.status === "VALID" ? { success: "Google accepted this client ID and secret." } : { error: result.message ?? "Google did not confirm this client." };
  } catch (err) {
    if (err instanceof GoogleClientConfigError) return { error: err.message };
    throw err;
  }
}

/**
 * Switch the integration on or off for this project. Off stops every Google call and the worker's
 * reading for this project; nothing is deleted, disconnected or revoked, so on resumes as it was.
 */
export async function setGoogleIntegrationEnabledAction(enabled: boolean): Promise<SettingsActionResult> {
  const access = await checkPermission("google_sheets.manage", "GOOGLE_SHEETS");
  if ("denied" in access) return { error: access.denied };
  const changed = await setProjectGoogleIntegrationEnabled(enabled, access.session.username);
  if (changed) {
    await logSystemEvent("WARN", "google-sheets", `Google integration ${enabled ? "switched on" : "switched off"} for this project`, { changedBy: access.session.username }, { actorUserId: access.session.userId, targetType: "GoogleIntegrationConfig" });
  }
  await revalidateSettings();
  return { success: enabled ? "The Google integration is on. Saved accounts and settings are used again." : "The Google integration is off. Nothing is sent to Google for this project; accounts, credentials and history are kept." };
}
