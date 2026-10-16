
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { Prisma } from "@prisma/client";
import {
  attributeOutbound,
  createSenderResolver,
  describeSenderId,
  MOOD_LEVEL,
  readRichContent,
  type Mood,
  type OutboundContentKind,
  type OutboundSenderType,
  type RichContent,
  type OwnReactionState,
  type SenderMatchStatus,
} from "@support-automation/shared";
import { getGroupMoods, getMessageMoods, type MessageMood } from "@/server/moodDetectionReports";
import {
  isPersonalChatId,
  personalChatFallbackName,
  personalConversationKey,
  type ConversationKind,
  type ConversationType,
} from "@/lib/chatConversationType";

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
  /** A group's `WhatsAppGroup.id`, or a personal chat's key (`personalConversationKey`). */
  id: string;
  /** GROUP or PERSONAL, derived (lib/chatConversationType.ts) — never stored. */
  kind: ConversationKind;
  /** The WhatsApp chat id: the group's `…@g.us`, or the person's `…@c.us` / `…@lid`. */
  chatId: string;
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

/** One set of totals: every conversation, the waiting ones, the seen-but-unanswered ones. */
export interface ConversationViewCounts {
  total: number;
  waiting: number;
  seenUnanswered: number;
}

/**
 * The selected account's real totals, over EVERY active group and personal chat — never the
 * rendered 300. The top-level three are All (groups and personal chats together); `groups` and
 * `personal` are the same three for each type alone, so a chip can show "Waiting 4" under Personal
 * without a second query.
 */
