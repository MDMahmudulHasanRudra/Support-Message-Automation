"use server";

import { checkPermission } from "@/server/authorize";
import { getChatConversations, type ConversationSummary } from "@/server/chatInbox";

/**
 * Searches every group this account is in, not just the ones already on screen.
 *
 * The sidebar loads the 300 most recently active conversations, which is the right thing to
 * RENDER: nobody scrolls two thousand rows, and re-querying all of them every four seconds for a
 * list you navigate by searching would be expensive for no one's benefit.
 *
 * But the browser could only filter what had been loaded, so the cap was not a rendering bound at
 * all — it was a reachability bound. On an account in 1,856 groups, a group that had been quiet
 * for a week simply could not be found by typing its name, and the inbox gave no hint that it
 * existed. That is the complaint the cap actually produces, and it is a real one.
 *
 * `getChatConversations` has accepted a search term since it was written and no caller ever passed
 * one. This is that caller. The same LIMIT still applies to the RESULTS, so a two-letter query
 * cannot drag the whole roster into the browser.
 */
export async function searchConversations(query: string): Promise<ConversationSummary[]> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return [];

  const trimmed = query.trim();
  // One letter matches most of a roster and answers nothing, so it is not worth a round trip per
  // keystroke while somebody is still typing the first word.
  if (trimmed.length < 2) return [];

  return getChatConversations(trimmed);
}
