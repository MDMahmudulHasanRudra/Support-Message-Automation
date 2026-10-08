
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { Prisma } from "@prisma/client";
import { attributeOutbound, MOOD_LEVEL, type Mood, type OutboundSenderType } from "@support-automation/shared";
import { getGroupMoods, getMessageMoods, type MessageMood } from "@/server/moodDetectionReports";

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
 * practice it is a guardrail rather than a filter. It is a bound on what is RENDERED, not on what
 * is reachable: `searchConversations` (server/actions/chatSearch.ts) passes a term through to the
 * query below, so typing a name searches every group on the account and the matches beyond this
 * limit come back in their own section. That distinction is the whole point — before that caller
 * existed the browser could only filter what had been loaded, which made a quiet group on a
 * 1,856-group account literally unfindable.
 */
export { CONVERSATION_LIST_LIMIT } from "@/lib/chatInboxLimits";
import { CONVERSATION_LIST_LIMIT } from "@/lib/chatInboxLimits";

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
  /** The newest message is a customer's and nobody has answered it. */
  isUnanswered: boolean;
  /** Unanswered AND not opened since it arrived — what the "waiting" filter and the dot show. */
  awaitingReply: boolean;
  /** Inbox organisation. See `chatOrganisation.ts` — none of this affects automation. */
  categoryId: string | null;
  isPinned: boolean;
  isArchived: boolean;
  /** Mood Detection's conversation-level reading (concerned or worse), or null. An inference. */
  mood: Mood | null;
}

export interface ChatCategorySummary {
  id: string;
  name: string;
  color: string;
  position: number;
  /** Unarchived conversations of the SELECTED ACCOUNT filed here. */
  count: number;
}

/** A WhatsApp account the chat workspace can be opened in. */
export interface ChatAccountOption {
  id: string;
  label: string;
  phoneNumber: string | null;
  status: string;
  isPrimary: boolean;
  /** Active, unarchived groups — what the inbox would list. */
  groupCount: number;
}

/** The selected account's real totals, over EVERY active group — never the rendered 300. */
export interface ConversationCounts {
  total: number;
  waiting: number;
  seenUnanswered: number;
}

/** What the list is narrowed to. Applied in SQL, so a view is complete, not "what was loaded". */
export type ConversationView =
  | { kind: "all" }
  | { kind: "waiting" }
  | { kind: "seen-unanswered" }
  | { kind: "category"; id: string };

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

/**
 * Every WhatsApp account of this project, Primary first. The scoped client confines it to the URL's
 * project, so another project's account never appears and an id from one is simply "not found".
 */
export async function getChatAccounts(): Promise<ChatAccountOption[]> {
  const [accounts, counts] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      select: { id: true, label: true, phoneNumber: true, status: true, isPrimary: true },
      orderBy: [{ isPrimary: "desc" }, { label: "asc" }],
    }),
    prisma.whatsAppGroup.groupBy({
      by: ["accountId"],
      where: { isActive: true, chatArchivedAt: null },
      _count: { _all: true },
    }),
  ]);
  const byAccount = new Map(counts.map((row) => [row.accountId, row._count._all]));
  return accounts.map((a) => ({ ...a, groupCount: byAccount.get(a.id) ?? 0 }));
}

