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
  isGroup: boolean;
  status: "OPEN" | "CLOSED";
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
  status: "OPEN" | "CLOSED";
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

type ListOpts = { types: ChannelType[]; filters: InboxFilterSet; viewerId: string; now: Date };

function channelFilters(opts: ListOpts): Prisma.Sql {
  const f = opts.filters;
  const parts: Prisma.Sql[] = [Prisma.sql`c."type"::text IN (${Prisma.join(opts.types)})`];
  parts.push(f.view === "closed" ? Prisma.sql`c."status" = 'CLOSED'` : Prisma.sql`c."status" = 'OPEN'`);
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
  const term = f.search;
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    parts.push(Prisma.sql`(c."title" ILIKE ${like} OR c."customerName" ILIKE ${like} OR c."customerUsername" ILIKE ${like} OR c."lastMessagePreview" ILIKE ${like}
      OR EXISTS (SELECT 1 FROM "ChannelMessage" s WHERE s."projectId" = c."projectId" AND s."conversationId" = c."id" AND s."text" ILIKE ${like}))`);
  }
  return Prisma.join(parts, " AND ");
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
    isGroup: row.kind === "GROUP",
    status: row.status,
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

interface GroupOwner {
  name: string;
  userId: string | null;
  teamName: string | null;
}

function fromWhatsApp(c: ConversationSummary, owners: ReadonlyMap<string, GroupOwner>, labels: ReadonlyMap<string, { priority: ConversationPriorityValue; tags: string[] }>, viewerId: string): InboxItem {
  const owner = c.kind === "GROUP" ? owners.get(c.id) : undefined;
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
    isGroup: c.kind === "GROUP",
    status: "OPEN",
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
async function whatsAppChatRestriction(accountIds: string[], f: InboxFilterSet, viewerId: string): Promise<{ include: Map<string, Set<string>> | null; exclude: Map<string, Set<string>> }> {
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
  const priorities = priorityFilterOf(f.view);
  if (priorities || f.tag) {
    const rows = await prisma.conversationLabel.findMany({
      where: { channelConversationId: null, accountId: { in: accountIds }, ...(priorities ? { priority: { in: priorities } } : {}), ...(f.tag ? { tags: { has: f.tag } } : {}) },
      select: { accountId: true, chatId: true },
    });
    includes.push(toMap(rows));
  }
  if (f.view === "mine") includes.push(await groupsWhere({ assignedTeamMember: { userId: viewerId } }));
  if (f.assigneeId) includes.push(await groupsWhere({ assignedTeamMember: { userId: f.assigneeId } }));
  if (f.teamId) includes.push(await groupsWhere({ assignedTeamMember: { teamId: f.teamId } }));
  const exclude = f.view === "unassigned" ? await groupsWhere({ assignedTeamMemberId: { not: null } }) : new Map<string, Set<string>>();

  if (includes.length === 0) return { include: null, exclude };
  // Every include filter must hold: intersect per account.
  const include = new Map<string, Set<string>>();
  for (const accountId of accountIds) {
    const [first, ...rest] = includes.map((m) => m.get(accountId) ?? new Set<string>());
    include.set(accountId, new Set([...first!].filter((chatId) => rest.every((s) => s.has(chatId)))));
  }
  return { include, exclude };
}

async function decorateWhatsApp(list: ConversationSummary[], viewerId: string): Promise<InboxItem[]> {
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
  return list.map((c) => fromWhatsApp(c, owners, labels, viewerId));
}

async function loadWhatsApp(opts: { filters: InboxFilterSet; viewerId: string; now: Date }) {
  const f = opts.filters;
  const all = await getChatAccounts();
  const mine = await whatsAppGroupsAssignedTo(opts.viewerId);
  const countsOf = () => Promise.all(all.map((a) => getChatInbox(a.id).then((i) => i.counts)));
  // Closed is a channel state; WhatsApp conversations have none. A channel account filter excludes WhatsApp.
  if (f.view === "closed" || f.account?.startsWith("ch:")) return { items: [] as InboxItem[], counts: sumWhatsApp(await countsOf(), mine.size) };

  const accounts = f.account ? all.filter((a) => `wa:${a.id}` === f.account) : all;
  const restriction = await whatsAppChatRestriction(
    accounts.map((a) => a.id),
    f,
    opts.viewerId,
  );
  const state = f.view === "unread" ? ("waiting" as const) : f.view === "needs-reply" ? ("unanswered" as const) : undefined;
  const plain = restriction.include === null && restriction.exclude.size === 0 && !state && !f.search;

  const list: ConversationSummary[] = [];
  const counts: Array<{ total: number; waiting: number; seenUnanswered: number }> = [];
  for (const account of all) {
    const inbox = await getChatInbox(account.id);
    counts.push(inbox.counts);
    if (!accounts.some((a) => a.id === account.id)) continue;
    if (plain) {
      list.push(...inbox.conversations);
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
    list.push(...(await getChatConversations(account.id, { search: f.search || undefined, view })));
  }
  const within = f.within ? opts.now.getTime() - WITHIN_MS[f.within] : null;
  const items = await decorateWhatsApp(
    list.filter((c) => within === null || (c.lastMessageAt && c.lastMessageAt.getTime() >= within)),
    opts.viewerId,
  );
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

export async function loadInbox(opts: { scope: InboxScope; filters?: InboxFilterSet; viewerId: string; now?: Date }): Promise<InboxResult> {
  const filters = opts.filters ?? EMPTY_INBOX_FILTERS;
  const now = opts.now ?? new Date();
  const scopedType = channelBySlug(opts.scope);
  const types: ChannelType[] = opts.scope === "all" ? ["MESSENGER", "INSTAGRAM", "TELEGRAM"] : scopedType ? [scopedType] : [];
  const includeWhatsApp = opts.scope === "all" || opts.scope === "whatsapp";

  const [rows, chCounts, wa] = await Promise.all([
    loadChannelRows({ types, filters, viewerId: opts.viewerId, now }),
    channelCounts(types, opts.viewerId),
    includeWhatsApp ? loadWhatsApp({ filters, viewerId: opts.viewerId, now }) : Promise.resolve(null),
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

/** The choices for the inbox's Team / person / account filters. */
export async function inboxFilterOptions(): Promise<{ teams: { id: string; name: string }[]; accounts: { key: string; label: string }[] }> {
  const [teams, waAccounts, connections] = await Promise.all([
    prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getChatAccounts(),
    prisma.channelConnection.findMany({ select: { id: true, name: true, type: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    teams,
    accounts: [
      ...waAccounts.map((a) => ({ key: `wa:${a.id}`, label: `WhatsApp · ${a.label}` })),
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
