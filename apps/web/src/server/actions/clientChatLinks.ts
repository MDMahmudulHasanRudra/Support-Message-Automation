"use server";

import { revalidatePath } from "next/cache";
import { CHAT_LINK_REFUSALS, isLinkableChatId, suggestedChatIds } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { isUniqueViolation } from "@/lib/prismaErrors";
import { recordClientActivity } from "@/server/clientRecords";
import { findLinkableChats, type LinkableChat } from "@/server/clientChatLinks";

/**
 * Linking a WhatsApp chat to a client (CLIENT_CENTER_PLAN.md §3.4). Every action is a public
 * endpoint, so every one makes its own check: `clients.link_whatsapp_chat`, a key held by authorized
 * admins only. Linking is manual, one chat at a time: there is no automatic link (a number that
 * equals the client's is only SUGGESTED), no "link all" and no link from an import. Nothing here sends
 * a message, and nothing is enforced by a link yet — later stages read it to address an individual
 * campaign.
 *
 * The client's timeline records THAT a chat was linked or removed, never the number.
 */

export interface LinkResult {
  ok: boolean;
  message: string;
}

async function refresh(clientId: string) {
  revalidatePath(await projectPath(`/clients/${clientId}`));
}

/**
 * The account's chats to choose from. Refuses as an empty list (a reader polled while somebody types
 * must not throw): no key, another project's client, or an account that is not this project's.
 */
export async function searchLinkableChats(clientId: string, accountId: string, query: string): Promise<LinkableChat[]> {
  const granted = await checkPermission("clients.link_whatsapp_chat");
  if ("denied" in granted) return [];
  const [client, account] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId }, select: { channels: { where: { kind: "WHATSAPP" }, select: { normalizedValue: true } } } }),
    prisma.whatsAppAccount.findFirst({ where: { id: accountId }, select: { id: true } }),
  ]);
  if (!client || !account) return [];
  const numbers = client.channels.map((c) => c.normalizedValue);
  const suggestedIds = numbers.map((n) => `${n}@c.us`);
  const chats = await findLinkableChats(accountId, String(query ?? ""), suggestedIds);
  const suggested = suggestedChatIds(numbers, chats);
  return chats.map((c) => ({ ...c, suggested: suggested.has(c.chatId) }));
}

export async function linkWhatsAppChat(clientId: string, accountId: string, chatId: string): Promise<LinkResult> {
  const granted = await checkPermission("clients.link_whatsapp_chat");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const client = await prisma.client.findFirst({ where: { id: clientId }, select: { status: true } });
  if (!client) return { ok: false, message: "That client no longer exists." };
  if (client.status === "ARCHIVED") return { ok: false, message: "This client is archived. Restore it before linking a chat." };
  if (!isLinkableChatId(chatId)) return { ok: false, message: CHAT_LINK_REFUSALS.notPersonal };
  const account = await prisma.whatsAppAccount.findFirst({ where: { id: accountId }, select: { label: true } });
  if (!account) return { ok: false, message: CHAT_LINK_REFUSALS.noAccount };
  // "Link an existing chat": the account must already hold a conversation with it. Never a number typed from memory.
  if (!(await prisma.message.findFirst({ where: { accountId, chatId, groupId: null }, select: { id: true } }))) return { ok: false, message: CHAT_LINK_REFUSALS.noChat };

  const active = await prisma.clientWhatsAppChatLink.findFirst({ where: { accountId, chatId, unlinkedAt: null }, select: { clientId: true } });
  if (active) return { ok: false, message: active.clientId === clientId ? CHAT_LINK_REFUSALS.alreadyLinkedHere : CHAT_LINK_REFUSALS.alreadyLinked };

  let linkId: string;
  try {
    linkId = await prisma.$transaction(async (tx) => {
      const link = await tx.clientWhatsAppChatLink.create({ data: { clientId, accountId, chatId, linkedById: granted.session.userId }, select: { id: true } });
      await recordClientActivity(tx, clientId, granted.session.userId, { type: "CHAT_LINKED", summary: `WhatsApp chat linked (${account.label})`, details: { linkId: link.id, accountId } });
      return link.id;
    });
  } catch (err) {
    // Two admins linking one chat at once: the database's one-active-link-per-chat index decides.
    if (isUniqueViolation(err)) return { ok: false, message: CHAT_LINK_REFUSALS.alreadyLinked };
    throw err;
  }
  await logSystemEvent("INFO", "clients", "WhatsApp chat linked to a client", { linkId, clientId, accountId }, { actorUserId: granted.session.userId, targetType: "Client", targetId: clientId });
  await refresh(clientId);
  return { ok: true, message: "Chat linked." };
}

export async function unlinkWhatsAppChat(linkId: string): Promise<LinkResult> {
  const granted = await checkPermission("clients.link_whatsapp_chat");
  if ("denied" in granted) return { ok: false, message: granted.denied };
  const link = await prisma.clientWhatsAppChatLink.findFirst({ where: { id: linkId, unlinkedAt: null }, select: { clientId: true, accountId: true } });
  if (!link) return { ok: false, message: "That link no longer exists." };
  // Conditional on still being active, so pressing twice (or two admins) unlinks once.
  const done = await prisma.$transaction(async (tx) => {
    const updated = await tx.clientWhatsAppChatLink.updateMany({ where: { id: linkId, unlinkedAt: null }, data: { unlinkedAt: new Date(), unlinkedById: granted.session.userId } });
    if (updated.count === 0) return false;
    await recordClientActivity(tx, link.clientId, granted.session.userId, { type: "CHAT_UNLINKED", summary: "WhatsApp chat link removed", details: { linkId, accountId: link.accountId } });
    return true;
  });
  if (!done) return { ok: false, message: "That link was already removed." };
  await logSystemEvent("INFO", "clients", "WhatsApp chat unlinked from a client", { linkId, clientId: link.clientId }, { actorUserId: granted.session.userId, targetType: "Client", targetId: link.clientId });
  await refresh(link.clientId);
  return { ok: true, message: "Link removed." };
}
