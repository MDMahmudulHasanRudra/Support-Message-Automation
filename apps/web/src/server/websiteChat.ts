import { classifyWebchatConversation, type WebchatQueueState } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { presenceFor, type WidgetPresence } from "@/server/channels/webchatPresence";

/**
 * The Website Chat module's figures (WEBSITE_CHAT.md §Live board). One reading of who a conversation is waiting
 * on (`classifyWebchatConversation`), from the conversations and messages themselves, so the board cannot
 * disagree with the inbox. A reply that failed is not an answer.
 */
const MAX_ROWS = 500;

export interface QueueRow {
  id: string;
  connectionId: string;
  widget: string;
  name: string;
  verified: boolean;
  phone: string | null;
  email: string | null;
  pageUrl: string | null;
  preview: string | null;
  assigneeId: string | null;
  assignee: string | null;
  state: WebchatQueueState;
  lastAt: Date | null;
  /** Since the customer's first message after our last reply. */
  waitSeconds: number | null;
}

export interface BoardWidget {
  id: string;
  name: string;
  enabled: boolean;
  origins: string[];
  seenAt: Date | null;
  seenOrigin: string | null;
  refusedOrigin: string | null;
  waiting: number;
  open: number;
  online: number;
}

export interface BoardToday {
  newChats: number;
  customerMessages: number;
  aiReplies: number;
  teamReplies: number;
  medianFirstReply: number | null;
  medianFirstHumanReply: number | null;
  visitors: number;
  visitorsWithContact: number;
}

export interface WebsiteChatBoard {
  rows: QueueRow[];
  counts: Record<"all" | "waiting" | "ai" | "aiAnswered" | "team" | "unassigned", number>;
  longestWait: number | null;
  today: BoardToday;
  byDay: Array<{ day: string; chats: number }>;
  team: Array<{ id: string; name: string; open: number; waiting: number }>;
  widgets: BoardWidget[];
  presence: WidgetPresence;
}

interface RawRow {
  id: string;
  connectionId: string;
  widget: string;
  customerName: string | null;
  title: string | null;
  assignedUserId: string | null;
  assignee: string | null;
  aiEnabled: boolean;
  aiSuppressedUntil: Date | null;
  preview: string | null;
  vName: string | null;
  email: string | null;
  phone: string | null;
  typedPhone: string | null;
  pageUrl: string | null;
  verified: boolean;
  lastSender: string | null;
  lastAiOutcome: string | null;
  lastAt: Date | null;
  waitSince: Date | null;
}

/** Midnight in Dhaka, today. */
function startOfDhakaDay(now: Date): Date {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(now);
  return new Date(`${day}T00:00:00+06:00`);
}

