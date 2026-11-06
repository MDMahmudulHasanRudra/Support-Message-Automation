"use server";

import { revalidatePath } from "next/cache";
import { checkPermission } from "@/server/authorize";
import { saveCsatSettings } from "@/server/csat";
import { projectPath } from "@/server/projectPaths";

/**
 * Settings → Satisfaction surveys (CSAT.md, feature CSAT_SURVEYS). Which channels ask, the question and the
 * per-customer cooldown. Gated on settings.edit and the feature; every value is clamped on the server.
 */
export async function saveCsatSettingsAction(input: {
  whatsappPersonalEnabled?: unknown;
  webchatEnabled?: unknown;
  messengerEnabled?: unknown;
  instagramEnabled?: unknown;
  telegramEnabled?: unknown;
  questionText?: unknown;
  cooldownDays?: unknown;
}): Promise<{ ok: true } | { error: string }> {
  const granted = await checkPermission("settings.edit", "CSAT_SURVEYS");
  if ("denied" in granted) return { error: granted.denied };
  await saveCsatSettings(input, granted.session.userId);
  revalidatePath(await projectPath("/settings/csat"));
  return { ok: true };
}
