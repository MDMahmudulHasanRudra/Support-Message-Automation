import { Prisma } from "@prisma/client";
import {
  ATTENTION_ISSUE_LABELS,
  attentionItems,
  groupMessageCounts,
  responseStats,
  shortDuration,
  type AttentionIssue,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { measuredTo, type ReportContext } from "./context";
import { count, duration, percent, when } from "./format";
import { loadLastActivity, loadMonitoredGroups, loadRoster } from "./groupReports";
import { waitsInScope } from "./responseReports";
import type { BuiltReport, ReportTable, ReportTone } from "./types";

/**
 * Executive Support Health (REPORTS.md): one page management reads in half a minute — how much
 * support was asked for, how much of it was handled, where responses are a problem, which groups
 * need somebody, and how the work sat across the Teams.
 *
 * Not a second dashboard and not a ranking: a fixed set of figures, then an exception list where a
 * group appears only when something about it needs attention. Every figure is one the existing
 * reports already define (the Team Report's dataset, waits and support time; Response SLA's SLA;
 * Inactive Groups' "no communication") — cut together, never re-decided here.
 */

const PROLONGED_OPTIONS = [1, 2, 6, 24] as const;
const DEFAULT_PROLONGED_HOURS = 2;

/**
 * Stored messages per group in the previous period of the same length, counted as the dataset counts
 * the current one (one per real message — copies on two accounts once — never a system event), so
 * "declining activity" compares like with like. The project is named explicitly: raw SQL.
 */
async function previousPeriodCounts(ctx: ReportContext, groupKeys: readonly string[]): Promise<Map<string, { previous: number }>> {
  if (!groupKeys.length) return new Map();
  const length = ctx.rangeEnd - ctx.rangeStart;
  const prevStart = new Date(ctx.rangeStart - length);
  const start = new Date(ctx.rangeStart);
  const rows = await prisma.$queryRaw<Array<{ wgid: string; previous: bigint }>>`
    SELECT g."whatsappGroupId" AS wgid, COUNT(DISTINCT m."whatsappMessageId") AS previous
    FROM "WhatsAppGroup" g
    JOIN "Message" m ON m."groupId" = g."id"
    WHERE g."projectId" = ${await activeProjectId()}
      AND g."whatsappGroupId" IN (${Prisma.join([...groupKeys])})
      ${ctx.filters.accountId ? Prisma.sql`AND g."accountId" = ${ctx.filters.accountId}` : Prisma.empty}
      AND m."timestampWa" >= ${prevStart} AND m."timestampWa" < ${start}
      AND m."direction" <> 'SYSTEM'
    GROUP BY g."whatsappGroupId"`;
  return new Map(rows.map((r) => [r.wgid, { previous: Number(r.previous) }]));
}

export async function buildExecutiveHealth(ctx: ReportContext): Promise<BuiltReport> {
  const prolongedRaw = Number(ctx.params.prolonged);
  const prolongedHours = (PROLONGED_OPTIONS as readonly number[]).includes(prolongedRaw) ? prolongedRaw : DEFAULT_PROLONGED_HOURS;
  const rangeLabel = ctx.data.range.label;
  const to = measuredTo(ctx);

  const groups = await loadMonitoredGroups(ctx);
  const keys = groups.map((g) => g.whatsappGroupId);
  const [last, roster, periods] = await Promise.all([loadLastActivity(ctx, keys), loadRoster(ctx), previousPeriodCounts(ctx, keys)]);

  // Group activity — the same "no communication" Inactive Groups reports.
  const counts = groupMessageCounts(ctx.data.messages, ctx.rangeStart, ctx.rangeEnd);
  const active = groups.filter((g) => (counts.get(g.whatsappGroupId)?.total ?? 0) > 0).length;
  const silent = groups.length - active;

  // Demand and response — the Team Report's own figures and waits, Response SLA's SLA.
  const { summary } = ctx.data.result;
  const waits = waitsInScope(ctx);
  const stats = responseStats(waits);
  const unanswered = stats.never + stats.pending;
  const missed = stats.late + stats.never;

  const items = attentionItems({
    groups: groups.map((g) => ({
      groupKey: g.whatsappGroupId,
      messagesInPeriod: counts.get(g.whatsappGroupId)?.total ?? 0,
      messagesPreviousPeriod: periods.get(g.whatsappGroupId)?.previous ?? 0,
      lastActivityAt: last.get(g.whatsappGroupId)?.at ?? null,
    })),
    waits, // only monitored groups are listed, so other groups' waits never surface here
    measuredTo: to,
    prolongedSeconds: prolongedHours * 3600,
  });
  const issueCount = (issue: AttentionIssue) => items.filter((i) => i.issue === issue || i.alsoIssues.includes(issue)).length;
  const byKey = new Map(groups.map((g) => [g.whatsappGroupId, g]));

  const attention: ReportTable = {
    id: "attention",
    sheet: "Detailed",
    title: `Attention required (${count(items.length)})`,
    description: "Monitored groups that need somebody, most urgent first. A group appears once, under its most urgent issue. Select a group for its Team Report.",
    noun: { singular: "group", plural: "groups" },
    columns: [
      { label: "Group" },
      { label: "Issue" },
      { label: "Detail" },
      { label: "Also" },
      { label: "Last activity", muted: true },
      { label: "Waiting" },
      { label: "Assigned" },
      { label: "Team" },
    ],
    rows: items.map((item) => {
      const g = byKey.get(item.groupKey)!;
      const assigned = g.assignedMemberId ? ctx.memberName(g.assignedMemberId) : "—";
      const team = g.assignedMemberId ? (roster.teamOf.get(g.assignedMemberId) ?? "—") : "—";
      return {
        key: item.groupKey,
        cells: [
          g.name,
          ATTENTION_ISSUE_LABELS[item.issue],
          item.detail,
          item.alsoIssues.map((i) => ATTENTION_ISSUE_LABELS[i]).join(", ") || "—",
          item.lastActivityAt === null ? "Never recorded" : when(item.lastActivityAt),
          item.waitingSeconds === null ? "—" : shortDuration(item.waitingSeconds),
          assigned,
          team,
        ],
        sort: [
          g.name.toLowerCase(),
          ["PROLONGED_UNANSWERED", "UNANSWERED", "SLA_BREACH", "NO_COMMUNICATION", "DECLINING"].indexOf(item.issue),
          item.detail,
          item.alsoIssues.length,
          item.lastActivityAt ?? 0,
          item.waitingSeconds ?? -1,
          assigned.toLowerCase(),
          team.toLowerCase(),
        ],
        sub: [item.groupKey, null, null, null, null, null, null, null],
      };
    }),
  };

  // How the work sat across the Teams: distribution, not a ranking of people.
  const teams = new Map<string, { members: number; replies: number; seconds: number; missed: number }>();
  for (const m of ctx.data.result.members) {
    if (m.memberId === "UNASSIGNED" || (m.messages === 0 && m.activeSeconds === 0)) continue;
    const team = roster.teamOf.get(m.memberId) ?? "No team";
    const row = teams.get(team) ?? { members: 0, replies: 0, seconds: 0, missed: 0 };
    row.members += 1;
    row.replies += m.messages;
    row.seconds += m.activeSeconds;
    row.missed += m.missed;
    teams.set(team, row);
  }
  const totalReplies = [...teams.values()].reduce((sum, t) => sum + t.replies, 0);
  const workload: ReportTable = {
    id: "teams",
    sheet: "Breakdown",
    title: "Workload by team",
    description: "Where the support work sat, by each person's Team today. A share of the work, not a score.",
    noun: { singular: "team", plural: "teams" },
    columns: [
      { label: "Team" },
      { label: "Active members", numeric: true },
      { label: "Replies", numeric: true },
      { label: "Share of replies" },
      { label: "Support Overtime" },
      { label: "Missed (charged)", numeric: true },
    ],
    rows: [...teams.entries()]
      .sort((a, b) => b[1].replies - a[1].replies || a[0].localeCompare(b[0]))
      .map(([team, t]) => ({
        key: team,
        cells: [team, t.members, t.replies, percent(totalReplies ? t.replies / totalReplies : null), duration(t.seconds), t.missed],
        sort: [team.toLowerCase(), t.members, t.replies, totalReplies ? t.replies / totalReplies : 0, t.seconds, t.missed],
        muted: team === "No team",
      })),
  };

  const tone = (n: number, kind: ReportTone): ReportTone => (n > 0 ? kind : "neutral");
  return {
    id: "executive-health",
    title: "Executive Support Health",
    question: "How much support was asked for, how much was handled, and what needs attention?",
    tiles: [
      { label: "Monitored groups", value: count(groups.length), hint: "active and monitored today" },
      { label: "Active groups", value: count(active), hint: "at least one stored message", tone: "success" },
      { label: "No-communication groups", value: count(silent), hint: "no stored message in the period", tone: tone(silent, "warning") },
      { label: "Customer messages", value: count(summary.customerMessages) },
      { label: "Team replies", value: count(summary.memberReplies + summary.businessReplies), hint: "team members and business number" },
      { label: "Unanswered customer waits", value: count(unanswered), hint: "no reply yet; a run of messages is one wait", tone: tone(unanswered, "danger") },
      { label: "Missed support", value: count(missed), hint: "answered late or never", tone: tone(missed, "warning") },
      { label: "Average first response", value: duration(stats.averageSeconds) },
      { label: "Median first response", value: duration(stats.medianSeconds) },
      { label: "SLA %", value: percent(stats.slaRatio), hint: "answered within the threshold" },
      { label: "Support Overtime", value: duration(summary.activeSeconds) },
      { label: "Active team members", value: count(summary.activeMembers) },
      { label: "Groups requiring attention", value: count(items.length), tone: tone(items.length, "warning") },
      { label: "Groups with declining activity", value: count(issueCount("DECLINING")), hint: "half or less of the previous period" },
      {
        label: "Groups with prolonged unanswered",
        value: count(issueCount("PROLONGED_UNANSWERED")),
        hint: `a customer waiting ${prolongedHours}h or more`,
        tone: tone(issueCount("PROLONGED_UNANSWERED"), "danger"),
      },
    ],
    visuals: [],
    tables: [attention, workload],
    notes: [
      {
        tone: items.length ? "warning" : "info",
        text: items.length
          ? `${rangeLabel}: ${count(items.length)} of ${count(groups.length)} monitored groups need attention — ${count(issueCount("PROLONGED_UNANSWERED"))} with a customer waiting ${prolongedHours}h or more, ${count(issueCount("UNANSWERED"))} unanswered, ${count(issueCount("SLA_BREACH"))} with late answers, ${count(issueCount("NO_COMMUNICATION"))} silent, ${count(issueCount("DECLINING"))} declining.`
          : groups.length
            ? `${rangeLabel}: no monitored group needs attention.`
            : `${rangeLabel}: no monitored group matches these filters.`,
      },
      ...(ctx.dataHealth.status === "DATA_GAP" || ctx.dataHealth.status === "UNVERIFIED_HISTORY"
        ? [
            {
              tone: ctx.dataHealth.status === "DATA_GAP" ? ("warning" as const) : ("info" as const),
              text: `Every figure here is what was recorded. ${ctx.dataHealth.headline} "No communication" and "declining activity" can reflect missing data rather than a quiet group — see the data health details above.`,
            },
          ]
        : []),
      {
        tone: "info",
        text: "This is a snapshot and an exception list, not a ranking of groups or people. WhatsApp activity shows workload and responsiveness; it is not a measure of anyone's overall performance.",
      },
    ],
    formulas: [
      { title: "Groups", text: "Monitored groups are the ones monitored and active today. Active: at least one stored message of any kind in the period. No communication: none — the Inactive Groups definition." },
      {
        title: "Customer messages, team replies, Support Overtime, active members",
        text: "The Team Report's own figures for the same filters: one row per real message, team replies including the business number, Support Overtime by the idle-gap rule.",
      },
      {
        title: "Waits, unanswered, missed, response, SLA",
        text: "A wait is a run of customer messages, closed by the next team or business-number reply. Unanswered: no reply yet (still waiting, or missed). Missed: answered after the group's threshold, or never. First response: average and median of answered waits. SLA %: answered within the threshold ÷ waits decided — the Response SLA definition.",
      },
      {
        title: "Attention required",
        text: `Prolonged unanswered: a customer with no reply for ${prolongedHours}h or more by the period end (or now). Unanswered: shorter. SLA breach: answers after the threshold (the worst shown). No communication: no message in the period. Declining: half or fewer messages than the previous period of the same length, from at least 10. A group appears once, under its most urgent issue; the rest are under "Also".`,
      },
    ],
    selects: [
      {
        name: "prolonged",
        label: "Prolonged after",
        value: String(prolongedHours),
        options: PROLONGED_OPTIONS.map((h) => ({ value: String(h), label: h === 24 ? "24 hours" : `${h} hour${h === 1 ? "" : "s"}` })),
      },
    ],
    usesGranularity: false,
    emptyMessage: groups.length === 0 ? "No monitored, active group matches these filters." : null,
  };
}
