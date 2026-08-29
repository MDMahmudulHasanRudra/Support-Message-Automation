import { prisma } from "@support-automation/db";
import { Prisma } from "@prisma/client";

/**
 * Read helpers for the WhatsApp Chat inbox. Plain async functions with no "use server"
 * directive — they are called from Server Components only, never from a client event
 * handler (the same convention as dashboardSummary.ts / dashboardMetrics.ts).
 *
 * The inbox reads the conversation the app has already stored. It never asks the worker
 * for history: `Message` is populated by the live subscription, so the thread goes back
 * to whenever this app started monitoring the group and grows from there.
 */

/** Statuses meaning "written, but not yet confirmed on WhatsApp". */
const UNSETTLED_OUTBOUND: Prisma.OutboundMessageWhereInput["status"] = {
  in: ["PENDING", "PROCESSING", "RATE_LIMITED", "FAILED", "CANCELLED", "SKIPPED"],
};

export interface ConversationSummary {
  id: string;
  name: string;
  accountId: string;
  accountLabel: string;
  isMonitored: boolean;
  isActive: boolean;
  aiAutomationEnabled: boolean;
  aiSuppressedUntil: Date | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageOutgoing: boolean;
  lastMessageSender: string | null;
  pendingCount: number;
  /**
   * The last thing said in this group came from a customer and nobody has answered it yet.
   * The one question a support inbox exists to answer, so it is computed here rather than left
   * for the reader to infer from a timestamp.
   */
  awaitingReply: boolean;
}

/**
 * The left-hand conversation list.
 *
 * The last-message preview is one `DISTINCT ON` rather than a query per group: `Message`
 * is indexed on `[groupId, timestampWa]`, so Postgres walks that index once and stops at
 * the newest row per group. Prisma's own `distinct` is applied after rows are fetched,
 * which on a large message table would mean reading the whole history to render a list —
 * this is the one place in the app where dropping to SQL genuinely earns it.
 */
export async function getChatConversations(search?: string): Promise<ConversationSummary[]> {
  const trimmed = search?.trim();

  const groups = await prisma.whatsAppGroup.findMany({
    where: {
      isActive: true,
      ...(trimmed ? { name: { contains: trimmed, mode: "insensitive" } } : {}),
    },
    select: {
      id: true,
      name: true,
      accountId: true,
      isMonitored: true,
      isActive: true,
      aiAutomationEnabled: true,
      aiSuppressedUntil: true,
      whatsappGroupId: true,
      account: { select: { label: true } },
    },
    orderBy: { name: "asc" },
  });

  if (groups.length === 0) return [];

  const groupIds = groups.map((g) => g.id);
  const chatIds = groups.map((g) => g.whatsappGroupId);

  const [latest, pending] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        groupId: string;
        body: string;
        timestampWa: Date;
        direction: string;
        senderName: string | null;
        senderPhone: string;
        isFromTeamMember: boolean;
      }>
    >`
      SELECT DISTINCT ON (m."groupId")
        m."groupId", m."body", m."timestampWa", m."direction"::text AS direction,
        m."senderName", m."senderPhone", m."isFromTeamMember"
      FROM "Message" m
      WHERE m."groupId" IN (${Prisma.join(groupIds)})
      ORDER BY m."groupId", m."timestampWa" DESC
    `,
    prisma.outboundMessage.groupBy({
      by: ["chatId"],
      where: { chatId: { in: chatIds }, status: UNSETTLED_OUTBOUND },
      _count: { chatId: true },
    }),
  ]);

  const latestByGroup = new Map(latest.map((row) => [row.groupId, row]));
  const pendingByChat = new Map(pending.map((row) => [row.chatId, row._count.chatId]));

  return groups
    .map((group) => {
      const last = latestByGroup.get(group.id);
      return {
        id: group.id,
        name: group.name,
        accountId: group.accountId,
        accountLabel: group.account.label,
        isMonitored: group.isMonitored,
        isActive: group.isActive,
        aiAutomationEnabled: group.aiAutomationEnabled,
        aiSuppressedUntil: group.aiSuppressedUntil,
        lastMessageAt: last?.timestampWa ?? null,
        lastMessagePreview: last?.body ?? null,
        lastMessageOutgoing: last?.direction === "OUTGOING",
        lastMessageSender: last ? (last.senderName ?? last.senderPhone) : null,
        pendingCount: pendingByChat.get(group.whatsappGroupId) ?? 0,
        // A team member's own message arrives as INCOMING too (it is inbound to this account),
        // so direction alone is not enough — isFromTeamMember is what separates "a customer is
        // waiting" from "we already answered".
        awaitingReply: Boolean(last) && last!.direction === "INCOMING" && !last!.isFromTeamMember,
      };
    })
    // Most recently active first, and groups that have never spoken sink to the bottom
    // rather than disappearing — a silent group is still one you may need to open.
    .sort((a, b) => {
      if (!a.lastMessageAt && !b.lastMessageAt) return a.name.localeCompare(b.name);
      if (!a.lastMessageAt) return 1;
      if (!b.lastMessageAt) return -1;
      return b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
    });
}

export type ThreadEntryKind = "INCOMING" | "OUTGOING" | "SYSTEM" | "QUEUED";

