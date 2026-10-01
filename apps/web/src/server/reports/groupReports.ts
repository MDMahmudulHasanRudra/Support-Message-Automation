import { Prisma } from "@prisma/client";
import {
  classifyGroupActivity,
  daysBetween,
  DEFAULT_LOW_ACTIVITY_THRESHOLD,
  GROUP_ACTIVITY_LABELS,
  groupActivityTrend,
  groupMessageCounts,
  groupWaitsBy,
  responseStats,
  type GroupActivityStatus,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { bucketLabel } from "@/server/teamReport";
import { bucketColumnLabel } from "@/server/teamReportTables";
import { measuredTo, type ReportContext } from "./context";
import { count, dateOnly, duration, percent } from "./format";
import type { BuiltReport, ReportTable } from "./types";

/** Group-oriented reports: Inactive Groups, Group Support Coverage, Group Activity Trend. */

export interface MonitoredGroup {
  whatsappGroupId: string;
  name: string;
  assignedMemberId: string | null;
}

/**
 * Today's monitored, active groups — one per WhatsApp group (the Primary account's copy names it) —
 * within the group and account filters and the group scope rule. "Today's" deliberately: whether a
 * group was monitored last month is not recorded anywhere, and the page says so.
 */
export async function loadMonitoredGroups(ctx: ReportContext): Promise<MonitoredGroup[]> {
  const { groupKeys, accountId } = ctx.filters;
  const rows = await prisma.whatsAppGroup.findMany({
    where: {
      isMonitored: true,
      isActive: true,
      ...(groupKeys?.length ? { whatsappGroupId: { in: groupKeys } } : {}),
      ...(accountId ? { accountId } : {}),
    },
    select: { whatsappGroupId: true, name: true, assignedTeamMemberId: true, account: { select: { isPrimary: true } } },
  });
  const out = new Map<string, MonitoredGroup>();
  for (const row of rows) {
    const existing = out.get(row.whatsappGroupId);
    if (!existing || row.account.isPrimary) {
      out.set(row.whatsappGroupId, {
        whatsappGroupId: row.whatsappGroupId,
        name: row.name,
        assignedMemberId: row.assignedTeamMemberId ?? existing?.assignedMemberId ?? null,
      });
    } else if (!existing.assignedMemberId && row.assignedTeamMemberId) existing.assignedMemberId = row.assignedTeamMemberId;
  }
  return [...out.values()].filter((g) => ctx.groupInScope(g.whatsappGroupId, g.assignedMemberId));
}

/** The assigned member of a group the dataset knows (any group with a message in the period). */
const assignedOf = (ctx: ReportContext, groupKey: string) => ctx.data.groups.get(groupKey)?.assignedMemberId ?? null;

// ---------------------------------------------------------------------------------------------

const STATUS_ORDER: GroupActivityStatus[] = ["CUSTOMER_NO_REPLY", "NO_CUSTOMER_ACTIVITY", "LOW_ACTIVITY", "ACTIVE"];

export async function buildInactiveGroups(ctx: ReportContext): Promise<BuiltReport> {
  const lowRaw = Number(ctx.params.low);
  const low = [3, 5, 10, 20].includes(lowRaw) ? lowRaw : DEFAULT_LOW_ACTIVITY_THRESHOLD;
  const statusFilter = ctx.params.status && (ctx.params.status === "all" || ctx.params.status in GROUP_ACTIVITY_LABELS) ? ctx.params.status : "attention";

  const groups = await loadMonitoredGroups(ctx);
  const counts = groupMessageCounts(ctx.data.messages, ctx.rangeStart, ctx.rangeEnd);

  // Each group's last stored message before the period ends — any kind, any account in the filter.
  // One index probe per group (LATERAL on [groupId, timestampWa]), never a scan of Message.
  const lastRows = groups.length
    ? await prisma.$queryRaw<Array<{ wgid: string; lastAt: Date | null }>>`
        SELECT g."whatsappGroupId" AS wgid, MAX(last.ts) AS "lastAt"
        FROM "WhatsAppGroup" g
        CROSS JOIN LATERAL (
          SELECT m."timestampWa" AS ts FROM "Message" m
          WHERE m."groupId" = g."id" AND m."timestampWa" < ${new Date(ctx.rangeEnd)}
            AND m."direction" <> 'SYSTEM'
          ORDER BY m."timestampWa" DESC
          LIMIT 1
        ) last
        WHERE g."projectId" = ${await activeProjectId()}
          AND g."whatsappGroupId" IN (${Prisma.join(groups.map((g) => g.whatsappGroupId))})
          ${ctx.filters.accountId ? Prisma.sql`AND g."accountId" = ${ctx.filters.accountId}` : Prisma.empty}
        GROUP BY g."whatsappGroupId"`
    : [];
  const lastAt = new Map(lastRows.map((r) => [r.wgid, r.lastAt?.getTime() ?? null]));
  const to = measuredTo(ctx);

  const classified = groups.map((g) => {
    const c = counts.get(g.whatsappGroupId);
    return { group: g, counts: c, status: classifyGroupActivity(c, low), lastAt: lastAt.get(g.whatsappGroupId) ?? null };
  });
  const byStatus = (s: GroupActivityStatus) => classified.filter((row) => row.status === s).length;
  const shown = classified
    .filter((row) => (statusFilter === "all" ? true : statusFilter === "attention" ? row.status !== "ACTIVE" : row.status === statusFilter))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        (a.lastAt ?? 0) - (b.lastAt ?? 0) ||
        a.group.name.localeCompare(b.group.name),
    );

  const table: ReportTable = {
    id: "groups",
    sheet: "Detailed",
    title: `Groups (${count(shown.length)})`,
    description: "Monitored groups and their status for the period, the ones needing attention first. Select a group for its Team Report.",
    noun: { singular: "group", plural: "groups" },
    columns: [
      { label: "Group" },
      { label: "Status" },
      { label: "Assigned" },
      { label: "Customer msgs", numeric: true },
      { label: "Replies", numeric: true },
      { label: "All messages", numeric: true },
      { label: "Last message", muted: true },
      { label: "Days since last message", numeric: true },
    ],
    rows: shown.map(({ group, counts: c, status, lastAt: last }) => {
      const days = daysBetween(last, to);
      const replies = (c?.member ?? 0) + (c?.business ?? 0);
      return {
        key: group.whatsappGroupId,
        cells: [
          group.name,
          GROUP_ACTIVITY_LABELS[status],
          group.assignedMemberId ? ctx.memberName(group.assignedMemberId) : "—",
          c?.customer ?? 0,
          replies,
          c?.total ?? 0,
          last === null ? "No stored messages" : dateOnly(last),
          days === null ? "—" : days,
        ],
        sort: [
          group.name.toLowerCase(),
          STATUS_ORDER.indexOf(status),
          group.assignedMemberId ? ctx.memberName(group.assignedMemberId).toLowerCase() : "~",
          c?.customer ?? 0,
          replies,
          c?.total ?? 0,
          last ?? 0,
          days ?? Number.MAX_SAFE_INTEGER,
        ],
        sub: [group.whatsappGroupId, null, null, null, null, null, null, null],
      };
    }),
  };

  return {
    id: "inactive-groups",
    title: "Inactive Groups",
    question: "Which monitored groups have gone quiet, or are waiting with no reply?",
    tiles: [
      { label: "Monitored groups", value: count(groups.length), hint: "active and monitored today" },
      {
        label: "Customer activity, no reply",
        value: count(byStatus("CUSTOMER_NO_REPLY")),
        hint: "customers wrote, nobody answered",
        tone: byStatus("CUSTOMER_NO_REPLY") > 0 ? "danger" : "neutral",
      },
      { label: "No customer activity", value: count(byStatus("NO_CUSTOMER_ACTIVITY")), hint: "no customer message" },
      { label: "Low activity", value: count(byStatus("LOW_ACTIVITY")), hint: `fewer than ${low} messages` },
      { label: "Active", value: count(byStatus("ACTIVE")), tone: "success" },
    ],
    visuals: [],
    tables: [table],
    notes: [
      {
        tone: "info",
        text: "Groups are the ones monitored and active today: whether a group was monitored in the past is not recorded. No customer activity is not a problem in itself — some groups are quiet.",
      },
    ],
    formulas: [
      {
        title: "Status",
        text: `Checked in this order for the period: no customer message → No customer activity; customer messages but no reply from a team member or the business number → Customer activity, no reply; fewer than ${low} messages in total → Low activity; otherwise Active.`,
      },
      {
        title: "Days since last message",
        text: "Whole days from the group's last stored message of any kind (before the period end) to the end of the period, or to now if the period has not ended.",
      },
    ],
    selects: [
      {
        name: "status",
        label: "Show",
        value: statusFilter,
        options: [
          { value: "attention", label: "Needing attention" },
          { value: "all", label: "All monitored groups" },
          ...STATUS_ORDER.map((s) => ({ value: s, label: GROUP_ACTIVITY_LABELS[s] })),
        ],
      },
      {
        name: "low",
        label: "Low activity below",
        value: String(low),
        options: [3, 5, 10, 20].map((n) => ({ value: String(n), label: `${n} messages` })),
      },
    ],
    usesGranularity: false,
    emptyMessage: groups.length === 0 ? "No monitored, active group matches these filters." : null,
  };
}

