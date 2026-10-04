import type { Prisma } from "@prisma/client";
import { parseDhakaDayFromInput } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Read side of Messages → Unanswered Groups and Response Time (SUPPORT_RESPONSE.md).
 *
 * Both tabs read `SupportResponseEpisode` rows the worker keeps up to date as messages arrive —
 * indexed reads, never a scan of `Message`. The page, "select all matching", Clear All and both
 * exports go through the SAME `where` builders below, so the set a person sees counted is the set an
 * action touches.
 */

export const SUPPORT_RESPONSE_PAGE_SIZES = [50, 100, 250, 500, 1000] as const;
/** The most rows one selection, clear or export may touch at once. */
export const SUPPORT_RESPONSE_MAX_SELECTION = 5000;

type Params = Record<string, string | undefined>;

const text = (v: string | undefined) => (v ?? "").trim();
const positiveInt = (v: string | undefined): number | null => {
  const n = Number(text(v));
  return text(v) !== "" && Number.isInteger(n) && n >= 0 ? n : null;
};

// ---------------------------------------------------------------- Unanswered Groups

export const UNANSWERED_SORTS = {
  oldest: "Waiting longest",
  newest: "Newest message",
  messages: "Most messages",
  account: "Account",
  group: "Group",
} as const;
export type UnansweredSort = keyof typeof UNANSWERED_SORTS;

export interface UnansweredFilters {
  /** UNANSWERED (the default) or CLEARED — the dismissed ones, kept for the record. */
  status: "UNANSWERED" | "CLEARED";
  accountId: string;
  group: string;
  sender: string;
  /** Waiting at least this many minutes. */
  waitingMin: number | null;
  /** At least this many unanswered messages. */
  minMessages: number | null;
  dateFrom: string;
  dateTo: string;
  sort: UnansweredSort;
}

export function parseUnansweredFilters(params: Params): UnansweredFilters {
  const sort = text(params.sort) as UnansweredSort;
  return {
    status: params.status === "CLEARED" ? "CLEARED" : "UNANSWERED",
    accountId: text(params.accountId),
    group: text(params.group),
    sender: text(params.sender),
    waitingMin: positiveInt(params.waitingMin),
    minMessages: positiveInt(params.minMessages),
    dateFrom: text(params.dateFrom),
    dateTo: text(params.dateTo),
    sort: sort in UNANSWERED_SORTS ? sort : "oldest",
  };
}

export function unansweredWhere(f: UnansweredFilters, now: Date): Prisma.SupportResponseEpisodeWhereInput {
  const where: Prisma.SupportResponseEpisodeWhereInput = { status: f.status };
  // An open wait in a group this account has left cannot be answered from here; it is not shown as
  // something to act on. Cleared ones are history and are shown regardless.
  const group: Prisma.WhatsAppGroupWhereInput = f.status === "UNANSWERED" ? { isActive: true } : {};
  if (f.group) group.name = { contains: f.group, mode: "insensitive" };
  where.group = group;
  if (f.accountId) where.accountId = f.accountId;
  if (f.sender) {
    where.latestIncomingMessage = {
      OR: [{ senderName: { contains: f.sender, mode: "insensitive" } }, { senderPhone: { contains: f.sender, mode: "insensitive" } }],
    };
  }
  const firstAt: Prisma.DateTimeFilter = {};
  if (f.waitingMin !== null) firstAt.lte = new Date(now.getTime() - f.waitingMin * 60_000);
  const from = parseDhakaDayFromInput(f.dateFrom);
  const to = parseDhakaDayFromInput(f.dateTo);
  if (from) firstAt.gte = from.start;
  if (to) firstAt.lt = to.end;
  if (Object.keys(firstAt).length) where.firstIncomingAt = firstAt;
  if (f.minMessages !== null) where.incomingMessageCount = { gte: f.minMessages };
  return where;
}

function unansweredOrder(sort: UnansweredSort): Prisma.SupportResponseEpisodeOrderByWithRelationInput[] {
  switch (sort) {
    case "newest":
      return [{ latestIncomingAt: "desc" }, { id: "asc" }];
    case "messages":
      return [{ incomingMessageCount: "desc" }, { firstIncomingAt: "asc" }, { id: "asc" }];
    case "account":
      return [{ account: { label: "asc" } }, { firstIncomingAt: "asc" }, { id: "asc" }];
    case "group":
      return [{ group: { name: "asc" } }, { firstIncomingAt: "asc" }, { id: "asc" }];
    default:
      return [{ firstIncomingAt: "asc" }, { id: "asc" }];
  }
}

