import { Prisma } from "@prisma/client";
import {
  activityHeatmap,
  CALL_KIND_LABELS,
  CALL_SQL_PREFILTER,
  detectCallMention,
  HEATMAP_METRICS,
  type CallKind,
  type HeatmapMetric,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { senderIdentifiers } from "@/server/teamReport";
import type { ReportContext } from "./context";
import { count, duration, hourLabel, when, WEEKDAYS } from "./format";
import { waitsInScope } from "./responseReports";
import type { BuiltReport } from "./types";

/** Activity reports: Support Activity Heatmap and WhatsApp Call Activity. */

const assignedOf = (ctx: ReportContext, groupKey: string) => ctx.data.groups.get(groupKey)?.assignedMemberId ?? null;

export function buildHeatmap(ctx: ReportContext): BuiltReport {
  const metric: HeatmapMetric = ctx.params.metric && Object.prototype.hasOwnProperty.call(HEATMAP_METRICS, ctx.params.metric) ? (ctx.params.metric as HeatmapMetric) : "customer";
  const scope = ctx.data.scope;
  const grid = activityHeatmap(ctx.data.messages, waitsInScope(ctx), metric, {
    rangeStart: ctx.rangeStart,
    rangeEnd: ctx.rangeEnd,
    // Customer messages: the groups in scope. Replies: the in-scope members' own, as the Team Report
    // counts them — the business number belongs to no Team, so it is left out of a scoped view.
    includeMessage: (m) => {
      if (m.kind === "CUSTOMER") return ctx.groupInScope(m.groupKey, assignedOf(ctx, m.groupKey));
      if (!scope) return true;
      return m.kind === "MEMBER" && m.memberId !== null && scope(m.memberId, m.ts);
    },
  });
  const total = grid.flat().reduce((a, b) => a + b, 0);
  let peak = { weekday: 0, hour: 0, value: -1 };
  grid.forEach((row, weekday) => row.forEach((value, hour) => value > peak.value && (peak = { weekday, hour, value })));
  const byWeekday = grid.map((row) => row.reduce((a, b) => a + b, 0));
  const byHour = Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + row[h]!, 0));
  const busiestDay = byWeekday.indexOf(Math.max(...byWeekday));
  const busiestHour = byHour.indexOf(Math.max(...byHour));
  const label = HEATMAP_METRICS[metric];

  return {
    id: "heatmap",
    title: "Support Activity Heatmap",
    question: "When in the week do customers write and the team reply?",
    tiles: [
      { label, value: count(total) },
      { label: "Busiest slot", value: total ? `${WEEKDAYS[peak.weekday]!.slice(0, 3)} ${hourLabel(peak.hour)}` : "—", hint: total ? `${count(peak.value)} in that hour` : undefined },
      { label: "Busiest weekday", value: total ? WEEKDAYS[busiestDay]! : "—", hint: total ? count(byWeekday[busiestDay]!) : undefined },
      { label: "Busiest hour", value: total ? `${hourLabel(busiestHour)}–${hourLabel((busiestHour + 1) % 24)}` : "—", hint: total ? count(byHour[busiestHour]!) : undefined },
    ],
    visuals: [{ kind: "heatmap", title: label, description: "By weekday and hour of day, Asia/Dhaka. Darker is more.", unit: label.toLowerCase(), grid }],
    tables: [
      {
        id: "grid",
        sheet: "Detailed",
        title: "By weekday and hour",
        description: `${label}, counted in the hour they happened.`,
        noun: { singular: "weekday", plural: "weekdays" },
        columns: [{ label: "Weekday" }, ...Array.from({ length: 24 }, (_, h) => ({ label: String(h).padStart(2, "0"), numeric: true })), { label: "Total", numeric: true }],
        rows: grid.map((row, weekday) => ({
          key: String(weekday),
          cells: [WEEKDAYS[weekday]!, ...row, byWeekday[weekday]!],
          sort: [weekday, ...row, byWeekday[weekday]!],
        })),
      },
    ],
    notes: [],
    formulas: [
      { title: "Customer messages", text: "Every stored customer message in the groups in scope, in the hour it was sent." },
      { title: "Team replies", text: "Messages from team members, plus the business number when no Team or member is chosen." },
      { title: "Customer waits started", text: "The Team Report's waits, in the hour the customer's first line was sent." },
    ],
    selects: [
      {
        name: "metric",
        label: "Show",
        value: metric,
        options: (Object.keys(HEATMAP_METRICS) as HeatmapMetric[]).map((m) => ({ value: m, label: HEATMAP_METRICS[m] })),
      },
    ],
    usesGranularity: false,
    emptyMessage: total === 0 ? `Nothing to show for ${label.toLowerCase()} in ${ctx.data.range.label}.` : null,
  };
}