export interface ConversationCounts extends ConversationViewCounts {
  groups: ConversationViewCounts;
  personal: ConversationViewCounts;
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
async function groupBaseSql(projectId: string, accountId: string, search: string | undefined): Promise<Prisma.Sql> {
  return Prisma.sql`
    SELECT
      g."id", g."whatsappGroupId" AS "chatId", 'GROUP'::text AS "kind",
      g."name", g."chatPinnedAt", g."chatCategoryId", g."chatReviewedAt",
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

/**
 * A personal (1:1) chat, in SQL: a message of the account with no group, in one of WhatsApp's
 * individual chat domains. The SQL twin of `isPersonalChatId` (lib/chatConversationType.ts); a test
 * holds the two together. `"groupId" IS NULL` is also what lets the planner use the partial index
 * `Message_personal_chat_idx`, which holds exactly the account's non-group messages.
 */
const PERSONAL_CHAT_SQL = Prisma.sql`m."groupId" IS NULL AND (m."chatId" LIKE '%@c.us' OR m."chatId" LIKE '%@lid')`;

/**
 * One row per personal (1:1) chat of ONE account, in the same shape as `groupBaseSql`.
 *
 * A personal chat has no row of its own — it IS its messages — so it is derived here: the account's
 * distinct personal chat ids, then one LATERAL probe each for the newest message (time, direction,
 * team member) and the newest name the customer's WhatsApp gave (`senderName` on an incoming
 * message), on `Message_personal_chat_idx`. Nothing about a personal chat is ever written to make
 * it listable.
 *
 * Unanswered means what it means for a group: the newest message is the customer's, not a team
 * member's, and nothing has been queued or sent to this chat since. One difference, deliberately:
 * only THIS account's outbound counts. A group is one conversation every one of our numbers in it
 * shares; a 1:1 chat is between the customer and this number, and another number writing to the
 * same person is a different chat.
 *
 * Personal chats are never pinned, filed or archived — those live on `WhatsAppGroup` — so those
 * columns are NULL. The review mark comes from `PersonalChatReview`. Search matches the name or the
 * chat id (the number), since a personal chat has no group name.
 */
async function personalBaseSql(projectId: string, accountId: string, search: string | undefined): Promise<Prisma.Sql> {
  const like = search ? `%${search}%` : null;
  return Prisma.sql`
    SELECT
      CONCAT(${personalConversationKey("")}::text, p."chatId") AS "id", p."chatId", 'PERSONAL'::text AS "kind",
      COALESCE(nm."senderName", p."chatId") AS "name",
      NULL::timestamp(3) AS "chatPinnedAt", NULL::text AS "chatCategoryId", r."reviewedAt" AS "chatReviewedAt",
      last."timestampWa" AS "lastAt",
      CASE
        WHEN last."direction" = 'INCOMING' AND NOT last."isFromTeamMember" THEN NOT EXISTS (
          SELECT 1 FROM "OutboundMessage" o
          WHERE o."chatId" = p."chatId"
            AND o."projectId" = ${projectId}
            AND o."accountId" = ${accountId}
            AND o."status" IN ('PENDING', 'PROCESSING', 'RATE_LIMITED', 'SENT')
            AND o."createdAt" > last."timestampWa"
        )
        ELSE false
      END AS "unanswered"
    FROM (
      SELECT m."chatId"
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."accountId" = ${accountId} AND ${PERSONAL_CHAT_SQL}
      GROUP BY m."chatId"
    ) p
    CROSS JOIN LATERAL (
      SELECT m."timestampWa", m."direction", m."isFromTeamMember"
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."accountId" = ${accountId} AND m."groupId" IS NULL AND m."chatId" = p."chatId"
      ORDER BY m."timestampWa" DESC
      LIMIT 1
    ) last
    LEFT JOIN LATERAL (
      SELECT NULLIF(m."senderName", '') AS "senderName"
      FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."accountId" = ${accountId} AND m."groupId" IS NULL AND m."chatId" = p."chatId"
        AND m."direction" = 'INCOMING' AND NULLIF(m."senderName", '') IS NOT NULL
      ORDER BY m."timestampWa" DESC
      LIMIT 1
    ) nm ON true
    LEFT JOIN "PersonalChatReview" r
      ON r."projectId" = ${projectId} AND r."accountId" = ${accountId} AND r."chatId" = p."chatId"
    ${like ? Prisma.sql`WHERE (nm."senderName" ILIKE ${like} OR p."chatId" ILIKE ${like})` : Prisma.empty}
  `;
}

/**
 * Every conversation of ONE account — its groups and its personal chats — with a `kind` column, so
 * the type filter and the per-type counts are applied in SQL over the complete set.
 */
async function inboxBaseSql(accountId: string, search: string | undefined): Promise<Prisma.Sql> {
  const projectId = await activeProjectId();
  return Prisma.sql`${await groupBaseSql(projectId, accountId, search)} UNION ALL ${await personalBaseSql(projectId, accountId, search)}`;
}

/** Awaiting = unanswered and not opened since the customer's message. */
const AWAITING_SQL = Prisma.sql`(b."unanswered" AND (b."chatReviewedAt" IS NULL OR b."lastAt" > b."chatReviewedAt"))`;
const SEEN_UNANSWERED_SQL = Prisma.sql`(b."unanswered" AND NOT ${AWAITING_SQL})`;

function viewSql(view: ConversationView): Prisma.Sql {
  switch (view.kind) {
    case "waiting":
      return Prisma.sql`AND ${AWAITING_SQL}`;
    case "seen-unanswered":
      return Prisma.sql`AND ${SEEN_UNANSWERED_SQL}`;
    case "category":
      return Prisma.sql`AND b."chatCategoryId" = ${view.id}`;
    default:
      return Prisma.empty;
  }
}

/** The type filter. Composes with the view: Personal + Waiting is both conditions. */
function typeSql(type: ConversationType): Prisma.Sql {
  if (type === "groups") return Prisma.sql`AND b."kind" = 'GROUP'`;
  if (type === "personal") return Prisma.sql`AND b."kind" = 'PERSONAL'`;
  return Prisma.empty;
}

interface RankedRow {
  id: string | null;
  kind: ConversationKind | null;
  chatId: string | null;
  name: string | null;
  unanswered: boolean | null;
  awaiting: boolean | null;
  total: number;
  waiting: number;
  seen: number;
  gTotal: number;
  gWaiting: number;
  gSeen: number;
  pTotal: number;
  pWaiting: number;
  pSeen: number;
}

interface RankedConversation {
  id: string;
  kind: ConversationKind;
  chatId: string;
  name: string;
  unanswered: boolean;
  awaiting: boolean;
}

const NO_COUNTS: ConversationViewCounts = { total: 0, waiting: 0, seenUnanswered: 0 };

/**
 * Ranks one account's conversations and, in the same statement, counts all of them.
 *
 * Which conversations make the list is decided by RECENT ACTIVITY, not by name: pinned first (a pin
 * means "always keep this where I can see it"), then the newest message, conversations that never
 * spoke last. It used to take the first 300 groups alphabetically, which silently omitted a
 * conversation that arrived five minutes ago if its name sorted past the 300th. The LIMIT bounds what
 * is rendered; the counts are over every row, so "All 742" means 742 — it used to be the length of
 * the rendered list, so it could never read more than 300.
 *
 * Groups and personal chats rank together under All; the type filter narrows the ranked list in SQL,
 * so "Personal" is that account's personal chats in full (up to the limit), not whichever of them
 * happened to be among the 300 most recent conversations. The counts always cover both types and
 * each type alone, whatever is selected.
 */
async function rankInbox(
  accountId: string,
  opts: { search?: string; view?: ConversationView; type?: ConversationType },
): Promise<{ rows: RankedConversation[]; counts: ConversationCounts }> {
  const search = opts.search?.trim() || undefined;
  const view = opts.view ?? { kind: "all" };
  const type = opts.type ?? "all";
  const rows = await prisma.$queryRaw<RankedRow[]>`
    WITH base AS MATERIALIZED (${await inboxBaseSql(accountId, search)}),
    counts AS (
      SELECT
        count(*)::int AS "total",
        (count(*) FILTER (WHERE ${AWAITING_SQL}))::int AS "waiting",
        (count(*) FILTER (WHERE ${SEEN_UNANSWERED_SQL}))::int AS "seen",
        (count(*) FILTER (WHERE b."kind" = 'GROUP'))::int AS "gTotal",
        (count(*) FILTER (WHERE b."kind" = 'GROUP' AND ${AWAITING_SQL}))::int AS "gWaiting",
        (count(*) FILTER (WHERE b."kind" = 'GROUP' AND ${SEEN_UNANSWERED_SQL}))::int AS "gSeen",
        (count(*) FILTER (WHERE b."kind" = 'PERSONAL'))::int AS "pTotal",
        (count(*) FILTER (WHERE b."kind" = 'PERSONAL' AND ${AWAITING_SQL}))::int AS "pWaiting",
        (count(*) FILTER (WHERE b."kind" = 'PERSONAL' AND ${SEEN_UNANSWERED_SQL}))::int AS "pSeen"
      FROM base b
    ),
    ranked AS (
      SELECT
        b."id", b."kind", b."chatId", b."name", b."unanswered", ${AWAITING_SQL} AS "awaiting",
        row_number() OVER (
          ORDER BY (b."chatPinnedAt" IS NOT NULL) DESC, b."chatPinnedAt" DESC NULLS LAST, b."lastAt" DESC NULLS LAST, b."name" ASC
        ) AS "rank"
      FROM base b
      WHERE true ${viewSql(view)} ${typeSql(type)}
      ORDER BY "rank"
      LIMIT ${CONVERSATION_LIST_LIMIT}
    )
    SELECT r."id", r."kind", r."chatId", r."name", r."unanswered", r."awaiting", c.*
    FROM counts c
    LEFT JOIN ranked r ON true
    ORDER BY r."rank" NULLS LAST
  `;
  const first = rows[0];
  return {
    rows: rows.flatMap((r) =>
      r.id && r.kind && r.chatId
        ? [{ id: r.id, kind: r.kind, chatId: r.chatId, name: r.name ?? "", unanswered: Boolean(r.unanswered), awaiting: Boolean(r.awaiting) }]
        : [],
    ),
    counts: first
      ? {
          total: first.total,
          waiting: first.waiting,
          seenUnanswered: first.seen,
          groups: { total: first.gTotal, waiting: first.gWaiting, seenUnanswered: first.gSeen },
          personal: { total: first.pTotal, waiting: first.pWaiting, seenUnanswered: first.pSeen },
        }
      : { ...NO_COUNTS, groups: NO_COUNTS, personal: NO_COUNTS },
  };
}

/** The list rows for ranked ids, in rank order: the newest message's preview and the queued count. */
async function summarise(accountId: string, ranked: RankedConversation[]): Promise<ConversationSummary[]> {
  if (ranked.length === 0) return [];
  const [groupRows, personalRows] = await Promise.all([
    summariseGroups(accountId, ranked.filter((row) => row.kind === "GROUP")),
    summarisePersonal(accountId, ranked.filter((row) => row.kind === "PERSONAL")),
  ]);
  const byId = new Map([...groupRows, ...personalRows].map((row) => [row.id, row]));
  return ranked.flatMap((rank) => {
    const row = byId.get(rank.id);
    return row ? [row] : [];
  });
}

async function summariseGroups(accountId: string, ranked: RankedConversation[]): Promise<ConversationSummary[]> {
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
        kind: "GROUP" as const,
        chatId: group.whatsappGroupId,
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
 * Personal chats for the list. A personal chat is not a group, so the group-only parts of a row are
 * fixed: never monitored or AI-answered (automation answers in monitored groups only), never pinned,
 * filed or archived, and no mood (Mood Detection reads monitored groups).
 */
async function summarisePersonal(accountId: string, ranked: RankedConversation[]): Promise<ConversationSummary[]> {
  if (ranked.length === 0) return [];
  const projectId = await activeProjectId();
  const chatIds = ranked.map((row) => row.chatId);
  const [account, latest, pending] = await Promise.all([
    prisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { label: true } }),
    prisma.$queryRaw<Array<{ chatId: string; body: string; timestampWa: Date; direction: string; senderName: string | null; senderPhone: string }>>`
      SELECT c."chatId", l."body", l."timestampWa", l."direction"::text AS direction, l."senderName", l."senderPhone"
      FROM unnest(ARRAY[${Prisma.join(chatIds)}]::text[]) AS c("chatId")
      CROSS JOIN LATERAL (
        SELECT m."body", m."timestampWa", m."direction", m."senderName", m."senderPhone"
        FROM "Message" m
        WHERE m."projectId" = ${projectId} AND m."accountId" = ${accountId} AND m."groupId" IS NULL AND m."chatId" = c."chatId"
        ORDER BY m."timestampWa" DESC
        LIMIT 1
      ) l
    `,
    prisma.outboundMessage.groupBy({
      by: ["chatId"],
      where: { accountId, chatId: { in: chatIds }, status: UNSETTLED_OUTBOUND },
      _count: { chatId: true },
    }),
  ]);
  if (!account) return [];

  const latestByChat = new Map(latest.map((row) => [row.chatId, row]));
  const pendingByChat = new Map(pending.map((row) => [row.chatId, row._count.chatId]));

  return ranked.map((rank) => {
    const last = latestByChat.get(rank.chatId);
    return {
      id: rank.id,
      kind: "PERSONAL" as const,
      chatId: rank.chatId,
      // The SQL falls back to the chat id so it can sort and search; on screen that is a number.
      name: rank.name && rank.name !== rank.chatId ? rank.name : personalChatFallbackName(rank.chatId),
      accountId,
      accountLabel: account.label,
      isMonitored: false,
      isActive: true,
      aiAutomationEnabled: false,
      aiSuppressedUntil: null,
      lastMessageAt: last?.timestampWa ?? null,
      lastMessagePreview: last?.body ?? null,
      lastMessageOutgoing: last?.direction === "OUTGOING",
      lastMessageSender: last ? (last.senderName ?? last.senderPhone) : null,
      pendingCount: pendingByChat.get(rank.chatId) ?? 0,
      categoryId: null,
      isPinned: false,
      isArchived: false,
      isUnanswered: rank.unanswered,
      awaitingReply: rank.awaiting,
      mood: null,
    };
  });
}

/**
 * The inbox of ONE WhatsApp account: up to CONVERSATION_LIST_LIMIT conversations (groups and personal
 * chats), ranked, plus the account's real totals. There is no cross-account inbox: an account is
 * always chosen, and every query here is filtered by it on the server.
 */
export async function getChatInbox(accountId: string): Promise<{ conversations: ConversationSummary[]; counts: ConversationCounts }> {
  const { rows, counts } = await rankInbox(accountId, {});
  return { conversations: await summarise(accountId, rows), counts };
}

/**
 * One account's conversations narrowed by a search term, a view and/or a type, in SQL — so the
 * waiting list, a category or Personal is complete rather than whatever the ranked 300 happened to
 * contain. Used by the search box (every conversation of the account) and by a filter whose count
 * exceeds what is loaded.
 */
export async function getChatConversations(
  accountId: string,
  opts: { search?: string; view?: ConversationView; type?: ConversationType } = {},
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
    kind: "GROUP" as const,
    chatId: group.whatsappGroupId,
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
  /** The sender with its WhatsApp domain (`Message.senderJid`), when known. */
  senderJid?: string | null;
  /**
   * Who sent an INCOMING message, read through the one identity rule every report uses
   * (WHATSAPP_IDENTITY.md): the roster member when exactly one matches, and a display name that is
   * never a guess — a WhatsApp private id (LID) is never printed as if it were a phone number.
   */
  sender?: ThreadSenderIdentity;
  /** The message this one replies to (WhatsApp's swipe-to-reply), when we stored it. */
  quoted?: ThreadQuote | null;
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
  /**
   * Chat v2: the reaction THIS account sent, as far as the worker confirmed it (chatReactions.ts).
   * Others' reactions are never here — receiving them needs a licence this deployment lacks.
   */
  ownReaction?: OwnReactionState;
  // ---- Chat v2 rich messaging (CHAT_RICH_MESSAGING.md) ----
  /** A message this account sent: WhatsApp's highest reported ack (null = none reported). */
  ackLevel?: number | null;
  /** Deleted for everyone on WhatsApp — the text is still shown, marked as deleted. */
  revokedAt?: Date | null;
  /** Starred on WhatsApp by this account, as the worker confirmed. */
  starred?: boolean;
  /** A poll's or a location's own details, when WhatsApp delivered them. */
  rich?: RichContent | null;
  /** Stored by "Load earlier from WhatsApp", not as it happened. */
  fromHistory?: boolean;
  /** A queued send's type (TEXT for a typed reply) and, for a sticker, the file it sends. */
  queuedContent?: { type: OutboundContentKind; stickerMediaId?: string | null; rich?: RichContent | null };
}

export interface ThreadSenderIdentity {
  /** What to call them: the roster name, else their WhatsApp name, else their number or a masked id. */
  label: string;
  memberId: string | null;
  status: SenderMatchStatus;
  /** A colleague whose identity could not be settled (CONFLICT / AMBIGUOUS). */
  needsReview: boolean;
  /** The id the contact panel opens with (domain kept when known). */
  contactKey: string;
}

type QuotedRow = { id: string; body: string; direction: string; senderName: string | null; senderPhone: string; senderJid: string | null };

export interface ThreadQuote {
  id: string;
  author: string;
  body: string;
  outgoing: boolean;
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
    /** When somebody last opened it (before this view marks it again) — the v2 unread divider. */
    reviewedAt: Date | null;
  };
  entries: ThreadEntry[];
  /** True when older messages exist beyond the window this returned. */
  hasMore: boolean;
}

/** One account's personal (1:1) chat with one person: no group row, so only what the messages say. */
export interface PersonalChatThread {
  chat: {
    /** The list key (`personalConversationKey`). */
    id: string;
    chatId: string;
    name: string;
    accountId: string;
    accountLabel: string;
    accountPhone: string | null;
    accountStatus: string;
    /** When somebody last opened it (before this view marks it again) — the v2 unread divider. */
    reviewedAt: Date | null;
  };
  entries: ThreadEntry[];
  hasMore: boolean;
}

export const THREAD_LIMIT = 80;

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

/** The message columns a thread renders: text, sender, attribution keys and media metadata. */
export const THREAD_MESSAGE_SELECT = {
  id: true,
  body: true,
  direction: true,
  senderName: true,
  senderPhone: true,
  senderJid: true,
  timestampWa: true,
  isFromTeamMember: true,
  whatsappMessageId: true,
  ackLevel: true,
  revokedAt: true,
  starredAt: true,
  richContent: true,
  loadedFromHistoryAt: true,
  quotedMessage: { select: { id: true, body: true, direction: true, senderName: true, senderPhone: true, senderJid: true } },
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
} as const;

/**
 * A thread's entries from one window of messages and this account's queued rows for the chat — the
 * same for a group and a personal chat. `moodChatId` is the group's WhatsApp id (Mood Detection reads
 * monitored groups only), or null for a personal chat.
 */
export async function buildThreadEntries(
  accountId: string,
  messages: Prisma.MessageGetPayload<{ select: typeof THREAD_MESSAGE_SELECT }>[],
  queued: Array<Prisma.OutboundMessageGetPayload<{ select: typeof QUEUED_SELECT }>>,
  moodChatId: string | null,
): Promise<ThreadEntry[]> {
  const storedWhatsAppIds = new Set(messages.map((m) => m.whatsappMessageId));

  // An outgoing message reaches this thread as an echo through the same subscription that feeds
  // `Message`, so attribution is recovered by matching the provider's id back to the outbound row we
  // queued — an exact lookup on the `providerMessageId` index for exactly the echoes on screen, not
  // "whichever of the newest outbound rows happen to match". Anything with no match predates this
  // app or was sent from the phone directly, and is left unattributed rather than guessed at.
  const outgoingIds = messages.filter((m) => m.direction === "OUTGOING").map((m) => m.whatsappMessageId);
  const echoed = outgoingIds.length
    ? await prisma.outboundMessage.findMany({
        where: { accountId, providerMessageId: { in: outgoingIds } },
        select: { ...OUTBOUND_ATTRIBUTION_SELECT, providerMessageId: true },
      })
    : [];
  const attributionByProviderId = new Map(echoed.map((row) => [row.providerMessageId!, attributionOf(row)]));
  const incomingIds = messages.filter((m) => m.direction === "INCOMING" && !m.isFromTeamMember).map((m) => m.whatsappMessageId);
  const [messageMoods, roster] = await Promise.all([
    moodChatId ? getMessageMoods(moodChatId, incomingIds) : Promise.resolve(new Map<string, MessageMood>()),
    // Every member, deactivated ones included: an old message keeps the name of whoever sent it.
    prisma.internalTeamMember.findMany({ select: { id: true, name: true, phoneNumber: true, whatsappId: true } }),
  ]);
  const resolver = createSenderResolver(roster);
  const memberName = new Map(roster.map((m) => [m.id, m.name]));
  const identityOf = (phone: string, jid: string | null, pushName: string | null): ThreadSenderIdentity => {
    const res = resolver.resolve(phone, jid);
    const described = describeSenderId(phone, jid);
    const fallback = described.phone ?? `WhatsApp user ···${(described.id ?? phone).slice(-4)}`;
    return {
      label: (res.memberId ? memberName.get(res.memberId) : null) ?? (pushName?.trim() || fallback),
      memberId: res.memberId,
      status: res.status,
      needsReview: res.isRosterMember && !res.memberId,
      contactKey: jid ?? phone,
    };
  };

  const quoteOf = (q: QuotedRow | null): ThreadQuote | null =>
    q
      ? {
          id: q.id,
          outgoing: q.direction === "OUTGOING",
          // WhatsApp's own word for the business's side of the conversation.
          author: q.direction === "OUTGOING" ? "You" : identityOf(q.senderPhone, q.senderJid, q.senderName).label,
          body: q.body.length > 160 ? `${q.body.slice(0, 160)}…` : q.body,
        }
      : null;

  const entries: ThreadEntry[] = messages.map((m) => ({
    id: m.id,
    kind: m.direction as ThreadEntryKind,
    body: m.body,
    at: m.timestampWa,
    senderName: m.senderName,
    senderPhone: m.senderPhone,
    senderJid: m.senderJid,
    // The stamped flag, deliberately: the inbox's "waiting" definition (inboxBaseSql) reads it, and
    // the header's Mark-waiting button must agree with the list. Who the sender IS is `sender`.
    isTeamMember: m.isFromTeamMember,
    ...(m.direction === "INCOMING" ? { sender: identityOf(m.senderPhone, m.senderJid, m.senderName) } : {}),
    quoted: quoteOf(m.quotedMessage),
    ...(m.direction === "OUTGOING" ? { ackLevel: m.ackLevel } : {}),
    ...(m.revokedAt ? { revokedAt: m.revokedAt } : {}),
    ...(m.starredAt ? { starred: true } : {}),
    ...(m.richContent ? { rich: readRichContent(m.richContent) } : {}),
    ...(m.loadedFromHistoryAt ? { fromHistory: true } : {}),
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
      quoted: quoteOf(row.replyToMessage),
      ...attributionOf(row),
      ...(row.contentType !== "TEXT" ? { queuedContent: queuedContentOf(row.contentType, row.content) } : {}),
    });
  }

  // Ties at one timestamp keep a stable order (the row id), the same order the older-page cursor uses.
  entries.sort((a, b) => a.at.getTime() - b.at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

/** What a queued poll / location / sticker / forward shows before WhatsApp echoes it (display only). */
function queuedContentOf(type: OutboundContentKind, content: unknown): NonNullable<ThreadEntry["queuedContent"]> {
  const raw = (content ?? {}) as Record<string, unknown>;
  if (type === "STICKER") return { type, stickerMediaId: typeof raw.mediaId === "string" ? raw.mediaId : null };
  if (type === "POLL") return { type, rich: readRichContent({ kind: "POLL", ...raw }) };
  if (type === "LOCATION") return { type, rich: readRichContent({ kind: "LOCATION", ...raw }) };
  return { type };
}

export const QUEUED_SELECT = {
  ...OUTBOUND_ATTRIBUTION_SELECT,
  body: true,
  contentType: true,
  content: true,
  status: true,
  createdAt: true,
  failureReason: true,
  providerMessageId: true,
  // Chat v2: what a queued reply quotes. Shown as the intent on the dashed bubble; the quote a stored
  // message shows comes only from WhatsApp's own echo (CHAT_UI_V2.md §4).
  replyToMessage: { select: { id: true, body: true, direction: true, senderName: true, senderPhone: true, senderJid: true } },
} as const;

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
      chatReviewedAt: true,
      account: { select: { label: true, status: true, phoneNumber: true } },
    },
  });
  if (!group) return null;

  const [windowed, queued] = await Promise.all([
    prisma.message.findMany({
      where: { groupId },
      // The row id breaks timestamp ties, so the window and the older pages (chatThreadV2.ts) agree on
      // exactly where one ends and the next begins.
      orderBy: [{ timestampWa: "desc" }, { id: "desc" }],
      // One row past the window is all it takes to know older history exists. This used to be a
      // COUNT of the group's entire message history, run on every 4s poll of every open tab, for
      // a value only ever read as a boolean.
      take: limit + 1,
      select: THREAD_MESSAGE_SELECT,
    }),
    // THIS account's sends only. The same WhatsApp group can have another of our accounts in it, and
    // its queued or failed sends belong to its own copy of the conversation, not this one.
    prisma.outboundMessage.findMany({
      where: { chatId: group.whatsappGroupId, accountId: group.accountId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: QUEUED_SELECT,
    }),
  ]);

  const hasMore = windowed.length > limit;
  const messages = hasMore ? windowed.slice(0, limit) : windowed;
  const [entries, groupMoods] = await Promise.all([
    buildThreadEntries(group.accountId, messages, queued, group.whatsappGroupId),
    getGroupMoods([group.whatsappGroupId]),
  ]);

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
      reviewedAt: group.chatReviewedAt,
    },
    entries,
    hasMore,
  };
}

/**
 * One account's personal (1:1) chat, from its stored messages — the same entries a group thread
 * shows, read by (account, chat id) because a personal chat has no row of its own. Null when the
 * account has no message in that chat, or the id is not a personal chat id: a URL naming a group
 * id, a status broadcast or another account's chat is "not found", never an empty thread.
 *
 * Read only, like everything in this file. Replying is `sendPersonalChatMessage` (server/actions/chat.ts).
 */
export async function getPersonalChatThread(accountId: string, chatId: string, limit = THREAD_LIMIT): Promise<PersonalChatThread | null> {
  if (!isPersonalChatId(chatId)) return null;
  // The scoped client: another project's account is not found.
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId }, select: { id: true, label: true, status: true, phoneNumber: true } });
  if (!account) return null;

  const where = { accountId: account.id, chatId, groupId: null };
  const [windowed, queued, named, review] = await Promise.all([
    prisma.message.findMany({ where, orderBy: [{ timestampWa: "desc" }, { id: "desc" }], take: limit + 1, select: THREAD_MESSAGE_SELECT }),
    prisma.outboundMessage.findMany({ where: { chatId, accountId: account.id }, orderBy: { createdAt: "desc" }, take: limit, select: QUEUED_SELECT }),
    prisma.message.findFirst({
      where: { ...where, direction: "INCOMING", AND: [{ senderName: { not: null } }, { senderName: { not: "" } }] },
      orderBy: { timestampWa: "desc" },
      select: { senderName: true },
    }),
    prisma.personalChatReview.findFirst({ where: { accountId: account.id, chatId }, select: { reviewedAt: true } }),
  ]);
  if (windowed.length === 0) return null;

  const hasMore = windowed.length > limit;
  const messages = hasMore ? windowed.slice(0, limit) : windowed;
  return {
    chat: {
      id: personalConversationKey(chatId),
      chatId,
      name: named?.senderName || personalChatFallbackName(chatId),
      accountId: account.id,
      accountLabel: account.label,
      accountPhone: account.phoneNumber,
      accountStatus: account.status,
      reviewedAt: review?.reviewedAt ?? null,
    },
    entries: await buildThreadEntries(account.id, messages, queued, null),
    hasMore,
  };
}