const UNANSWERED_SELECT = {
  id: true,
  status: true,
  firstIncomingAt: true,
  latestIncomingAt: true,
  incomingMessageCount: true,
  clearedAt: true,
  clearReason: true,
  group: { select: { id: true, name: true, whatsappGroupId: true } },
  account: { select: { id: true, label: true } },
  latestIncomingMessage: { select: { body: true, senderName: true, senderPhone: true } },
  clearedBy: { select: { name: true, username: true } },
} satisfies Prisma.SupportResponseEpisodeSelect;

export interface UnansweredRow {
  id: string;
  status: "UNANSWERED" | "ANSWERED" | "CLEARED";
  groupId: string;
  groupName: string;
  whatsappGroupId: string;
  accountLabel: string;
  firstIncomingAt: Date;
  latestIncomingAt: Date;
  messageCount: number;
  latestMessage: string | null;
  latestSender: string | null;
  clearedAt: Date | null;
  clearedBy: string | null;
  clearReason: string | null;
}

type UnansweredRecord = Prisma.SupportResponseEpisodeGetPayload<{ select: typeof UNANSWERED_SELECT }>;
function toUnansweredRow(e: UnansweredRecord): UnansweredRow {
  return {
    id: e.id,
    status: e.status,
    groupId: e.group.id,
    groupName: e.group.name,
    whatsappGroupId: e.group.whatsappGroupId,
    accountLabel: e.account.label,
    firstIncomingAt: e.firstIncomingAt,
    latestIncomingAt: e.latestIncomingAt,
    messageCount: e.incomingMessageCount,
    latestMessage: e.latestIncomingMessage?.body ?? null,
    latestSender: e.latestIncomingMessage ? e.latestIncomingMessage.senderName || e.latestIncomingMessage.senderPhone : null,
    clearedAt: e.clearedAt,
    clearedBy: e.clearedBy ? e.clearedBy.name || e.clearedBy.username : null,
    clearReason: e.clearReason,
  };
}

export async function listUnanswered(f: UnansweredFilters, page: number, pageSize: number, now: Date) {
  const where = unansweredWhere(f, now);
  const [rows, total] = await Promise.all([
    prisma.supportResponseEpisode.findMany({ where, orderBy: unansweredOrder(f.sort), skip: (page - 1) * pageSize, take: pageSize, select: UNANSWERED_SELECT }),
    prisma.supportResponseEpisode.count({ where }),
  ]);
  return { rows: rows.map(toUnansweredRow), total };
}

/**
 * Rows for an export: the chosen ids, or everything matching, in the page's own order. One row past
 * the limit is read so the caller can refuse a too-large export out loud instead of cutting it short.
 */
export async function unansweredForExport(f: UnansweredFilters, ids: string[] | null, now: Date): Promise<UnansweredRow[]> {
  const where = ids ? { AND: [unansweredWhere(f, now), { id: { in: ids } }] } : unansweredWhere(f, now);
  const rows = await prisma.supportResponseEpisode.findMany({ where, orderBy: unansweredOrder(f.sort), take: SUPPORT_RESPONSE_MAX_SELECTION + 1, select: UNANSWERED_SELECT });
  return rows.map(toUnansweredRow);
}

// ---------------------------------------------------------------- Response Time

export const RESPONSE_SORTS = {
  newest: "Newest reply",
  slowest: "Slowest response",
  fastest: "Fastest response",
  group: "Group",
} as const;
export type ResponseSort = keyof typeof RESPONSE_SORTS;

export interface ResponseFilters {
  accountId: string;
  group: string;
  memberId: string;
  teamId: string;
  dateFrom: string;
  dateTo: string;
  /** Response time at least / at most this many minutes. */
  minMinutes: number | null;
  maxMinutes: number | null;
  sort: ResponseSort;
}

export function parseResponseFilters(params: Params): ResponseFilters {
  const sort = text(params.sort) as ResponseSort;
  return {
    accountId: text(params.accountId),
    group: text(params.group),
    memberId: text(params.memberId),
    teamId: text(params.teamId),
    dateFrom: text(params.dateFrom),
    dateTo: text(params.dateTo),
    minMinutes: positiveInt(params.minMinutes),
    maxMinutes: positiveInt(params.maxMinutes),
    sort: sort in RESPONSE_SORTS ? sort : "newest",
  };
}

export function responseWhere(f: ResponseFilters): Prisma.SupportResponseEpisodeWhereInput {
  const where: Prisma.SupportResponseEpisodeWhereInput = { status: "ANSWERED" };
  if (f.accountId) where.accountId = f.accountId;
  if (f.group) where.group = { name: { contains: f.group, mode: "insensitive" } };
  if (f.memberId) where.supportMemberId = f.memberId;
  if (f.teamId) where.supportTeamId = f.teamId;
  const from = parseDhakaDayFromInput(f.dateFrom);
  const to = parseDhakaDayFromInput(f.dateTo);
  if (from || to) where.supportRepliedAt = { ...(from ? { gte: from.start } : {}), ...(to ? { lt: to.end } : {}) };
  if (f.minMinutes !== null || f.maxMinutes !== null) {
    where.responseSeconds = {
      ...(f.minMinutes !== null ? { gte: f.minMinutes * 60 } : {}),
      ...(f.maxMinutes !== null ? { lte: f.maxMinutes * 60 } : {}),
    };
  }
  return where;
}

