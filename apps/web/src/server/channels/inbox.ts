import { matchKey, searchWhatsAppMessages, type MessageSearchResult } from "@/server/whatsAppMessageSearch";
import {
  INBOX_RECENT_HOURS,
  UPSET_MOOD_LEVEL, channelStatusOf, channelStorageOf, type ConversationStatus } from "@support-automation/shared";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { Prisma } from "@prisma/client";
import {
  CHANNELS,
  channelBySlug,
  decideReplyWindow,
  type ChannelAttachment,
  type ChannelContentType,
  type ChannelDeliveryStatus,
  type ChannelType,
  type InboxScope,
  EMPTY_INBOX_FILTERS,
  INBOX_VIEW_KEYS,
  priorityFilterOf,
  type ConversationPriorityValue,
  type ConversationRef,
  type InboxFilterSet,
  type InboxViewKey,
  type InboxWithinKey,
  LEGACY_WHATSAPP_LABEL,
  orderInboxItems,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { getChatAccounts, getChatConversations, getChatInbox, type ConversationSummary } from "@/server/chatInbox";
import { conversationPath } from "@/lib/chatConversationType";

/**
 * The unified inbox (OMNICHANNEL.md §4, §12): every conversation from every connected channel in one
 * list, and each channel's own list, read from where each channel's messages already live.
 *
 * Nothing is copied. WhatsApp conversations come from the WhatsApp Chat inbox's own reader
 * (`getChatInbox` / `getChatConversations` in server/chatInbox.ts), so "waiting", "seen" and the
 * 300-row window mean exactly what they mean there; Messenger, Instagram and Telegram come from
 * `ChannelConversation`. The two are merged by latest activity. A WhatsApp row links to the WhatsApp
 * Chat thread — the WhatsApp module, unchanged, is still the only place a WhatsApp reply is sent from.
 *
 * Everything is read through the project-scoped client or with `"projectId"` named in raw SQL, so
 * another project's conversations cannot appear.
 */

/** What is rendered at most. Search reaches past it (see `loadInbox`'s `search`). */
export const INBOX_LIMIT = 300;

export type InboxChannel = "WHATSAPP" | ChannelType;
export type InboxView = InboxViewKey;
export const INBOX_VIEWS: readonly InboxView[] = INBOX_VIEW_KEYS;
export type InboxWithin = InboxWithinKey | null;

export function isInboxView(value: unknown): value is InboxView {
  return typeof value === "string" && (INBOX_VIEWS as readonly string[]).includes(value);
}

export interface InboxItem {
  /** Unique across channels: `wa:<account>:<conversation>` or `ch:<conversation>`. */
  key: string;
  /** The conversation, for the workspace panel and bulk actions (INBOX_WORKSPACE.md). */
  ref: ConversationRef;
  channel: InboxChannel;
  /** Project-relative. */
  href: string;
  title: string;
  /** Which number / Page / account / bot it came in on. */
  via: string;
  /** `wa:<account>` or `ch:<connection>` — the account filter's value. */
  accountKey: string;
  preview: string | null;
  lastMessageAt: string | null;
  lastMessageOutgoing: boolean;
  /** A customer message nobody has answered and nobody has opened since it arrived. */
  unread: boolean;
  /** A customer message nobody has answered (opened or not). */
  needsReply: boolean;
  /** Inbox V3: when the customer started waiting (first message after our last reply), for rows that need a reply. */
  waitingSince: string | null;
  isGroup: boolean;
  status: "OPEN" | "CLOSED";
  /** Inbox V3 status (UNIFIED_INBOX_V3 on), or null while it is off. */
  lifecycleStatus: ConversationStatus | null;
  /** Channel: the assigned user. WhatsApp group: its owner (team member) from the Groups page. */
  assigneeName: string | null;
  assignedToMe: boolean;
  teamName: string | null;
  priority: ConversationPriorityValue;
  tags: string[];
  aiOn: boolean;
  /** The newest reply we sent failed (or its outcome is unknown). */
  lastSendFailed: boolean;
  /** Why replies cannot go out from here right now, if they cannot (a disconnected channel…). */
  connectionProblem: string | null;
  /** Inbox V3 message search: the newest message in this conversation whose text matched the search. */
  messageMatch?: { snippet: string; at: string; messageId: string };
}

/** Inbox V3 message search, as the list reports it (whatsAppMessageSearch.ts). */
export interface MessageSearchInfo {
  /** Cursor for "More message matches", or null when there are none. */
  nextCursor: string | null;
  /** The search ran out of time and returned nothing; narrow it. */
  timedOut: boolean;
  /** The term is too short to search message text (name search still ran). */
  tooShort: boolean;
  /** Conversations on this page whose message text matched. */
  matched: number;
  /** As many matches were shown as paging allows; narrow the search to go further. */
  limitReached: boolean;
}

const searchInfo = (r: MessageSearchResult): MessageSearchInfo => ({ nextCursor: r.nextCursor, timedOut: r.timedOut, tooShort: r.tooShort, matched: r.matches.size, limitReached: r.limitReached });

function withMatches(items: InboxItem[], search: MessageSearchResult | null): InboxItem[] {
  if (!search?.matches.size) return items;
  return items.map((i) => {
    const m = i.ref.kind === "whatsapp" ? search.matches.get(matchKey(i.ref.accountId, i.ref.chatId)) : undefined;
    return m ? { ...i, messageMatch: { snippet: m.snippet, at: m.at.toISOString(), messageId: m.messageId } } : i;
  });
}

export interface InboxCounts {
  all: number;
  unread: number;
  needsReply: number;
  mine: number;
  closed: number;
  byChannel: Record<InboxChannel, number>;
}

const WITHIN_MS: Record<InboxWithinKey, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export function isInboxWithin(value: unknown): value is InboxWithinKey {
  return value === "24h" || value === "7d" || value === "30d";
}

// ─── Messenger / Instagram / Telegram ─────────────────────────────────────────────────────────

interface ChannelRow {
  id: string;
  type: ChannelType;
  kind: "DIRECT" | "GROUP";
  title: string | null;
  customerName: string | null;
  customerUsername: string | null;
  externalThreadId: string;
  status: "OPEN" | "CLOSED" | "PENDING" | "SNOOZED";
  assignedUserId: string | null;
  assigneeName: string | null;
  teamName: string | null;
  priority: ConversationPriorityValue;
  tags: string[];
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  connectionId: string;
  connectionName: string;
  connectionStatus: string;
  connectionEnabled: boolean;
  aiAutomationEnabled: boolean;
  needsReply: boolean;
  unread: boolean;
  lastSendFailed: boolean;
  waitingSince: Date | null;
}

/**
 * A conversation needs a reply when the customer's newest message has no answer after it. An answer
 * is any outbound message — a person here, AI, or someone in the provider's own app — except one that
 * FAILED, because a failed send means the customer received nothing.
 */
const NEEDS_REPLY_SQL = Prisma.sql`(c."lastInboundAt" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "ChannelMessage" m
  WHERE m."projectId" = c."projectId" AND m."conversationId" = c."id" AND m."direction" = 'OUTBOUND'
    AND m."occurredAt" >= c."lastInboundAt" AND m."deliveryStatus" IS DISTINCT FROM 'FAILED'))`;

type ListOpts = { types: ChannelType[]; filters: InboxFilterSet; viewerId: string; now: Date; lifecycle: boolean };

/**
 * Which channel conversations the default views list. Inbox V3 on: the active ones, Open and Pending (Snoozed
 * and Resolved have their own status filter). Off: anything not CLOSED — a conversation left Pending or Snoozed
 * while the feature was on is still open here, never hidden.
 */
const activeChannelSql = (lifecycle: boolean) => (lifecycle ? Prisma.sql`c."status"::text IN ('OPEN', 'PENDING')` : Prisma.sql`c."status"::text <> 'CLOSED'`);

function channelFilters(opts: ListOpts): Prisma.Sql {
  const f = opts.filters;
  const parts: Prisma.Sql[] = [Prisma.sql`c."type"::text IN (${Prisma.join(opts.types)})`];
  if (opts.lifecycle && f.status) parts.push(Prisma.sql`c."status"::text = ${channelStorageOf(f.status)}`);
  else parts.push(f.view === "closed" ? Prisma.sql`c."status" = 'CLOSED'` : activeChannelSql(opts.lifecycle));
  if (f.view === "unread") parts.push(Prisma.sql`${NEEDS_REPLY_SQL} AND (c."reviewedAt" IS NULL OR c."reviewedAt" < c."lastInboundAt")`);
  if (f.view === "needs-reply") parts.push(NEEDS_REPLY_SQL);
  if (f.view === "mine") parts.push(Prisma.sql`c."assignedUserId" = ${opts.viewerId}`);
  if (f.view === "unassigned") parts.push(Prisma.sql`c."assignedUserId" IS NULL AND c."assignedTeamId" IS NULL`);
  const priorities = priorityFilterOf(f.view);
  if (priorities) parts.push(Prisma.sql`l."priority"::text IN (${Prisma.join(priorities)})`);
  if (f.tag) parts.push(Prisma.sql`${f.tag} = ANY(l."tags")`);
  if (f.teamId) parts.push(Prisma.sql`c."assignedTeamId" = ${f.teamId}`);
  if (f.assigneeId) parts.push(Prisma.sql`c."assignedUserId" = ${f.assigneeId}`);
  if (f.account) parts.push(f.account.startsWith("ch:") ? Prisma.sql`c."connectionId" = ${f.account.slice(3)}` : Prisma.sql`false`);
  if (f.within) parts.push(Prisma.sql`c."lastMessageAt" >= ${new Date(opts.now.getTime() - WITHIN_MS[f.within])}`);
  if (opts.lifecycle && f.lastSender) parts.push(Prisma.sql`c."lastMessageDirection"::text = ${f.lastSender === "customer" ? "INBOUND" : "OUTBOUND"}`);
  // Mood is read in WhatsApp groups only, so no channel conversation can match.
  if (f.mood) parts.push(Prisma.sql`false`);
  // "AI is handling": the newest message is the AI's own reply (keyed ai:<message id>; a survey or a person's reply is not), not failed.
  if (f.view === "ai") {
    parts.push(Prisma.sql`c."lastMessageAt" >= ${new Date(opts.now.getTime() - INBOX_RECENT_HOURS * 3_600_000)} AND EXISTS (
      SELECT 1 FROM (
        SELECT m."idempotencyKey", m."deliveryStatus" FROM "ChannelMessage" m
        WHERE m."projectId" = c."projectId" AND m."conversationId" = c."id"
        ORDER BY m."occurredAt" DESC, m."id" DESC LIMIT 1
      ) newest WHERE newest."idempotencyKey" LIKE 'ai:%' AND newest."deliveryStatus"::text <> 'FAILED')`);
  }
  const term = f.search;
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    parts.push(Prisma.sql`(c."title" ILIKE ${like} OR c."customerName" ILIKE ${like} OR c."customerUsername" ILIKE ${like} OR c."lastMessagePreview" ILIKE ${like}
      OR EXISTS (SELECT 1 FROM "ChannelMessage" s WHERE s."projectId" = c."projectId" AND s."conversationId" = c."id" AND s."text" ILIKE ${like}))`);
  }
  return Prisma.join(parts, " AND ");
}

