"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * The throttles on adding people to groups, which had no UI at all — the columns existed and only
 * the schema defaults were ever used, so a deployment that needed a bigger job simply could not
 * have one.
 *
 * Every field is clamped rather than trusted, same as the broadcast limits. These pace the single
 * operation WhatsApp punishes hardest, and there is no second chance to discover that a number is
 * banned.
 */

export interface ParticipantAddSettingsState {
  error?: string;
  saved?: boolean;
}

const LIMITS = {
  // Slower floor than broadcasting on purpose (that allows 1s): a one-second gap between adds is
  // exactly the machine-gun pattern this whole feature is paced to avoid.
  delaySeconds: { min: 5, max: 300 },
  // Ten is already well above the conservative default. This is the number that actually protects
  // the account, so it is the one with the tightest ceiling.
  maxPerMinute: { min: 1, max: 10 },
  // Large jobs are safe now that the rate limit is global — a big one simply runs for longer, and
  // 5,000 adds at three a minute is most of a day. The ceiling bounds a single mistake.
  maxPerJob: { min: 1, max: 5000 },
  retryMaxAttempts: { min: 0, max: 3 },
} as const;

function clamp(value: number, { min, max }: { min: number; max: number }, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Seconds in, milliseconds out — see the form for why the boundary converts once. */
function secondsToMs(raw: FormDataEntryValue | null, currentMs: number): number {
  const seconds = clamp(Number(raw), LIMITS.delaySeconds, Math.round(currentMs / 1000));
  return seconds * 1000;
}

export async function updateGroupParticipantAddSettings(
  _prev: ParticipantAddSettingsState,
  formData: FormData,
): Promise<ParticipantAddSettingsState> {
  const granted = await checkPermission("bulk_messaging.manage");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;

  const current = await prisma.groupParticipantAddSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  const delayMinMs = secondsToMs(formData.get("delayMinSeconds"), current.delayMinMs);
  let delayMaxMs = secondsToMs(formData.get("delayMaxSeconds"), current.delayMaxMs);
  // A maximum below the minimum would make randomDelayMs return a negative range and every add
  // fire instantly — the opposite of what the person setting it intended.
  if (delayMaxMs < delayMinMs) delayMaxMs = delayMinMs;

  await prisma.groupParticipantAddSettings.update({
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
    },
  });

  await logSystemEvent("WARN", "settings", "Add-to-groups limits changed", { changedBy: session.username });
  revalidatePath("/group-member-adder/settings");
  revalidatePath("/group-member-adder");
  return { saved: true };
}