/** Who actually composed an outgoing message. Absent on anything inbound. */
export type ThreadAuthor = "AI" | "RULE" | "PERSON";

export interface ThreadEntry {
  id: string;
  kind: ThreadEntryKind;
  body: string;
  at: Date;
  senderName: string | null;
  senderPhone: string | null;
  /** Present only on QUEUED entries — the outbound row's own state. */
  outboundStatus?: string;
  failureReason?: string | null;
  isTeamMember?: boolean;
  /**
   * Set on outgoing entries this app can account for. Someone taking a conversation over after
   * an AI handoff has to know what the AI already told the customer before they add to it —
   * an unlabelled reply reads as a colleague's and gets contradicted.
   */
  authoredBy?: ThreadAuthor;
}

export interface ChatThread {
  group: {
    id: string;
    name: string;
    whatsappGroupId: string;
    accountId: string;
    accountLabel: string;
    accountStatus: string;
    isMonitored: boolean;
    isActive: boolean;
    aiAutomationEnabled: boolean;
    aiSuppressedUntil: Date | null;
    participantCount: number | null;
  };
  entries: ThreadEntry[];
  /** True when older messages exist beyond the window this returned. */
  hasMore: boolean;
}

const THREAD_LIMIT = 80;

export async function getChatThread(groupId: string, limit = THREAD_LIMIT): Promise<ChatThread | null> {
  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      whatsappGroupId: true,
      accountId: true,
      isMonitored: true,
      isActive: true,
      aiAutomationEnabled: true,
      aiSuppressedUntil: true,
      participantCount: true,
      account: { select: { label: true, status: true } },
    },
  });
  if (!group) return null;

  const [messages, totalMessages, outbound] = await Promise.all([
    prisma.message.findMany({
      where: { groupId },
      orderBy: { timestampWa: "desc" },
      take: limit,
      select: {
        id: true,
        body: true,
        direction: true,
        senderName: true,
        senderPhone: true,
        timestampWa: true,
        isFromTeamMember: true,
        whatsappMessageId: true,
      },
    }),
    prisma.message.count({ where: { groupId } }),
    prisma.outboundMessage.findMany({
      where: { chatId: group.whatsappGroupId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        body: true,
        status: true,
        createdAt: true,
        failureReason: true,
        providerMessageId: true,
        actionType: true,
        ruleId: true,
        aiFallbackDecision: { select: { id: true } },
      },
    }),
  ]);

  const storedWhatsAppIds = new Set(messages.map((m) => m.whatsappMessageId));

  // An outgoing message reaches this thread as an echo through the same subscription that feeds
  // `Message`, so attribution has to be recovered by matching the provider's id back to the
  // outbound row we queued. Anything with no match predates this app or was sent from the phone
  // directly, and is left unattributed rather than guessed at.
  const authorByProviderId = new Map<string, ThreadAuthor>();
  for (const row of outbound) {
    if (!row.providerMessageId) continue;
    authorByProviderId.set(
      row.providerMessageId,
      row.actionType === "MANUAL_REPLY"
        ? "PERSON"
        : row.aiFallbackDecision
          ? "AI"
          : row.ruleId
            ? "RULE"
            : "PERSON",
    );
  }

  const entries: ThreadEntry[] = messages.map((m) => ({
    id: m.id,
    kind: m.direction as ThreadEntryKind,
    body: m.body,
    at: m.timestampWa,
    senderName: m.senderName,
    senderPhone: m.senderPhone,
    isTeamMember: m.isFromTeamMember,
    authoredBy: m.direction === "OUTGOING" ? authorByProviderId.get(m.whatsappMessageId) : undefined,
  }));

  for (const row of outbound) {
    // A SENT row whose provider id is already present as a stored Message would be a
    // duplicate — WhatsApp echoes our own sends back through the same subscription that
    // feeds `Message`. Anything else (still queued, failed, or sent-but-not-echoed-yet)
    // has no stored counterpart and must be shown, or the operator's own message would
    // simply vanish from the thread they just typed it into.
    if (row.status === "SENT" && row.providerMessageId && storedWhatsAppIds.has(row.providerMessageId)) {
      continue;
    }
    entries.push({
      id: `outbound-${row.id}`,
      kind: "QUEUED",
      body: row.body,
      at: row.createdAt,
      senderName: null,
      senderPhone: null,
      outboundStatus: row.status,
      failureReason: row.failureReason,
      authoredBy:
        row.actionType === "MANUAL_REPLY" ? "PERSON" : row.aiFallbackDecision ? "AI" : row.ruleId ? "RULE" : "PERSON",
    });
  }

  entries.sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    group: {
      id: group.id,
      name: group.name,
      whatsappGroupId: group.whatsappGroupId,
      accountId: group.accountId,
      accountLabel: group.account.label,
      accountStatus: group.account.status,
      isMonitored: group.isMonitored,
      isActive: group.isActive,
      aiAutomationEnabled: group.aiAutomationEnabled,
      aiSuppressedUntil: group.aiSuppressedUntil,
      participantCount: group.participantCount,
    },
    entries,
    hasMore: totalMessages > messages.length,
  };
}
