import { clampInactivityMinutes, DEFAULT_INACTIVITY_MINUTES } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * The project's Google Sheets settings (GOOGLE_SHEETS.md §7). One row per project; an absent row
 * means the defaults, so nothing has to be created for the module to work.
 */
export interface GoogleSheetsSettingsView {
  /** T: a gap longer than this between two signals is a pause, not work. */
  inactivityMinutes: number;
  /** Phase 8: read who changed monitored sheets in Google directly. */
  externalActivityEnabled: boolean;
  updatedByUsername: string | null;
  updatedAt: Date | null;
}

export async function getGoogleSheetsSettings(): Promise<GoogleSheetsSettingsView> {
  const row = await prisma.googleSheetsSettings.findUnique({ where: { id: "global" } });
  return {
    inactivityMinutes: row ? clampInactivityMinutes(row.inactivityMinutes) : DEFAULT_INACTIVITY_MINUTES,
    externalActivityEnabled: row?.externalActivityEnabled ?? true,
    updatedByUsername: row?.updatedByUsername ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Save them, clamped on the server whatever the form sent. */
export async function saveGoogleSheetsSettings(input: { inactivityMinutes: unknown; externalActivityEnabled: boolean; username: string }): Promise<GoogleSheetsSettingsView> {
  const data = {
    inactivityMinutes: clampInactivityMinutes(input.inactivityMinutes),
    externalActivityEnabled: input.externalActivityEnabled,
    updatedByUsername: input.username,
  };
  await prisma.googleSheetsSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  return getGoogleSheetsSettings();
}
