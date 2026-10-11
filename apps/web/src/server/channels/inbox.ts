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
export type InboxView = "all" | "unread" | "needs-reply" | "mine" | "closed";
export const INBOX_VIEWS: readonly InboxView[] = ["all", "unread", "needs-reply", "mine", "closed"];
export type InboxWithin = "24h" | "7d" | "30d" | null;

export function isInboxView(value: unknown): value is InboxView {
  return typeof value === "string" && (INBOX_VIEWS as readonly string[]).includes(value);
}

export interface InboxItem {
  /** Unique across channels: `wa:<account>:<conversation>` or `ch:<conversation>`. */
  key: string;
  channel: InboxChannel;
  /** Project-relative. */
  href: string;
  title: string;
  /** Which number / Page / account / bot it came in on. */
  via: string;
  preview: string | null;
  lastMessageAt: string | null;
  lastMessageOutgoing: boolean;
  /** A customer message nobody has answered and nobody has opened since it arrived. */
  unread: boolean;
  /** A customer message nobody has answered (opened or not). */
  needsReply: boolean;
  isGroup: boolean;
  status: "OPEN" | "CLOSED";
  assigneeName: string | null;
  assignedToMe: boolean;
  aiOn: boolean;
  /** Why replies cannot go out from here right now, if they cannot (a disconnected channel…). */
  connectionProblem: string | null;
}

export interface InboxCounts {
  all: number;
  unread: number;
  needsReply: number;
  mine: number;
  closed: number;
  byChannel: Record<InboxChannel, number>;
}

const WITHIN_MS: Record<Exclude<InboxWithin, null>, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };

export function isInboxWithin(value: unknown): value is Exclude<InboxWithin, null> {
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
  status: "OPEN" | "CLOSED";
  assignedUserId: string | null;
  assigneeName: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  connectionName: string;
  connectionStatus: string;
  connectionEnabled: boolean;
  aiAutomationEnabled: boolean;
  needsReply: boolean;
  unread: boolean;
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

function channelFilters(opts: { types: ChannelType[]; view: InboxView; search?: string; within: InboxWithin; viewerId: string; now: Date }): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`c."type"::text IN (${Prisma.join(opts.types)})`];
  if (opts.view === "closed") parts.push(Prisma.sql`c."status" = 'CLOSED'`);
  else parts.push(Prisma.sql`c."status" = 'OPEN'`);
  if (opts.view === "unread") parts.push(Prisma.sql`${NEEDS_REPLY_SQL} AND (c."reviewedAt" IS NULL OR c."reviewedAt" < c."lastInboundAt")`);
  if (opts.view === "needs-reply") parts.push(NEEDS_REPLY_SQL);
  if (opts.view === "mine") parts.push(Prisma.sql`c."assignedUserId" = ${opts.viewerId}`);
  if (opts.within) parts.push(Prisma.sql`c."lastMessageAt" >= ${new Date(opts.now.getTime() - WITHIN_MS[opts.within])}`);
  const term = opts.search?.trim();
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    parts.push(Prisma.sql`(c."title" ILIKE ${like} OR c."customerName" ILIKE ${like} OR c."customerUsername" ILIKE ${like} OR c."lastMessagePreview" ILIKE ${like}
      OR EXISTS (SELECT 1 FROM "ChannelMessage" s WHERE s."projectId" = c."projectId" AND s."conversationId" = c."id" AND s."text" ILIKE ${like}))`);
  }
  return Prisma.join(parts, " AND ");
}

