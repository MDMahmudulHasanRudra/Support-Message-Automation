import { Prisma } from "@prisma/client";
import {
  classifyGroupActivity,
  DATA_CONFIDENCE_LABELS,
  daysBetween,
  DEFAULT_LOW_ACTIVITY_THRESHOLD,
  GROUP_ACTIVITY_LABELS,
  groupActivityTrend,
  groupMessageCounts,
  groupDataConfidence,
  groupWaitsBy,
  normalizePhoneNumber,
  responseStats,
  type GroupActivityStatus,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { accountsByGroupKey } from "@/server/dataHealth";
import { bucketLabel, senderIdentifiers } from "@/server/teamReport";
import { bucketColumnLabel } from "@/server/teamReportTables";
import { measuredTo, type ReportContext } from "./context";
import { count, dateOnly, duration, percent, when } from "./format";
import type { BuiltReport, ReportTable } from "./types";

/** Group-oriented reports: Inactive Groups, Group Support Coverage, Group Activity Trend. */

export interface MonitoredGroup {
  whatsappGroupId: string;
  name: string;
  assignedMemberId: string | null;
  /** The accounts (within the account filter) that hold this group, Primary first. */
  accounts: Array<{ label: string; status: string }>;
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
    select: { whatsappGroupId: true, name: true, assignedTeamMemberId: true, account: { select: { isPrimary: true, label: true, status: true } } },
    orderBy: [{ account: { isPrimary: "desc" } }, { account: { label: "asc" } }],
  });
  const out = new Map<string, MonitoredGroup>();
  for (const row of rows) {
    const existing = out.get(row.whatsappGroupId);
    const account = { label: row.account.label, status: row.account.status };
    if (!existing || row.account.isPrimary) {
      out.set(row.whatsappGroupId, {
        whatsappGroupId: row.whatsappGroupId,
        name: row.name,
        assignedMemberId: row.assignedTeamMemberId ?? existing?.assignedMemberId ?? null,
        accounts: existing ? [account, ...existing.accounts] : [account],
      });
    } else {
      existing.accounts.push(account);
      if (!existing.assignedMemberId && row.assignedTeamMemberId) existing.assignedMemberId = row.assignedTeamMemberId;
    }
  }
  return [...out.values()].filter((g) => ctx.groupInScope(g.whatsappGroupId, g.assignedMemberId));
}

/** The assigned member of a group the dataset knows (any group with a message in the period). */
const assignedOf = (ctx: ReportContext, groupKey: string) => ctx.data.groups.get(groupKey)?.assignedMemberId ?? null;

// ---------------------------------------------------------------------------------------------

/** No communication first — the report's question — then the other ways a group can need attention. */
const STATUS_ORDER: GroupActivityStatus[] = ["NO_COMMUNICATION", "CUSTOMER_NO_REPLY", "NO_CUSTOMER_ACTIVITY", "LOW_ACTIVITY", "ACTIVE"];

/** A group's most recent stored message before the period ends, and who sent it. */
export interface LastActivity {
  at: number;
  senderPhone: string;
  senderName: string | null;
  direction: string;
}

/**
 * Each group's latest stored message before the period END — any kind, any account in the filter —
 * with its sender. For a group silent in the period that is its last activity BEFORE the period.
 * One index probe per group row (LATERAL on [groupId, timestampWa]), never a scan of Message, and the
 * project named explicitly: raw SQL is not covered by the scoped client.
 */
export async function loadLastActivity(ctx: ReportContext, groupKeys: readonly string[]): Promise<Map<string, LastActivity>> {
  if (!groupKeys.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ wgid: string; lastAt: Date; senderPhone: string; senderName: string | null; direction: string }>>`
    SELECT DISTINCT ON (g."whatsappGroupId")
           g."whatsappGroupId" AS wgid, last.ts AS "lastAt", last."senderPhone", last."senderName", last.direction
    FROM "WhatsAppGroup" g
    CROSS JOIN LATERAL (
      SELECT m."timestampWa" AS ts, m."senderPhone", m."senderName", m."direction"::text AS direction FROM "Message" m
      WHERE m."groupId" = g."id" AND m."timestampWa" < ${new Date(ctx.rangeEnd)}
        AND m."direction" <> 'SYSTEM'
      ORDER BY m."timestampWa" DESC
      LIMIT 1
    ) last
    WHERE g."projectId" = ${await activeProjectId()}
      AND g."whatsappGroupId" IN (${Prisma.join([...groupKeys])})
      ${ctx.filters.accountId ? Prisma.sql`AND g."accountId" = ${ctx.filters.accountId}` : Prisma.empty}
    ORDER BY g."whatsappGroupId", last.ts DESC`;
  return new Map(rows.map((r) => [r.wgid, { at: r.lastAt.getTime(), senderPhone: r.senderPhone, senderName: r.senderName, direction: r.direction }]));
}