// ---------------------------------------------------------------------------------------------

export function buildGroupCoverage(ctx: ReportContext): BuiltReport {
  const waits = ctx.data.result.waits.filter((w) => ctx.groupInScope(w.groupKey, assignedOf(ctx, w.groupKey)));
  const byGroup = groupWaitsBy(waits, (w) => w.groupKey);
  const overall = responseStats(waits);
  const rows = [...byGroup.entries()].map(([groupKey, list]) => ({ groupKey, stats: responseStats(list) }));
  const groupsWithNever = rows.filter((r) => r.stats.never > 0).length;

  const table: ReportTable = {
    id: "groups",
    sheet: "Detailed",
    title: `Groups with customer waits (${count(rows.length)})`,
    description: "Lowest coverage first. A group with no customer wait in the period is not listed — see Inactive Groups.",
    noun: { singular: "group", plural: "groups" },
    columns: [
      { label: "Group" },
      { label: "Assigned" },
      { label: "Waits", numeric: true },
      { label: "Answered", numeric: true },
      { label: "In time", numeric: true },
      { label: "Late", numeric: true },
      { label: "Never answered", numeric: true },
      { label: "Still waiting", numeric: true },
      { label: "Coverage" },
      { label: "In time %" },
      { label: "Median response" },
    ],
    rows: rows
      .sort((a, b) => (a.stats.coverageRatio ?? 2) - (b.stats.coverageRatio ?? 2) || b.stats.waits - a.stats.waits)
      .map(({ groupKey, stats }) => {
        const assigned = assignedOf(ctx, groupKey);
        return {
          key: groupKey,
          cells: [
            ctx.groupName(groupKey),
            assigned ? ctx.memberName(assigned) : "—",
            stats.waits,
            stats.answered,
            stats.within,
            stats.late,
            stats.never,
            stats.pending,
            percent(stats.coverageRatio),
            percent(stats.slaRatio),
            duration(stats.medianSeconds),
          ],
          sort: [
            ctx.groupName(groupKey).toLowerCase(),
            assigned ? ctx.memberName(assigned).toLowerCase() : "~",
            stats.waits,
            stats.answered,
            stats.within,
            stats.late,
            stats.never,
            stats.pending,
            stats.coverageRatio ?? 2,
            stats.slaRatio ?? 2,
            stats.medianSeconds ?? Number.MAX_SAFE_INTEGER,
          ],
          sub: [groupKey, null, null, null, null, null, null, null, null, null, null],
        };
      }),
  };

  return {
    id: "group-coverage",
    title: "Group Support Coverage",
    question: "In each group, how many customer waits got an answer?",
    tiles: [
      { label: "Groups with customer waits", value: count(rows.length) },
      { label: "Coverage", value: percent(overall.coverageRatio), hint: `${count(overall.answered)} of ${count(overall.answered + overall.never)} answered` },
      { label: "Answered in time", value: percent(overall.slaRatio), hint: `${count(overall.within)} waits` },
      {
        label: "Never answered",
        value: count(overall.never),
        hint: `in ${count(groupsWithNever)} group(s)`,
        tone: overall.never > 0 ? "danger" : "neutral",
      },
      { label: "Still waiting", value: count(overall.pending), hint: "inside their time — not counted yet" },
    ],
    visuals: [
      {
        kind: "bars",
        title: "Most never-answered waits",
        description: "The groups with the most customer waits nobody answered.",
        unit: "waits",
        items: rows
          .filter((r) => r.stats.never > 0)
          .sort((a, b) => b.stats.never - a.stats.never)
          .slice(0, 10)
          .map((r) => ({ id: r.groupKey, label: ctx.groupName(r.groupKey), value: r.stats.never })),
      },
    ],
    tables: [table],
    notes: [],
    formulas: [
      {
        title: "Coverage",
        text: "Waits answered (in time or late) ÷ waits that needed an answer (answered + never answered). Waits still inside their time are left out until they are decided.",
      },
      { title: "In time %", text: "Waits answered within the group's Missed threshold ÷ the same denominator." },
      { title: "A wait", text: "The Team Report's: a customer message after a reply (or none) starts one, a run of lines is one wait, and the next reply ends it." },
    ],
    selects: [],
    usesGranularity: false,
    emptyMessage: waits.length === 0 ? `No customer waits started in ${ctx.data.range.label} for these filters.` : null,
  };
}

