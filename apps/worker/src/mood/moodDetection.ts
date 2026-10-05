import type { MoodDetectionSettings, Prisma } from "@prisma/client";
import {
  applyMoodTrend,
  decideMoodTrigger,
  detectMood,
  hasMoodSignal,
  isMood,
  moodThreshold,
  MOOD_LEVEL,
  parseMoodPolicies,
  type ConversationBehaviour,
  type Mood,
  type MoodPolicies,
  type MoodSources,
  type PreviousMood,
  MOOD_TREND_WINDOW_MS,
} from "@support-automation/shared";
import { prisma } from "../db.js";

/**
 * Mood Detection's pipeline half (MOOD_DETECTION.md): the cheap deterministic pre-filter that runs
 * on every customer message, and the shared readers the mood processor uses.
 *
 * Only a message that carries an emotional signal writes anything. The AI, the alert, every
 * notification and the customer-facing message all happen later in the mood processor, so this
 * adds one settings read to an ordinary message and never blocks ingestion on a model or a send.
 *
 * The one thing done here rather than later is the AI pause, and only when the deterministic
 * reading alone already crosses the threshold for a mood whose policy pauses AI: the AI fallback
 * runs further down this same pipeline, and an angry customer must not get a cheerful AI answer
 * in the seconds before the processor reaches their message.
 */

export interface ResolvedMoodSettings {
  enabled: boolean;
  sources: MoodSources;
  useAi: boolean;
  /** 50–99. */
  threshold: number;
  cooldownMinutes: number;
  internalGroupIds: string[];
  policies: MoodPolicies;
  unassignedMention: "OPTED_IN" | "NONE";
  skipCustomerMessageWhenUnassigned: boolean;
  requireHumanHours: number;
}

/** Read-only: the worker never writes the settings row. An absent row is "off". */
export async function getMoodSettings(): Promise<ResolvedMoodSettings> {
  return resolveMoodSettings(await prisma.moodDetectionSettings.findUnique({ where: { id: "global" } }));
}

export function resolveMoodSettings(row: MoodDetectionSettings | null): ResolvedMoodSettings {
  return {
    enabled: Boolean(row?.enabled),
    sources: { text: row?.analyzeText ?? true, emoji: row?.analyzeEmoji ?? true, stickers: row?.analyzeStickers ?? true },
    useAi: Boolean(row?.useAiClassification),
    threshold: moodThreshold(row?.sensitivity ?? "BALANCED", row?.minConfidence ?? 80),
    cooldownMinutes: Math.min(24 * 60, Math.max(1, row?.cooldownMinutes ?? 30)),
    internalGroupIds: row?.internalGroupIds ?? [],
    policies: parseMoodPolicies(row?.policies ?? null),
    unassignedMention: row?.unassignedMention === "NONE" ? "NONE" : "OPTED_IN",
    skipCustomerMessageWhenUnassigned: Boolean(row?.skipCustomerMessageWhenUnassigned),
    requireHumanHours: Math.min(168, Math.max(1, row?.requireHumanHours ?? 24)),
  };
}

/** How long a conversation behaviour holds AI replies back. */
export function pauseUntil(behaviour: ConversationBehaviour, settings: ResolvedMoodSettings, now: Date): Date | null {
  if (behaviour === "PAUSE_AI") return new Date(now.getTime() + settings.cooldownMinutes * 60_000);
  if (behaviour === "REQUIRE_HUMAN") return new Date(now.getTime() + settings.requireHumanHours * 3_600_000);
  return null;
}

/**
 * Holds AI replies back in every account's copy of this WhatsApp group, through the canonical
 * handoff state (`WhatsAppGroup.aiSuppressedUntil`) — never a second pause mechanism. Only ever
 * extends: a pause already running longer is left alone. A team member replying afterwards runs
 * `recordHumanTakeover`, which sets the ordinary takeover window: the person has taken over.
 */
export async function pauseAiInWhatsAppGroup(whatsappGroupId: string, until: Date): Promise<number> {
  const { count } = await prisma.whatsAppGroup.updateMany({
    where: { whatsappGroupId, OR: [{ aiSuppressedUntil: null }, { aiSuppressedUntil: { lt: until } }] },
    data: { aiSuppressedUntil: until },
  });
  return count;
}

