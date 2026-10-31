import { formatMinor, normalizeChannelValue, normalizePhoneNumber, ORDER_STATUS_LABELS, type OrderStatus } from "@support-automation/shared";
import { prisma } from "@/server/db";
import type { Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { activeProjectId } from "@/server/projectContext";

/**
 * What the team sees about a website chat visitor beside the conversation (WEBSITE_CHAT.md §Visitor card).
 *
 * Trust is part of every line, because the two kinds of identity mean different things:
 *   - VERIFIED: the site signed it (HMAC with the widget's identity secret). The name and email came from
 *     the site's own login, and a phone number only with its own `phoneHash`.
 *   - TYPED: the visitor wrote it into the widget. Anybody can type anybody's email address.
 *
 * Clients and orders are looked up by the visitor's email and (signed) phone, each only for a viewer who
 * could open that module anyway — Client Management with `clients.view`, Orders with `orders.view` — and
 * every match says which identifier it rests on and whether that identifier was verified. A match on a
 * typed email is shown as a POSSIBLE match, never as who the visitor is.
 */
export interface WebchatVisitorCard {
  name: string | null;
  email: string | null;
  phone: string | null;
  verified: boolean;
  pageUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  typing: boolean;
  /** null = not shown to this viewer (module off or no permission). */
  clients: Array<{ id: string; name: string; code: string; matchedBy: "email" | "phone"; verified: boolean }> | null;
  orders: Array<{ id: string; number: string; status: string; total: string; createdAt: string; matchedBy: "email" | "phone"; verified: boolean }> | null;
}

const VISITOR_TYPING_MS = 6_000;
const MAX_CLIENTS = 3;
const MAX_ORDERS = 5;

export async function getWebchatVisitorCard(session: Session, conversationId: string, now: Date = new Date()): Promise<WebchatVisitorCard | null> {
  const conversation = await prisma.channelConversation.findFirst({
    where: { id: conversationId, type: "WEBCHAT" },
    select: { connectionId: true, externalThreadId: true },
  });
  if (!conversation) return null;
  const visitor = await prisma.webChatVisitor.findFirst({
    where: { id: conversation.externalThreadId, connectionId: conversation.connectionId },
    select: { name: true, email: true, phone: true, verifiedExternalId: true, pageUrl: true, typingAt: true, createdAt: true, lastSeenAt: true },
  });
  if (!visitor) return null;

  const verified = Boolean(visitor.verifiedExternalId);
  const email = visitor.email ? normalizeChannelValue("EMAIL", visitor.email) : null;
  // A phone is stored only with its own valid signature, so it is always verified.
  const phone = visitor.phone ? normalizePhoneNumber(visitor.phone) : null;
  const disabled = await activeDisabledFeatures();

  let clients: WebchatVisitorCard["clients"] = null;
  if (!disabled.has("CLIENT_CENTER") && (await hasPermission(session, "clients.view"))) {
    const phoneValue = phone ? normalizeChannelValue("PHONE", phone) : null;
    const or = [
      ...(email ? [{ kind: "EMAIL" as const, normalizedValue: email }] : []),
      ...(phoneValue ? [{ kind: { in: ["PHONE" as const, "WHATSAPP" as const] }, normalizedValue: phoneValue }] : []),
    ];
    clients = [];
    if (or.length) {
      const rows = await prisma.clientChannel.findMany({
        where: { OR: or, client: { archivedAt: null } },
        select: { kind: true, client: { select: { id: true, name: true, code: true } } },
        take: 20,
      });
      const seen = new Map<string, NonNullable<WebchatVisitorCard["clients"]>[number]>();
      // A phone match is signed; an email match is only as good as the visitor's identity.
      for (const r of rows.sort((a, b) => Number(a.kind === "EMAIL") - Number(b.kind === "EMAIL"))) {
        if (seen.has(r.client.id)) continue;
        const byPhone = r.kind !== "EMAIL";
        seen.set(r.client.id, { ...r.client, matchedBy: byPhone ? "phone" : "email", verified: byPhone || verified });
      }
      clients = [...seen.values()].slice(0, MAX_CLIENTS);
    }
  }

  let orders: WebchatVisitorCard["orders"] = null;
  if (!disabled.has("ORDERS") && (await hasPermission(session, "orders.view"))) {
    orders = [];
    const found = new Map<string, { matchedBy: "email" | "phone"; verified: boolean }>();
    if (phone) {
      const digits = phone.replace(/\D/g, "");
      if (digits.length >= 8) {
        // Phones on orders are stored as typed: narrowed by the last nine digits in SQL, then compared
        // exactly after normalising both sides (the commerce AI's own rule, AI_COMMERCE.md).
        const candidates = await prisma.$queryRaw<Array<{ id: string; customerPhone: string | null }>>`
          SELECT "id", "customerPhone" FROM "CommerceOrder"
          WHERE "projectId" = ${await activeProjectId()}
            AND regexp_replace(coalesce("customerPhone", ''), '\\D', '', 'g') LIKE ${`%${digits.slice(-9)}`}
          ORDER BY "createdAt" DESC
          LIMIT 20`;
        for (const c of candidates) {
          if (c.customerPhone && normalizePhoneNumber(c.customerPhone) === phone) found.set(c.id, { matchedBy: "phone", verified: true });
        }
      }
    }
    if (email) {
      const byEmail = await prisma.commerceOrder.findMany({
        where: { customerEmail: { equals: email, mode: "insensitive" } },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true },
      });
      for (const o of byEmail) if (!found.has(o.id)) found.set(o.id, { matchedBy: "email", verified });
    }
    if (found.size) {
      const rows = await prisma.commerceOrder.findMany({
        where: { id: { in: [...found.keys()] } },
        orderBy: { createdAt: "desc" },
        take: MAX_ORDERS,
        select: { id: true, number: true, status: true, totalMinor: true, currency: true, createdAt: true },
      });
      orders = rows.map((o) => ({
        id: o.id,
        number: o.number,
        status: ORDER_STATUS_LABELS[o.status as OrderStatus] ?? o.status,
        total: formatMinor(o.totalMinor, o.currency),
        createdAt: o.createdAt.toISOString(),
        ...found.get(o.id)!,
      }));
    }
  }

  return {
    name: visitor.name,
    email: visitor.email,
    phone,
    verified,
    pageUrl: visitor.pageUrl,
    firstSeenAt: visitor.createdAt.toISOString(),
    lastSeenAt: visitor.lastSeenAt.toISOString(),
    typing: Boolean(visitor.typingAt && now.getTime() - visitor.typingAt.getTime() < VISITOR_TYPING_MS),
    clients,
    orders,
  };
}