function responseOrder(sort: ResponseSort): Prisma.SupportResponseEpisodeOrderByWithRelationInput[] {
  switch (sort) {
    case "slowest":
      return [{ responseSeconds: "desc" }, { id: "asc" }];
    case "fastest":
      return [{ responseSeconds: "asc" }, { id: "asc" }];
    case "group":
      return [{ group: { name: "asc" } }, { supportRepliedAt: "desc" }, { id: "asc" }];
    default:
      return [{ supportRepliedAt: "desc" }, { id: "asc" }];
  }
}

const RESPONSE_SELECT = {
  id: true,
  firstIncomingAt: true,
  supportRepliedAt: true,
  responseSeconds: true,
  incomingMessageCount: true,
  createdAt: true,
  group: { select: { id: true, name: true, whatsappGroupId: true } },
  account: { select: { id: true, label: true } },
  supportMember: { select: { id: true, name: true } },
  supportTeam: { select: { name: true } },
  supportReplyMessage: { select: { body: true } },
} satisfies Prisma.SupportResponseEpisodeSelect;

export interface ResponseRow {
  id: string;
  groupId: string;
  groupName: string;
  whatsappGroupId: string;
  accountLabel: string;
  firstIncomingAt: Date;
  supportRepliedAt: Date;
  responseSeconds: number;
  messageCount: number;
  memberId: string | null;
  memberName: string | null;
  teamName: string | null;
  replyText: string | null;
  createdAt: Date;
}

type ResponseRecord = Prisma.SupportResponseEpisodeGetPayload<{ select: typeof RESPONSE_SELECT }>;
function toResponseRow(e: ResponseRecord): ResponseRow {
  return {
    id: e.id,
    groupId: e.group.id,
    groupName: e.group.name,
    whatsappGroupId: e.group.whatsappGroupId,
    accountLabel: e.account.label,
    firstIncomingAt: e.firstIncomingAt,
    supportRepliedAt: e.supportRepliedAt!,
    responseSeconds: e.responseSeconds ?? 0,
    messageCount: e.incomingMessageCount,
    memberId: e.supportMember?.id ?? null,
    memberName: e.supportMember?.name ?? null,
    teamName: e.supportTeam?.name ?? null,
    replyText: e.supportReplyMessage?.body ?? null,
    createdAt: e.createdAt,
  };
}

export async function listResponses(f: ResponseFilters, page: number, pageSize: number) {
  const where = responseWhere(f);
  const [rows, total, stats] = await Promise.all([
    prisma.supportResponseEpisode.findMany({ where, orderBy: responseOrder(f.sort), skip: (page - 1) * pageSize, take: pageSize, select: RESPONSE_SELECT }),
    prisma.supportResponseEpisode.count({ where }),
    prisma.supportResponseEpisode.aggregate({ where, _avg: { responseSeconds: true }, _max: { responseSeconds: true } }),
  ]);
  return { rows: rows.map(toResponseRow), total, averageSeconds: stats._avg.responseSeconds, slowestSeconds: stats._max.responseSeconds };
}

export async function responsesForExport(f: ResponseFilters, ids: string[] | null): Promise<ResponseRow[]> {
  const where = ids ? { AND: [responseWhere(f), { id: { in: ids } }] } : responseWhere(f);
  const rows = await prisma.supportResponseEpisode.findMany({ where, orderBy: responseOrder(f.sort), take: SUPPORT_RESPONSE_MAX_SELECTION + 1, select: RESPONSE_SELECT });
  return rows.map(toResponseRow);
}

// ---------------------------------------------------------------- shared

/** Which Teams are the Support Team, by name — empty means tracking is not set up. */
export async function getSupportResponseSetup(): Promise<{ teams: Array<{ id: string; name: string }> }> {
  const settings = await prisma.supportActivitySettings.findUnique({ where: { id: "global" }, select: { responseTrackingTeamIds: true } });
  const ids = settings?.responseTrackingTeamIds ?? [];
  if (!ids.length) return { teams: [] };
  const teams = await prisma.team.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return { teams };
}

export async function getSupportResponseFilterOptions() {
  const [accounts, members, teams] = await Promise.all([
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true }, orderBy: { label: "asc" } }),
    prisma.internalTeamMember.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { accounts, members, teams };
}