// ---------------------------------------------------------------------------------------------

/** At most this many call messages are listed; the page says when it stopped. */
const MAX_CALL_ROWS = 5000;

export async function buildCalls(ctx: ReportContext): Promise<BuiltReport> {
  const { groupKeys, accountId } = ctx.filters;
  const [candidates, members] = await Promise.all([
    // Only messages whose text could mention a call cross to this process; detectCallMention decides.
    // DISTINCT ON collapses the copies two of our numbers store of one message, as the Team Report does.
    prisma.$queryRaw<Array<{ wgid: string; wamid: string; ts: Date; direction: string; fromTeam: boolean; sender: string; body: string }>>`
      SELECT DISTINCT ON (g."whatsappGroupId", m."whatsappMessageId")
        g."whatsappGroupId" AS wgid, m."whatsappMessageId" AS wamid, m."timestampWa" AS ts, m."direction"::text AS direction,
        m."isFromTeamMember" AS "fromTeam", m."senderPhone" AS sender, left(m."body", 400) AS body
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
      WHERE m."projectId" = ${await activeProjectId()}
        AND m."timestampWa" >= ${new Date(ctx.rangeStart)} AND m."timestampWa" < ${new Date(ctx.rangeEnd)}
        AND m."direction" <> 'SYSTEM'
        AND m."body" ~* ${CALL_SQL_PREFILTER}
        ${groupKeys?.length ? Prisma.sql`AND g."whatsappGroupId" IN (${Prisma.join(groupKeys)})` : Prisma.empty}
        ${accountId ? Prisma.sql`AND m."accountId" = ${accountId}` : Prisma.empty}
      ORDER BY g."whatsappGroupId", m."whatsappMessageId", m."timestampWa", m."id"`,
    prisma.internalTeamMember.findMany({ select: { id: true, phoneNumber: true, whatsappId: true } }),
  ]);
  const identifierToMember = new Map<string, string>();
  for (const member of members) for (const id of senderIdentifiers(member)) if (!identifierToMember.has(id)) identifierToMember.set(id, member.id);

  const scope = ctx.data.scope;
  const found = candidates
    .map((row) => {
      const mention = detectCallMention(row.body);
      if (!mention) return null;
      const memberId = row.direction === "OUTGOING" ? null : (identifierToMember.get(row.sender) ?? null);
      const who = row.direction === "OUTGOING" ? "BUSINESS" : memberId || row.fromTeam ? "MEMBER" : "CUSTOMER";
      return { ...row, ms: row.ts.getTime(), mention, memberId, who };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .filter((row) => {
      if (row.who === "MEMBER" && scope) return row.memberId !== null && scope(row.memberId, row.ms);
      if (row.who === "BUSINESS" && scope) return false;
      return ctx.groupInScope(row.wgid, assignedOf(ctx, row.wgid));
    })
    .sort((a, b) => b.ms - a.ms);
  const shown = found.slice(0, MAX_CALL_ROWS);
  const kindCount = (k: CallKind) => found.filter((r) => r.mention.kind === k).length;
  const withDuration = found.filter((r) => r.mention.statedDurationSeconds !== null);
  const whoLabel = (r: (typeof found)[number]) =>
    r.who === "BUSINESS" ? "Business number" : r.who === "CUSTOMER" ? "Customer" : r.memberId ? ctx.memberName(r.memberId) : "Team member (not on the roster)";

  return {
    id: "calls",
    title: "WhatsApp Call Activity",
    question: "Where did people ask for, or mention, a call?",
    tiles: [
      { label: "Calls requested", value: count(kindCount("CALL_REQUESTED")), hint: "\"please call me\", \"কল দিন\"" },
      { label: "Missed calls mentioned", value: count(kindCount("MISSED_CALL")), tone: kindCount("MISSED_CALL") > 0 ? "warning" : "neutral" },
      { label: "Calls mentioned", value: count(kindCount("CALL_MENTIONED")), hint: "\"ami call dicchi\", \"called you\"" },
      { label: "Groups", value: count(new Set(found.map((r) => r.wgid)).size) },
      {
        label: "Stated duration",
        value: duration(withDuration.reduce((s, r) => s + r.mention.statedDurationSeconds!, 0) || null),
        hint: `in ${count(withDuration.length)} message(s) that say how long`,
      },
    ],
    visuals: [],
    tables: [
      {
        id: "calls",
        sheet: "Detailed",
        title: `Messages about a call (${count(found.length)})`,
        description: "Newest first. Every row is inferred from what somebody wrote; none is a call record.",
        noun: { singular: "message", plural: "messages" },
        columns: [
      // The group first: a table's search reads its first column (and the WhatsApp id under it),
      // and "which group" is what somebody searches a list of messages by — not a timestamp.
          { label: "Group" },
          { label: "When", muted: true },
          { label: "Written by" },
          { label: "Kind" },
          { label: "Duration" },
          { label: "Detected from" },
          { label: "Message" },
        ],
        rows: shown.map((r) => ({
          // The message's own identity, not its position: a selection exported after new messages
          // arrived must still name the same rows (a position-based key would shift onto others).
          key: `${r.wgid}|${r.wamid}`,
          cells: [
            ctx.groupName(r.wgid),
            when(r.ms),
            whoLabel(r),
            CALL_KIND_LABELS[r.mention.kind],
            r.mention.statedDurationSeconds !== null ? `${duration(r.mention.statedDurationSeconds)} (stated in message)` : "Duration unavailable",
            "Inferred from message text",
            r.body.replace(/\s+/g, " ").trim(),
          ],
          sort: [ctx.groupName(r.wgid).toLowerCase(), r.ms, whoLabel(r).toLowerCase(), r.mention.kind, r.mention.statedDurationSeconds ?? -1, "", r.body.toLowerCase()],
          sub: [r.wgid],
        })),
      },
    ],
    notes: [
      {
        tone: "warning",
        text: "WhatsApp call events are not recorded by this system, so there are no call records, durations or missed-call logs here. Every row is a message whose text asks for or mentions a call. A duration is shown only when the message itself says how long the call was.",
      },
      ...(found.length > MAX_CALL_ROWS
        ? [{ tone: "info" as const, text: `Showing the newest ${count(MAX_CALL_ROWS)} of ${count(found.length)} messages; the tiles count all of them.` }]
        : []),
    ],
    formulas: [
      {
        title: "Kinds",
        text: "Missed call mentioned (\"missed call\", \"call dhorlen na\", \"কল ধরেন না\") is checked first, then Call requested (\"please call me\", \"call den\", \"কল দিন\"), then Call mentioned (\"ami call dicchi\", \"I called you\", \"কল দিয়েছি\"). English, Banglish and Bangla phrases; the list is in packages/shared/src/supportReports.ts (CALL_PHRASES).",
      },
      {
        title: "Duration",
        text: "Only when the message ties a number to the call (\"15 min call\", \"call lasted 7 minutes\", \"১০ মিনিট কথা হয়েছে\"). \"Call me in 10 minutes\" names a time, not a duration, and is not counted as one.",
      },
    ],
    selects: [],
    usesGranularity: false,
    emptyMessage: found.length === 0 ? `No stored message in ${ctx.data.range.label} asks for or mentions a call, for these filters.` : null,
  };
}