export async function loadWebsiteChatBoard(now = new Date(), widgetId: string | null = null): Promise<WebsiteChatBoard> {
  const projectId = await activeProjectId();
  const dayStart = startOfDhakaDay(now);
  const since14 = new Date(dayStart.getTime() - 13 * 86_400_000);

  const [raw, widgets, todayRows, byDay] = await Promise.all([
    prisma.$queryRaw<RawRow[]>`
      SELECT c."id", c."connectionId", cn."name" AS "widget", c."customerName", c."title", c."assignedUserId", u."name" AS "assignee",
             cn."aiAutomationEnabled" AS "aiEnabled", c."aiSuppressedUntil", c."lastMessagePreview" AS "preview",
             v."name" AS "vName", v."email", v."phone", v."typedPhone", v."pageUrl", (v."verifiedExternalId" IS NOT NULL) AS "verified",
             last."senderType"::text AS "lastSender", last."aiOutcome"::text AS "lastAiOutcome", last."occurredAt" AS "lastAt",
             (SELECT min(w."occurredAt") FROM "ChannelMessage" w
               WHERE w."conversationId" = c."id" AND w."projectId" = ${projectId} AND w."senderType" = 'CUSTOMER'
                 AND w."occurredAt" > COALESCE((SELECT max(r."occurredAt") FROM "ChannelMessage" r
                   WHERE r."conversationId" = c."id" AND r."projectId" = ${projectId} AND r."direction" = 'OUTBOUND'
                     AND (r."deliveryStatus" IS NULL OR r."deliveryStatus" NOT IN ('FAILED', 'UNKNOWN'))), '-infinity'::timestamp)) AS "waitSince"
      FROM "ChannelConversation" c
      JOIN "ChannelConnection" cn ON cn."id" = c."connectionId"
      LEFT JOIN "User" u ON u."id" = c."assignedUserId"
      LEFT JOIN "WebChatVisitor" v ON v."id" = c."externalThreadId" AND v."connectionId" = c."connectionId"
      LEFT JOIN LATERAL (
        SELECT m."senderType", m."aiOutcome", m."occurredAt" FROM "ChannelMessage" m
        WHERE m."conversationId" = c."id" AND m."projectId" = ${projectId}
          AND (m."direction" = 'INBOUND' OR m."deliveryStatus" IS NULL OR m."deliveryStatus" NOT IN ('FAILED', 'UNKNOWN'))
        ORDER BY m."occurredAt" DESC, m."createdAt" DESC LIMIT 1
      ) last ON TRUE
      WHERE c."projectId" = ${projectId} AND c."type" = 'WEBCHAT' AND c."status" <> 'CLOSED'
        AND (c."snoozedUntil" IS NULL OR c."snoozedUntil" <= ${now})
      ORDER BY c."lastMessageAt" DESC NULLS LAST
      LIMIT ${MAX_ROWS}
    `,
    prisma.channelConnection.findMany({
      where: { type: "WEBCHAT", status: { not: "DISCONNECTED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, enabled: true, allowedOrigins: true, widgetSeenAt: true, widgetSeenOrigin: true, widgetRefusedOrigin: true },
    }),
    prisma.$queryRaw<Array<Record<keyof BoardToday, number | bigint | null>>>`
      WITH msgs AS (
        SELECT m."conversationId", m."senderType", m."direction", m."occurredAt" FROM "ChannelMessage" m
        WHERE m."projectId" = ${projectId} AND m."type" = 'WEBCHAT' AND m."occurredAt" >= ${dayStart}
      ), firsts AS (
        SELECT "conversationId", min("occurredAt") AS at FROM msgs WHERE "senderType" = 'CUSTOMER' GROUP BY 1
      ), waits AS (
        SELECT
          EXTRACT(EPOCH FROM (SELECT min(r."occurredAt") FROM msgs r WHERE r."conversationId" = f."conversationId" AND r."direction" = 'OUTBOUND' AND r."occurredAt" >= f.at) - f.at) AS "anyReply",
          EXTRACT(EPOCH FROM (SELECT min(r."occurredAt") FROM msgs r WHERE r."conversationId" = f."conversationId" AND r."senderType" IN ('AGENT', 'BUSINESS') AND r."occurredAt" >= f.at) - f.at) AS "humanReply"
        FROM firsts f
      )
      SELECT
        (SELECT count(*) FROM "ChannelConversation" c WHERE c."projectId" = ${projectId} AND c."type" = 'WEBCHAT' AND c."createdAt" >= ${dayStart}) AS "newChats",
        (SELECT count(*) FROM msgs WHERE "senderType" = 'CUSTOMER') AS "customerMessages",
        (SELECT count(*) FROM msgs WHERE "senderType" = 'AI') AS "aiReplies",
        (SELECT count(*) FROM msgs WHERE "senderType" IN ('AGENT', 'BUSINESS')) AS "teamReplies",
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "anyReply") FROM waits) AS "medianFirstReply",
        (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "humanReply") FROM waits) AS "medianFirstHumanReply",
        (SELECT count(*) FROM "WebChatVisitor" v WHERE v."projectId" = ${projectId} AND v."createdAt" >= ${dayStart}) AS "visitors",
        (SELECT count(*) FROM "WebChatVisitor" v WHERE v."projectId" = ${projectId} AND v."createdAt" >= ${dayStart} AND (v."email" IS NOT NULL OR v."phone" IS NOT NULL OR v."typedPhone" IS NOT NULL)) AS "visitorsWithContact"
    `,
    prisma.$queryRaw<Array<{ day: Date; chats: bigint }>>`
      SELECT (c."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')::date AS day, count(*) AS chats
      FROM "ChannelConversation" c
      WHERE c."projectId" = ${projectId} AND c."type" = 'WEBCHAT' AND c."createdAt" >= ${since14}
      GROUP BY 1
    `,
  ]);

  const rows: QueueRow[] = raw
    .filter((r) => !widgetId || r.connectionId === widgetId)
    .map((r) => {
      const state = classifyWebchatConversation({ lastSender: r.lastSender, lastAiOutcome: r.lastAiOutcome, lastAt: r.lastAt, aiEnabled: r.aiEnabled, aiSuppressedUntil: r.aiSuppressedUntil, now });
      const waiting = state === "WAITING_PERSON" || state === "AI_ANSWERING";
      return {
        id: r.id,
        connectionId: r.connectionId,
        widget: r.widget,
        name: (r.vName ?? r.customerName ?? r.title ?? "Website visitor").replace(/ \(unverified\)$/, ""),
        verified: r.verified,
        phone: r.phone ?? r.typedPhone,
        email: r.email,
        pageUrl: r.pageUrl,
        preview: r.preview,
        assigneeId: r.assignedUserId,
        assignee: r.assignee,
        state,
        lastAt: r.lastAt,
        waitSeconds: waiting && r.waitSince ? Math.max(0, Math.round((now.getTime() - r.waitSince.getTime()) / 1000)) : null,
      };
    });

  // Longest wait first: the person at the top of this list is the next one to answer.
  rows.sort((a, b) => (b.waitSeconds ?? -1) - (a.waitSeconds ?? -1));

  const waitingRows = rows.filter((r) => r.state === "WAITING_PERSON");
  const counts = {
    all: rows.length,
    waiting: waitingRows.length,
    ai: rows.filter((r) => r.state === "AI_ANSWERING").length,
    aiAnswered: rows.filter((r) => r.state === "AI_ANSWERED").length,
    team: rows.filter((r) => r.state === "TEAM_ANSWERED").length,
    unassigned: rows.filter((r) => !r.assigneeId).length,
  };

  const teamMap = new Map<string, { id: string; name: string; open: number; waiting: number }>();
  for (const r of rows) {
    if (!r.assigneeId) continue;
    const entry = teamMap.get(r.assigneeId) ?? { id: r.assigneeId, name: r.assignee ?? "Team member", open: 0, waiting: 0 };
    entry.open += 1;
    if (r.state === "WAITING_PERSON") entry.waiting += 1;
    teamMap.set(r.assigneeId, entry);
  }

  const dayCounts = new Map(byDay.map((d) => [d.day.toISOString().slice(0, 10), Number(d.chats)]));
  const days: Array<{ day: string; chats: number }> = [];
  for (let i = 0; i < 14; i += 1) {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date(since14.getTime() + i * 86_400_000));
    days.push({ day: key, chats: dayCounts.get(key) ?? 0 });
  }

  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
  const t = todayRows[0];
  const shown = widgets.filter((w) => !widgetId || w.id === widgetId);
  return {
    rows,
    counts,
    longestWait: waitingRows.reduce<number | null>((max, r) => (r.waitSeconds !== null && (max === null || r.waitSeconds > max) ? r.waitSeconds : max), null),
    today: {
      newChats: num(t?.newChats),
      customerMessages: num(t?.customerMessages),
      aiReplies: num(t?.aiReplies),
      teamReplies: num(t?.teamReplies),
      medianFirstReply: t?.medianFirstReply === null || t?.medianFirstReply === undefined ? null : Number(t.medianFirstReply),
      medianFirstHumanReply: t?.medianFirstHumanReply === null || t?.medianFirstHumanReply === undefined ? null : Number(t.medianFirstHumanReply),
      visitors: num(t?.visitors),
      visitorsWithContact: num(t?.visitorsWithContact),
    },
    byDay: days,
    team: [...teamMap.values()].sort((a, b) => b.waiting - a.waiting || b.open - a.open),
    widgets: widgets.map((w) => ({
      id: w.id,
      name: w.name,
      enabled: w.enabled,
      origins: w.allowedOrigins,
      seenAt: w.widgetSeenAt,
      seenOrigin: w.widgetSeenOrigin,
      refusedOrigin: w.widgetRefusedOrigin,
      waiting: raw.filter((r) => r.connectionId === w.id && classifyWebchatConversation({ lastSender: r.lastSender, lastAiOutcome: r.lastAiOutcome, lastAt: r.lastAt, aiEnabled: r.aiEnabled, aiSuppressedUntil: r.aiSuppressedUntil, now }) === "WAITING_PERSON").length,
      open: raw.filter((r) => r.connectionId === w.id).length,
      online: presenceFor([w.id]).online,
    })),
    presence: presenceFor(shown.map((w) => w.id)),
  };
}

/** Whether a widget has started on a website lately; older than a week, the code has probably gone. */
export function seenInLastWeek(at: Date | null): boolean {
  return Boolean(at && Date.now() - at.getTime() < 7 * 86_400_000);
}

export const VISITOR_PAGE_SIZE = 50;

export interface VisitorFilters {
  q: string;
  widget: string;
  contact: "" | "yes" | "no";
}

function visitorWhere(filters: VisitorFilters) {
  const q = filters.q.trim();
  const contact = { OR: [{ email: { not: null } }, { phone: { not: null } }, { typedPhone: { not: null } }] };
  return {
    ...(filters.widget ? { connectionId: filters.widget } : {}),
    ...(filters.contact === "yes" ? contact : {}),
    ...(filters.contact === "no" ? { email: null, phone: null, typedPhone: null } : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { name: { contains: q, mode: "insensitive" as const } },
                { email: { contains: q, mode: "insensitive" as const } },
                { typedPhone: { contains: q.replace(/\D/g, "") || q } },
                { phone: { contains: q.replace(/\D/g, "") || q } },
              ],
            },
          ],
        }
      : {}),
  };
}