/**
 * Inbox V3 triage order, applied in SQL so the 300-row limit keeps the rows the order puts first (the longest waits
 * under "waiting"). The merged list is ordered again by orderInboxItems; both break ties the same way.
 */
function channelOrder(opts: ListOpts): Prisma.Sql {
  const sort = opts.lifecycle ? opts.filters.sort : null;
  if (sort === "oldest") return Prisma.sql`c."lastMessageAt" ASC NULLS LAST, c."id"`;
  if (sort === "waiting") return Prisma.sql`"needsReply" DESC, "waitingSince" ASC NULLS LAST, c."lastMessageAt" DESC NULLS LAST, c."id"`;
  return Prisma.sql`c."lastMessageAt" DESC NULLS LAST, c."id"`;
}

async function loadChannelRows(opts: ListOpts): Promise<ChannelRow[]> {
  if (opts.types.length === 0) return [];
  const projectId = await activeProjectId();
  return prisma.$queryRaw<ChannelRow[]>`
    SELECT c."id", c."type"::text AS "type", c."kind"::text AS "kind", c."title", c."customerName", c."customerUsername", c."externalThreadId",
           c."status"::text AS "status", c."assignedUserId", u."name" AS "assigneeName", t."name" AS "teamName",
           COALESCE(l."priority"::text, 'NONE') AS "priority", COALESCE(l."tags", ARRAY[]::text[]) AS "tags",
           c."lastMessageAt", c."lastMessagePreview", c."lastMessageDirection"::text AS "lastMessageDirection",
           c."connectionId", conn."name" AS "connectionName", conn."status"::text AS "connectionStatus", conn."enabled" AS "connectionEnabled", conn."aiAutomationEnabled",
           ${NEEDS_REPLY_SQL} AS "needsReply",
           CASE WHEN ${NEEDS_REPLY_SQL} THEN COALESCE((
             SELECT min(w."occurredAt") FROM "ChannelMessage" w
             WHERE w."projectId" = c."projectId" AND w."conversationId" = c."id" AND w."direction" = 'INBOUND'
               AND w."occurredAt" > COALESCE((
                 SELECT o."occurredAt" FROM "ChannelMessage" o
                 WHERE o."projectId" = c."projectId" AND o."conversationId" = c."id" AND o."direction" = 'OUTBOUND' AND o."deliveryStatus" IS DISTINCT FROM 'FAILED'
                 ORDER BY o."occurredAt" DESC LIMIT 1), '-infinity'::timestamp)
           ), c."lastInboundAt") END AS "waitingSince",
           (${NEEDS_REPLY_SQL} AND (c."reviewedAt" IS NULL OR c."reviewedAt" < c."lastInboundAt")) AS "unread",
           COALESCE((SELECT f."deliveryStatus"::text IN ('FAILED', 'UNKNOWN') FROM "ChannelMessage" f
             WHERE f."projectId" = c."projectId" AND f."conversationId" = c."id" AND f."direction" = 'OUTBOUND'
             ORDER BY f."occurredAt" DESC LIMIT 1), false) AS "lastSendFailed"
    FROM "ChannelConversation" c
    JOIN "ChannelConnection" conn ON conn."id" = c."connectionId" AND conn."projectId" = c."projectId"
    LEFT JOIN "User" u ON u."id" = c."assignedUserId"
    LEFT JOIN "Team" t ON t."id" = c."assignedTeamId" AND t."projectId" = c."projectId"
    LEFT JOIN "ConversationLabel" l ON l."channelConversationId" = c."id" AND l."projectId" = c."projectId"
    WHERE c."projectId" = ${projectId} AND ${channelFilters(opts)}
    ORDER BY ${channelOrder(opts)}
    LIMIT ${INBOX_LIMIT}`;
}

