import { Prisma } from "@prisma/client";
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { personalChatFallbackName } from "@/lib/chatConversationType";

/**
 * Chat-link READS (CLIENT_CENTER_PLAN.md §3.4). Not a "use server" file: nothing here is an endpoint.
 * Every query goes through the project-scoped client, and the one raw query names "projectId".
 */

export interface ChatLinkView {
  id: string;
  accountId: string;
  accountLabel: string;
  chatId: string;
  /** The name WhatsApp gave, else the number (never a hidden number's digits as a phone). */
  chatLabel: string;
  linkedBy: string | null;
  linkedAt: Date;
}

export interface LinkableChat {
  chatId: string;
  label: string;
  lastAt: string;
  suggested: boolean;
  /** The client this chat is already linked to, when it is. */
  linkedTo: { clientId: string; name: string } | null;
}

/** The newest name WhatsApp gave an incoming message from this chat, if any. */
async function chatNames(accountId: string, chatIds: string[]): Promise<Map<string, string>> {
  if (chatIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ chatId: string; name: string | null }>>(Prisma.sql`
    SELECT m."chatId", (array_agg(m."senderName" ORDER BY m."timestampWa" DESC) FILTER (WHERE m."senderName" IS NOT NULL AND m."direction" = 'INCOMING'))[1] AS "name"
    FROM "Message" m
    WHERE m."projectId" = ${await activeProjectId()} AND m."accountId" = ${accountId} AND m."groupId" IS NULL AND m."chatId" IN (${Prisma.join(chatIds)})
    GROUP BY m."chatId"`);
  return new Map(rows.filter((r) => r.name).map((r) => [r.chatId, r.name!]));
}

/** A client's ACTIVE links. A removed link stays in the table as history and is not listed here. */
export async function getClientChatLinks(clientId: string): Promise<ChatLinkView[]> {
  const links = await prisma.clientWhatsAppChatLink.findMany({
    where: { clientId, unlinkedAt: null },
    orderBy: { linkedAt: "desc" },
    include: { account: { select: { label: true } }, linkedBy: { select: { name: true } } },
  });
  const byAccount = new Map<string, string[]>();
  for (const l of links) byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), l.chatId]);
  const names = new Map<string, string>();
  for (const [accountId, chatIds] of byAccount) for (const [chatId, name] of await chatNames(accountId, chatIds)) names.set(`${accountId}|${chatId}`, name);
  return links.map((l) => ({
    id: l.id,
    accountId: l.accountId,
    accountLabel: l.account.label,
    chatId: l.chatId,
    chatLabel: names.get(`${l.accountId}|${l.chatId}`) ?? personalChatFallbackName(l.chatId),
    linkedBy: l.linkedBy?.name ?? null,
    linkedAt: l.linkedAt,
  }));
}

/** The project's WhatsApp accounts, for the picker. */
export async function listLinkableAccounts() {
  return prisma.whatsAppAccount.findMany({ select: { id: true, label: true, phoneNumber: true, status: true }, orderBy: { label: "asc" } });
}

export const LINKABLE_CHAT_LIMIT = 40;

/**
 * The account's individual chats an admin can choose from: most recently active first, narrowed by
 * a number or a name when one is typed. `suggestedIds` (chats whose number equals the client's
 * WhatsApp number) are always included, marked, and listed first — a suggestion, never a link.
 */
export async function findLinkableChats(accountId: string, query: string, suggestedIds: string[]): Promise<LinkableChat[]> {
  const projectId = await activeProjectId();
  const q = query.replace(/[%_\\]/g, "").trim().slice(0, 60);
  const digits = q.replace(/\D/g, "");
  const filter = q
    ? Prisma.sql`AND (${digits ? Prisma.sql`m."chatId" LIKE ${`%${digits}%`} OR ` : Prisma.empty}m."senderName" ILIKE ${`%${q}%`})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ chatId: string; lastAt: Date; name: string | null }>>(Prisma.sql`
    SELECT m."chatId", max(m."timestampWa") AS "lastAt",
           (array_agg(m."senderName" ORDER BY m."timestampWa" DESC) FILTER (WHERE m."senderName" IS NOT NULL AND m."direction" = 'INCOMING'))[1] AS "name"
    FROM "Message" m
    WHERE m."projectId" = ${projectId} AND m."accountId" = ${accountId} AND m."groupId" IS NULL
      AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid') ${filter}
    GROUP BY m."chatId"
    ORDER BY max(m."timestampWa") DESC
    LIMIT ${LINKABLE_CHAT_LIMIT}`);
  const have = new Set(rows.map((r) => r.chatId));
  const missing = suggestedIds.filter((id) => !have.has(id));
  const extra = missing.length
    ? await prisma.$queryRaw<Array<{ chatId: string; lastAt: Date; name: string | null }>>(Prisma.sql`
        SELECT m."chatId", max(m."timestampWa") AS "lastAt",
               (array_agg(m."senderName" ORDER BY m."timestampWa" DESC) FILTER (WHERE m."senderName" IS NOT NULL AND m."direction" = 'INCOMING'))[1] AS "name"
        FROM "Message" m
        WHERE m."projectId" = ${projectId} AND m."accountId" = ${accountId} AND m."groupId" IS NULL AND m."chatId" IN (${Prisma.join(missing)})
        GROUP BY m."chatId"`)
    : [];
  const all = [...extra, ...rows];
  const links = all.length
    ? await prisma.clientWhatsAppChatLink.findMany({ where: { accountId, chatId: { in: all.map((r) => r.chatId) }, unlinkedAt: null }, include: { client: { select: { id: true, name: true } } } })
    : [];
  const linkedTo = new Map(links.map((l) => [l.chatId, { clientId: l.client.id, name: l.client.name }]));
  const suggested = new Set(suggestedIds);
  return all
    .map((r) => ({ chatId: r.chatId, label: r.name ?? personalChatFallbackName(r.chatId), lastAt: r.lastAt.toISOString(), suggested: suggested.has(r.chatId), linkedTo: linkedTo.get(r.chatId) ?? null }))
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.lastAt.localeCompare(a.lastAt));
}