/**
 * Of groups with nothing stored before the period end (`noneBefore`), the ones that do have
 * messages — after the period. Told apart from "never recorded", because only that one is a group
 * with no history.
 */
export async function loadGroupsWithLaterMessagesOnly(ctx: ReportContext, noneBefore: readonly string[]): Promise<Set<string>> {
  if (!noneBefore.length) return new Set();
  const rows = await prisma.$queryRaw<Array<{ wgid: string }>>`
    SELECT DISTINCT g."whatsappGroupId" AS wgid
    FROM "WhatsAppGroup" g
    WHERE g."projectId" = ${await activeProjectId()}
      AND g."whatsappGroupId" IN (${Prisma.join([...noneBefore])})
      ${ctx.filters.accountId ? Prisma.sql`AND g."accountId" = ${ctx.filters.accountId}` : Prisma.empty}
      AND EXISTS (SELECT 1 FROM "Message" m WHERE m."groupId" = g."id" AND m."direction" <> 'SYSTEM')`;
  return new Set(rows.map((r) => r.wgid));
}

/**
 * The roster, for two questions group reports ask: which Team a member is in today, and who sent a
 * message (customer / team member / business number) — by the identifiers the Team Report matches on.
 */
export async function loadRoster(ctx: ReportContext): Promise<{ teamOf: Map<string, string | null>; describeSender: (l: LastActivity) => string }> {
  const roster = await prisma.internalTeamMember.findMany({ select: { id: true, name: true, phoneNumber: true, whatsappId: true, teamId: true } });
  const memberBySender = new Map<string, { name: string }>();
  for (const member of roster) for (const id of senderIdentifiers(member)) memberBySender.set(id, member);
  const teamNameById = new Map(ctx.data.teams.map((t) => [t.id, t.name]));
  return {
    teamOf: new Map(roster.map((m) => [m.id, m.teamId ? (teamNameById.get(m.teamId) ?? null) : null])),
    describeSender: (l) => {
      if (l.direction === "OUTGOING") return "Business number";
      const member = memberBySender.get(l.senderPhone) ?? memberBySender.get(normalizePhoneNumber(l.senderPhone) ?? "");
      return member ? `Team member · ${member.name}` : `Customer · ${l.senderName || l.senderPhone}`;
    },
  };
}

/**
 * Inactive Groups, centred on one question: which groups had NO communication at all in the period?
 *
 * "No communication" means zero stored messages of any kind — customer, team member, business
 * number — in the period. It is kept apart from "no customer activity" (only the team posted),
 * which is communication and is never reported as silence. For a silent group, the last-activity
 * columns describe the most recent message BEFORE the period; a group with no stored message at all
 * says "Never recorded" rather than looking like a known silence.
 *
 * Message counts come from the Team Report's own dataset (same filters, one row per real message);
 * the last activity is one index probe per group. Both are read through the project-scoped client or
 * name the project explicitly, so another project's copy of the same WhatsApp group never leaks in.
 */
