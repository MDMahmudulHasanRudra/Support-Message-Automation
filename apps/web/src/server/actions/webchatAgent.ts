"use server";

import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";

/**
 * An agent is typing a reply in a website chat conversation, so the visitor's widget shows "typing…"
 * for a few seconds (WEBSITE_CHAT.md §Typing). Written at most every 2 seconds. Silent when not
 * allowed: it is a courtesy, never something to refuse loudly in the middle of typing.
 */
export async function markAgentTyping(conversationId: string): Promise<void> {
  const access = await checkPermission("conversations.reply", "OMNICHANNEL");
  if ("denied" in access) return;
  const now = new Date();
  await prisma.channelConversation.updateMany({
    where: {
      id: String(conversationId),
      type: "WEBCHAT",
      OR: [{ agentTypingAt: null }, { agentTypingAt: { lt: new Date(now.getTime() - 2_000) } }],
    },
    data: { agentTypingAt: now },
  });
}
