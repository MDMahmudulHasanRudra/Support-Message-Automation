"use server";

import { revalidatePath } from "next/cache";
import { sanitizeRoutingSettings } from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { saveRoutingSettings } from "@/server/autoRouting";

/** Settings → Automatic routing (AUTO_ROUTING.md). Needs settings.edit, AUTO_ROUTING and Inbox V3. */
export async function saveAutoRoutingSettings(input: unknown): Promise<{ ok: true } | { error: string }> {
  const granted = await checkPermission("settings.edit", "AUTO_ROUTING");
  if ("denied" in granted) return { error: granted.denied };
  if ((await activeDisabledFeatures()).has("UNIFIED_INBOX_V3")) return { error: "Automatic routing needs Inbox V3, which is switched off for this project." };
  const parsed = sanitizeRoutingSettings(input);
  if (!parsed.ok) return { error: parsed.error };
  const saved = await saveRoutingSettings(parsed.value, granted.session.userId);
  if ("error" in saved) return saved;
  revalidatePath(await projectPath("/settings/auto-routing"));
  return { ok: true };
}