/** This customer's earlier analysed moods in this WhatsApp group, oldest first, inside the trend window. */
export async function previousMoods(whatsappGroupId: string, customerKey: string, before: Date, excludeEventId?: string): Promise<PreviousMood[]> {
  const rows = await prisma.customerMoodEvent.findMany({
    where: {
      whatsappGroupId,
      customerKey,
      messageAt: { gte: new Date(before.getTime() - MOOD_TREND_WINDOW_MS), lt: before },
      status: { in: ["ANALYZED", "PENDING", "PROCESSING"] },
      // A sticker-only reading carries no mood; it must not break a trend.
      confidence: { gt: 0 },
      ...(excludeEventId ? { id: { not: excludeEventId } } : {}),
    },
    orderBy: { messageAt: "desc" },
    take: 6,
    select: { mood: true, messageAt: true },
  });
  return rows
    .reverse()
    .filter((row) => isMood(row.mood))
    .map((row) => ({ mood: row.mood as Mood, at: row.messageAt.getTime() }));
}

export interface MoodSignalInput {
  messageId: string;
  accountId: string;
  whatsappGroupId: string | null | undefined;
  whatsappMessageId: string;
  chatId: string;
  group: { id: string; isMonitored: boolean } | null;
  isFromTeamMember: boolean;
  senderPhone: string;
  body: string;
  timestampWa: Date;
  isSticker: boolean;
  now?: Date;
}

export interface MoodSignalResult {
  recorded: boolean;
  /** Set when this message paused AI replies, so the pipeline's own AI fallback sees it at once. */
  aiSuppressedUntil?: Date;
}

const NOTHING: MoodSignalResult = { recorded: false };

/**
 * The pipeline hook. Never throws past its own caller's try/catch in any way that matters: every
 * path either records one row or returns NOTHING.
 */
export async function recordMoodSignal(input: MoodSignalInput): Promise<MoodSignalResult> {
  // Customer mood only. A team member's message never triggers, whatever it says — and neither
  // does a group nobody opted into automation, or a direct message.
  if (input.isFromTeamMember || !input.group || !input.group.isMonitored || !input.whatsappGroupId) return NOTHING;

  const settings = await getMoodSettings();
  if (!settings.enabled) return NOTHING;
  // The escalation group itself carries alert text, which reads exactly like anger.
  if (settings.internalGroupIds.includes(input.whatsappGroupId)) return NOTHING;

  const now = input.now ?? new Date();
  const at = input.timestampWa;

  // This customer's own last few messages, for a burst or a complaint repeated across messages.
  const recent = await prisma.message.findMany({
    where: {
      groupId: input.group.id,
      senderPhone: input.senderPhone,
      direction: "INCOMING",
      id: { not: input.messageId },
      timestampWa: { gte: new Date(at.getTime() - 30 * 60_000), lte: at },
    },
    orderBy: { timestampWa: "desc" },
    take: 5,
    select: { body: true, timestampWa: true },
  });

  const reading = detectMood({
    text: input.body,
    isSticker: input.isSticker,
    sources: settings.sources,
    recent: recent.reverse().map((m) => ({ text: m.body, at: m.timestampWa.getTime() })),
    now: at.getTime(),
  });
  if (!hasMoodSignal(reading)) return NOTHING;

  // A second account in the same group stores its own copy of this message. One reading per
  // WhatsApp message: whichever copy arrived first is the one.
  const twin = await prisma.customerMoodEvent.findFirst({
    where: { whatsappGroupId: input.whatsappGroupId, message: { whatsappMessageId: input.whatsappMessageId } },
    select: { id: true },
  });
  if (twin) return NOTHING;

  const previous = await previousMoods(input.whatsappGroupId, input.senderPhone, at);
  const { reading: final, previousMood } = applyMoodTrend(reading, previous, at.getTime());
  const aiRequested = settings.useAi && reading.needsAi;

  try {
    await prisma.customerMoodEvent.create({
      data: {
        messageId: input.messageId,
        accountId: input.accountId,
        groupId: input.group.id,
        whatsappGroupId: input.whatsappGroupId,
        customerKey: input.senderPhone,
        messageAt: at,
        mood: final.mood,
        confidence: final.confidence,
        scores: final.scores as Prisma.InputJsonValue,
        signals: final.signals,
        previousMood,
        level: MOOD_LEVEL[final.mood],
        aiRequested,
        status: "PENDING",
        scheduledAt: now,
      },
    });
  } catch (err) {
    // One reading per message: a replay, a redelivery or a stranded-message re-run lands here.
    if ((err as { code?: string }).code === "P2002") return NOTHING;
    throw err;
  }

  const decision = decideMoodTrigger(final, settings.policies, settings.threshold);
  if (decision.triggered && decision.policy && decision.policy.conversation !== "CONTINUE") {
    const until = pauseUntil(decision.policy.conversation, settings, now);
    if (until) {
      await pauseAiInWhatsAppGroup(input.whatsappGroupId, until);
      return { recorded: true, aiSuppressedUntil: until };
    }
  }
  return { recorded: true };
}
