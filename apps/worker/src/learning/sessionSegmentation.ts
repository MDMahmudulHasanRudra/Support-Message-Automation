import { prisma } from "@support-automation/db";
import type { ConversationSession, LearningSettings } from "@prisma/client";
import { logSystemEvent } from "../logging/logSystemEvent.js";

/**
 * Conversation Learning — Phase 1 (data collection only). This module ONLY reads already-
 * persisted Message rows and tags them with a ConversationSession; it never writes a Message row
 * itself and is never called from apps/worker/src/pipeline/processIncomingMessage.ts. Turning
 * LearningSettings.conversationLearningEnabled off makes every function here a pure no-op —
 * the real message pipeline, rule engine, and outbound queue are completely unaffected either way.
 */

const BATCH_SIZE = 500;

/** Lazily seeds the singleton settings row, same "upsert on read" pattern as getAutomationSettings(). */
export async function getLearningSettings(): Promise<LearningSettings> {
  return prisma.learningSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
}

/**
 * Exported for direct testing — runs one segmentation pass: assigns any unsegmented incoming
 * messages to a (possibly new) ConversationSession, then closes any OPEN session that's gone
 * idle past the configured gap even without a new message arriving. Returns false only when the
 * feature is disabled or there was genuinely nothing to do.
 */
export async function processOneSegmentationBatch(): Promise<boolean> {
  const settings = await getLearningSettings();
  if (!settings.conversationLearningEnabled) return false;

  const job = await prisma.learningBatchJob.create({
    data: { jobType: "CONVERSATION_SEGMENTATION", trigger: "SCHEDULED", status: "RUNNING", startedAt: new Date() },
  });

  try {
    const messagesAssigned = await segmentUnassignedMessages(settings);
    const sessionsClosedIdle = await closeIdleOpenSessions(settings);

    await prisma.learningBatchJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        // Generic counters shared across all LearningBatchJob types — for this job type,
        // "considered" = messages examined, "updated" = sessions closed for inactivity.
        candidatesConsidered: messagesAssigned,
        candidatesUpdated: sessionsClosedIdle,
      },
    });
    return messagesAssigned > 0 || sessionsClosedIdle > 0;
  } catch (err) {
    await prisma.learningBatchJob.update({
      where: { id: job.id },
      data: { status: "FAILED", completedAt: new Date(), errorMessage: (err as Error).message },
    });
    await logSystemEvent("ERROR", "conversation-learning", "Session segmentation batch failed", {
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Reads a bounded, indexed slice (never a full table scan): only messages nobody has segmented
 * yet. `processingStatus: { not: "PENDING" }` skips a message still being evaluated by the real
 * pipeline, so this never races processIncomingMessage.ts's own writes to the same row.
 */
async function segmentUnassignedMessages(settings: LearningSettings): Promise<number> {
  const gapMs = settings.sessionGapMinutes * 60_000;

  const messages = await prisma.message.findMany({
    where: { conversationSessionId: null, direction: "INCOMING", processingStatus: { not: "PENDING" } },
    orderBy: [{ chatId: "asc" }, { timestampWa: "asc" }],
    take: BATCH_SIZE,
    select: { id: true, accountId: true, groupId: true, chatId: true, senderPhone: true, timestampWa: true },
  });
  if (messages.length === 0) return 0;

  const chatIds = [...new Set(messages.map((m) => m.chatId))];
  const openSessions = await prisma.conversationSession.findMany({
    where: { chatId: { in: chatIds }, status: "OPEN" },
  });
  const openByChatId = new Map<string, ConversationSession>(openSessions.map((s) => [s.chatId, s]));

  for (const chatId of chatIds) {
    let session = openByChatId.get(chatId) ?? null;

    for (const message of messages) {
      if (message.chatId !== chatId) continue;

      const withinGap = session && message.timestampWa.getTime() - session.lastMessageAt.getTime() <= gapMs;
      if (session && !withinGap) {
        await prisma.conversationSession.update({
          where: { id: session.id },
          data: { status: "CLOSED", closedAt: new Date() },
        });
        session = null;
      }

      if (!session) {
        session = await prisma.conversationSession.create({
          data: {
            accountId: message.accountId,
            chatId: message.chatId,
            groupId: message.groupId,
            firstMessageAt: message.timestampWa,
            lastMessageAt: message.timestampWa,
          },
        });
        openByChatId.set(chatId, session);
      }

      const participantPhones = session.participantPhones.includes(message.senderPhone)
        ? session.participantPhones
        : [...session.participantPhones, message.senderPhone];

      session = await prisma.conversationSession.update({
        where: { id: session.id },
        data: { lastMessageAt: message.timestampWa, messageCount: { increment: 1 }, participantPhones },
      });
      openByChatId.set(chatId, session);

      await prisma.message.update({ where: { id: message.id }, data: { conversationSessionId: session.id } });
    }
  }

  return messages.length;
}

/** Settles a session that simply went quiet — no new message ever "announces" this, so it needs its own sweep. */
async function closeIdleOpenSessions(settings: LearningSettings): Promise<number> {
  const cutoff = new Date(Date.now() - settings.sessionGapMinutes * 60_000);
  const result = await prisma.conversationSession.updateMany({
    where: { status: "OPEN", lastMessageAt: { lt: cutoff } },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  return result.count;
}