async function loadChannelRows(opts: { types: ChannelType[]; view: InboxView; search?: string; within: InboxWithin; viewerId: string; now: Date }): Promise<ChannelRow[]> {
  if (opts.types.length === 0) return [];
  const projectId = await activeProjectId();
  return prisma.$queryRaw<ChannelRow[]>`
    SELECT c."id", c."type"::text AS "type", c."kind"::text AS "kind", c."title", c."customerName", c."customerUsername", c."externalThreadId",
           c."status"::text AS "status", c."assignedUserId", u."name" AS "assigneeName",
           c."lastMessageAt", c."lastMessagePreview", c."lastMessageDirection"::text AS "lastMessageDirection",
           conn."name" AS "connectionName", conn."status"::text AS "connectionStatus", conn."enabled" AS "connectionEnabled", conn."aiAutomationEnabled",
           ${NEEDS_REPLY_SQL} AS "needsReply",
           (${NEEDS_REPLY_SQL} AND (c."reviewedAt" IS NULL OR c."reviewedAt" < c."lastInboundAt")) AS "unread"
    FROM "ChannelConversation" c
    JOIN "ChannelConnection" conn ON conn."id" = c."connectionId" AND conn."projectId" = c."projectId"
    LEFT JOIN "User" u ON u."id" = c."assignedUserId"
    WHERE c."projectId" = ${projectId} AND ${channelFilters(opts)}
    ORDER BY c."lastMessageAt" DESC NULLS LAST, c."id"
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

function fromChannelRow(row: ChannelRow, scope: InboxScope, viewerId: string): InboxItem {
  return {
    key: `ch:${row.id}`,
    channel: row.type,
    href: `/conversations/${scope}/c/${row.id}`,
    title: channelConversationTitle(row),
    via: row.connectionName,
    preview: row.lastMessagePreview,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessageOutgoing: row.lastMessageDirection === "OUTBOUND",
    unread: row.unread,
    needsReply: row.needsReply,
    isGroup: row.kind === "GROUP",
    status: row.status,
    assigneeName: row.assigneeName,
    assignedToMe: row.assignedUserId === viewerId,
    aiOn: row.aiAutomationEnabled && row.kind === "DIRECT",
    connectionProblem: connectionProblem(row),
  };
}

async function channelCounts(types: ChannelType[], viewerId: string): Promise<Omit<InboxCounts, "byChannel"> & { byChannel: Partial<Record<InboxChannel, number>> }> {
  const empty = { all: 0, unread: 0, needsReply: 0, mine: 0, closed: 0, byChannel: {} };
  if (types.length === 0) return empty;
  const projectId = await activeProjectId();
  const rows = await prisma.$queryRaw<Array<{ type: ChannelType; all: bigint; unread: bigint; needsReply: bigint; mine: bigint; closed: bigint }>>`
    SELECT c."type"::text AS "type",
      COUNT(*) FILTER (WHERE c."status" = 'OPEN') AS "all",
      COUNT(*) FILTER (WHERE c."status" = 'OPEN' AND ${NEEDS_REPLY_SQL} AND (c."reviewedAt" IS NULL OR c."reviewedAt" < c."lastInboundAt")) AS "unread",
      COUNT(*) FILTER (WHERE c."status" = 'OPEN' AND ${NEEDS_REPLY_SQL}) AS "needsReply",
      COUNT(*) FILTER (WHERE c."status" = 'OPEN' AND c."assignedUserId" = ${viewerId}) AS "mine",
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

function fromWhatsApp(c: ConversationSummary, myGroupIds: ReadonlySet<string>): InboxItem {
  return {
    key: `wa:${c.accountId}:${c.id}`,
    channel: "WHATSAPP",
    href: conversationPath(c.accountId, c),
    title: c.name,
    via: c.accountLabel,
    preview: c.lastMessagePreview,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessageOutgoing: c.lastMessageOutgoing,
    unread: c.awaitingReply,
    needsReply: c.isUnanswered,
    isGroup: c.kind === "GROUP",
    status: "OPEN",
    assigneeName: null,
    assignedToMe: myGroupIds.has(c.id),
    aiOn: c.aiAutomationEnabled,
    connectionProblem: null,
  };
}

/** WhatsApp groups whose assigned team member is linked to this login (the explicit userId link only). */
async function whatsAppGroupsAssignedTo(viewerId: string): Promise<Set<string>> {
  const rows = await prisma.whatsAppGroup.findMany({ where: { isActive: true, assignedTeamMember: { userId: viewerId } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

async function loadWhatsApp(opts: { view: InboxView; search?: string; within: InboxWithin; viewerId: string; now: Date }) {
  if (opts.view === "closed") {
    // WhatsApp conversations have no open/closed state; they never appear under Closed.
    const accounts = await getChatAccounts();
    const counts = await Promise.all(accounts.map((a) => getChatInbox(a.id).then((i) => i.counts)));
    const mine = await whatsAppGroupsAssignedTo(opts.viewerId);
    return { items: [] as InboxItem[], counts: sumWhatsApp(counts, mine.size) };
  }
  const accounts = await getChatAccounts();
  const mine = await whatsAppGroupsAssignedTo(opts.viewerId);
  const items: InboxItem[] = [];
  const counts: Array<{ total: number; waiting: number; seenUnanswered: number }> = [];
  for (const account of accounts) {
    const inbox = await getChatInbox(account.id);
    counts.push(inbox.counts);
    let list: ConversationSummary[];
    const search = opts.search?.trim();
    if (search) list = await getChatConversations(account.id, { search });
    else if (opts.view === "unread") list = await getChatConversations(account.id, { view: { kind: "waiting" } });
    else if (opts.view === "needs-reply") {
      const [waiting, seen] = await Promise.all([getChatConversations(account.id, { view: { kind: "waiting" } }), getChatConversations(account.id, { view: { kind: "seen-unanswered" } })]);
      list = [...waiting, ...seen];
    } else list = inbox.conversations;
    for (const c of list) {
      const item = fromWhatsApp(c, mine);
      if (search && opts.view === "unread" && !item.unread) continue;
      if (search && opts.view === "needs-reply" && !item.needsReply) continue;
      if (opts.view === "mine" && !item.assignedToMe) continue;
      if (opts.within && (!c.lastMessageAt || c.lastMessageAt.getTime() < opts.now.getTime() - WITHIN_MS[opts.within])) continue;
      items.push(item);
    }
  }
  return { items, counts: sumWhatsApp(counts, mine.size) };
}

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
}

export async function loadInbox(opts: { scope: InboxScope; view?: InboxView; search?: string; within?: InboxWithin; viewerId: string; now?: Date }): Promise<InboxResult> {
  const view = opts.view ?? "all";
  const within = opts.within ?? null;
  const now = opts.now ?? new Date();
  const scopedType = channelBySlug(opts.scope);
  const types: ChannelType[] = opts.scope === "all" ? ["MESSENGER", "INSTAGRAM", "TELEGRAM"] : scopedType ? [scopedType] : [];
  const includeWhatsApp = opts.scope === "all" || opts.scope === "whatsapp";

  const [rows, chCounts, wa] = await Promise.all([
    loadChannelRows({ types, view, search: opts.search, within, viewerId: opts.viewerId, now }),
    channelCounts(types, opts.viewerId),
    includeWhatsApp ? loadWhatsApp({ view, search: opts.search, within, viewerId: opts.viewerId, now }) : Promise.resolve(null),
  ]);

  const merged = [...rows.map((r) => fromChannelRow(r, opts.scope, opts.viewerId)), ...(wa?.items ?? [])].sort(
    (a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "") || a.key.localeCompare(b.key),
  );
  const byChannel: Record<InboxChannel, number> = { WHATSAPP: 0, MESSENGER: 0, INSTAGRAM: 0, TELEGRAM: 0 };
  for (const [k, v] of Object.entries({ ...chCounts.byChannel, ...(wa?.counts.byChannel ?? {}) })) byChannel[k as InboxChannel] = v ?? 0;
  const counts: InboxCounts = {
    all: chCounts.all + (wa?.counts.all ?? 0),
    unread: chCounts.unread + (wa?.counts.unread ?? 0),
    needsReply: chCounts.needsReply + (wa?.counts.needsReply ?? 0),
    mine: chCounts.mine + (wa?.counts.mine ?? 0),
    closed: chCounts.closed,
    byChannel,
  };
  return { items: merged.slice(0, INBOX_LIMIT), counts, truncated: merged.length > INBOX_LIMIT || rows.length >= INBOX_LIMIT };
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
      status: conversation.status,
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
  };
  for (const r of rows) {
    if (r.status === "DISCONNECTED") continue;
    out[r.type].total += r._count._all;
    if (r.status === "CONNECTED") out[r.type].working += r._count._all;
  }
  return out;
}
