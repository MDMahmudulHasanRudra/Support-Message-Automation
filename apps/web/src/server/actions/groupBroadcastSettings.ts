"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { checkPermission } from "@/server/authorize";

/**
 * The throttles on the bulk-messaging path.
 *
 * These existed in the database from the beginning but had no UI at all — the only writes were
 * create-if-missing. So the settings that govern the single riskiest thing this product does
 * (sending the same message to many groups from the number that also serves every customer) were
 * whatever the schema defaulted to, permanently.
 *
 * Every field is clamped rather than trusted. A broadcast delay of 0 or a per-minute cap of 500 is
 * how a WhatsApp number gets banned, and the person typing it will not get a second chance to
 * discover that — so the bounds are enforced here, not merely suggested in the form.
 */

const LIMITS = {
  /** Seconds, as the form asks for them — see delaySecondsToMs below. */
  delaySeconds: { min: 1, max: 120 },
  maxPerMinute: { min: 1, max: 30 },
  maxPerJob: { min: 1, max: 2_000 },
  retryMaxAttempts: { min: 0, max: 5 },
  duplicateGroupCooldownMinutes: { min: 0, max: 10_080 },
} as const;

function clamp(value: number, { min, max }: { min: number; max: number }, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Seconds in from the form, milliseconds out to the column; falls back to the stored value. */
function delaySecondsToMs(raw: FormDataEntryValue | null, currentMs: number): number {
  const seconds = clamp(Number(raw), LIMITS.delaySeconds, Math.round(currentMs / 1000));
  return seconds * 1000;
}

export interface BroadcastSettingsState {
  error?: string;
  saved?: boolean;
}

export async function updateGroupBroadcastSettings(
  _prevState: BroadcastSettingsState,
  formData: FormData,
): Promise<BroadcastSettingsState> {
  const granted = await checkPermission("bulk_messaging.manage");
  if ("denied" in granted) return { error: granted.denied };
  const current = await prisma.groupBroadcastSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  // The form asks for seconds because nobody reasons about a pause between messages in
  // thousandths of a second — and typing 15000 invites the slip of one digit that turns a
  // fifteen-second gap into a fifteen-millisecond one. Converted here, once, at the boundary.
  const delayMinMs = delaySecondsToMs(formData.get("delayMinSeconds"), current.delayMinMs);
  const delayMaxMs = delaySecondsToMs(formData.get("delayMaxSeconds"), current.delayMaxMs);
  if (delayMaxMs < delayMinMs) {
    return { error: "The longest gap cannot be shorter than the shortest one." };
  }

  await prisma.groupBroadcastSettings.update({
    where: { id: "global" },
    data: {
      delayMinMs,
      delayMaxMs,
      maxPerMinute: clamp(Number(formData.get("maxPerMinute")), LIMITS.maxPerMinute, current.maxPerMinute),
      maxPerJob: clamp(Number(formData.get("maxPerJob")), LIMITS.maxPerJob, current.maxPerJob),
      retryMaxAttempts: clamp(
        Number(formData.get("retryMaxAttempts")),
        LIMITS.retryMaxAttempts,
        current.retryMaxAttempts,
      ),
      duplicateGroupCooldownMinutes: clamp(
        Number(formData.get("duplicateGroupCooldownMinutes")),
        LIMITS.duplicateGroupCooldownMinutes,
        current.duplicateGroupCooldownMinutes,
      ),
    },
  });

  revalidatePath("/group-message-sender");
  revalidatePath("/group-message-sender/settings");
  return { saved: true };
}
