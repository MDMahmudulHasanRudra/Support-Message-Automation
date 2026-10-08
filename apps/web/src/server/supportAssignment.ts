import type { Prisma, SupportAssignmentStatus } from "@prisma/client";
import { CLOSED_ASSIGNMENT_STATUSES, getDhakaDayRange, hasReachablePhoneNumber, parseDhakaDayFromInput, PENDING_ASSIGNMENT_STATUSES } from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Read side of Support Assignment (SUPPORT_ASSIGNMENT.md). Every list — Unanswered, My
 * Assignments, Completed — goes through ONE `where` builder, so the rows a person sees are the rows
 * an action (assign selected, cancel) is allowed to touch.
 */

export const SUPPORT_ASSIGNMENT_PAGE_SIZES = [50, 100, 250, 500] as const;
/** The most cases one bulk action may touch. */
export const SUPPORT_ASSIGNMENT_MAX_SELECTION = 500;

/** Which list a page shows. */
export type AssignmentView = "all" | "unassigned" | "assigned" | "overdue" | "mine" | "closed";

export const OPEN_TABS = [
  { view: "all", label: "All" },
  { view: "unassigned", label: "Unassigned" },
  { view: "assigned", label: "Assigned" },
  { view: "overdue", label: "Overdue" },
] as const satisfies readonly { view: AssignmentView; label: string }[];

export const CLOSED_FILTERS = [
  { status: "COMPLETED", label: "Completed" },
  { status: "ANSWERED_BY_OTHER", label: "Answered by someone else" },
  { status: "CANCELLED", label: "Cancelled" },
  { status: "IGNORED", label: "Ignored (filtered)" },
] as const satisfies readonly { status: SupportAssignmentStatus; label: string }[];

export interface AssignmentFilters {
  view: AssignmentView;
  /** Only for the closed view: one of CLOSED_FILTERS, or "" for every finished case. */
  closedStatus: SupportAssignmentStatus | "";
  q: string;
  memberId: string;
  accountId: string;
  dateFrom: string;
  dateTo: string;
}

type Params = Record<string, string | undefined>;
const text = (v: string | undefined) => (v ?? "").trim();

export function parseAssignmentFilters(params: Params, view: AssignmentView): AssignmentFilters {
  const requested = text(params.status);
  const closedStatus = (CLOSED_FILTERS.some((f) => f.status === requested) ? requested : "") as AssignmentFilters["closedStatus"];
  return {
    view,
    closedStatus,
    q: text(params.q).slice(0, 120),
    memberId: text(params.memberId),
    accountId: text(params.accountId),
    dateFrom: text(params.dateFrom),
    dateTo: text(params.dateTo),
  };
}

export function parseOpenView(value: string | undefined): AssignmentView {
  return OPEN_TABS.some((t) => t.view === value) ? (value as AssignmentView) : "all";
}

/**
 * The single `where` every list and bulk action uses. `mineMemberId` is the roster member linked to
 * the viewer's login (null = nobody linked, which matches nothing rather than everything).
 */
export function assignmentWhere(f: AssignmentFilters, mineMemberId: string | null = null): Prisma.SupportAssignmentWhereInput {
  const and: Prisma.SupportAssignmentWhereInput[] = [];
  switch (f.view) {
    case "all":
      // Open cases in groups the account is still in: a wait in a group it has left cannot be
      // answered from here (the same rule as Messages → Unanswered groups).
      and.push({ status: { in: ["UNASSIGNED", "ASSIGNED", "OVERDUE"] }, group: { isActive: true } });
      break;
    case "unassigned":
      and.push({ status: "UNASSIGNED", group: { isActive: true } });
      break;
    case "assigned":
      and.push({ status: "ASSIGNED", group: { isActive: true } });
      break;
    case "overdue":
      and.push({ status: "OVERDUE", group: { isActive: true } });
      break;
    case "mine":
      and.push({ status: { in: [...PENDING_ASSIGNMENT_STATUSES] }, assignedMemberId: mineMemberId ?? "__nobody__" });
      break;
    case "closed":
      and.push(f.closedStatus ? { status: f.closedStatus } : { status: { in: [...CLOSED_ASSIGNMENT_STATUSES] } });
      break;
  }
  if (f.memberId) and.push({ OR: [{ assignedMemberId: f.memberId }, { responderMemberId: f.memberId }] });
  if (f.accountId) and.push({ accountId: f.accountId });
  if (f.q) {
    const contains = { contains: f.q, mode: "insensitive" as const };
    and.push({
      OR: [
        { group: { name: contains } },
        { firstMessage: { body: contains } },
        { firstMessage: { senderName: contains } },
        { firstMessage: { senderPhone: contains } },
      ],
    });
  }
  const created: Prisma.DateTimeFilter = {};
  const from = parseDhakaDayFromInput(f.dateFrom);
  const to = parseDhakaDayFromInput(f.dateTo);
  if (from) created.gte = from.start;
  if (to) created.lt = to.end;
  if (Object.keys(created).length) and.push({ createdAt: created });
  return { AND: and };
}

