"use server";

import { isInboxScope, parseInboxFilterSet } from "@support-automation/shared";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { loadInbox, loadMoreMessageMatches, type InboxItem, type InboxResult, type MessageSearchInfo } from "@/server/channels/inbox";
import {
  assignChannelConversation,
  ChannelReplyError,
  markChannelConversationRead,
  queueChannelReply,
  resumeChannelAi,
  retryChannelReply,
  setChannelConversationStatus,
} from "@/server/channels/replies";

/**
 * The unified inbox's actions (OMNICHANNEL.md §12). Every one is a public endpoint and checks for
 * itself: reading needs `messages.view` with the Omnichannel feature on; replying and changing a
 * conversation (status, assignment, AI) need `conversations.reply`, which belongs to that feature.
 * WhatsApp is not replied to from here — its rows open WhatsApp Chat, whose own actions apply.
 */

export interface InboxActionResult {
  error?: string;
  success?: string;
}

const refuse = (err: unknown): InboxActionResult => {
  if (err instanceof ChannelReplyError) return { error: err.message };
  console.error("[channels] inbox action failed", err);
  return { error: "Something went wrong on the server. Nothing was changed — try again, and check System Logs if it keeps happening." };
};

/** The list for a filter or a search the loaded list cannot answer. Refuses as an empty list (it is polled). */
export async function listInboxAction(input: { scope: string; filters?: unknown }): Promise<InboxResult | null> {
  const access = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in access) return null;
  if (!isInboxScope(input.scope)) return null;
  // Validated to the one accepted shape (packages/shared inboxFilters.ts): a filter narrows what the
  // viewer can already read and is never trusted as anything else.
  return loadInbox({ scope: input.scope, filters: parseInboxFilterSet(input.filters), viewerId: access.session.userId });
}

/** Inbox V3: the next page of conversations whose message text matches the search. Refuses as an empty page. */
export async function moreMessageMatchesAction(input: { scope: string; filters?: unknown; cursor: string; seen?: unknown }): Promise<{ items: InboxItem[]; messageSearch: MessageSearchInfo | null }> {
  const access = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in access || !isInboxScope(input.scope) || typeof input.cursor !== "string") return { items: [], messageSearch: null };
  return loadMoreMessageMatches({ scope: input.scope, filters: parseInboxFilterSet(input.filters), viewerId: access.session.userId, cursor: input.cursor, seen: Array.isArray(input.seen) ? input.seen.filter((k): k is string => typeof k === "string").slice(0, 1_000) : [] });
}

export async function sendChannelReplyAction(conversationId: string, text: string, nonce: string): Promise<InboxActionResult & { messageId?: string }> {
  const access = await checkPermission("conversations.reply");
  if ("denied" in access) return { error: access.denied };
  try {
    const result = await queueChannelReply({ conversationId, text, nonce, userId: access.session.userId });
    return { success: result.duplicate ? "Already queued." : "Queued — sending now.", messageId: result.messageId };
  } catch (err) {
    return refuse(err);
  }
}

export async function retryChannelReplyAction(messageId: string, confirmedUnknown: boolean): Promise<InboxActionResult> {
  const access = await checkPermission("conversations.reply");
  if ("denied" in access) return { error: access.denied };
  try {
    await retryChannelReply({ messageId, confirmedUnknown, actor: { userId: access.session.userId, username: access.session.username } });
    await logSystemEvent("INFO", "channels", "A channel reply was queued again", { confirmedUnknown }, { actorUserId: access.session.userId, targetType: "ChannelMessage", targetId: messageId });
    return { success: "Queued again." };
  } catch (err) {
    return refuse(err);
  }
}

/** Opening a conversation marks it read. Silent: it runs from the page's `after()`. */
export async function markChannelConversationReadAction(conversationId: string): Promise<void> {
  const access = await checkPermission("messages.view", "OMNICHANNEL");
  if ("denied" in access) return;
  await markChannelConversationRead(conversationId).catch(() => undefined);
}

export async function setChannelConversationStatusAction(conversationId: string, status: "OPEN" | "CLOSED"): Promise<InboxActionResult> {
  const access = await checkPermission("conversations.reply");
  if ("denied" in access) return { error: access.denied };
  if (status !== "OPEN" && status !== "CLOSED") return { error: "Unknown status." };
  try {
    await setChannelConversationStatus(conversationId, status, new Date(), access.session.userId);
    return { success: status === "CLOSED" ? "Closed. A new message from the customer reopens it." : "Reopened." };
  } catch (err) {
    return refuse(err);
  }
}

export async function assignChannelConversationAction(conversationId: string, toMe: boolean): Promise<InboxActionResult> {
  const access = await checkPermission("conversations.reply");
  if ("denied" in access) return { error: access.denied };
  try {
    await assignChannelConversation(conversationId, toMe ? access.session.userId : null, access.session.userId);
    return { success: toMe ? "Assigned to you." : "Unassigned." };
  } catch (err) {
    return refuse(err);
  }
}

export async function resumeChannelAiAction(conversationId: string): Promise<InboxActionResult> {
  const access = await checkPermission("conversations.reply");
  if ("denied" in access) return { error: access.denied };
  try {
    await resumeChannelAi(conversationId);
    return { success: "AI may answer the customer's next message." };
  } catch (err) {
    return refuse(err);
  }
}
