"use server";

import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { getChatConversations, type ConversationSummary, type ConversationView } from "@/server/chatInbox";

/**
 * Searches every group of the SELECTED account, not just the ones already on screen.
 *
 * The sidebar loads the 300 most recently active conversations, which is the right thing to
 * RENDER: nobody scrolls two thousand rows, and re-querying all of them every four seconds for a
 * list you navigate by searching would be expensive for no one's benefit.
 *
 * But the browser can only filter what has been loaded, so without this the cap would be a
 * reachability bound: on an account in 1,856 groups, a group quiet for a week could not be found by
 * typing its name. The same LIMIT still applies to the RESULTS, so a two-letter query cannot drag
 * the whole roster into the browser. The account is filtered on the server, so another account's
 * groups are never returned whatever the browser sends.
 */
export async function searchConversations(accountId: string, query: string): Promise<ConversationSummary[]> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return [];

  const trimmed = query.trim();
  // One letter matches most of a roster and answers nothing, so it is not worth a round trip per
  // keystroke while somebody is still typing the first word.
  if (trimmed.length < 2) return [];

  return getChatConversations(accountId, { search: trimmed });
}

/**
 * The whole of one view (Waiting, Seen-unanswered, a category) for the selected account, when its
 * real count is larger than what the ranked list loaded — so clicking "Waiting 18" shows eighteen,
 * not the twelve that happened to be among the 300 most recently active. Refuses as "nothing to show"
 * like every polled reader.
 */
export async function listConversationView(accountId: string, view: ConversationView): Promise<ConversationSummary[]> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return [];
  if (view.kind === "category" && typeof view.id !== "string") return [];
  return getChatConversations(accountId, { view });
}

/**
 * Where switching the workspace to another account should land. With a conversation open, the same
 * WhatsApp group under the new account (that account's own copy) when it is a member; otherwise the
 * new account's inbox — never the old conversation under the new account's list.
 */
export async function chatAccountSwitchTarget(targetAccountId: string, openGroupId: string | null): Promise<string | null> {
  const granted = await checkPermission("messages.view");
  if ("denied" in granted) return null;
  // The scoped client: an account of another project is not found.
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: targetAccountId }, select: { id: true } });
  if (!account) return null;
  const base = `/chat/account/${account.id}`;
  if (!openGroupId) return base;
  const open = await prisma.whatsAppGroup.findUnique({ where: { id: openGroupId }, select: { whatsappGroupId: true } });
  if (!open) return base;
  const copy = await prisma.whatsAppGroup.findFirst({
    where: { accountId: account.id, whatsappGroupId: open.whatsappGroupId, isActive: true },
    select: { id: true },
  });
  return copy ? `${base}/${copy.id}` : base;
}
