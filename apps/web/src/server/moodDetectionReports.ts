import {
  groupMood,
  isMood,
  isMoodSignal,
  MOOD_LEVEL,
  MOOD_TREND_WINDOW_MS,
  parseMoodPolicies,
  type Mood,
  type MoodSignal,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { MoodSettingsInput } from "@/lib/moodDetectionForm";

/**
 * Read side of Mood Detection (MOOD_DETECTION.md). Everything goes through the project-scoped
 * client, so another project's readings and alerts are simply not there.
 */

export interface MoodSettingsView extends MoodSettingsInput {
  exists: boolean;
  updatedAt: Date | null;
  updatedByName: string | null;
}

export async function getMoodSettingsView(): Promise<MoodSettingsView> {
  const row = await prisma.moodDetectionSettings.findUnique({ where: { id: "global" } });
  const updatedBy = row?.updatedById ? await prisma.user.findUnique({ where: { id: row.updatedById }, select: { name: true } }) : null;
  return {
    exists: row !== null,
    enabled: row?.enabled ?? false,
    analyzeText: row?.analyzeText ?? true,
    analyzeEmoji: row?.analyzeEmoji ?? true,
    analyzeStickers: row?.analyzeStickers ?? true,
    useAiClassification: row?.useAiClassification ?? false,
    sensitivity: (row?.sensitivity as MoodSettingsInput["sensitivity"]) ?? "BALANCED",
    minConfidence: row?.minConfidence ?? 80,
    cooldownMinutes: row?.cooldownMinutes ?? 30,
    internalGroupIds: row?.internalGroupIds ?? [],
    policies: parseMoodPolicies(row?.policies ?? null),
    unassignedMention: row?.unassignedMention === "NONE" ? "NONE" : "OPTED_IN",
    skipCustomerMessageWhenUnassigned: row?.skipCustomerMessageWhenUnassigned ?? false,
    requireHumanHours: row?.requireHumanHours ?? 24,
    updatedAt: row?.updatedAt ?? null,
    updatedByName: updatedBy?.name ?? null,
  };
}

export interface RecentMoodAlert {
  id: string;
  mood: string;
  priority: string;
  confidence: number;
  signals: MoodSignal[];
  triggerCount: number;
  openedAt: Date;
  cooldownUntil: Date;
  groupId: string;
  groupName: string;
  accountId: string;
  customer: string;
  message: string | null;
  actions: Array<{ action: string; status: string; detail: string | null; lastError: string | null }>;
}

export async function getRecentMoodAlerts(limit = 25): Promise<RecentMoodAlert[]> {
  const alerts = await prisma.moodAlert.findMany({
    orderBy: { openedAt: "desc" },
    take: limit,
    include: {
      group: { select: { name: true } },
      actions: { select: { action: true, status: true, detail: true, lastError: true }, orderBy: { createdAt: "asc" } },
    },
  });
  const messages = await prisma.message.findMany({
    where: { id: { in: alerts.map((a) => a.latestMessageId) } },
    select: { id: true, body: true, senderName: true, senderPhone: true },
  });
  const byId = new Map(messages.map((m) => [m.id, m]));
  return alerts.map((a) => {
    const m = byId.get(a.latestMessageId);
    return {
      id: a.id,
      mood: a.mood,
      priority: a.priority,
      confidence: a.confidence,
      signals: a.signals.filter(isMoodSignal),
      triggerCount: a.triggerCount,
      openedAt: a.openedAt,
      cooldownUntil: a.cooldownUntil,
      groupId: a.groupId,
      groupName: a.group.name,
      accountId: a.accountId,
      customer: m?.senderName ?? m?.senderPhone ?? a.customerKey,
      message: m?.body ?? null,
      actions: a.actions,
    };
  });
}

/** Readings in the last seven days by mood — the history behind the alerts. */
export async function getMoodReadingCounts(days = 7): Promise<{ total: number; triggered: number; byMood: Array<{ mood: string; count: number }> }> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [byMood, triggered] = await Promise.all([
    prisma.customerMoodEvent.groupBy({ by: ["mood"], where: { messageAt: { gte: since } }, _count: { _all: true } }),
    prisma.customerMoodEvent.count({ where: { messageAt: { gte: since }, triggered: true } }),
  ]);
  const rows = byMood.map((r) => ({ mood: r.mood, count: r._count._all })).sort((a, b) => b.count - a.count);
  return { total: rows.reduce((n, r) => n + r.count, 0), triggered, byMood: rows };
}

/**
 * The conversation-level mood of each WhatsApp group: an aggregate of each customer's latest
 * reading inside the trend window (`groupMood`). Only concerned-or-worse is returned — a calm
 * conversation carries no badge.
 */
export async function getGroupMoods(whatsappGroupIds: string[], now = new Date()): Promise<Map<string, Mood>> {
  const out = new Map<string, Mood>();
  if (whatsappGroupIds.length === 0) return out;
  const rows = await prisma.customerMoodEvent.findMany({
    // `confidence > 0` leaves out a sticker-only reading: it says nothing about mood, so it must not
    // replace an angry customer's latest mood with "neutral".
    where: { whatsappGroupId: { in: whatsappGroupIds }, messageAt: { gte: new Date(now.getTime() - MOOD_TREND_WINDOW_MS) }, confidence: { gt: 0 } },
    orderBy: { messageAt: "desc" },
    select: { whatsappGroupId: true, customerKey: true, mood: true },
    take: 3000,
  });
  const latest = new Map<string, Map<string, Mood>>();
  for (const row of rows) {
    if (!isMood(row.mood)) continue;
    const perGroup = latest.get(row.whatsappGroupId) ?? new Map<string, Mood>();
    if (!perGroup.has(row.customerKey)) perGroup.set(row.customerKey, row.mood);
    latest.set(row.whatsappGroupId, perGroup);
  }
  for (const [jid, perCustomer] of latest) {
    const mood = groupMood([...perCustomer.values()]);
    if (MOOD_LEVEL[mood] >= 1) out.set(jid, mood);
  }
  return out;
}

export interface MessageMood {
  mood: Mood;
  confidence: number;
  signals: MoodSignal[];
  triggered: boolean;
  aiUsed: boolean;
  analysed: boolean;
}

/** The reading of each message (by WhatsApp message id), so every account's copy shows the same one. */
export async function getMessageMoods(whatsappGroupId: string, whatsappMessageIds: string[]): Promise<Map<string, MessageMood>> {
  const out = new Map<string, MessageMood>();
  if (whatsappMessageIds.length === 0) return out;
  const rows = await prisma.customerMoodEvent.findMany({
    where: { whatsappGroupId, message: { whatsappMessageId: { in: whatsappMessageIds } } },
    select: { mood: true, confidence: true, signals: true, triggered: true, aiUsed: true, status: true, message: { select: { whatsappMessageId: true } } },
  });
  for (const row of rows) {
    if (!isMood(row.mood)) continue;
    out.set(row.message.whatsappMessageId, {
      mood: row.mood,
      confidence: row.confidence,
      signals: row.signals.filter(isMoodSignal),
      triggered: row.triggered,
      aiUsed: row.aiUsed,
      analysed: row.status === "ANALYZED",
    });
  }
  return out;
}