export function connectionProblem(row: { connectionStatus: string; connectionEnabled: boolean; connectionName: string }): string | null {
  if (row.connectionStatus === "DISCONNECTED") return `${row.connectionName} is disconnected. Reconnect it under Settings → Messaging Channels to reply.`;
  if (row.connectionStatus === "NEEDS_RECONNECT") return `${row.connectionName} needs new credentials before replies can be sent (Settings → Messaging Channels).`;
  if (!row.connectionEnabled) return `${row.connectionName} is switched off, so nothing can be sent from it.`;
  return null;
}

export function channelConversationTitle(row: { title: string | null; customerName: string | null; customerUsername: string | null; externalThreadId: string; type: ChannelType }): string {
  return row.title ?? row.customerName ?? (row.customerUsername ? `@${row.customerUsername}` : `${CHANNELS[row.type].label} user ${row.externalThreadId.slice(-6)}`);
}

function fromChannelRow(row: ChannelRow, scope: InboxScope, viewerId: string, lifecycle: boolean): InboxItem {
  return {
    key: `ch:${row.id}`,
    ref: { kind: "channel", conversationId: row.id },
    channel: row.type,
    href: `/conversations/${scope}/c/${row.id}`,
    title: channelConversationTitle(row),
    via: row.connectionName,
    accountKey: `ch:${row.connectionId}`,
    preview: row.lastMessagePreview,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessageOutgoing: row.lastMessageDirection === "OUTBOUND",
    unread: row.unread,
    needsReply: row.needsReply,
    waitingSince: lifecycle ? (row.waitingSince?.toISOString() ?? null) : null,
    isGroup: row.kind === "GROUP",
    // Inbox V3 may store PENDING / SNOOZED; for this view anything not CLOSED is open, as before.
    status: row.status === "CLOSED" ? "CLOSED" : "OPEN",
    lifecycleStatus: lifecycle ? channelStatusOf(row.status) : null,
    assigneeName: row.assigneeName,
    assignedToMe: row.assignedUserId === viewerId,
    teamName: row.teamName,
    priority: row.priority,
    tags: row.tags,
    aiOn: row.aiAutomationEnabled && row.kind === "DIRECT",
    lastSendFailed: row.lastSendFailed,
    connectionProblem: connectionProblem(row),
  };
}

async function channelCounts(types: ChannelType[], viewerId: string, lifecycle: boolean): Promise<Omit<InboxCounts, "byChannel"> & { byChannel: Partial<Record<InboxChannel, number>> }> {
  const empty = { all: 0, unread: 0, needsReply: 0, mine: 0, closed: 0, byChannel: {} };
  if (types.length === 0) return empty;
  const projectId = await activeProjectId();
  const rows = await prisma.$queryRaw<Array<{ type: ChannelType; all: bigint; unread: bigint; needsReply: bigint; mine: bigint; closed: bigint }>>`
    SELECT c."type"::text AS "type",
      COUNT(*) FILTER (WHERE ${activeChannelSql(lifecycle)}) AS "all",
      COUNT(*) FILTER (WHERE ${activeChannelSql(lifecycle)} AND ${NEEDS_REPLY_SQL} AND (c."reviewedAt" IS NULL OR c."reviewedAt" < c."lastInboundAt")) AS "unread",
      COUNT(*) FILTER (WHERE ${activeChannelSql(lifecycle)} AND ${NEEDS_REPLY_SQL}) AS "needsReply",
      COUNT(*) FILTER (WHERE ${activeChannelSql(lifecycle)} AND c."assignedUserId" = ${viewerId}) AS "mine",
      COUNT(*) FILTER (WHERE c."status" = 'CLOSED') AS "closed"
    FROM "ChannelConversation" c
    WHERE c."projectId" = ${projectId} AND c."type"::text IN (${Prisma.join(types)})
    GROUP BY c."type"`;
  const out = { ...empty, byChannel: {} as Partial<Record<InboxChannel, number>> };
  for (const r of rows) {
    out.all += Number(r.all);
    out.unread += Number(r.unread);
    out.needsReply += Number(r.needsReply);
    out.mine += Number(r.mine);
    out.closed += Number(r.closed);
    out.byChannel[r.type] = Number(r.all);
  }
  return out;
}

