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

/**
 * Upper bound on the conversation list. Not pagination: the list is a sidebar you scan and search,
 * and page two of a chat list is where conversations go to be lost. It exists so the raw `IN (...)`
 * below can never be handed an unbounded id list on an account that belongs to thousands of groups,
 * and it is set well above the number of groups a support account realistically monitors, so in
 * practice it is a guardrail rather than a filter. This function accepts a search term that narrows
 * server-side, but neither caller passes one today — the inbox filters the loaded list in the
 * browser — so the cap is genuinely the ceiling on what the inbox can reach. ConversationList
 * renders a "showing the first N" line when the list comes back full, so the bound is never
 * invisible once it starts biting.
 */
export const CONVERSATION_LIST_LIMIT = 300;

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
  /** The newest message is a customer's and nobody has answered it. */
  isUnanswered: boolean;
  /** Unanswered AND not opened since it arrived — what the "waiting" filter and the dot show. */
  awaitingReply: boolean;
  /** Inbox organisation. See `chatOrganisation.ts` — none of this affects automation. */
  categoryId: string | null;
  isPinned: boolean;
  isArchived: boolean;
}

export interface ChatCategorySummary {
  id: string;
  name: string;
  color: string;
  position: number;
  /** Unarchived conversations filed here, so a category can show its own weight. */
  count: number;
}

/**
 * Saved replies for the composer picker, most-used first.
 *
 * Usage order rather than alphabetical: the four everybody sends rise to the top on their own
 * after a week, which is the ordering somebody scanning mid-conversation actually wants.
 */
export async function getSavedReplies(): Promise<Array<{ id: string; title: string; body: string }>> {
  return prisma.savedReply.findMany({
    orderBy: [{ usageCount: "desc" }, { position: "asc" }],
    select: { id: true, title: true, body: true },
    take: 100,
  });
}

