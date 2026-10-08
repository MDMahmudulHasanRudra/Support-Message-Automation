import type { Prisma, SupportAssignmentStatus } from "@prisma/client";
import {
  computeSupportAssignmentReport,
  getDhakaDayRange,
  getDhakaMonthRange,
  getDhakaWeekRange,
  isSupportAssignmentStatus,
  parseDhakaDayFromInput,
  slaOutcome,
  type ReportCaseInput,
  type SupportAssignmentReport,
} from "@support-automation/shared";
import { prisma } from "@/server/db";

/**
 * Support Assignment → Report, and the same report under Reports → All Reports
 * (SUPPORT_ASSIGNMENT.md). One loader for the page and both exports; the counting itself is
 * `computeSupportAssignmentReport` in packages/shared, so screen and file cannot disagree.
 *
 * The period selects cases by when they OPENED (the customer's first message), and every figure is
 * about those cases — including what happened to them later.
 */

export const REPORT_PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_week", label: "This week" },
  { id: "this_month", label: "This month" },
  { id: "custom", label: "Custom" },
] as const;
type PresetId = (typeof REPORT_PRESETS)[number]["id"];

/** Same ceiling as the Team Report: a custom range longer than this is cut to it, and says so. */
const MAX_RANGE_DAYS = 92;
/** Cases read for one report. Far above a busy quarter; past it the page says the figures are partial. */
const MAX_CASES = 20_000;

export interface ReportFilters {
  preset: PresetId;
  from: string;
  to: string;
  start: Date;
  end: Date;
  rangeLabel: string;
  rangeCapped: boolean;
  memberId: string;
  group: string;
  status: SupportAssignmentStatus | "";
  sla: "" | "met" | "missed";
}

type Params = Record<string, string | undefined>;
const DAY_MS = 86_400_000;
const isoDay = (d: Date) => new Date(d.getTime() + 6 * 3_600_000).toISOString().slice(0, 10);

export function parseReportFilters(params: Params, now: Date): ReportFilters {
  const preset = (REPORT_PRESETS.some((p) => p.id === params.preset) ? params.preset : "this_month") as PresetId;
  let range: { start: Date; end: Date };
  let rangeCapped = false;
  switch (preset) {
    case "today":
      range = getDhakaDayRange(now);
      break;
    case "yesterday":
      range = getDhakaDayRange(new Date(now.getTime() - DAY_MS));
      break;
    case "this_week":
      range = getDhakaWeekRange(now);
      break;
    case "this_month":
      range = getDhakaMonthRange(now);
      break;
    case "custom": {
      const from = parseDhakaDayFromInput(params.from) ?? getDhakaDayRange(now);
      const to = parseDhakaDayFromInput(params.to) ?? getDhakaDayRange(now);
      const start = from.start <= to.start ? from.start : to.start;
      let end = from.start <= to.start ? to.end : from.end;
      if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        end = new Date(start.getTime() + MAX_RANGE_DAYS * DAY_MS);
        rangeCapped = true;
      }
      range = { start, end };
    }
  }
  const status = params.status && isSupportAssignmentStatus(params.status) ? params.status : "";
  const sla = params.sla === "met" || params.sla === "missed" ? params.sla : "";
  const lastDay = new Date(range.end.getTime() - 1);
  return {
    preset,
    from: isoDay(range.start),
    to: isoDay(lastDay),
    start: range.start,
    end: range.end,
    rangeLabel: isoDay(range.start) === isoDay(lastDay) ? isoDay(range.start) : `${isoDay(range.start)} – ${isoDay(lastDay)}`,
    rangeCapped,
    memberId: (params.memberId ?? "").trim(),
    group: (params.group ?? "").trim().slice(0, 120),
    status,
    sla,
  };
}

export interface ReportCaseRow {
  id: string;
  groupName: string;
  accountLabel: string;
  customer: string | null;
  message: string | null;
  status: SupportAssignmentStatus;
  openedAt: Date;
  assignedTo: string | null;
  assignedAt: Date | null;
  dueAt: Date | null;
  completedAt: Date | null;
  answeredBy: string | null;
  responseSeconds: number | null;
  sla: "MET" | "MISSED" | null;
}

