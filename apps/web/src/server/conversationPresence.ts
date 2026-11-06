import { PRESENCE_TYPING_MS, PRESENCE_VIEWING_MS, presenceKey, type ConversationRef } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";

/**
 * Inbox V3 agent presence (V3-05). A heartbeat records that this person has the conversation open (and, when
 * they just typed, that they are typing); a read returns the OTHER people seen inside the windows. It expires
 * by time — a closed tab simply stops sending — so nothing can leave a stale "is viewing" behind. Every query
 * is the project-scoped client, so a heartbeat or a read never reaches another project's conversation.
 * Nothing about what anybody typed is stored.
 */

export interface PresencePeer {
  userId: string;
  name: string;
  typing: boolean;
}

/** Rows past this are deleted by the next heartbeat in the project (one bounded statement, no job to run). */
const PRUNE_AFTER_MS = 24 * 60 * 60_000;

export async function recordPresence(ref: ConversationRef, userId: string, typing: boolean, now: Date = new Date()): Promise<void> {
  const projectId = await activeProjectId();
  const conversationKey = presenceKey(ref);
  await prisma.conversationPresence.upsert({
    where: { projectId_conversationKey_userId: { projectId, conversationKey, userId } },
    create: { projectId, conversationKey, userId, seenAt: now, typingAt: typing ? now : null },
    update: typing ? { seenAt: now, typingAt: now } : { seenAt: now },
  });
  await prisma.conversationPresence.deleteMany({ where: { seenAt: { lt: new Date(now.getTime() - PRUNE_AFTER_MS) } } });
}

export async function readPresence(ref: ConversationRef, viewerId: string, now: Date = new Date()): Promise<PresencePeer[]> {
  const rows = await prisma.conversationPresence.findMany({
    where: { conversationKey: presenceKey(ref), userId: { not: viewerId }, seenAt: { gte: new Date(now.getTime() - PRESENCE_VIEWING_MS) } },
    select: { userId: true, typingAt: true, user: { select: { name: true, isActive: true } } },
    orderBy: { seenAt: "desc" },
    take: 10,
  });
  return rows
    .filter((r) => r.user.isActive)
    .map((r) => ({ userId: r.userId, name: r.user.name, typing: r.typingAt !== null && r.typingAt.getTime() >= now.getTime() - PRESENCE_TYPING_MS }));
}