function orderFor(view: AssignmentView): Prisma.SupportAssignmentOrderByWithRelationInput[] {
  switch (view) {
    case "closed":
      return [{ closedAt: "desc" }, { id: "asc" }];
    case "assigned":
    case "overdue":
    case "mine":
      return [{ dueAt: "asc" }, { id: "asc" }];
    default:
      // Longest-waiting customer first.
      return [{ firstMessageAt: "asc" }, { createdAt: "asc" }, { id: "asc" }];
  }
}

const ROW_SELECT = {
  id: true,
  status: true,
  groupId: true,
  firstMessageAt: true,
  createdAt: true,
  assignedAt: true,
  dueAt: true,
  overdueAt: true,
  escalationLevel: true,
  completedAt: true,
  closedAt: true,
  closeReason: true,
  responseSeconds: true,
  ignoredMessageCount: true,
  group: { select: { name: true } },
  account: { select: { label: true } },
  firstMessage: { select: { body: true, senderName: true, senderPhone: true } },
  assignedMember: { select: { id: true, name: true } },
  responderMember: { select: { id: true, name: true } },
} satisfies Prisma.SupportAssignmentSelect;

export interface AssignmentRow {
  id: string;
  status: SupportAssignmentStatus;
  groupId: string;
  groupName: string;
  accountLabel: string;
  customer: string | null;
  message: string | null;
  receivedAt: string;
  assignedAt: string | null;
  dueAt: string | null;
  overdueAt: string | null;
  escalated: boolean;
  completedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  responseSeconds: number | null;
  ignoredMessageCount: number;
  assignedTo: { id: string; name: string } | null;
  answeredBy: { id: string; name: string } | null;
}

type RowRecord = Prisma.SupportAssignmentGetPayload<{ select: typeof ROW_SELECT }>;

function toRow(r: RowRecord): AssignmentRow {
  return {
    id: r.id,
    status: r.status,
    groupId: r.groupId,
    groupName: r.group.name,
    accountLabel: r.account.label,
    customer: r.firstMessage ? r.firstMessage.senderName || r.firstMessage.senderPhone : null,
    message: r.firstMessage?.body ?? null,
    receivedAt: (r.firstMessageAt ?? r.createdAt).toISOString(),
    assignedAt: r.assignedAt?.toISOString() ?? null,
    dueAt: r.dueAt?.toISOString() ?? null,
    overdueAt: r.overdueAt?.toISOString() ?? null,
    escalated: r.escalationLevel > 0,
    completedAt: r.completedAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    closeReason: r.closeReason,
    responseSeconds: r.responseSeconds,
    ignoredMessageCount: r.ignoredMessageCount,
    assignedTo: r.assignedMember,
    answeredBy: r.responderMember,
  };
}

export async function listAssignments(f: AssignmentFilters, page: number, pageSize: number, mineMemberId: string | null = null) {
  const where = assignmentWhere(f, mineMemberId);
  const [rows, total] = await Promise.all([
    prisma.supportAssignment.findMany({ where, orderBy: orderFor(f.view), skip: (page - 1) * pageSize, take: pageSize, select: ROW_SELECT }),
    prisma.supportAssignment.count({ where }),
  ]);
  return { rows: rows.map(toRow), total };
}

