import { prisma } from "@support-automation/db";

/**
 * The few messages before this one, so a follow-up question can be understood as a follow-up.
 *
 * Without this the assistant answered every message as though it were the first thing anyone had
 * ever said. A real example from this deployment, answered with confidence 90:
 *
 *   Customer: "Rudra name er client er khetreo ki same process follow hobe?"
 *   Assistant: "Yes, the same process will be followed."
 *
 * It had no idea what process. It agreed because agreeing is the shape of an answer.
 *
 * Two separate things were context-free, and fixing only one would have left the other: the prompt
 * that drafts the reply, and the knowledge lookup that grounds it. A question like the one above
 * carries no searchable word at all, so retrieval returned nothing and — under a response mode
 * that permits general answers — the model filled the gap from general knowledge.
 *
 * **The window is the one this system already uses.** `LearningSettings.sessionGapMinutes` is how
 * Conversation Learning decides where one conversation ends and the next begins, and reusing it
 * means there is one definition rather than two that can drift. Walking back from the newest
 * message and stopping at the first gap wider than that is what "this conversation" means here.
 *
 * Speakers are reduced to a role before anything leaves this file, the same way the group
 * knowledge builder does it — the model never sees a name or a number, so it cannot repeat one.
 */

/** Enough to resolve a reference; more starts to crowd out the knowledge that grounds the answer. */
const MAX_TURNS = 10;
/** A hard ceiling regardless of turn count, so one pasted essay cannot dominate the prompt. */
const MAX_TRANSCRIPT_CHARS = 1500;
/** Used when the settings row is missing, matching the schema default for sessionGapMinutes. */
const DEFAULT_SESSION_GAP_MINUTES = 30;

export interface ConversationTurn {
  /** SUPPORT covers this system's own replies and a person typing from the business phone alike. */
  role: "CUSTOMER" | "SUPPORT";
  body: string;
}

/**
 * Renders turns as the transcript the model sees. Pure and exported so the format can be tested
 * without a database — the same split `selectRelevantKnowledge` uses next door.
 */
export function formatConversationTranscript(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "";

  const lines: string[] = [];
  let used = 0;
  // Newest turns matter most, so when the cap bites it must drop the oldest — building the string
  // forwards and slicing the end would throw away the message the question actually refers to.
  for (const turn of [...turns].reverse()) {
    const line = `[${turn.role}] ${turn.body.replace(/\s+/g, " ").trim()}`;
    if (used + line.length > MAX_TRANSCRIPT_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Loads the turns preceding one message in its own chat.
 *
 * Never throws. The caller is mid-conversation with a customer, and answering without context is
 * what happened before this existed — strictly worse than answering, never worse than failing.
 */
export async function loadConversationContext(params: {
  accountId: string;
  chatId: string;
  /** Excluded from its own context, and the point the walk starts from. */
  currentMessageId: string;
  currentMessageAt: Date;
}): Promise<ConversationTurn[]> {
  try {
    const settings = await prisma.learningSettings.findUnique({
      where: { id: "global" },
      select: { sessionGapMinutes: true },
    });
    const gapMs = (settings?.sessionGapMinutes ?? DEFAULT_SESSION_GAP_MINUTES) * 60_000;

    const rows = await prisma.message.findMany({
      where: {
        accountId: params.accountId,
        chatId: params.chatId,
        id: { not: params.currentMessageId },
        timestampWa: { lte: params.currentMessageAt },
      },
      orderBy: { timestampWa: "desc" },
      take: MAX_TURNS,
      select: { body: true, direction: true, isFromTeamMember: true, timestampWa: true },
    });

    const turns: ConversationTurn[] = [];
    let previousAt = params.currentMessageAt;
    for (const row of rows) {
      // The session boundary: once the silence between two consecutive messages is longer than
      // the gap, everything older belongs to a different conversation and would mislead rather
      // than inform.
      if (previousAt.getTime() - row.timestampWa.getTime() > gapMs) break;
      previousAt = row.timestampWa;

      const body = row.body?.trim();
      if (!body) continue;
      turns.push({
        role: row.direction === "INCOMING" && !row.isFromTeamMember ? "CUSTOMER" : "SUPPORT",
        body,
      });
    }

    // Read newest-first for the walk; returned oldest-first because that is how a conversation reads.
    return turns.reverse();
  } catch (err) {
    console.error("[aiFallback] could not load conversation context; answering without it", err);
    return [];
  }
}