// ─── WhatsApp, through WhatsApp Chat's own reader ─────────────────────────────────────────────

interface GroupOwner {
  name: string;
  userId: string | null;
  teamName: string | null;
}

function fromWhatsApp(
  c: ConversationSummary,
  owners: ReadonlyMap<string, GroupOwner>,
  labels: ReadonlyMap<string, { priority: ConversationPriorityValue; tags: string[] }>,
  viewerId: string,
  states: ReadonlyMap<string, WhatsAppStateView> | null,
): InboxItem {
  const state = states?.get(`${c.accountId}|${c.chatId}`);
  // Inbox V3: a person or Team assigned to the conversation itself comes before the group's owner.
  const owner = state && (state.userId || state.teamName) ? { name: state.userName ?? "", userId: state.userId, teamName: state.teamName } : c.kind === "GROUP" ? owners.get(c.id) : undefined;
  const label = labels.get(`${c.accountId}|${c.chatId}`);
  return {
    key: `wa:${c.accountId}:${c.id}`,
    ref: { kind: "whatsapp", accountId: c.accountId, chatId: c.chatId },
    channel: "WHATSAPP",
    href: conversationPath(c.accountId, c),
    title: c.name,
    via: c.accountLabel,
    accountKey: `wa:${c.accountId}`,
    preview: c.lastMessagePreview,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessageOutgoing: c.lastMessageOutgoing,
    unread: c.awaitingReply,
    needsReply: c.isUnanswered,
    waitingSince: null,
    isGroup: c.kind === "GROUP",
    status: "OPEN",
    lifecycleStatus: states ? (state?.status ?? "OPEN") : null,
    assigneeName: owner?.name ?? null,
    assignedToMe: Boolean(owner?.userId && owner.userId === viewerId),
    teamName: owner?.teamName ?? null,
    priority: label?.priority ?? "NONE",
    tags: label?.tags ?? [],
    aiOn: c.aiAutomationEnabled,
    lastSendFailed: false,
    connectionProblem: null,
  };
}