/** The tab counts on Unanswered, and the "filtered today" figure that shows the filtering working. */
export async function getAssignmentCounts(now: Date) {
  const today = getDhakaDayRange(now);
  const [byStatus, ignoredToday, openedToday] = await Promise.all([
    prisma.supportAssignment.groupBy({
      by: ["status"],
      where: { status: { in: ["UNASSIGNED", "ASSIGNED", "OVERDUE"] }, group: { isActive: true } },
      _count: { _all: true },
    }),
    prisma.supportAssignment.count({ where: { createdAt: { gte: today.start, lt: today.end }, status: "IGNORED" } }),
    prisma.supportAssignment.count({ where: { createdAt: { gte: today.start, lt: today.end } } }),
  ]);
  const count = (s: SupportAssignmentStatus) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const unassigned = count("UNASSIGNED");
  const assigned = count("ASSIGNED");
  const overdue = count("OVERDUE");
  return { all: unassigned + assigned + overdue, unassigned, assigned, overdue, ignoredToday, openedToday };
}

export interface AssignableMember {
  id: string;
  name: string;
  role: string;
  teamName: string | null;
  /** Can receive a WhatsApp direct message (has a real phone number, not only a WhatsApp id). */
  reachable: boolean;
  /** Cases currently assigned to them and not yet answered. */
  openCount: number;
}

/**
 * Who can be given a case: ACTIVE team members, narrowed to the chosen Teams when the settings name
 * any. With each one's current open load, so work is spread by sight rather than by memory.
 */
export async function getAssignableMembers(assignableTeamIds: string[]): Promise<AssignableMember[]> {
  const [members, load] = await Promise.all([
    prisma.internalTeamMember.findMany({
      where: { status: "ACTIVE", ...(assignableTeamIds.length ? { teamId: { in: assignableTeamIds } } : {}) },
      select: { id: true, name: true, role: true, phoneNumber: true, whatsappId: true, team: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.supportAssignment.groupBy({
      by: ["assignedMemberId"],
      where: { status: { in: [...PENDING_ASSIGNMENT_STATUSES] }, assignedMemberId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const loadBy = new Map(load.map((l) => [l.assignedMemberId, l._count._all]));
  return members.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    teamName: m.team?.name ?? null,
    reachable: hasReachablePhoneNumber(m),
    openCount: loadBy.get(m.id) ?? 0,
  }));
}

/** The settings row; null means never saved — the module is off, with the schema's defaults. */
export async function getSupportAssignmentSettings() {
  return prisma.supportAssignmentSettings.findUnique({ where: { id: "global" } });
}

/** The roster member linked to this login in the current project, if any. */
export async function getMemberForUser(userId: string) {
  return prisma.internalTeamMember.findFirst({ where: { userId }, select: { id: true, name: true, status: true } });
}

/** Whether Support Response tracking (which this module is built on) has a Support Team chosen. */
export async function hasSupportTeamConfigured(): Promise<boolean> {
  const row = await prisma.supportActivitySettings.findUnique({ where: { id: "global" }, select: { responseTrackingTeamIds: true } });
  return (row?.responseTrackingTeamIds.length ?? 0) > 0;
}

export async function getAssignmentFilterOptions() {
  const [accounts, members] = await Promise.all([
    prisma.whatsAppAccount.findMany({ select: { id: true, label: true }, orderBy: { label: "asc" } }),
    prisma.internalTeamMember.findMany({ select: { id: true, name: true, status: true }, orderBy: { name: "asc" } }),
  ]);
  return { accounts, members };
}

/** One case with its full history, for the detail page. */
export async function getAssignmentDetail(id: string) {
  return prisma.supportAssignment.findFirst({
    where: { id },
    select: {
      ...ROW_SELECT,
      whatsappGroupId: true,
      assignmentRound: true,
      slaMinutes: true,
      nextEscalationAt: true,
      assignedBy: { select: { name: true, username: true } },
      completionMessage: { select: { body: true, timestampWa: true } },
      events: {
        orderBy: [{ at: "asc" }, { id: "asc" }],
        select: {
          id: true,
          type: true,
          at: true,
          detail: true,
          recipient: true,
          member: { select: { name: true } },
          actorUser: { select: { name: true, username: true } },
          notification: { select: { status: true, sentAt: true, failureReason: true, attemptCount: true } },
        },
      },
    },
  });
}
