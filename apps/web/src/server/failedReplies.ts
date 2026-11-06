import { Prisma } from "@prisma/client";
import {
  classifyReplyFailure,
  decideFailedReplyRetry,
  allowedInBulkRetry,
  FAILED_REPLY_ECHO_WINDOW_MS,
  FAILED_REPLY_STATES,
  parseDhakaDayFromInput,
  redactText,
  TEMPLATE_TEST_KEY_PREFIX,
  type FailedReplyCategory,
  type FailedReplyResolution,
  type FailedReplySource,
  type FailedReplyState,
  type RetryDecision,
  type RetryFacts,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";

/**
 * Messages → Failed Replies (FAILED_REPLIES.md): customer replies that did not go out, from both send
 * queues — WhatsApp (`OutboundMessage`, AUTO_REPLY and MANUAL_REPLY) and the other channels
 * (`ChannelMessage`, outbound replies). Reads only; the actions are in `server/actions/failedReplies.ts`.
 *
 * The state (Failed / Retrying / Resolved / Closed) is DERIVED, never stored: `failedReplyState` in
 * packages/shared is the rule, and `STATE_SQL` below is its SQL twin (a test runs both over the same rows).
 * Every query names "projectId"; the channel half is read only while the project has OMNICHANNEL.
 */

export const FAILED_REPLY_PAGE_SIZES = [25, 50, 100] as const;

export interface FailedReplyFilters {
  /** "open" = Failed + Retrying (the default), "all", or one state. */
  state: "open" | "all" | FailedReplyState;
  source: "" | FailedReplySource;
  accountId: string;
  /** Channel rows: MESSENGER / INSTAGRAM / TELEGRAM / WEBCHAT. */
  channelType: string;
  uncertainOnly: boolean;
  q: string;
  dateFrom: string;
  dateTo: string;
}

const text = (v: string | undefined) => (v ?? "").trim().slice(0, 120);

export function parseFailedReplyFilters(params: Record<string, string | undefined>): FailedReplyFilters {
  const state = params.state === "all" || (FAILED_REPLY_STATES as readonly string[]).includes(params.state ?? "") ? (params.state as FailedReplyFilters["state"]) : "open";
  const source = params.source === "WHATSAPP" || params.source === "CHANNEL" ? params.source : "";
  return {
    state,
    source,
    accountId: text(params.accountId),
    channelType: /^[A-Z_]{2,20}$/.test(params.channelType ?? "") ? params.channelType! : "",
    uncertainOnly: params.uncertain === "1",
    q: text(params.q),
    dateFrom: text(params.dateFrom),
    dateTo: text(params.dateTo),
  };
}

export interface FailedReplyRow {
  source: FailedReplySource;
  id: string;
  createdAt: Date;
  status: string;
  state: FailedReplyState;
  category: FailedReplyCategory;
  deliveryUncertain: boolean;
  /** Redacted. */
  failureReason: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  manualRetryCount: number;
  actionType: string;
  /** What was being sent (the reply's own text), shown truncated. */
  text: string;
  channelType: string;
  chatName: string;
  accountId: string | null;
  accountLabel: string;
  connectionStatus: string | null;
  groupId: string | null;
  chatId: string | null;
  conversationId: string | null;
  relatedMessageId: string | null;
  resolution: FailedReplyResolution | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

interface RawRow {
  source: FailedReplySource;
  id: string;
  createdAt: Date;
  status: string;
  state: FailedReplyState;
  deliveryUncertain: boolean;
  failureReason: string | null;
  attempts: number;
  lastAttemptAt: Date | null;
  manualRetryCount: number;
  actionType: string;
  text: string | null;
  channelType: string;
  chatName: string | null;
  accountId: string | null;
  accountLabel: string | null;
  connectionStatus: string | null;
  groupId: string | null;
  chatId: string | null;
  conversationId: string | null;
  relatedMessageId: string | null;
  resolution: FailedReplyResolution | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

/**
 * The SQL twin of `failedReplyState` for each half. The WHERE of each half already limits rows to
 * failed-or-retried ones, which is what the trailing branches rely on.
 */
const WA_STATE_SQL = Prisma.sql`CASE
  WHEN o."replyResolution" = 'CLOSED' THEN 'CLOSED'
  WHEN o."replyResolution" = 'RESOLVED' THEN 'RESOLVED'
  WHEN o.status IN ('FAILED', 'RATE_LIMITED', 'SKIPPED') THEN 'FAILED'
  WHEN o.status = 'SENT' THEN 'RESOLVED'
  WHEN o.status IN ('PENDING', 'PROCESSING') THEN 'RETRYING'
  WHEN o.status = 'CANCELLED' THEN 'FAILED'
END`;
const CH_STATE_SQL = Prisma.sql`CASE
  WHEN m."replyResolution" = 'CLOSED' THEN 'CLOSED'
  WHEN m."replyResolution" = 'RESOLVED' THEN 'RESOLVED'
  WHEN m."deliveryStatus" IN ('FAILED', 'UNKNOWN') THEN 'FAILED'
  WHEN m."deliveryStatus" IN ('SENT', 'DELIVERED', 'READ') THEN 'RESOLVED'
  WHEN m."deliveryStatus" IN ('QUEUED', 'SENDING') THEN 'RETRYING'
END`;

async function unionSql(projectId: string, includeChannels: boolean, onlyIds?: { source: FailedReplySource; id: string } | null) {
  const wa = Prisma.sql`
    SELECT 'WHATSAPP'::text AS source, o.id, o."createdAt", o.status::text AS status, ${WA_STATE_SQL} AS state,
      o."deliveryUncertain", o."failureReason", o."attemptCount" AS attempts, o."lastAttemptAt", o."manualRetryCount",
      o."actionType"::text AS "actionType", o.body AS text, 'WHATSAPP'::text AS "channelType",
      COALESCE(g.name, o."groupNameSnapshot", rm."senderName") AS "chatName",
      o."accountId", a.label AS "accountLabel", a.status::text AS "connectionStatus",
      o."groupId", o."chatId", NULL::text AS "conversationId", o."relatedMessageId",
      o."replyResolution" AS resolution, o."replyResolvedAt" AS "resolvedAt", o."replyResolutionNote" AS "resolutionNote",
      lower(concat_ws(' ', g.name, o."groupNameSnapshot", rm."senderName", o."toPhone", a.label)) AS haystack
    FROM "OutboundMessage" o
    LEFT JOIN "WhatsAppAccount" a ON a.id = o."accountId"
    LEFT JOIN "WhatsAppGroup" g ON g.id = o."groupId"
    LEFT JOIN "Message" rm ON rm.id = o."relatedMessageId"
    WHERE o."projectId" = ${projectId}
      AND o."actionType" IN ('AUTO_REPLY', 'MANUAL_REPLY')
      AND o."idempotencyKey" NOT LIKE ${`${TEMPLATE_TEST_KEY_PREFIX}%`}
      AND (o.status IN ('FAILED', 'RATE_LIMITED', 'SKIPPED') OR o."manualRetryCount" > 0)
      ${onlyIds ? (onlyIds.source === "WHATSAPP" ? Prisma.sql`AND o.id = ${onlyIds.id}` : Prisma.sql`AND false`) : Prisma.empty}`;
  if (!includeChannels) return wa;
  const ch = Prisma.sql`
    SELECT 'CHANNEL'::text AS source, m.id, m."createdAt", m."deliveryStatus"::text AS status, ${CH_STATE_SQL} AS state,
      (m."deliveryStatus" = 'UNKNOWN') AS "deliveryUncertain", m."lastError" AS "failureReason", m.attempts, COALESCE(m."failedAt", m."sendingStartedAt") AS "lastAttemptAt", m."manualRetryCount",
      m."senderType"::text AS "actionType", COALESCE(m.text, '') AS text, m.type::text AS "channelType",
      COALESCE(cv."customerName", cv.title) AS "chatName",
      NULL::text AS "accountId", c.name AS "accountLabel", c.status::text AS "connectionStatus",
      NULL::text AS "groupId", NULL::text AS "chatId", m."conversationId", NULL::text AS "relatedMessageId",
      m."replyResolution" AS resolution, m."replyResolvedAt" AS "resolvedAt", m."replyResolutionNote" AS "resolutionNote",
      lower(concat_ws(' ', cv."customerName", cv.title, c.name)) AS haystack
    FROM "ChannelMessage" m
    JOIN "ChannelConnection" c ON c.id = m."connectionId"
    JOIN "ChannelConversation" cv ON cv.id = m."conversationId"
    WHERE m."projectId" = ${projectId}
      AND m.direction = 'OUTBOUND' AND m."senderType" <> 'BUSINESS'
      AND (m."deliveryStatus" IN ('FAILED', 'UNKNOWN') OR m."manualRetryCount" > 0)
      ${onlyIds ? (onlyIds.source === "CHANNEL" ? Prisma.sql`AND m.id = ${onlyIds.id}` : Prisma.sql`AND false`) : Prisma.empty}`;
  return Prisma.sql`${wa} UNION ALL ${ch}`;
}

function filterSql(f: FailedReplyFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (f.state === "open") parts.push(Prisma.sql`x.state IN ('FAILED', 'RETRYING')`);
  else if (f.state !== "all") parts.push(Prisma.sql`x.state = ${f.state}`);
  if (f.source) parts.push(Prisma.sql`x.source = ${f.source}`);
  if (f.accountId) parts.push(Prisma.sql`x."accountId" = ${f.accountId}`);
  if (f.channelType) parts.push(Prisma.sql`x."channelType" = ${f.channelType}`);
  if (f.uncertainOnly) parts.push(Prisma.sql`x."deliveryUncertain"`);
  if (f.q) parts.push(Prisma.sql`x.haystack LIKE ${`%${f.q.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`}`);
  const from = parseDhakaDayFromInput(f.dateFrom);
  const to = parseDhakaDayFromInput(f.dateTo);
  if (from) parts.push(Prisma.sql`x."createdAt" >= ${from.start}`);
  if (to) parts.push(Prisma.sql`x."createdAt" < ${to.end}`);
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}

function toRow(r: RawRow): FailedReplyRow {
  const failureReason = r.failureReason ? redactText(r.failureReason).slice(0, 500) : null;
  return {
    ...r,
    text: (r.text ?? "").slice(0, 2000),
    failureReason,
    chatName: r.chatName?.trim() || (r.source === "WHATSAPP" ? (r.groupId ? "WhatsApp group" : "Personal chat") : "Customer"),
    accountLabel: r.accountLabel ?? (r.source === "WHATSAPP" ? "Removed account" : "Removed connection"),
    category: classifyReplyFailure({ source: r.source, status: r.status, failureReason: r.failureReason, deliveryUncertain: r.deliveryUncertain }),
  };
}


export async function listFailedReplies(f: FailedReplyFilters, page: number, pageSize: number, includeChannels: boolean): Promise<{ rows: FailedReplyRow[]; total: number; counts: Record<FailedReplyState, number> }> {
  const projectId = await activeProjectId();
  const union = await unionSql(projectId, includeChannels);
  const where = filterSql(f);
  const countsWhere = filterSql({ ...f, state: "all" });
  const [rows, totals, byState] = await Promise.all([
    prisma.$queryRaw<RawRow[]>`SELECT * FROM (${union}) x ${where} ORDER BY x."createdAt" DESC, x.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM (${union}) x ${where}`,
    prisma.$queryRaw<Array<{ state: FailedReplyState; n: bigint }>>`SELECT x.state, count(*)::bigint AS n FROM (${union}) x ${countsWhere} GROUP BY x.state`,
  ]);
  const counts: Record<FailedReplyState, number> = { FAILED: 0, RETRYING: 0, RESOLVED: 0, CLOSED: 0 };
  for (const s of byState) if (s.state in counts) counts[s.state] = Number(s.n);
  return { rows: rows.map(toRow), total: Number(totals[0]?.n ?? 0), counts };
}

/** The ids every row matching these filters has, capped, for "select all matching". */
export const FAILED_REPLY_MAX_SELECTION = 500;
export async function listFailedReplyKeys(f: FailedReplyFilters, includeChannels: boolean): Promise<Array<{ source: FailedReplySource; id: string }>> {
  const projectId = await activeProjectId();
  const union = await unionSql(projectId, includeChannels);
  return prisma.$queryRaw<Array<{ source: FailedReplySource; id: string }>>`
    SELECT x.source, x.id FROM (${union}) x ${filterSql(f)} ORDER BY x."createdAt" DESC, x.id DESC LIMIT ${FAILED_REPLY_MAX_SELECTION}`;
}

export async function getFailedReply(source: FailedReplySource, id: string, includeChannels: boolean): Promise<FailedReplyRow | null> {
  if (source === "CHANNEL" && !includeChannels) return null;
  const projectId = await activeProjectId();
  const union = await unionSql(projectId, includeChannels, { source, id });
  const rows = await prisma.$queryRaw<RawRow[]>`SELECT * FROM (${union}) x`;
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Evidence that an uncertain WhatsApp send arrived anyway: a message with exactly this text, sent from
 * this number into this chat, stored around the time the send began (WhatsApp echoes our own sends).
 * Only ever used to REFUSE a retry and suggest Resolve; never to mark anything delivered by itself.
 */
export async function echoSeenFor(outboundId: string): Promise<{ seen: boolean; at: Date | null }> {
  const row = await prisma.outboundMessage.findFirst({
    where: { id: outboundId },
    select: { accountId: true, chatId: true, body: true, sendStartedAt: true, lastAttemptAt: true, createdAt: true, contentType: true },
  });
  if (!row || row.contentType !== "TEXT" || !row.body) return { seen: false, at: null };
  const pivot = row.sendStartedAt ?? row.lastAttemptAt ?? row.createdAt;
  const echo = await prisma.message.findFirst({
    where: {
      accountId: row.accountId,
      chatId: row.chatId,
      direction: "OUTGOING",
      body: row.body,
      timestampWa: { gte: new Date(pivot.getTime() - 60_000), lte: new Date(pivot.getTime() + FAILED_REPLY_ECHO_WINDOW_MS) },
    },
    select: { timestampWa: true },
    orderBy: { timestampWa: "asc" },
  });
  return { seen: Boolean(echo), at: echo?.timestampWa ?? null };
}

/** Everything `decideFailedReplyRetry` needs about one row, read now. */
export async function retryFactsFor(row: FailedReplyRow, confirmedUncertain: boolean): Promise<{ facts: RetryFacts; echoAt: Date | null }> {
  let automationPausedForThis = false;
  let echo = { seen: false, at: null as Date | null };
  if (row.source === "WHATSAPP") {
    if (row.actionType === "AUTO_REPLY") {
      const settings = await prisma.automationSettings.findFirst({ select: { automationEnabled: true } });
      automationPausedForThis = settings ? !settings.automationEnabled : false;
    }
    if (row.category === "DELIVERY_UNCERTAIN") echo = await echoSeenFor(row.id);
  }
  return {
    facts: {
      source: row.source,
      state: row.state,
      category: row.category,
      manualRetryCount: row.manualRetryCount,
      connectionStatus: row.connectionStatus,
      automationPausedForThis,
      echoSeen: echo.seen,
      confirmedUncertain,
    },
    echoAt: echo.at,
  };
}

export async function retryDecisionFor(row: FailedReplyRow, confirmedUncertain = false): Promise<{ decision: RetryDecision; echoAt: Date | null; bulk: boolean }> {
  const { facts, echoAt } = await retryFactsFor(row, confirmedUncertain);
  return { decision: decideFailedReplyRetry(facts), echoAt, bulk: allowedInBulkRetry(facts) };
}

export interface FailedReplyHistoryEntry {
  id: string;
  action: string;
  fromStatus: string;
  failureReason: string | null;
  confirmedUncertain: boolean;
  note: string | null;
  actorUsername: string | null;
  createdAt: Date;
}

export async function failedReplyHistory(source: FailedReplySource, id: string): Promise<FailedReplyHistoryEntry[]> {
  return prisma.failedReplyAction.findMany({
    where: source === "WHATSAPP" ? { outboundMessageId: id } : { channelMessageId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, action: true, fromStatus: true, failureReason: true, confirmedUncertain: true, note: true, actorUsername: true, createdAt: true },
  });
}

/** The customer's message this reply answered (WhatsApp), for the detail page. */
export async function originalMessageFor(relatedMessageId: string | null) {
  if (!relatedMessageId) return null;
  return prisma.message.findFirst({
    where: { id: relatedMessageId },
    select: { id: true, body: true, senderName: true, timestampWa: true },
  });
}

/** Where to open the conversation: WhatsApp Chat for a WhatsApp row, All Conversations for a channel row. */
export function conversationHref(row: Pick<FailedReplyRow, "source" | "accountId" | "groupId" | "chatId" | "conversationId">): string | null {
  if (row.source === "CHANNEL") return row.conversationId ? `/conversations/all/c/${row.conversationId}` : null;
  if (!row.accountId) return null;
  if (row.groupId) return `/chat/account/${row.accountId}/${row.groupId}`;
  if (row.chatId && !row.chatId.endsWith("@g.us")) return `/chat/account/${row.accountId}/personal/${encodeURIComponent(row.chatId)}`;
  return null;
}