/** Categories with their live counts, for the inbox filter bar. */
export async function getChatCategories(): Promise<ChatCategorySummary[]> {
  const rows = await prisma.chatCategory.findMany({
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      color: true,
      position: true,
      _count: { select: { groups: { where: { isActive: true, chatArchivedAt: null } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    count: row._count.groups,
  }));
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

  // Which groups make the list is decided by RECENT ACTIVITY, not by name.
  //
  // This used to take the first 300 groups alphabetically and then sort those by recency, which
  // reads as an ordering choice and is really a selection one: with 1,848 groups, a conversation
  // that arrived five minutes ago was invisible if its name sorted past the 300th. An inbox
  // silently omitting the newest message is the one thing an inbox cannot do.
  //
  // Pinned first regardless — a pin means "always keep this where I can see it", and a pinned
  // group dropping off because it went quiet would defeat the point of pinning it. Archived rows
  // are excluded here and fetched separately by the archived view.
  const ranked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT g."id"
    FROM "WhatsAppGroup" g
    LEFT JOIN LATERAL (
      SELECT m."timestampWa"
      FROM "Message" m
      WHERE m."groupId" = g."id"
      ORDER BY m."timestampWa" DESC
      LIMIT 1
    ) last ON true
    WHERE g."isActive" = true
      AND g."chatArchivedAt" IS NULL
      ${trimmed ? Prisma.sql`AND g."name" ILIKE ${`%${trimmed}%`}` : Prisma.empty}
    ORDER BY
      (g."chatPinnedAt" IS NOT NULL) DESC,
      g."chatPinnedAt" DESC NULLS LAST,
      last."timestampWa" DESC NULLS LAST,
      g."name" ASC
    LIMIT ${CONVERSATION_LIST_LIMIT}
  `;
  if (ranked.length === 0) return [];

  const groups = await prisma.whatsAppGroup.findMany({
    where: { id: { in: ranked.map((row) => row.id) } },
    select: {
      id: true,
      name: true,
      accountId: true,
      isMonitored: true,
      isActive: true,
      aiAutomationEnabled: true,
      aiSuppressedUntil: true,
      whatsappGroupId: true,
      chatCategoryId: true,
      chatPinnedAt: true,
      chatArchivedAt: true,
      chatReviewedAt: true,
      account: { select: { label: true } },
    },
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
  const pinnedAtById = new Map(groups.map((group) => [group.id, group.chatPinnedAt]));
  const pendingByChat = new Map(pending.map((row) => [row.chatId, row._count.chatId]));

  return groups
    .map((group) => {
      const last = latestByGroup.get(group.id);
      const unanswered = Boolean(last) && last!.direction === "INCOMING" && !last!.isFromTeamMember;
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
        categoryId: group.chatCategoryId,
        isPinned: group.chatPinnedAt !== null,
        isArchived: group.chatArchivedAt !== null,
        // A team member's own message arrives as INCOMING too (it is inbound to this account),
        // so direction alone is not enough — isFromTeamMember is what separates "a customer is
        // waiting" from "we already answered".
        isUnanswered: unanswered,
        // ...and opening the conversation settles it. "Waiting" in this inbox is a triage signal —
        // what still needs somebody's attention — not a claim that the customer was answered, so
        // reading it is a legitimate way to resolve it.
        //
        // Compared against the message timestamp rather than a flag, which is the part that makes
        // this safe: a NEW customer message lands after the review mark and puts the conversation
        // straight back in the list. Nothing can be dismissed permanently, only until they speak
        // again — otherwise one glance would bury a customer for good.
        awaitingReply: unanswered && (!group.chatReviewedAt || last!.timestampWa > group.chatReviewedAt),
      };
    })
    // Pinned first, then most recently active, and groups that have never spoken sink to the
    // bottom rather than disappearing — a silent group is still one you may need to open.
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (a.isPinned && b.isPinned) {
        // Pin order comes from a lookup rather than a field on the row: the client has no use for
        // the timestamp, and carrying it only to delete it again needs a discarded binding.
        const pinDelta = (pinnedAtById.get(b.id)?.getTime() ?? 0) - (pinnedAtById.get(a.id)?.getTime() ?? 0);
        if (pinDelta !== 0) return pinDelta;
      }
      if (!a.lastMessageAt && !b.lastMessageAt) return a.name.localeCompare(b.name);
      if (!a.lastMessageAt) return 1;
      if (!b.lastMessageAt) return -1;
      return b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
    });
}

/**
 * The archived view, which is its own query rather than a flag on the one above.
 *
 * Archived conversations are excluded from the main list entirely — that is what archiving means —
 * so folding them in behind a filter would mean the expensive ranking query fetched rows it almost
 * always discards. This runs only when somebody opens the archive.
 */
export async function getArchivedChatConversations(search?: string): Promise<ConversationSummary[]> {
  const trimmed = search?.trim();

  const groups = await prisma.whatsAppGroup.findMany({
    where: {
      isActive: true,
      chatArchivedAt: { not: null },
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
      chatCategoryId: true,
      chatPinnedAt: true,
      chatArchivedAt: true,
      account: { select: { label: true } },
    },
    orderBy: { chatArchivedAt: "desc" },
    take: CONVERSATION_LIST_LIMIT,
  });

  // No last-message lookup: the archive is a list you go to in order to un-archive something, not
  // one you read conversations from, and the preview would cost the same DISTINCT ON for rows
  // nobody is triaging.
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    accountId: group.accountId,
    accountLabel: group.account.label,
    isMonitored: group.isMonitored,
    isActive: group.isActive,
    aiAutomationEnabled: group.aiAutomationEnabled,
    aiSuppressedUntil: group.aiSuppressedUntil,
    lastMessageAt: null,
    lastMessagePreview: null,
    lastMessageOutgoing: false,
    lastMessageSender: null,
    pendingCount: 0,
    isUnanswered: false,
    awaitingReply: false,
    categoryId: group.chatCategoryId,
    isPinned: group.chatPinnedAt !== null,
    isArchived: true,
  }));
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

  const [windowed, outbound] = await Promise.all([
    prisma.message.findMany({
      where: { groupId },
      orderBy: { timestampWa: "desc" },
      // One row past the window is all it takes to know older history exists. This used to be a
      // COUNT of the group's entire message history, run on every 4s poll of every open tab, for
      // a value only ever read as a boolean.
      take: limit + 1,
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

  const hasMore = windowed.length > limit;
  const messages = hasMore ? windowed.slice(0, limit) : windowed;

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
    hasMore,
  };
}
