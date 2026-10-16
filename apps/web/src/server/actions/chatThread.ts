"use server";

import { checkPermission } from "@/server/authorize";
import type { OwnReactionState, MentionCandidate } from "@support-automation/shared";
import type { ThreadEntry } from "@/server/chatInbox";
import {
  attachOwnReactions,
  isChatUiV2Enabled,
  loadOlderEntries,
  mentionCandidatesFor,
  resolveConversation,
  searchConversationMessages,
  type ConversationRef,
  type OlderPageResult,
  type ThreadSearchHit,
} from "@/server/chatThreadV2";
import { prisma } from "@/server/db";

/**
 * WhatsApp Chat v2 reads, called from the browser (CHAT_UI_V2.md). Each one is a public endpoint, so
 * each checks for itself: a session with `messages.view` in this project, the CHAT_UI_V2 feature on,
 * and a conversation the server re-derives (`resolveConversation`) — never a project, account or
 * chat taken on trust. A refusal is "nothing to show", worded, never a redirect: these run while the
 * person is reading.
 */

const NOT_AVAILABLE = "The new conversation view is not switched on for this project.";
const NOT_FOUND = "This conversation could not be found on the selected account.";

async function gate(): Promise<string | null> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return granted.denied;
  if (!(await isChatUiV2Enabled())) return NOT_AVAILABLE;
  return null;
}

export async function loadOlderChatMessages(ref: ConversationRef, cursor: string, untilMessageId?: string | null): Promise<OlderPageResult> {
  const refused = await gate();
  if (refused) return { error: refused };
  const conversation = await resolveConversation(ref);
  if (!conversation) return { error: NOT_FOUND };
  return loadOlderEntries(conversation, cursor, untilMessageId ?? null);
}

export async function searchChatThread(ref: ConversationRef, term: string): Promise<{ hits: ThreadSearchHit[] } | { error: string }> {
  const refused = await gate();
  if (refused) return { error: refused };
  if (typeof term !== "string") return { hits: [] };
  const conversation = await resolveConversation(ref);
  if (!conversation) return { error: NOT_FOUND };
  return { hits: await searchConversationMessages(conversation, term) };
}

export async function getChatMentionCandidates(ref: ConversationRef): Promise<{ candidates: MentionCandidate[]; unmentionable: number } | { error: string }> {
  const refused = await gate();
  if (refused) return { error: refused };
  const conversation = await resolveConversation(ref);
  if (!conversation) return { error: NOT_FOUND };
  return mentionCandidatesFor(conversation);
}

/** The settled state of this account's own reactions on some messages of this conversation. */
export async function refreshOwnReactions(ref: ConversationRef, messageIds: string[]): Promise<Record<string, OwnReactionState>> {
  if (await gate()) return {};
  const conversation = await resolveConversation(ref);
  if (!conversation || !Array.isArray(messageIds)) return {};
  const ids = messageIds.filter((id): id is string => typeof id === "string" && id.length <= 64).slice(0, 100);
  if (ids.length === 0) return {};
  // Only messages that really are in this conversation; anything else is simply absent.
  const owned = await prisma.message.findMany({
    where: conversation.kind === "GROUP" ? { id: { in: ids }, groupId: conversation.groupRowId } : { id: { in: ids }, accountId: conversation.accountId, chatId: conversation.chatId, groupId: null },
    select: { id: true, direction: true },
  });
  const entries = owned.map(
    (m) => ({ id: m.id, kind: m.direction === "OUTGOING" ? "OUTGOING" : "INCOMING", body: "", at: new Date(0), senderName: null, senderPhone: null }) as ThreadEntry,
  );
  const withReactions = await attachOwnReactions(conversation.accountId, entries);
  return Object.fromEntries(withReactions.filter((e) => e.ownReaction).map((e) => [e.id, e.ownReaction!]));
}