/** WhatsApp groups whose assigned team member is linked to this login (the explicit userId link only). */
async function whatsAppGroupsAssignedTo(viewerId: string): Promise<Set<string>> {
  const rows = await prisma.whatsAppGroup.findMany({ where: { isActive: true, assignedTeamMember: { userId: viewerId } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/**
 * The chat ids, per account, that the label / assignment filters allow — decided over EVERY
 * conversation in the project before the WhatsApp ranker applies its 300-row window. `include` null
 * means "no restriction"; `exclude` removes chats (Unassigned = every chat but owned groups).
 *
 * WhatsApp ownership is the group's owner (`WhatsAppGroup.assignedTeamMember`, set on the Groups page
 * and recorded in GroupResponsibilityChange for the Team Report); personal chats have no owner. The
 * inbox only reads it — no second assignment for WhatsApp exists.
 */
/** Groups where a customer's newest mood reading in the last day is frustrated or worse, per account's copy. */
async function upsetChats(accountIds: string[], now: Date): Promise<Array<{ accountId: string; chatId: string }>> {
  if (accountIds.length === 0) return [];
  const since = new Date(now.getTime() - INBOX_RECENT_HOURS * 3_600_000);
  return prisma.$queryRaw<Array<{ accountId: string; chatId: string }>>`
    SELECT DISTINCT r."accountId", r."whatsappGroupId" AS "chatId" FROM (
      SELECT DISTINCT ON (e."accountId", e."whatsappGroupId", e."customerKey") e."accountId", e."whatsappGroupId", e."level"
      FROM "CustomerMoodEvent" e
      WHERE e."projectId" = ${await activeProjectId()} AND e."accountId" IN (${Prisma.join(accountIds)}) AND e."messageAt" >= ${since}
      ORDER BY e."accountId", e."whatsappGroupId", e."customerKey", e."messageAt" DESC, e."id" DESC
    ) r WHERE r."level" >= ${UPSET_MOOD_LEVEL}`;
}

/**
 * "AI is handling" on WhatsApp: in the last day the AI answered a customer's message, its reply did not fail, and
 * nothing has been said in that chat since except that reply's own echo. A person replying, or the customer writing
 * again, ends it (until the AI answers that message too).
 */
async function aiHandledChats(accountIds: string[], now: Date): Promise<Array<{ accountId: string; chatId: string }>> {
  if (accountIds.length === 0) return [];
  const projectId = await activeProjectId();
  const since = new Date(now.getTime() - INBOX_RECENT_HOURS * 3_600_000);
  return prisma.$queryRaw<Array<{ accountId: string; chatId: string }>>`
    SELECT DISTINCT m."accountId", m."chatId"
    FROM "AiFallbackDecision" d
    JOIN "Message" m ON m."id" = d."messageId" AND m."projectId" = ${projectId}
    WHERE d."projectId" = ${projectId} AND d."outcome" = 'AI_REPLIED' AND d."createdAt" >= ${since} AND m."accountId" IN (${Prisma.join(accountIds)})
      AND NOT EXISTS (
        SELECT 1 FROM "OutboundMessage" f
        WHERE f."projectId" = ${projectId} AND f."relatedMessageId" = m."id" AND f."status" = 'FAILED')
      AND NOT EXISTS (
        SELECT 1 FROM "Message" n
        WHERE n."projectId" = ${projectId} AND n."accountId" = m."accountId" AND n."chatId" = m."chatId" AND n."timestampWa" > m."timestampWa"
          AND NOT EXISTS (
            SELECT 1 FROM "OutboundMessage" o
            WHERE o."projectId" = ${projectId} AND o."relatedMessageId" = m."id" AND o."providerMessageId" = n."whatsappMessageId"))`;
}

async function whatsAppChatRestriction(accountIds: string[], f: InboxFilterSet, viewerId: string, lifecycle = false, now: Date = new Date()): Promise<{ include: Map<string, Set<string>> | null; exclude: Map<string, Set<string>> }> {
  const toMap = (rows: Array<{ accountId: string | null; chatId: string | null }>) => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) if (r.accountId && r.chatId) (m.get(r.accountId) ?? m.set(r.accountId, new Set()).get(r.accountId)!).add(r.chatId);
    return m;
  };
  const groupsWhere = (where: Prisma.WhatsAppGroupWhereInput) =>
    prisma.whatsAppGroup
      .findMany({ where: { accountId: { in: accountIds }, isActive: true, ...where }, select: { accountId: true, whatsappGroupId: true } })
      .then((rows) => toMap(rows.map((r) => ({ accountId: r.accountId, chatId: r.whatsappGroupId }))));

  const includes: Map<string, Set<string>>[] = [];
  if (f.mood === "upset") includes.push(toMap(await upsetChats(accountIds, now)));
  if (f.view === "ai") includes.push(toMap(await aiHandledChats(accountIds, now)));
  const priorities = priorityFilterOf(f.view);
  if (priorities || f.tag) {
    const rows = await prisma.conversationLabel.findMany({
      where: { channelConversationId: null, accountId: { in: accountIds }, ...(priorities ? { priority: { in: priorities } } : {}), ...(f.tag ? { tags: { has: f.tag } } : {}) },
      select: { accountId: true, chatId: true },
    });
    includes.push(toMap(rows));
  }
  // Inbox V3: a conversation's own state (status, person, Team), read for the whole project before the ranker.
  const statesWhere = (where: Prisma.WhatsAppConversationStateWhereInput) =>
    prisma.whatsAppConversationState.findMany({ where: { accountId: { in: accountIds }, ...where }, select: { accountId: true, chatId: true } }).then(toMap);
  const union = (a: Map<string, Set<string>>, b: Map<string, Set<string>>) => {
    for (const [k, set] of b) for (const id of set) (a.get(k) ?? a.set(k, new Set()).get(k)!).add(id);
    return a;
  };
  const owned = async (groupWhere: Prisma.WhatsAppGroupWhereInput, stateWhere: Prisma.WhatsAppConversationStateWhereInput) =>
    lifecycle ? union(await groupsWhere(groupWhere), await statesWhere(stateWhere)) : groupsWhere(groupWhere);
  if (f.view === "mine") includes.push(await owned({ assignedTeamMember: { userId: viewerId } }, { assignedUserId: viewerId }));
  if (f.assigneeId) includes.push(await owned({ assignedTeamMember: { userId: f.assigneeId } }, { assignedUserId: f.assigneeId }));
  if (f.teamId) includes.push(await owned({ assignedTeamMember: { teamId: f.teamId } }, { assignedTeamId: f.teamId }));
  let exclude =
    f.view === "unassigned"
      ? await owned({ assignedTeamMemberId: { not: null } }, { OR: [{ assignedUserId: { not: null } }, { assignedTeamId: { not: null } }] })
      : new Map<string, Set<string>>();
  if (lifecycle) {
    const wanted = f.status ?? (f.view === "closed" ? "RESOLVED" : null);
    if (wanted && wanted !== "OPEN") includes.push(await statesWhere({ status: wanted }));
    else exclude = union(exclude, await statesWhere({ status: { in: wanted === "OPEN" ? ["PENDING", "SNOOZED", "RESOLVED"] : ["SNOOZED", "RESOLVED"] } }));
  }

  if (includes.length === 0) return { include: null, exclude };
  // Every include filter must hold: intersect per account.
  const include = new Map<string, Set<string>>();
  for (const accountId of accountIds) {
    const [first, ...rest] = includes.map((m) => m.get(accountId) ?? new Set<string>());
    include.set(accountId, new Set([...first!].filter((chatId) => rest.every((s) => s.has(chatId)))));
  }
  return { include, exclude };
}

interface WhatsAppStateView {
  status: ConversationStatus;
  userId: string | null;
  userName: string | null;
  teamName: string | null;
}

async function decorateWhatsApp(list: ConversationSummary[], viewerId: string, lifecycle: boolean): Promise<InboxItem[]> {
  if (list.length === 0) return [];
  const groupIds = list.filter((c) => c.kind === "GROUP").map((c) => c.id);
  const accountIds = [...new Set(list.map((c) => c.accountId))];
  const chatIds = [...new Set(list.map((c) => c.chatId))];
  const [groups, labelRows] = await Promise.all([
    groupIds.length
      ? prisma.whatsAppGroup.findMany({
          where: { id: { in: groupIds }, assignedTeamMemberId: { not: null } },
          select: { id: true, assignedTeamMember: { select: { name: true, userId: true, team: { select: { name: true } } } } },
        })
      : [],
    prisma.conversationLabel.findMany({
      where: { channelConversationId: null, accountId: { in: accountIds }, chatId: { in: chatIds } },
      select: { accountId: true, chatId: true, priority: true, tags: true },
    }),
  ]);
  const owners = new Map<string, GroupOwner>();
  for (const g of groups) if (g.assignedTeamMember) owners.set(g.id, { name: g.assignedTeamMember.name, userId: g.assignedTeamMember.userId, teamName: g.assignedTeamMember.team?.name ?? null });
  const labels = new Map(labelRows.map((l) => [`${l.accountId}|${l.chatId}`, { priority: l.priority, tags: l.tags }]));
  let states: Map<string, WhatsAppStateView> | null = null;
  if (lifecycle) {
    const rows = await prisma.whatsAppConversationState.findMany({
      where: { accountId: { in: accountIds }, chatId: { in: chatIds } },
      select: { accountId: true, chatId: true, status: true, assignedUserId: true, assignedUser: { select: { name: true } }, assignedTeam: { select: { name: true } } },
    });
    states = new Map(rows.map((r) => [`${r.accountId}|${r.chatId}`, { status: r.status, userId: r.assignedUserId, userName: r.assignedUser?.name ?? null, teamName: r.assignedTeam?.name ?? null }]));
  }
  const waits = lifecycle ? await whatsAppWaitingSince(list.filter((c) => c.isUnanswered)) : new Map<string, Date>();
  return list.map((c) => {
    const item = fromWhatsApp(c, owners, labels, viewerId, states);
    const since = waits.get(`${c.accountId}|${c.chatId}`);
    return since ? { ...item, waitingSince: since.toISOString() } : item;
  });
}

/**
 * Inbox V3: when each unanswered WhatsApp conversation started waiting — its first customer message after our last
 * reply (an outgoing message or a team member's), the First Response definition. A group counts a reply from any of
 * our numbers; a personal chat only its own account's. One probe per listed row, on the (chatId, timestampWa) index.
 */
async function whatsAppWaitingSince(list: ConversationSummary[]): Promise<Map<string, Date>> {
  if (list.length === 0) return new Map();
  const projectId = await activeProjectId();
  const values = Prisma.join(list.map((c) => Prisma.sql`(${c.accountId}, ${c.chatId}, ${c.kind !== "GROUP"})`));
  const rows = await prisma.$queryRaw<Array<{ accountId: string; chatId: string; since: Date | null }>>`
    SELECT v."accountId", v."chatId", w."since"
    FROM (VALUES ${values}) AS v("accountId", "chatId", "personal")
    CROSS JOIN LATERAL (
      SELECT min(m."timestampWa") AS "since" FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."chatId" = v."chatId" AND (NOT v."personal" OR m."accountId" = v."accountId")
        AND m."direction" = 'INCOMING' AND NOT m."isFromTeamMember"
        AND m."timestampWa" > COALESCE((
          SELECT r."timestampWa" FROM "Message" r
          WHERE r."projectId" = ${projectId} AND r."chatId" = v."chatId" AND (NOT v."personal" OR r."accountId" = v."accountId")
            AND (r."direction" = 'OUTGOING' OR r."isFromTeamMember")
          ORDER BY r."timestampWa" DESC LIMIT 1), '-infinity'::timestamp)
    ) w`;
  return new Map(rows.filter((r) => r.since).map((r) => [`${r.accountId}|${r.chatId}`, r.since!]));
}

async function loadWhatsApp(opts: { filters: InboxFilterSet; viewerId: string; now: Date; lifecycle: boolean }) {
  const f = opts.filters;
  const all = await getChatAccounts();
  const mine = await whatsAppGroupsAssignedTo(opts.viewerId);
  const countsOf = () => Promise.all(all.map((a) => getChatInbox(a.id).then((i) => i.counts)));
  // Closed is a channel state; WhatsApp conversations have none. A channel account filter excludes WhatsApp.
  // Without Inbox V3, closed is a channel state and WhatsApp has none. A channel account filter excludes WhatsApp.
  if ((f.view === "closed" && !opts.lifecycle) || f.account?.startsWith("ch:")) return { items: [] as InboxItem[], counts: sumWhatsApp(await countsOf(), mine.size) };

  const accounts = f.account ? all.filter((a) => `wa:${a.id}` === f.account) : all;
  const restriction = await whatsAppChatRestriction(
    accounts.map((a) => a.id),
    f,
    opts.viewerId,
    opts.lifecycle,
    opts.now,
  );
  const state = whatsAppState(f, opts.lifecycle);
  // Inbox V3: also the chats whose message TEXT matches, over the whole history, one bounded page (whatsAppMessageSearch.ts).
  const bodySearch = opts.lifecycle && f.search ? await searchWhatsAppMessages(accounts.map((a) => a.id), f.search) : null;
  const plain = restriction.include === null && restriction.exclude.size === 0 && !state && !f.search;

  const list: ConversationSummary[] = [];
  const counts: Array<{ total: number; waiting: number; seenUnanswered: number }> = [];
  for (const account of all) {
    const inbox = await getChatInbox(account.id);
    counts.push(inbox.counts);
    if (!accounts.some((a) => a.id === account.id)) continue;
    if (plain) {
      list.push(...inbox.conversations);
      if (opts.lifecycle && f.sort === "waiting") {
        const listed = new Set(inbox.conversations.map((c) => c.id));
        const waiting = await getChatConversations(account.id, { view: { kind: "chats" as const, chatIds: null, state: "unanswered" } });
        list.push(...waiting.filter((c) => !listed.has(c.id)));
      }
      continue;
    }
    const include = restriction.include?.get(account.id);
    const exclude = restriction.exclude.get(account.id);
    const view =
      restriction.include !== null
        ? { kind: "chats" as const, chatIds: [...(include ?? [])].filter((id) => !exclude?.has(id)), state }
        : exclude?.size
          ? { kind: "chats" as const, chatIds: [...exclude], exclude: true, state }
          : { kind: "chats" as const, chatIds: null, state };
    const byName = await getChatConversations(account.id, { search: f.search || undefined, view });
    list.push(...byName);
    const seen = new Set(byName.map((c) => c.chatId));
    const textChats = textMatchChats(bodySearch, account.id, restriction, seen);
    if (textChats.length) list.push(...(await getChatConversations(account.id, { view: { kind: "chats" as const, chatIds: textChats, state } })));
  }
  const within = f.within ? opts.now.getTime() - WITHIN_MS[f.within] : null;
  const items = await decorateWhatsApp(
    list.filter((c) => (within === null || (c.lastMessageAt && c.lastMessageAt.getTime() >= within)) && keepForLastSender(f, opts.lifecycle)(c)),
    opts.viewerId,
    opts.lifecycle,
  );
  return { items: withMatches(items, bodySearch), counts: sumWhatsApp(counts, mine.size), messageSearch: bodySearch ? searchInfo(bodySearch) : null };
}

/** The text-matched chats of one account that the list's other filters allow, minus those already listed. */
function textMatchChats(search: MessageSearchResult | null, accountId: string, restriction: Awaited<ReturnType<typeof whatsAppChatRestriction>>, seen: Set<string>): string[] {
  if (!search) return [];
  const include = restriction.include?.get(accountId);
  const exclude = restriction.exclude.get(accountId);
  const out: string[] = [];
  for (const m of search.matches.values()) {
    if (m.accountId !== accountId || seen.has(m.chatId) || exclude?.has(m.chatId)) continue;
    if (restriction.include !== null && !include?.has(m.chatId)) continue;
    out.push(m.chatId);
  }
  return out;
}

/**
 * Inbox V3: the next page of WhatsApp conversations whose message text matches (the list's "More message
 * matches"). The same filters and restriction as the list; only text matches, never name matches or channel rows,
 * which the first page already returned. Empty with the feature off.
 */
export async function loadMoreMessageMatches(opts: { scope: InboxScope; filters: InboxFilterSet; viewerId: string; cursor: string; seen: string[]; now?: Date }): Promise<{ items: InboxItem[]; messageSearch: MessageSearchInfo | null }> {
  const f = opts.filters;
  const now = opts.now ?? new Date();
  const lifecycle = !(await activeDisabledFeatures()).has("UNIFIED_INBOX_V3");
  if (!lifecycle || !f.search || (opts.scope !== "all" && opts.scope !== "whatsapp") || f.account?.startsWith("ch:") || (f.view === "closed" && !lifecycle)) return { items: [], messageSearch: null };
  const all = await getChatAccounts();
  const accounts = f.account ? all.filter((a) => `wa:${a.id}` === f.account) : all;
  const search = await searchWhatsAppMessages(accounts.map((a) => a.id), f.search, { cursor: opts.cursor, seen: opts.seen });
  const restriction = await whatsAppChatRestriction(accounts.map((a) => a.id), f, opts.viewerId, lifecycle);
  const state = whatsAppState(f, lifecycle);
  const list: ConversationSummary[] = [];
  for (const account of accounts) {
    const chats = textMatchChats(search, account.id, restriction, new Set());
    if (chats.length) list.push(...(await getChatConversations(account.id, { view: { kind: "chats" as const, chatIds: chats, state } })));
  }
  const within = f.within ? now.getTime() - WITHIN_MS[f.within] : null;
  const items = await decorateWhatsApp(list.filter((c) => (within === null || (c.lastMessageAt && c.lastMessageAt.getTime() >= within)) && keepForLastSender(f, lifecycle)(c)), opts.viewerId, lifecycle);
  const ordered = withMatches(items, search).sort((a, b) => (b.messageMatch?.at ?? "").localeCompare(a.messageMatch?.at ?? "") || a.key.localeCompare(b.key));
  return { items: ordered, messageSearch: searchInfo(search) };
}

/**
 * The chat-inbox state a WhatsApp list asks for. "Customer spoke last" (Inbox V3) is the unanswered state — the
 * chat inbox's own definition, looked up over every conversation, not just the 300 most recent.
 */
function whatsAppState(f: InboxFilterSet, lifecycle: boolean): "waiting" | "unanswered" | undefined {
  if (f.view === "unread") return "waiting";
  if (f.view === "needs-reply" || (lifecycle && f.lastSender === "customer")) return "unanswered";
  return undefined;
}

/** Inbox V3 "we spoke last": the answered conversations (a reply, queued or sent, after the customer's last message). */
const keepForLastSender = (f: InboxFilterSet, lifecycle: boolean) => (c: ConversationSummary) => !(lifecycle && f.lastSender === "team" && c.isUnanswered);

function sumWhatsApp(counts: Array<{ total: number; waiting: number; seenUnanswered: number }>, mine: number) {
  const total = counts.reduce((n, c) => n + c.total, 0);
  return {
    all: total,
    unread: counts.reduce((n, c) => n + c.waiting, 0),
    needsReply: counts.reduce((n, c) => n + c.waiting + c.seenUnanswered, 0),
    mine,
    closed: 0,
    byChannel: { WHATSAPP: total } as Partial<Record<InboxChannel, number>>,
  };
}

// ─── The merged list ───────────────────────────────────────────────────────────────────────────

export interface InboxResult {
  items: InboxItem[];
  counts: InboxCounts;
  /** More matched than the list shows; search narrows it. */
  truncated: boolean;
  /** Inbox V3: the WhatsApp message-text search that ran with this search term, and its limits. Null otherwise. */
  messageSearch: MessageSearchInfo | null;
}

export async function loadInbox(opts: { scope: InboxScope; filters?: InboxFilterSet; viewerId: string; now?: Date }): Promise<InboxResult> {
  const asked = opts.filters ?? EMPTY_INBOX_FILTERS;
  const now = opts.now ?? new Date();
  const scopedType = channelBySlug(opts.scope);
  const types: ChannelType[] = opts.scope === "all" ? ["MESSENGER", "INSTAGRAM", "TELEGRAM", "WEBCHAT"] : scopedType ? [scopedType] : [];
  const includeWhatsApp = opts.scope === "all" || opts.scope === "whatsapp";
  const lifecycle = !(await activeDisabledFeatures()).has("UNIFIED_INBOX_V3");
  // "AI is handling" is an Inbox V3 view; a saved view holding it opens as the plain list while the feature is off.
  const filters = !lifecycle && asked.view === "ai" ? { ...asked, view: "all" as const } : asked;

  const [rows, chCounts, wa] = await Promise.all([
    loadChannelRows({ types, filters, viewerId: opts.viewerId, now, lifecycle }),
    channelCounts(types, opts.viewerId, lifecycle),
    includeWhatsApp ? loadWhatsApp({ filters, viewerId: opts.viewerId, now, lifecycle }) : Promise.resolve(null),
  ]);

  const merged = orderInboxItems([...rows.map((r) => fromChannelRow(r, opts.scope, opts.viewerId, lifecycle)), ...(wa?.items ?? [])], lifecycle ? filters.sort : null);
  const byChannel: Record<InboxChannel, number> = { WHATSAPP: 0, MESSENGER: 0, INSTAGRAM: 0, TELEGRAM: 0, WEBCHAT: 0, WHATSAPP_CLOUD: 0 };
  for (const [k, v] of Object.entries({ ...chCounts.byChannel, ...(wa?.counts.byChannel ?? {}) })) byChannel[k as InboxChannel] = v ?? 0;
  const counts: InboxCounts = {
    all: chCounts.all + (wa?.counts.all ?? 0),
    unread: chCounts.unread + (wa?.counts.unread ?? 0),
    needsReply: chCounts.needsReply + (wa?.counts.needsReply ?? 0),
    mine: chCounts.mine + (wa?.counts.mine ?? 0),
    closed: chCounts.closed,
    byChannel,
  };
  return {
    items: merged.slice(0, INBOX_LIMIT),
    counts,
    truncated: merged.length > INBOX_LIMIT || rows.length >= INBOX_LIMIT,
    messageSearch: wa && "messageSearch" in wa ? (wa.messageSearch ?? null) : null,
  };
}

/** The choices for the inbox's Team / person / account filters. */
export async function inboxFilterOptions(): Promise<{ teams: { id: string; name: string }[]; accounts: { key: string; label: string }[]; moodDetection: boolean }> {
  const [teams, waAccounts, connections] = await Promise.all([
    prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getChatAccounts(),
    prisma.channelConnection.findMany({ select: { id: true, name: true, type: true }, orderBy: { name: "asc" } }),
  ]);
  const moodDetection = Boolean((await prisma.moodDetectionSettings.findFirst({ select: { enabled: true } }))?.enabled);
  return {
    moodDetection,
    teams,
    accounts: [
      ...waAccounts.map((a) => ({ key: `wa:${a.id}`, label: `${LEGACY_WHATSAPP_LABEL} · ${a.label}` })),
      ...connections.map((c) => ({ key: `ch:${c.id}`, label: `${CHANNELS[c.type].label} · ${c.name}` })),
    ],
  };
}

// ─── One channel conversation ─────────────────────────────────────────────────────────────────

export const CHANNEL_THREAD_LIMIT = 200;

export interface ChannelThreadMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  senderType: "CUSTOMER" | "AGENT" | "AI" | "BUSINESS";
  senderName: string | null;
  /** The app user who pressed send. */
  sentBy: string | null;
  text: string | null;
  contentType: ChannelContentType;
  attachments: ChannelAttachment[];
  occurredAt: string;
  deliveryStatus: ChannelDeliveryStatus | null;
  lastError: string | null;
  messagingTag: string | null;
  aiOutcome: "REPLIED" | "HANDED_OVER" | "SKIPPED" | null;
  aiReason: string | null;
}

export interface ChannelThread {
  conversation: {
    id: string;
    type: ChannelType;
    kind: "DIRECT" | "GROUP";
    title: string;
    customerUsername: string | null;
    externalThreadId: string;
    status: "OPEN" | "CLOSED";
    assignedUserId: string | null;
    assigneeName: string | null;
    lastInboundAt: string | null;
    aiSuppressedUntil: string | null;
  };
  connection: { id: string; name: string; status: string; enabled: boolean; aiAutomationEnabled: boolean; humanAgentEnabled: boolean };
  messages: ChannelThreadMessage[];
  hasMore: boolean;
  /** Why a person cannot reply right now, or null. */
  replyBlocked: string | null;
  /** The reply will go out tagged HUMAN_AGENT (24 h–7 days after the customer's last message). */
  humanAgentReply: boolean;
}

export async function getChannelThread(conversationId: string, now: Date = new Date()): Promise<ChannelThread | null> {
  const conversation = await prisma.channelConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      type: true,
      kind: true,
      title: true,
      customerName: true,
      customerUsername: true,
      externalThreadId: true,
      status: true,
      assignedUserId: true,
      assignedUser: { select: { name: true } },
      lastInboundAt: true,
      aiSuppressedUntil: true,
      connection: { select: { id: true, name: true, status: true, enabled: true, aiAutomationEnabled: true, humanAgentEnabled: true } },
    },
  });
  if (!conversation) return null;
  const rows = await prisma.channelMessage.findMany({
    where: { conversationId },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    take: CHANNEL_THREAD_LIMIT + 1,
    select: {
      id: true,
      direction: true,
      senderType: true,
      senderName: true,
      createdBy: { select: { name: true } },
      text: true,
      contentType: true,
      attachments: true,
      occurredAt: true,
      deliveryStatus: true,
      lastError: true,
      messagingTag: true,
      aiOutcome: true,
      aiReason: true,
    },
  });
  const hasMore = rows.length > CHANNEL_THREAD_LIMIT;
  const messages = rows
    .slice(0, CHANNEL_THREAD_LIMIT)
    .reverse()
    .map<ChannelThreadMessage>((m) => ({
      id: m.id,
      direction: m.direction,
      senderType: m.senderType,
      senderName: m.senderName,
      sentBy: m.createdBy?.name ?? null,
      text: m.text,
      contentType: m.contentType as ChannelContentType,
      attachments: Array.isArray(m.attachments) ? (m.attachments as unknown as ChannelAttachment[]) : [],
      occurredAt: m.occurredAt.toISOString(),
      deliveryStatus: (m.deliveryStatus as ChannelDeliveryStatus | null) ?? null,
      lastError: m.lastError,
      messagingTag: m.messagingTag,
      aiOutcome: m.aiOutcome,
      aiReason: m.aiReason,
    }));

  const problem = connectionProblem({ connectionStatus: conversation.connection.status, connectionEnabled: conversation.connection.enabled, connectionName: conversation.connection.name });
  const window = decideReplyWindow({ type: conversation.type, lastInboundAt: conversation.lastInboundAt, now, humanAgentEnabled: conversation.connection.humanAgentEnabled, automated: false });
  return {
    conversation: {
      id: conversation.id,
      type: conversation.type,
      kind: conversation.kind,
      title: channelConversationTitle(conversation),
      customerUsername: conversation.customerUsername,
      externalThreadId: conversation.externalThreadId,
      status: conversation.status === "CLOSED" ? "CLOSED" : "OPEN",
      assignedUserId: conversation.assignedUserId,
      assigneeName: conversation.assignedUser?.name ?? null,
      lastInboundAt: conversation.lastInboundAt?.toISOString() ?? null,
      aiSuppressedUntil: conversation.aiSuppressedUntil?.toISOString() ?? null,
    },
    connection: conversation.connection,
    messages,
    hasMore,
    replyBlocked: problem ?? (window.allowed ? null : window.reason),
    humanAgentReply: window.allowed && window.tag === "HUMAN_AGENT",
  };
}

/** Whether any channel of this kind is connected — an unconfigured channel's inbox shows how to set it up. */
export async function connectionSummary(): Promise<Record<ChannelType, { total: number; working: number }>> {
  const rows = await prisma.channelConnection.groupBy({ by: ["type", "status"], _count: { _all: true } });
  const out: Record<ChannelType, { total: number; working: number }> = {
    MESSENGER: { total: 0, working: 0 },
    INSTAGRAM: { total: 0, working: 0 },
    TELEGRAM: { total: 0, working: 0 },
    WEBCHAT: { total: 0, working: 0 },
    WHATSAPP_CLOUD: { total: 0, working: 0 },
  };
  for (const r of rows) {
    if (r.status === "DISCONNECTED") continue;
    out[r.type].total += r._count._all;
    if (r.status === "CONNECTED") out[r.type].working += r._count._all;
  }
  return out;
}
