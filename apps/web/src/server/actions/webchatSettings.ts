"use server";

import { revalidatePath } from "next/cache";
import { parseAllowedOrigins } from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { projectPath } from "@/server/projectPaths";
import { removeWidgetAsset, rotateWebchatIdentitySecret, saveWebchatSettings, WebchatError } from "@/server/channels/webchat";

/** Website chat widget settings (WEBSITE_CHAT.md). channels.manage, OMNICHANNEL on. */

export interface WebchatSettingsState {
  error?: string;
  success?: string;
}

/**
 * The Widget Builder's save (Website Chat V3): the whole configuration as one JSON value plus the websites. The
 * server re-reads every field through `parseWidgetSettings` (clamped, defaults for anything unknown), keeps the
 * uploaded images and team consent from what is stored, and refuses a website list it cannot read rather than
 * saving part of it.
 */
export async function saveWidgetBuilderAction(connectionId: string, settingsJson: string, originsText: string): Promise<WebchatSettingsState> {
  const access = await checkPermission("channels.manage", "OMNICHANNEL");
  if ("denied" in access) return { error: access.denied };
  if (typeof settingsJson !== "string" || settingsJson.length > 64_000) return { error: "The settings could not be read. Reload the page and try again." };
  let settings: unknown;
  try {
    settings = JSON.parse(settingsJson);
  } catch {
    return { error: "The settings could not be read. Reload the page and try again." };
  }
  const { origins, invalid } = parseAllowedOrigins(String(originsText ?? ""));
  if (invalid.length) return { error: `Not a website address: ${invalid.slice(0, 3).join(", ")}. Use a domain like example.com or a full address like https://www.example.com.` };
  if (origins.length === 0) return { error: "Add at least one website address, or switch the widget off instead." };
  const hours = (settings as { hours?: { enabled?: boolean; timezone?: unknown } } | null)?.hours;
  if (hours?.enabled && typeof hours.timezone === "string") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: hours.timezone });
    } catch {
      return { error: `"${hours.timezone.slice(0, 60)}" is not a time zone. Use a name like Asia/Dhaka.` };
    }
  }
  const id = String(connectionId);
  try {
    await saveWebchatSettings(id, { settings, origins });
  } catch (err) {
    if (err instanceof WebchatError) return { error: err.message };
    throw err;
  }
  await logSystemEvent("INFO", "channels", "Website chat widget saved", { origins }, { actorUserId: access.session.userId, targetType: "ChannelConnection", targetId: id });
  revalidatePath(await projectPath(`/settings/channels/${id}`));
  return { success: "Saved. Websites showing the widget pick it up on their next page load." };
}

/** Removes a brand image (logo, launcher icon or team photo); the public address stops serving it at once. */
export async function removeWidgetAssetAction(connectionId: string, assetId: string): Promise<WebchatSettingsState> {
  const access = await checkPermission("channels.manage", "OMNICHANNEL");
  if ("denied" in access) return { error: access.denied };
  try {
    await removeWidgetAsset(String(connectionId), String(assetId));
  } catch (err) {
    if (err instanceof WebchatError) return { error: err.message };
    throw err;
  }
  await logSystemEvent("INFO", "channels", "Website chat image removed", {}, { actorUserId: access.session.userId, targetType: "ChannelConnection", targetId: String(connectionId) });
  revalidatePath(await projectPath(`/settings/channels/${connectionId}`));
  return { success: "Removed." };
}

/** Creates or replaces the identity secret and returns it ONCE. */
export async function rotateWebchatSecretAction(id: string): Promise<{ secret?: string; error?: string }> {
  const access = await checkPermission("channels.manage", "OMNICHANNEL");
  if ("denied" in access) return { error: access.denied };
  try {
    const secret = await rotateWebchatIdentitySecret(String(id));
    await logSystemEvent("WARN", "channels", "Website chat identity secret replaced", {}, { actorUserId: access.session.userId, targetType: "ChannelConnection", targetId: String(id) });
    revalidatePath(await projectPath(`/settings/channels/${id}`));
    return { secret };
  } catch (err) {
    if (err instanceof WebchatError) return { error: err.message };
    throw err;
  }
}
