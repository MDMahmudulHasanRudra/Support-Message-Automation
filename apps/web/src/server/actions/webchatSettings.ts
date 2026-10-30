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
  const hours = readBusinessHours(form);
  if ("error" in hours) return { error: hours.error };
  const offset = Number(form.get("bottomOffset") ?? 20);
  const settings = {
    title: String(form.get("title") ?? ""),
    welcome: String(form.get("welcome") ?? ""),
    color: String(form.get("color") ?? ""),
    position: String(form.get("position") ?? ""),
    replyNote: String(form.get("replyNote") ?? ""),
    askName: form.get("askName") === "on",
    askEmail: form.get("askEmail") === "on",
    launcherLabel: String(form.get("launcherLabel") ?? ""),
    bottomOffset: Number.isFinite(offset) ? offset : 20,
    allowAttachments: form.get("allowAttachments") === "on",
    hours: hours.value,
    offlineMessage: String(form.get("offlineMessage") ?? ""),
    offlineAskEmail: form.get("offlineAskEmail") === "on",
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

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The hours as the form posted them, Sunday-first. A day is closed when ticked so; an open day needs both
 * times with the opening first, and is refused with its name otherwise rather than quietly saved closed.
 * The time zone is checked here too: `parseWidgetSettings` would otherwise fall back to the default in
 * silence and the widget would open at the wrong hour.
 */
function readBusinessHours(form: FormData): { value: { enabled: boolean; timezone: string; days: Array<{ open: string; close: string } | null> } } | { error: string } {
  const enabled = form.get("hoursEnabled") === "on";
  const timezone = String(form.get("hoursTimezone") ?? "").trim() || "Asia/Dhaka";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return { error: `"${timezone.slice(0, 60)}" is not a time zone. Use a name like Asia/Dhaka.` };
  }
  const days: Array<{ open: string; close: string } | null> = [];
  for (let i = 0; i < 7; i++) {
    if (form.get(`closed_${i}`) === "on") {
      days.push(null);
      continue;
    }
    const open = String(form.get(`open_${i}`) ?? "");
    const close = String(form.get(`close_${i}`) ?? "");
    if (!HHMM.test(open) || !HHMM.test(close)) {
      if (!enabled) {
        days.push(null);
        continue;
      }
      return { error: `${DAY_NAMES[i]}: enter an opening and a closing time, or tick Closed.` };
    }
    if (open >= close) return { error: `${DAY_NAMES[i]}: the closing time must be after the opening time (overnight hours are not supported).` };
    days.push({ open, close });
  }
  return { value: { enabled, timezone, days } };
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
