"use server";

import { revalidatePath } from "next/cache";
import { parseAllowedOrigins } from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { projectPath } from "@/server/projectPaths";
import { rotateWebchatIdentitySecret, saveWebchatSettings, WebchatError } from "@/server/channels/webchat";

/** Website chat widget settings (WEBSITE_CHAT.md). channels.manage, OMNICHANNEL on. */

export interface WebchatSettingsState {
  error?: string;
  success?: string;
}

export async function saveWebchatSettingsAction(_prev: WebchatSettingsState, form: FormData): Promise<WebchatSettingsState> {
  const access = await checkPermission("channels.manage", "OMNICHANNEL");
  if ("denied" in access) return { error: access.denied };
  const id = String(form.get("connectionId") ?? "");
  const { origins, invalid } = parseAllowedOrigins(String(form.get("origins") ?? ""));
  if (invalid.length) return { error: `Not a website address: ${invalid.slice(0, 3).join(", ")}. Use the full address, like https://www.example.com.` };
  if (origins.length === 0) return { error: "Keep at least one website address, or switch the widget off instead." };
  const settings = {
    title: String(form.get("title") ?? ""),
    welcome: String(form.get("welcome") ?? ""),
    color: String(form.get("color") ?? ""),
    position: String(form.get("position") ?? ""),
    replyNote: String(form.get("replyNote") ?? ""),
    askName: form.get("askName") === "on",
    askEmail: form.get("askEmail") === "on",
  };
  try {
    await saveWebchatSettings(id, { settings, origins });
  } catch (err) {
    if (err instanceof WebchatError) return { error: err.message };
    throw err;
  }
  await logSystemEvent("INFO", "channels", "Website chat settings saved", { origins }, { actorUserId: access.session.userId, targetType: "ChannelConnection", targetId: id });
  revalidatePath(await projectPath(`/settings/channels/${id}`));
  return { success: "Saved. Open widgets pick it up the next time the page loads." };
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
