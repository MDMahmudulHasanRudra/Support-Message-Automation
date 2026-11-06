import type { ConversationRef } from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { getWebchatVisitorCard, lookupCustomerRecords, type CustomerRecords } from "@/server/channels/webchatVisitorCard";

/**
 * Who this conversation is with, for the side panel's Overview: what is already stored about them and how much
 * they have talked to us. Loaded once when the panel opens (never on the page's four-second refresh).
 *
 * A number is shown only when it really is one: a `@c.us` chat, or a website visitor's signed phone. A LID or a
 * Messenger id is never printed as a phone. Clients and orders appear only for a viewer who could open that
 * module anyway, and each says what the match rests on.
 */
export interface ConversationContact {
  name: string;
  via: string | null;
  isGroup: boolean;
  participants: number | null;
  phone: string | null;
  email: string | null;
  username: string | null;
  pageUrl: string | null;
  /** Website chat only: did the site sign this identity? */
  verified: boolean | null;
  firstAt: string | null;
  lastCustomerAt: string | null;
  stats: { messages: number; fromCustomer: number; resolved: number };
  clients: CustomerRecords["clients"];
  orders: CustomerRecords["orders"];
}

const RESOLVE_KINDS = { OR: [{ kind: "RESOLVE" }, { kind: "STATUS", toValue: { in: ["RESOLVED", "CLOSED"] } }] };

export async function loadConversationContact(session: Session, ref: ConversationRef): Promise<ConversationContact | null> {
  return ref.kind === "channel" ? loadChannelContact(session, ref.conversationId) : loadWhatsAppContact(session, ref.accountId, ref.chatId);
}

async function loadChannelContact(session: Session, conversationId: string): Promise<ConversationContact | null> {
  const row = await prisma.channelConversation.findFirst({
    where: { id: conversationId },
    select: { type: true, customerName: true, customerUsername: true, lastInboundAt: true, createdAt: true, connection: { select: { name: true } } },
  });
  if (!row) return null;
  const [messages, fromCustomer, first, resolved] = await Promise.all([
    prisma.channelMessage.count({ where: { conversationId } }),
    prisma.channelMessage.count({ where: { conversationId, direction: "INBOUND" } }),
    prisma.channelMessage.findFirst({ where: { conversationId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    prisma.conversationEvent.count({ where: { channelConversationId: conversationId, ...RESOLVE_KINDS } }),
  ]);
  const visitor = row.type === "WEBCHAT" ? await getWebchatVisitorCard(session, conversationId) : null;
  return {
    name: visitor?.name ?? row.customerName ?? "Customer",
    via: row.connection.name,
    isGroup: false,
    participants: null,
    phone: visitor?.phone ?? null,
    email: visitor?.email ?? null,
    username: row.customerUsername,
    pageUrl: visitor?.pageUrl ?? null,
    verified: visitor ? visitor.verified : null,
    firstAt: (first?.occurredAt ?? row.createdAt).toISOString(),
    lastCustomerAt: row.lastInboundAt?.toISOString() ?? null,
    stats: { messages, fromCustomer, resolved },
    clients: visitor?.clients ?? null,
    orders: visitor?.orders ?? null,
  };
}

async function loadWhatsAppContact(session: Session, accountId: string, chatId: string): Promise<ConversationContact | null> {
  const isGroup = chatId.endsWith("@g.us");
  const [account, group] = await Promise.all([
    prisma.whatsAppAccount.findFirst({ where: { id: accountId }, select: { label: true } }),
    isGroup ? prisma.whatsAppGroup.findFirst({ where: { accountId, whatsappGroupId: chatId }, select: { name: true, participantCount: true } }) : null,
  ]);
  if (!account || (isGroup && !group)) return null;
  const where = { accountId, chatId };
  const customerWhere = { ...where, direction: "INCOMING" as const, isFromTeamMember: false };
  const [messages, fromCustomer, first, lastCustomer, resolved] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.count({ where: customerWhere }),
    prisma.message.findFirst({ where, orderBy: { timestampWa: "asc" }, select: { timestampWa: true } }),
    prisma.message.findFirst({ where: customerWhere, orderBy: { timestampWa: "desc" }, select: { timestampWa: true, senderName: true } }),
    prisma.conversationEvent.count({ where: { ...where, ...RESOLVE_KINDS } }),
  ]);

  const phone = chatId.endsWith("@c.us") ? chatId.split("@")[0]! : null;
  const records = await lookupCustomerRecords(session, { email: null, phone, verified: true });
  const clients = records.clients === null ? null : [...records.clients];
  // A link somebody made by hand outranks a number match, and for a group it is the only match there is.
  if (clients !== null) {
    const disabled = await activeDisabledFeatures();
    if (!disabled.has("CLIENT_CENTER") && (await hasPermission(session, "clients.view"))) {
      const linked = isGroup
        ? await prisma.clientWhatsAppGroupLink.findMany({ where: { whatsappGroupId: chatId, unlinkedAt: null }, take: 3, select: { client: { select: { id: true, name: true, code: true, archivedAt: true } } } })
        : await prisma.clientWhatsAppChatLink.findMany({ where: { accountId, chatId, unlinkedAt: null }, take: 3, select: { client: { select: { id: true, name: true, code: true, archivedAt: true } } } });
      for (const { client } of linked.reverse()) {
        if (client.archivedAt || clients.some((c) => c.id === client.id)) continue;
        clients.unshift({ id: client.id, name: client.name, code: client.code, matchedBy: "link", verified: true });
      }
    }
  }

  return {
    name: group?.name ?? lastCustomer?.senderName ?? (phone ? `+${phone}` : "WhatsApp contact"),
    via: account.label,
    isGroup,
    participants: group?.participantCount ?? null,
    phone,
    email: null,
    username: null,
    pageUrl: null,
    verified: null,
    firstAt: first?.timestampWa.toISOString() ?? null,
    lastCustomerAt: lastCustomer?.timestampWa.toISOString() ?? null,
    stats: { messages, fromCustomer, resolved },
    clients,
    orders: records.orders,
  };
}