const VISITOR_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  typedPhone: true,
  verifiedExternalId: true,
  customAnswers: true,
  consentAt: true,
  pageUrl: true,
  firstPageUrl: true,
  referrer: true,
  utmSource: true,
  utmMedium: true,
  utmCampaign: true,
  browser: true,
  os: true,
  device: true,
  language: true,
  timeZone: true,
  visitCount: true,
  createdAt: true,
  lastSeenAt: true,
  connectionId: true,
  connection: { select: { name: true } },
} as const;

export async function listWebsiteVisitors(filters: VisitorFilters, page: number) {
  const where = visitorWhere(filters);
  const [total, visitors] = await Promise.all([
    prisma.webChatVisitor.count({ where }),
    prisma.webChatVisitor.findMany({ where, orderBy: { lastSeenAt: "desc" }, skip: (page - 1) * VISITOR_PAGE_SIZE, take: VISITOR_PAGE_SIZE, select: VISITOR_SELECT }),
  ]);
  const conversations = await prisma.channelConversation.findMany({
    where: { type: "WEBCHAT", externalThreadId: { in: visitors.map((v) => v.id) } },
    select: { id: true, externalThreadId: true, status: true },
  });
  const byVisitor = new Map(conversations.map((c) => [c.externalThreadId, c]));
  return { total, visitors: visitors.map((v) => ({ ...v, conversation: byVisitor.get(v.id) ?? null })) };
}

/** Every matching visitor, for the export. */
export async function exportWebsiteVisitors(filters: VisitorFilters) {
  return prisma.webChatVisitor.findMany({ where: visitorWhere(filters), orderBy: { lastSeenAt: "desc" }, take: 50_000, select: VISITOR_SELECT });
}
