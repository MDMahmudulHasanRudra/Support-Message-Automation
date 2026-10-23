import { prisma } from "@/server/db";
import type { ResolvedConversation } from "@/server/chatThreadV2";

/**
 * The checks every send from WhatsApp Chat v2 makes on its target — shared by the rich-message
 * actions (`actions/chatRich.ts`) and the file upload route (`api/whatsapp/send-file`), so a poll and
 * a photo cannot disagree about where a send may go.
 */

export const CONVERSATION_NOT_FOUND = "This conversation could not be found on the selected account. Nothing was sent.";
const NOT_FOUND = CONVERSATION_NOT_FOUND;

/**
 * Everything a send into this conversation needs, checked: the account connected, a group still
 * joined, a personal chat one the account already has (a reply, never a first message).
 */
export async function sendTarget(
  conversation: ResolvedConversation,
): Promise<{ ok: true; accountLabel: string; name: string; groupRowId: string | null } | { ok: false; error: string }> {
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: conversation.accountId }, select: { label: true, status: true } });
  if (!account) return { ok: false, error: NOT_FOUND };
  if (account.status !== "CONNECTED") {
    return { ok: false, error: `${account.label} is ${account.status.toLowerCase()}, so nothing was sent. Reconnect it on WhatsApp Accounts.` };
  }
  if (conversation.kind === "GROUP") {
    const group = await prisma.whatsAppGroup.findUnique({ where: { id: conversation.groupRowId }, select: { name: true, isActive: true } });
    if (!group) return { ok: false, error: NOT_FOUND };
    if (!group.isActive) return { ok: false, error: `This account is no longer a member of ${group.name}, so nothing was sent.` };
    return { ok: true, accountLabel: account.label, name: group.name, groupRowId: conversation.groupRowId };
  }
  const existing = await prisma.message.findFirst({
    where: { accountId: conversation.accountId, chatId: conversation.chatId, groupId: null },
    orderBy: { timestampWa: "desc" },
    select: { senderName: true },
  });
  if (!existing) return { ok: false, error: `${account.label} has no conversation with this number, so nothing was sent. Replies continue an existing chat; they never start one.` };
  return { ok: true, accountLabel: account.label, name: existing.senderName || conversation.chatId.split("@")[0]!, groupRowId: null };
}