/** Categories with the selected account's live counts, for the filter bar. */
export async function getChatCategories(accountId: string): Promise<ChatCategorySummary[]> {
  const [rows, counts] = await Promise.all([
    prisma.chatCategory.findMany({
      orderBy: [{ position: "asc" }, { name: "asc" }],
      select: { id: true, name: true, color: true, position: true },
    }),
    prisma.whatsAppGroup.groupBy({
      by: ["chatCategoryId"],
      where: { accountId, isActive: true, chatArchivedAt: null, chatCategoryId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const byCategory = new Map(counts.map((row) => [row.chatCategoryId, row._count._all]));
  return rows.map((row) => ({ ...row, count: byCategory.get(row.id) ?? 0 }));
}

/**
 * One row per active, unarchived group of ONE account, with what the inbox needs to rank and
 * classify it: the newest message's time, and whether that message is a customer's still unanswered.
 *
 * "Unanswered" is the definition the inbox has always used: the newest message is INCOMING, not from
 * a team member, and no reply has been queued or sent to the WhatsApp group since (PENDING,
 * PROCESSING, RATE_LIMITED or SENT — never FAILED, CANCELLED or SKIPPED, which mean the customer got
 * nothing). A reply only becomes a `Message` when WhatsApp echoes it back, so without the queue check
 * an answered conversation kept showing as waiting for that whole window. The check sits inside a
 * CASE so it runs only for groups whose newest message is a customer's. It reads any account's
 * outbound to the group: a customer answered from another of our numbers in it has been answered.
 *
 * The newest message is one LATERAL probe per group on `Message(groupId, timestampWa)`. Postgres has
 * no index skip-scan, so a DISTINCT ON here would be a sort over every message of every group.
 */
async function inboxBaseSql(accountId: string, search: string | undefined): Promise<Prisma.Sql> {
  const projectId = await activeProjectId();
  return Prisma.sql`
    SELECT
      g."id", g."name", g."chatPinnedAt", g."chatCategoryId", g."chatReviewedAt",
      last."timestampWa" AS "lastAt",
      CASE
        WHEN last."direction" = 'INCOMING' AND NOT last."isFromTeamMember" THEN NOT EXISTS (
          SELECT 1 FROM "OutboundMessage" o
          WHERE o."chatId" = g."whatsappGroupId"
            AND o."projectId" = ${projectId}
            AND o."status" IN ('PENDING', 'PROCESSING', 'RATE_LIMITED', 'SENT')
            AND o."createdAt" > last."timestampWa"
        )
        ELSE false
      END AS "unanswered"
    FROM "WhatsAppGroup" g
    LEFT JOIN LATERAL (
      SELECT m."timestampWa", m."direction", m."isFromTeamMember"
      FROM "Message" m
      WHERE m."groupId" = g."id"
      ORDER BY m."timestampWa" DESC
      LIMIT 1
    ) last ON true
    WHERE g."projectId" = ${projectId}
      AND g."accountId" = ${accountId}
      AND g."isActive" = true
      AND g."chatArchivedAt" IS NULL
      ${search ? Prisma.sql`AND g."name" ILIKE ${`%${search}%`}` : Prisma.empty}
  `;
}

/** Awaiting = unanswered and not opened since the customer's message. */
const AWAITING_SQL = Prisma.sql`(b."unanswered" AND (b."chatReviewedAt" IS NULL OR b."lastAt" > b."chatReviewedAt"))`;

function viewSql(view: ConversationView): Prisma.Sql {
  switch (view.kind) {
    case "waiting":
      return Prisma.sql`AND ${AWAITING_SQL}`;
    case "seen-unanswered":
      return Prisma.sql`AND b."unanswered" AND NOT ${AWAITING_SQL}`;
    case "category":
      return Prisma.sql`AND b."chatCategoryId" = ${view.id}`;
    default:
      return Prisma.empty;
  }
}

interface RankedRow {
  id: string | null;
  unanswered: boolean | null;
  awaiting: boolean | null;
  total: number;
  waiting: number;
  seen: number;
}

interface RankedConversation {
  id: string;
  unanswered: boolean;
  awaiting: boolean;
}

/**
 * Ranks one account's conversations and, in the same statement, counts all of them.
 *
 * Which groups make the list is decided by RECENT ACTIVITY, not by name: pinned first (a pin means
 * "always keep this where I can see it"), then the newest message, groups that never spoke last. It
 * used to take the first 300 groups alphabetically, which silently omitted a conversation that
 * arrived five minutes ago if its name sorted past the 300th. The LIMIT bounds what is rendered; the
 * counts are over every row, so "All 742" means 742 — it used to be the length of the rendered list,
 * so it could never read more than 300.
 */
async function rankInbox(
  accountId: string,
  opts: { search?: string; view?: ConversationView },
): Promise<{ rows: RankedConversation[]; counts: ConversationCounts }> {
  const search = opts.search?.trim() || undefined;
  const view = opts.view ?? { kind: "all" };
  const rows = await prisma.$queryRaw<RankedRow[]>`
    WITH base AS MATERIALIZED (${await inboxBaseSql(accountId, search)}),
    counts AS (
      SELECT
        count(*)::int AS "total",
        (count(*) FILTER (WHERE ${AWAITING_SQL}))::int AS "waiting",
        (count(*) FILTER (WHERE b."unanswered" AND NOT ${AWAITING_SQL}))::int AS "seen"
      FROM base b
    ),
    ranked AS (
      SELECT
        b."id", b."unanswered", ${AWAITING_SQL} AS "awaiting",
        row_number() OVER (
          ORDER BY (b."chatPinnedAt" IS NOT NULL) DESC, b."chatPinnedAt" DESC NULLS LAST, b."lastAt" DESC NULLS LAST, b."name" ASC
        ) AS "rank"
      FROM base b
      WHERE true ${viewSql(view)}
      ORDER BY "rank"
      LIMIT ${CONVERSATION_LIST_LIMIT}
    )
    SELECT r."id", r."unanswered", r."awaiting", c."total", c."waiting", c."seen"
    FROM counts c
    LEFT JOIN ranked r ON true
    ORDER BY r."rank" NULLS LAST
  `;
  const first = rows[0];
  return {
    rows: rows.flatMap((r) => (r.id ? [{ id: r.id, unanswered: Boolean(r.unanswered), awaiting: Boolean(r.awaiting) }] : [])),
    counts: { total: first?.total ?? 0, waiting: first?.waiting ?? 0, seenUnanswered: first?.seen ?? 0 },
  };
}

/** The list rows for ranked ids, in rank order: the newest message's preview and the queued count. */
async function summarise(accountId: string, ranked: RankedConversation[]): Promise<ConversationSummary[]> {
  if (ranked.length === 0) return [];
  const groups = await prisma.whatsAppGroup.findMany({
    where: { id: { in: ranked.map((row) => row.id) }, accountId },
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
  });
  if (groups.length === 0) return [];

  const [latest, pending, moods] = await Promise.all([
    prisma.$queryRaw<
      Array<{ groupId: string; body: string; timestampWa: Date; direction: string; senderName: string | null; senderPhone: string }>
    >`
      SELECT g."id" AS "groupId", l."body", l."timestampWa", l."direction"::text AS direction, l."senderName", l."senderPhone"
      FROM "WhatsAppGroup" g
      CROSS JOIN LATERAL (
        SELECT m."body", m."timestampWa", m."direction", m."senderName", m."senderPhone"
        FROM "Message" m
        WHERE m."groupId" = g."id"
        ORDER BY m."timestampWa" DESC
        LIMIT 1
      ) l
      WHERE g."id" IN (${Prisma.join(groups.map((g) => g.id))})
        AND g."projectId" = ${await activeProjectId()}
    `,
    // This account's own unsent rows only: another number's queued send to the same WhatsApp group
    // belongs to that number's inbox, not this one.
    prisma.outboundMessage.groupBy({
      by: ["chatId"],
      where: { accountId, chatId: { in: groups.map((g) => g.whatsappGroupId) }, status: UNSETTLED_OUTBOUND },
      _count: { chatId: true },
    }),
    getGroupMoods(groups.map((g) => g.whatsappGroupId)),
  ]);

  const latestByGroup = new Map(latest.map((row) => [row.groupId, row]));
  const pendingByChat = new Map(pending.map((row) => [row.chatId, row._count.chatId]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  return ranked.flatMap((rank) => {
    const group = groupById.get(rank.id);
    if (!group) return [];
    const last = latestByGroup.get(group.id);
    return [
      {
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
        // From the SQL above, the one place the definition lives. Opening the conversation settles
        // "awaiting" — compared against the message time rather than a flag, so a NEW customer
        // message puts it straight back. Nothing is dismissed for good, only until they speak again.
        isUnanswered: rank.unanswered,
        awaitingReply: rank.awaiting,
        mood: moods.get(group.whatsappGroupId) ?? null,
      },
    ];
  });
}

/**
 * The inbox of ONE WhatsApp account: up to CONVERSATION_LIST_LIMIT conversations, ranked, plus the
 * account's real totals. There is no cross-account inbox: an account is always chosen, and every
 * query here is filtered by it on the server.
 */
export async function getChatInbox(accountId: string): Promise<{ conversations: ConversationSummary[]; counts: ConversationCounts }> {
  const { rows, counts } = await rankInbox(accountId, {});
  return { conversations: await summarise(accountId, rows), counts };
}

/**
 * One account's conversations narrowed by a search term and/or a view, in SQL — so the waiting list
 * or a category is complete rather than whatever the ranked 300 happened to contain. Used by the
 * search box (every group of the account) and by a filter whose count exceeds what is loaded.
 */
export async function getChatConversations(
  accountId: string,
  opts: { search?: string; view?: ConversationView } = {},
): Promise<ConversationSummary[]> {
  const { rows } = await rankInbox(accountId, opts);
  return summarise(accountId, rows);
}

/**
 * One account's archive, which is its own query rather than a flag on the one above.
 *
 * Archived conversations are excluded from the main list entirely — that is what archiving means —
 * so folding them in behind a filter would mean the ranking query fetched rows it almost always
 * discards. This runs only when somebody opens the archive.
 */
export async function getArchivedChatConversations(accountId: string, search?: string): Promise<ConversationSummary[]> {
  const trimmed = search?.trim();

  const groups = await prisma.whatsAppGroup.findMany({
    where: {
      accountId,
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
  // one you read conversations from.
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
    mood: null,
  }));
}

export type ThreadEntryKind = "INCOMING" | "OUTGOING" | "SYSTEM" | "QUEUED";

/** The software user who pressed send — from `OutboundMessage.createdById`, written from the session. */
export interface ThreadSender {
  id: string;
  name: string;
  username: string;
}

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
   * Set on outgoing entries this app can account for (`attributeOutbound`, the same function the
   * User Activity report uses). Someone taking a conversation over after an AI handoff has to know
   * what the AI already told the customer — an unlabelled reply reads as a colleague's.
   */
  authoredBy?: OutboundSenderType;
  /** For a person's send: who pressed send in this software. Absent for automation. */
  sentBy?: ThreadSender | null;
  /**
   * The file this message carried, as metadata only (MEDIA_STORAGE.md). The bytes are never part
   * of the thread: the browser asks the media endpoint for each one when it is about to show it.
   * Absent for a message recorded without an attachment row — text, or media that arrived before
   * media storage existed.
   */
  media?: ThreadMedia;
  /** Mood Detection's reading of this customer message (concerned or worse), with its signals. */
  mood?: MessageMood;
}

export interface ThreadMedia {
  id: string;
  type: "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "STICKER" | "GIF" | "OTHER";
  waType: string;
  status: "PENDING" | "DOWNLOADING" | "STORED" | "NOT_STORED" | "FAILED" | "DELETED";
  statusReason: string | null;
  mimeType: string | null;
  fileName: string | null;
  /** The stored size, or the size WhatsApp announced while it is not stored yet. */
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  hasThumbnail: boolean;
  deletedAt: Date | null;
}

export interface ChatThread {
  group: {
    id: string;
    name: string;
    whatsappGroupId: string;
    accountId: string;
    accountLabel: string;
    accountPhone: string | null;
    accountStatus: string;
    isMonitored: boolean;
    isActive: boolean;
    aiAutomationEnabled: boolean;
    aiSuppressedUntil: Date | null;
    participantCount: number | null;
    /** The conversation's detected mood (concerned or worse), or null. */
    mood: Mood | null;
  };
  entries: ThreadEntry[];
  /** True when older messages exist beyond the window this returned. */
  hasMore: boolean;
}

const THREAD_LIMIT = 80;

/** Another of our accounts in the same WhatsApp group — its own copy of this conversation. */
export interface OtherAccountCopy {
  accountId: string;
  accountLabel: string;
  /** That account's `WhatsAppGroup` row for this WhatsApp group. */
  groupRowId: string;
  connected: boolean;
}

/**
 * The other accounts of this project that are still members of the same WhatsApp group.
 *
 * `WhatsAppGroup` is one row per account per group, so each account has its own copy of a
 * conversation. A reply always goes out from the account whose copy is open (never silently from
 * another one); this list only lets the composer say "Primary Account is offline — open this group
 * under Support Account instead", as a link that switches the selected account.
 */
export async function getOtherAccountCopies(groupId: string): Promise<OtherAccountCopy[]> {
  const thread = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: { whatsappGroupId: true, accountId: true },
  });
  if (!thread) return [];
  const rows = await prisma.whatsAppGroup.findMany({
    where: { whatsappGroupId: thread.whatsappGroupId, isActive: true, accountId: { not: thread.accountId } },
    select: { id: true, accountId: true, account: { select: { label: true, status: true, isPrimary: true } } },
  });
  // Connected first, then Primary: the likeliest useful alternative leads.
  return [...rows]
    .sort(
      (a, b) =>
        Number(b.account.status === "CONNECTED") - Number(a.account.status === "CONNECTED") ||
        Number(b.account.isPrimary) - Number(a.account.isPrimary) ||
        a.account.label.localeCompare(b.account.label),
    )
    .map((row) => ({ accountId: row.accountId, accountLabel: row.account.label, groupRowId: row.id, connected: row.account.status === "CONNECTED" }));
}

const OUTBOUND_ATTRIBUTION_SELECT = {
  id: true,
  actionType: true,
  ruleId: true,
  idempotencyKey: true,
  aiFallbackDecision: { select: { id: true } },
  createdBy: { select: { id: true, name: true, username: true } },
} as const;

function attributionOf(row: {
  actionType: string;
  ruleId: string | null;
  idempotencyKey: string;
  aiFallbackDecision: { id: string } | null;
  createdBy: ThreadSender | null;
}): { authoredBy: OutboundSenderType; sentBy: ThreadSender | null } {
  const { senderType } = attributeOutbound({
    actionType: row.actionType,
    ruleId: row.ruleId,
    hasAiDecision: row.aiFallbackDecision !== null,
    idempotencyKey: row.idempotencyKey,
  });
  return { authoredBy: senderType, sentBy: senderType === "HUMAN_USER" || senderType === "BROADCAST" ? row.createdBy : null };
}

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
      account: { select: { label: true, status: true, phoneNumber: true } },
    },
  });
  if (!group) return null;

  const [windowed, queued] = await Promise.all([
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
        // Metadata only; one indexed lookup by the unique messageId for the whole window.
        media: {
          select: {
            id: true,
            mediaType: true,
            waType: true,
            status: true,
            statusReason: true,
            mimeType: true,
            fileName: true,
            sizeBytes: true,
            declaredSizeBytes: true,
            width: true,
            height: true,
            durationSeconds: true,
            thumbnailKey: true,
            deletedAt: true,
          },
        },
      },
    }),
    // THIS account's sends only. The same WhatsApp group can have another of our accounts in it, and
    // its queued or failed sends belong to its own copy of the conversation, not this one.
    prisma.outboundMessage.findMany({
      where: { chatId: group.whatsappGroupId, accountId: group.accountId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { ...OUTBOUND_ATTRIBUTION_SELECT, body: true, status: true, createdAt: true, failureReason: true, providerMessageId: true },
    }),
  ]);

  const hasMore = windowed.length > limit;
  const messages = hasMore ? windowed.slice(0, limit) : windowed;

  const storedWhatsAppIds = new Set(messages.map((m) => m.whatsappMessageId));

  // An outgoing message reaches this thread as an echo through the same subscription that feeds
  // `Message`, so attribution is recovered by matching the provider's id back to the outbound row we
  // queued — an exact lookup on the `providerMessageId` index for exactly the echoes on screen, not
  // "whichever of the newest outbound rows happen to match". Anything with no match predates this
  // app or was sent from the phone directly, and is left unattributed rather than guessed at.
  const outgoingIds = messages.filter((m) => m.direction === "OUTGOING").map((m) => m.whatsappMessageId);
  const echoed = outgoingIds.length
    ? await prisma.outboundMessage.findMany({
        where: { accountId: group.accountId, providerMessageId: { in: outgoingIds } },
        select: { ...OUTBOUND_ATTRIBUTION_SELECT, providerMessageId: true },
      })
    : [];
  const attributionByProviderId = new Map(echoed.map((row) => [row.providerMessageId!, attributionOf(row)]));
  const incomingIds = messages.filter((m) => m.direction === "INCOMING" && !m.isFromTeamMember).map((m) => m.whatsappMessageId);
  const [messageMoods, groupMoods] = await Promise.all([
    getMessageMoods(group.whatsappGroupId, incomingIds),
    getGroupMoods([group.whatsappGroupId]),
  ]);

  const entries: ThreadEntry[] = messages.map((m) => ({
    id: m.id,
    kind: m.direction as ThreadEntryKind,
    body: m.body,
    at: m.timestampWa,
    senderName: m.senderName,
    senderPhone: m.senderPhone,
    isTeamMember: m.isFromTeamMember,
    ...(m.direction === "OUTGOING" ? attributionByProviderId.get(m.whatsappMessageId) : undefined),
    ...(() => {
      const mood = messageMoods.get(m.whatsappMessageId);
      return mood && MOOD_LEVEL[mood.mood] >= 1 ? { mood } : {};
    })(),
    media: m.media
      ? {
          id: m.media.id,
          type: m.media.mediaType,
          waType: m.media.waType,
          status: m.media.status,
          statusReason: m.media.statusReason,
          mimeType: m.media.mimeType,
          fileName: m.media.fileName,
          sizeBytes: m.media.sizeBytes !== null ? Number(m.media.sizeBytes) : m.media.declaredSizeBytes !== null ? Number(m.media.declaredSizeBytes) : null,
          width: m.media.width,
          height: m.media.height,
          durationSeconds: m.media.durationSeconds,
          hasThumbnail: m.media.thumbnailKey !== null,
          deletedAt: m.media.deletedAt,
        }
      : undefined,
  }));

  for (const row of queued) {
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
      ...attributionOf(row),
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
      accountPhone: group.account.phoneNumber,
      accountStatus: group.account.status,
      isMonitored: group.isMonitored,
      isActive: group.isActive,
      aiAutomationEnabled: group.aiAutomationEnabled,
      aiSuppressedUntil: group.aiSuppressedUntil,
      participantCount: group.participantCount,
      mood: groupMoods.get(group.whatsappGroupId) ?? null,
    },
    entries,
    hasMore,
  };
}