export async function loadSupportAssignmentReport(f: ReportFilters): Promise<{
  report: SupportAssignmentReport;
  cases: ReportCaseRow[];
  memberNames: Map<string, string>;
  truncated: boolean;
}> {
  const and: Prisma.SupportAssignmentWhereInput[] = [{ createdAt: { gte: f.start, lt: f.end } }];
  if (f.group) and.push({ group: { name: { contains: f.group, mode: "insensitive" } } });
  if (f.status) and.push({ status: f.status });
  if (f.memberId) {
    and.push({
      OR: [
        { assignedMemberId: f.memberId },
        { responderMemberId: f.memberId },
        { events: { some: { memberId: f.memberId, type: { in: ["ASSIGNED", "REASSIGNED"] } } } },
      ],
    });
  }

  const rows = await prisma.supportAssignment.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_CASES + 1,
    select: {
      id: true,
      status: true,
      groupId: true,
      createdAt: true,
      firstMessageAt: true,
      assignedAt: true,
      dueAt: true,
      overdueAt: true,
      completedAt: true,
      closedAt: true,
      responseSeconds: true,
      assignedMemberId: true,
      responderMemberId: true,
      group: { select: { name: true } },
      account: { select: { label: true } },
      firstMessage: { select: { body: true, senderName: true, senderPhone: true } },
      assignedMember: { select: { name: true } },
      responderMember: { select: { name: true } },
      events: {
        where: { type: { in: ["ASSIGNED", "REASSIGNED", "OVERDUE"] } },
        orderBy: [{ at: "asc" }, { id: "asc" }],
        select: { type: true, memberId: true },
      },
    },
  });
  const truncated = rows.length > MAX_CASES;
  const kept = rows.slice(0, MAX_CASES);

  const inputs: ReportCaseInput[] = kept.map((r) => ({
    id: r.id,
    status: r.status,
    groupId: r.groupId,
    groupName: r.group.name,
    assignedAt: r.assignedAt?.getTime() ?? null,
    dueAt: r.dueAt?.getTime() ?? null,
    overdueAt: r.overdueAt?.getTime() ?? null,
    completedAt: r.completedAt?.getTime() ?? null,
    closedAt: r.closedAt?.getTime() ?? null,
    responseSeconds: r.responseSeconds,
    assignedMemberId: r.assignedMemberId,
    responderMemberId: r.responderMemberId,
    events: r.events.map((e) => ({ type: e.type as "ASSIGNED" | "REASSIGNED" | "OVERDUE", memberId: e.memberId })),
  }));
  const slaFiltered = f.sla
    ? inputs.filter((c) => slaOutcome(c) === (f.sla === "met" ? "MET" : "MISSED"))
    : inputs;
  const keptIds = new Set(slaFiltered.map((c) => c.id));
  const inputById = new Map(inputs.map((c) => [c.id, c]));

  const memberIds = new Set<string>();
  for (const c of slaFiltered) {
    if (c.assignedMemberId) memberIds.add(c.assignedMemberId);
    for (const e of c.events) if (e.memberId) memberIds.add(e.memberId);
  }
  const members = memberIds.size
    ? await prisma.internalTeamMember.findMany({ where: { id: { in: [...memberIds] } }, select: { id: true, name: true } })
    : [];

  return {
    report: computeSupportAssignmentReport(slaFiltered),
    cases: kept
      .filter((r) => keptIds.has(r.id))
      .map((r) => ({
        id: r.id,
        groupName: r.group.name,
        accountLabel: r.account.label,
        customer: r.firstMessage ? r.firstMessage.senderName || r.firstMessage.senderPhone : null,
        message: r.firstMessage?.body ?? null,
        status: r.status,
        openedAt: r.firstMessageAt ?? r.createdAt,
        assignedTo: r.assignedMember?.name ?? null,
        assignedAt: r.assignedAt,
        dueAt: r.dueAt,
        completedAt: r.completedAt,
        answeredBy: r.responderMember?.name ?? null,
        responseSeconds: r.responseSeconds,
        sla: slaOutcome(inputById.get(r.id)!),
      })),
    memberNames: new Map(members.map((m) => [m.id, m.name])),
    truncated,
  };
}