export async function buildInactiveGroups(ctx: ReportContext): Promise<BuiltReport> {
  const lowRaw = Number(ctx.params.low);
  const low = [3, 5, 10, 20].includes(lowRaw) ? lowRaw : DEFAULT_LOW_ACTIVITY_THRESHOLD;
  const statusFilter =
    ctx.params.status && (ctx.params.status === "all" || ctx.params.status === "attention" || Object.prototype.hasOwnProperty.call(GROUP_ACTIVITY_LABELS, ctx.params.status))
      ? ctx.params.status
      : "NO_COMMUNICATION";

  const groups = await loadMonitoredGroups(ctx);
  const counts = groupMessageCounts(ctx.data.messages, ctx.rangeStart, ctx.rangeEnd);
  const [last, roster] = await Promise.all([loadLastActivity(ctx, groups.map((g) => g.whatsappGroupId)), loadRoster(ctx)]);
  const hasLaterOnly = await loadGroupsWithLaterMessagesOnly(
    ctx,
    groups.filter((g) => !last.has(g.whatsappGroupId)).map((g) => g.whatsappGroupId),
  );
  const teamOfMember = roster.teamOf;
  const lastBy = roster.describeSender;
  // Recorded ≠ occurred: a group whose account was not collecting, or a period nobody has verified,
  // can only say "no communication RECORDED" (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md §E).
  const accountsOf = await accountsByGroupKey(groups.map((g) => g.whatsappGroupId));
  const confidenceOf = (groupKey: string) => groupDataConfidence(ctx.dataHealth, accountsOf.get(groupKey) ?? []);

  const to = measuredTo(ctx);
  const classified = groups.map((g) => {
    const c = counts.get(g.whatsappGroupId);
    const l = last.get(g.whatsappGroupId) ?? null;
    return {
      group: g,
      counts: c,
      status: classifyGroupActivity(c, low),
      last: l,
      neverRecorded: !l && !hasLaterOnly.has(g.whatsappGroupId),
      days: daysBetween(l?.at ?? null, to),
    };
  });
  const byStatus = (s: GroupActivityStatus) => classified.filter((row) => row.status === s).length;
  const silent = classified.filter((row) => row.status === "NO_COMMUNICATION");
  const withActivity = groups.length - silent.length;
  const neverRecorded = silent.filter((row) => row.neverRecorded).length;
  const longest = silent
    .filter((row) => row.days !== null)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0) || a.group.name.localeCompare(b.group.name))[0];

  const shown = classified
    .filter((row) => (statusFilter === "all" ? true : statusFilter === "attention" ? row.status !== "ACTIVE" : row.status === statusFilter))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
        (a.last?.at ?? 0) - (b.last?.at ?? 0) ||
        a.group.name.localeCompare(b.group.name),
    );

  const rangeLabel = ctx.data.range.label;
  const lastActivityText = (row: (typeof classified)[number]) =>
    row.last ? when(row.last.at) : row.neverRecorded ? "Never recorded" : "None before the period end";
  const monitoring = (g: MonitoredGroup) => {
    const statuses = [...new Set(g.accounts.map((a) => a.status))];
    return `Monitored · ${statuses.length === 1 && statuses[0] === "CONNECTED" ? "account connected" : `account ${statuses.map((s) => s.toLowerCase().replace(/_/g, " ")).join(" / ")}`}`;
  };

  const table: ReportTable = {
    id: "groups",
    sheet: "Detailed",
    title: statusFilter === "NO_COMMUNICATION" ? `No communication · ${rangeLabel} (${count(shown.length)})` : `Groups (${count(shown.length)})`,
    description:
      statusFilter === "NO_COMMUNICATION"
        ? "Monitored groups with no stored WhatsApp message of any kind in the period, longest silent first. Last activity is the latest message before the period."
        : "Monitored groups and their status for the period, the ones needing attention first. Select a group for its Team Report.",
    noun: { singular: "group", plural: "groups" },
    columns: [
      { label: "Group" },
      { label: "WhatsApp account" },
      { label: "Team" },
      { label: "Status" },
      { label: "Last activity", muted: true },
      { label: "Last activity by" },
      { label: "Days since last activity", numeric: true },
      { label: "Messages in period", numeric: true },
      { label: "Customer messages", numeric: true },
      { label: "Team replies", numeric: true },
      { label: "Monitoring" },
      { label: "Data" },
    ],
    rows: shown.map((row) => {
      const { group, counts: c, status } = row;
      const replies = (c?.member ?? 0) + (c?.business ?? 0);
      const team = group.assignedMemberId ? (teamOfMember.get(group.assignedMemberId) ?? "—") : "—";
      return {
        key: group.whatsappGroupId,
        cells: [
          group.name,
          group.accounts.map((a) => a.label).join(", "),
          team,
          GROUP_ACTIVITY_LABELS[status],
          lastActivityText(row),
          row.last ? lastBy(row.last) : "—",
          row.days === null ? "—" : row.days,
          c?.total ?? 0,
          c?.customer ?? 0,
          replies,
          monitoring(group),
          DATA_CONFIDENCE_LABELS[confidenceOf(group.whatsappGroupId)],
        ],
        sort: [
          group.name.toLowerCase(),
          group.accounts.map((a) => a.label).join(", ").toLowerCase(),
          team.toLowerCase(),
          STATUS_ORDER.indexOf(status),
          row.last?.at ?? 0,
          row.last ? lastBy(row.last).toLowerCase() : "~",
          row.days ?? Number.MAX_SAFE_INTEGER,
          c?.total ?? 0,
          c?.customer ?? 0,
          replies,
          monitoring(group),
          DATA_CONFIDENCE_LABELS[confidenceOf(group.whatsappGroupId)],
        ],
        sub: [group.whatsappGroupId, null, group.assignedMemberId ? ctx.memberName(group.assignedMemberId) : null, null, null, null, null, null, null, null, null, null],
      };
    }),
  };

  const summary: ReportTable = {
    id: "summary",
    sheet: "Breakdown",
    title: "Activity summary",
    description: "Every monitored group in the period, by status.",
    noun: { singular: "status", plural: "statuses" },
    columns: [{ label: "Status" }, { label: "Groups", numeric: true }, { label: "Share" }],
    rows: STATUS_ORDER.map((s) => ({
      key: s,
      cells: [GROUP_ACTIVITY_LABELS[s], byStatus(s), percent(groups.length ? byStatus(s) / groups.length : null)],
      sort: [STATUS_ORDER.indexOf(s), byStatus(s), groups.length ? byStatus(s) / groups.length : 0],
    })),
  };

  return {
    id: "inactive-groups",
    title: "Inactive Groups — No Communication",
    question: "Which groups had no communication at all during this period?",
    tiles: [
      { label: "Monitored groups", value: count(groups.length), hint: "active and monitored today" },
      { label: "With communication", value: count(withActivity), hint: "at least one stored message", tone: "success" },
      {
        label: "No communication",
        value: count(silent.length),
        hint: `no stored message · ${rangeLabel}`,
        tone: silent.length > 0 ? "danger" : "neutral",
      },
      { label: "No-communication share", value: percent(groups.length ? silent.length / groups.length : null), hint: "of monitored groups" },
      {
        label: "Longest silence",
        value: longest ? `${count(longest.days ?? 0)} days` : "—",
        hint: longest ? `${longest.group.name} · last ${dateOnly(longest.last?.at ?? null)}` : "no silent group with earlier activity",
        tone: longest ? "warning" : "neutral",
      },
      { label: "Never recorded", value: count(neverRecorded), hint: "silent groups with no stored message at all" },
      {
        label: "Customer activity, no reply",
        value: count(byStatus("CUSTOMER_NO_REPLY")),
        hint: "customers wrote, nobody answered",
        tone: byStatus("CUSTOMER_NO_REPLY") > 0 ? "danger" : "neutral",
      },
    ],
    visuals: [],
    tables: [table, summary],
    notes: [
      {
        tone: silent.length > 0 ? "warning" : "info",
        text:
          groups.length === 0
            ? `No monitored group matches these filters · ${rangeLabel}.`
            : silent.length > 0
              ? `No communication · ${rangeLabel}: ${count(silent.length)} of ${count(groups.length)} monitored group${groups.length === 1 ? "" : "s"} had no recorded WhatsApp activity during this period.`
              : `All monitored groups had activity during this period (${rangeLabel}).`,
      },
      ...(ctx.dataHealth.status !== "HEALTHY" && silent.length > 0
        ? [
            {
              tone: ctx.dataHealth.status === "DATA_GAP" ? ("warning" as const) : ("info" as const),
              text:
                ctx.dataHealth.status === "DATA_GAP"
                  ? `No communication RECORDED is not proof that none occurred: collection was incomplete during this period, so a group marked "Data gap" in the Data column may have had messages that were never stored.`
                  : ctx.dataHealth.status === "UNVERIFIED_HISTORY"
                    ? `No communication RECORDED is not proof that none occurred: this period is historical / unverified, so missing messages cannot be ruled out.`
                    : `Collection paused during this period and the missed messages were recovered; the figures are complete as far as WhatsApp could still return them.`,
            },
          ]
        : []),
      {
        tone: "info",
        text: "Groups are the ones monitored and active today: whether a group was monitored in the past is not recorded. \"Never recorded\" means no message from the group has ever been stored — not proof the group was silent before monitoring began.",
      },
    ],
    formulas: [
      {
        title: "No communication",
        text: "A monitored group with zero stored WhatsApp messages of any kind — customer, team member or business number — between the start and end of the period. A group where only the team posted HAD communication and is listed as No customer activity instead.",
      },
      {
        title: "Status",
        text: `Checked in this order for the period: no message at all → No communication; messages but none from a customer → No customer activity; customer messages but no reply from a team member or the business number → Customer activity, no reply; fewer than ${low} messages in total → Low activity; otherwise Active.`,
      },
      {
        title: "Last activity and days since",
        text: "The group's latest stored message before the period ends (for a silent group, that is its latest message BEFORE the period), and who sent it. Days since: whole days from it to the end of the period, or to now if the period has not ended. \"Never recorded\": no stored message at all; \"None before the period end\": its first stored message came after the period.",
      },
      {
        title: "Team",
        text: "The Team of the group's assigned team member today. A group with no assigned member has no Team.",
      },
      {
        title: "Data",
        text: "How far a group's figures can be trusted. Data gap: one of the WhatsApp accounts the group is stored under had a collection gap in the period that was not fully recovered. Historical / unverified: the period is before the project's verified-from date. Verified: neither. Only a Verified \"No communication\" means none occurred; otherwise it means none was recorded.",
      },
    ],
    selects: [
      {
        name: "status",
        label: "Show",
        value: statusFilter,
        options: [
          { value: "NO_COMMUNICATION", label: "No communication" },
          { value: "attention", label: "Needing attention" },
          { value: "all", label: "All monitored groups" },
          ...STATUS_ORDER.filter((s) => s !== "NO_COMMUNICATION").map((s) => ({ value: s, label: GROUP_ACTIVITY_LABELS[s] })),
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