// ---------------------------------------------------------------------------------------------

export async function buildGroupTrend(ctx: ReportContext): Promise<BuiltReport> {
  const granularity = ctx.filters.granularity;
  const inScope = (groupKey: string) => ctx.groupInScope(groupKey, assignedOf(ctx, groupKey));
  const messages = ctx.data.messages.filter((m) => inScope(m.groupKey));
  const waits = ctx.data.result.waits.filter((w) => inScope(w.groupKey));
  const rows = groupActivityTrend(messages, waits, { rangeStart: ctx.rangeStart, rangeEnd: ctx.rangeEnd, granularity });
  const monitored = await loadMonitoredGroups(ctx);
  const total = rows.reduce(
    (acc, r) => ({ customer: acc.customer + r.customerMessages, replies: acc.replies + r.replies, waits: acc.waits + r.waits, missed: acc.missed + r.missed }),
    { customer: 0, replies: 0, waits: 0, missed: 0 },
  );
  const activeOverall = new Set(messages.filter((m) => m.ts >= ctx.rangeStart && m.ts < ctx.rangeEnd).map((m) => m.groupKey));
  const quietMonitored = monitored.filter((g) => !activeOverall.has(g.whatsappGroupId)).length;
  const labelOf = (key: string) => bucketLabel(key, granularity);

  return {
    id: "group-trend",
    title: "Group Activity Trend",
    question: "Are groups getting busier or quieter?",
    tiles: [
      { label: "Customer messages", value: count(total.customer) },
      { label: "Replies", value: count(total.replies), hint: "team members and business number" },
      { label: "Groups with a message", value: count(activeOverall.size), hint: "at least once in the period" },
      {
        label: "Monitored groups with no message",
        value: count(quietMonitored),
        hint: `of ${count(monitored.length)} monitored today`,
      },
      { label: "Customer waits", value: count(total.waits) },
      { label: "Missed", value: count(total.missed), tone: total.missed > 0 ? "warning" : "neutral" },
    ],
    visuals: [
      {
        kind: "columns",
        title: "Customer messages",
        description: `Per ${granularity}.`,
        unit: "messages",
        data: rows.map((r) => ({ label: labelOf(r.key), value: r.customerMessages })),
      },
      {
        kind: "columns",
        title: "Groups with a message",
        description: `Per ${granularity}.`,
        unit: "groups",
        data: rows.map((r) => ({ label: labelOf(r.key), value: r.activeGroups })),
      },
    ],
    tables: [
      {
        id: "buckets",
        sheet: "Detailed",
        title: `By ${granularity}`,
        description: "Every bucket of the period, including empty ones — a gap is information.",
        noun: granularity === "day" ? { singular: "day", plural: "days" } : granularity === "week" ? { singular: "week", plural: "weeks" } : { singular: "month", plural: "months" },
        columns: [
          { label: bucketColumnLabel(granularity) },
          { label: "Customer msgs", numeric: true },
          { label: "Replies", numeric: true },
          { label: "Groups with a message", numeric: true },
          { label: "Groups with no reply", numeric: true },
          { label: "Waits", numeric: true },
          { label: "Missed", numeric: true },
        ],
        rows: rows.map((r) => ({
          key: r.key,
          cells: [labelOf(r.key), r.customerMessages, r.replies, r.activeGroups, r.unansweredGroups, r.waits, r.missed],
          sort: [r.key, r.customerMessages, r.replies, r.activeGroups, r.unansweredGroups, r.waits, r.missed],
        })),
      },
    ],
    notes: [
      {
        tone: "info",
        text: "\"Monitored groups with no message\" compares against the groups monitored today; whether a group was monitored in the past is not recorded.",
      },
    ],
    formulas: [
      { title: "Groups with a message", text: "Groups with at least one stored message (any kind) in the bucket." },
      {
        title: "Groups with no reply",
        text: "Groups whose customers wrote in the bucket and that got no reply (team member or business number) in the same bucket. A reply the next day counts in the next bucket.",
      },
      { title: "Waits and Missed", text: "Counted in the bucket the wait started, with the Team Report's definitions." },
    ],
    selects: [],
    usesGranularity: true,
    emptyMessage: total.customer + total.replies === 0 ? `No group messages were stored in ${ctx.data.range.label} for these filters.` : null,
  };
}
