import { prisma } from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import {
  buildGroupKnowledgePrompt,
  parseGroupKnowledgeResponse,
  type ExtractedKnowledge,
} from "./groupKnowledgePrompt.js";

/**
 * Reads one monitored group's conversation and distils it into knowledge base entries: what this
 * group actually asks about, what answers resolved it, what it needs. The knowledge then feeds
 * the people answering — and, once an entry has been checked by a human, the rules they write.
 *
 * Read-only with respect to WhatsApp. It never sends anything, never touches the outbound queue,
 * and never creates a rule. Everything it produces lands as an **unverified** AiKnowledgeItem
 * (`humanVerified: false`) for review, because a claim distilled by a model out of chat history
 * is evidence, not fact.
 *
 * One group per tick, oldest-first, so a first run across hundreds of groups spreads out instead
 * of spending an afternoon's API budget in a minute. Incremental: each run records the timestamp
 * of the newest message it covered, and the next run starts from there.
 */

const MAX_MESSAGES_PER_RUN = 400;
/** Below this the model is extrapolating, not extracting. */
const MIN_CONFIDENCE_TO_STORE = 60;
/** A single run should not be able to flood the knowledge base off one chatty group. */
const MAX_ENTRIES_PER_RUN = 8;

export interface GroupKnowledgeRunResult {
  ran: boolean;
  groupId?: string;
  created?: number;
  skipped?: string;
}

/**
 * `clientOverride` is a test-only seam (mirrors aiAnalysisJob.ts's own) — production call sites
 * never pass it. `groupIdOverride` runs a specific group on demand, for the dashboard's
 * "Build knowledge now" action, bypassing the oldest-first rotation but no other gate.
 */
export async function processOneGroupKnowledgeBuild(
  clientOverride?: AiClient,
  groupIdOverride?: string,
): Promise<GroupKnowledgeRunResult> {
  const aiSettings = await prisma.aiSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
  // Both gates checked explicitly here as well as inside resolveAiClient, so injecting a test
  // client still exercises the real rule rather than bypassing it.
  if (!aiSettings.aiEngineEnabled) return { ran: false, skipped: "AI_ENGINE_DISABLED" };
  if (!aiSettings.knowledgeFromChatEnabled) return { ran: false, skipped: "KNOWLEDGE_DISABLED" };

  const group = groupIdOverride
    ? await prisma.whatsAppGroup.findUnique({
        where: { id: groupIdOverride },
        select: { id: true, name: true, knowledgeBuiltThroughAt: true, isMonitored: true, isActive: true },
      })
    : await prisma.whatsAppGroup.findFirst({
        where: { isMonitored: true, isActive: true },
        // Never-built groups first (nulls sort first ascending), then least recently built.
        orderBy: { knowledgeBuiltAt: { sort: "asc", nulls: "first" } },
        select: { id: true, name: true, knowledgeBuiltThroughAt: true, isMonitored: true, isActive: true },
      });

  if (!group) return { ran: false, skipped: "NO_GROUPS" };
  if (!group.isMonitored || !group.isActive) return { ran: false, skipped: "GROUP_NOT_ELIGIBLE" };

  const messages = await prisma.message.findMany({
    where: {
      groupId: group.id,
      ...(group.knowledgeBuiltThroughAt ? { timestampWa: { gt: group.knowledgeBuiltThroughAt } } : {}),
    },
    orderBy: { timestampWa: "asc" },
    take: MAX_MESSAGES_PER_RUN,
    select: { body: true, timestampWa: true, isFromTeamMember: true, senderName: true, senderPhone: true },
  });

  if (messages.length < aiSettings.knowledgeMinMessagesPerGroup) {
    // Not enough new conversation to draw a conclusion from. Stamp the attempt anyway so the
    // rotation moves on instead of retrying this same quiet group on every single tick.
    await prisma.whatsAppGroup.update({
      where: { id: group.id },
      data: { knowledgeBuiltAt: new Date() },
    });
    return { ran: false, groupId: group.id, skipped: "NOT_ENOUGH_MESSAGES" };
  }

  const client = clientOverride ?? (await resolveAiClient("LEARNING"));
  if (!client) return { ran: false, skipped: "NO_AI_CLIENT" };

  const prompt = buildGroupKnowledgePrompt({
    groupName: group.name,
    lines: messages.map((m) => ({
      at: m.timestampWa,
      // Reduced to a role before it ever reaches the prompt — the model never sees a customer's
      // name or number, so it cannot copy one into a knowledge entry.
      speaker: m.isFromTeamMember ? "SUPPORT" : "CUSTOMER",
      isTeamMember: m.isFromTeamMember,
      body: m.body,
    })),
  });

  let extracted: ExtractedKnowledge[];
  try {
    const completion = await client.complete(prompt);
    extracted = parseGroupKnowledgeResponse(completion.text).slice(0, MAX_ENTRIES_PER_RUN);
  } catch (err) {
    // Leave the watermark untouched so the same window is retried next time rather than skipped.
    await logSystemEvent("WARN", "knowledge-builder", `Knowledge extraction failed for "${group.name}"`, {
      groupId: group.id,
      error: (err as Error).message,
    });
    return { ran: false, groupId: group.id, skipped: "AI_ERROR" };
  }

  const newestMessageAt = messages[messages.length - 1]!.timestampWa;
  const worthStoring = extracted.filter((entry) => entry.confidence >= MIN_CONFIDENCE_TO_STORE);
  const created = await storeExtractedKnowledge(group.id, worthStoring);

  await prisma.whatsAppGroup.update({
    where: { id: group.id },
    data: { knowledgeBuiltAt: new Date(), knowledgeBuiltThroughAt: newestMessageAt },
  });

  await logSystemEvent("INFO", "knowledge-builder", `Built knowledge from "${group.name}"`, {
    groupId: group.id,
    messagesRead: messages.length,
    extracted: extracted.length,
    stored: created,
  });

  return { ran: true, groupId: group.id, created };
}

/**
 * Stores what survived the confidence filter, skipping anything this group already knows.
 *
 * Dedup is an exact title match within the same source group — deliberately simple. The
 * knowledge base has a similarity threshold setting intended for a fuller comparison later;
 * until that exists, a cheap exact check that occasionally lets a near-duplicate through is far
 * better than the alternative, which is the same entry re-created on every single run.
 */
async function storeExtractedKnowledge(groupId: string, entries: ExtractedKnowledge[]): Promise<number> {
  if (entries.length === 0) return 0;

  const existing = await prisma.aiKnowledgeItem.findMany({
    where: { sourceGroupId: groupId, title: { in: entries.map((e) => e.title) } },
    select: { title: true },
  });
  const existingTitles = new Set(existing.map((item) => item.title));

  const fresh = entries.filter((entry) => !existingTitles.has(entry.title));
  if (fresh.length === 0) return 0;

  await prisma.aiKnowledgeItem.createMany({
    data: fresh.map((entry) => ({
      title: entry.title,
      category: entry.category,
      question: entry.question,
      answer: entry.answer,
      source: "CHAT_LEARNING",
      sourceGroupId: groupId,
      confidence: entry.confidence,
      aiGenerated: true,
      // The whole point of the review queue: a model's reading of a chat log is evidence a
      // human confirms, never a fact the system asserts on its own.
      humanVerified: false,
    })),
  });

  return fresh.length;
}
