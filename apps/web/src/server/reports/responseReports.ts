import { Prisma } from "@prisma/client";
import {
  bucketKeyFor,
  bucketKeysForRange,
  groupWaitsBy,
  outcomeOf,
  responseStats,
  SUPPORT_OUTCOME_LABELS,
  type ReportWait,
  type SupportOutcome,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { activeProjectId } from "@/server/projectContext";
import { bucketLabel } from "@/server/teamReport";
import { bucketColumnLabel } from "@/server/teamReportTables";
import type { ReportContext } from "./context";
import { count, duration, percent, when } from "./format";
import type { BuiltReport, ReportTable } from "./types";

/** Response & SLA reports: Response SLA and Missed Support. */

const assignedOf = (ctx: ReportContext, groupKey: string) => ctx.data.groups.get(groupKey)?.assignedMemberId ?? null;

/** The waits a group report looks at: every wait in the groups in scope (REPORTS.md §3). */
export const waitsInScope = (ctx: ReportContext) =>
  ctx.data.result.waits.filter((w) => ctx.groupInScope(w.groupKey, assignedOf(ctx, w.groupKey)));

const STAT_COLUMNS = [
  { label: "Waits", numeric: true },
  { label: "Within SLA", numeric: true },
  { label: "Late", numeric: true },
  { label: "Never answered", numeric: true },
  { label: "Still waiting", numeric: true },
  { label: "SLA %" },
  { label: "Median" },
  { label: "Average" },
  { label: "90th percentile" },
  { label: "Worst" },
];

const statCells = (s: ReturnType<typeof responseStats>) => [
  s.waits,
  s.within,
  s.late,
  s.never,
  s.pending,
  percent(s.slaRatio),
  duration(s.medianSeconds),
  duration(s.averageSeconds),
  duration(s.p90Seconds),
  duration(s.maxSeconds),
];

const statSort = (s: ReturnType<typeof responseStats>) => [
  s.waits,
  s.within,
  s.late,
  s.never,
  s.pending,
  s.slaRatio ?? 2,
  s.medianSeconds ?? Number.MAX_SAFE_INTEGER,
  s.averageSeconds ?? Number.MAX_SAFE_INTEGER,
  s.p90Seconds ?? Number.MAX_SAFE_INTEGER,
  s.maxSeconds ?? Number.MAX_SAFE_INTEGER,
];

export function buildResponseSla(ctx: ReportContext): BuiltReport {
  const waits = waitsInScope(ctx);
  const overall = responseStats(waits);
  const scope = ctx.data.scope;
  const granularity = ctx.filters.granularity;

  const byGroup = [...groupWaitsBy(waits, (w) => w.groupKey).entries()].map(([groupKey, list]) => ({ groupKey, stats: responseStats(list) }));
  // A person's figures are the waits THEIR reply closed (while in scope); the business number is its
  // own row in the whole-team view and belongs to no Team.
  const byReplier = [
    ...groupWaitsBy(waits, (w) => {
      if (!w.repliedBy || w.repliedAt === null) return null;
      if (w.repliedBy === "BUSINESS") return scope ? null : "BUSINESS";
      return !scope || scope(w.repliedBy, w.repliedAt) ? w.repliedBy : null;
    }).entries(),
  ].map(([replier, list]) => ({ replier, stats: responseStats(list) }));
  const buckets = new Map(bucketKeysForRange(ctx.rangeStart, ctx.rangeEnd, granularity).map((k) => [k, [] as ReportWait[]]));
  for (const w of waits) buckets.get(bucketKeyFor(w.askedAt, granularity))?.push(w);

  const groupTable: ReportTable = {
    id: "groups",
    sheet: "Detailed",
    title: `By group (${count(byGroup.length)})`,
    description: "Lowest SLA % first.",
    noun: { singular: "group", plural: "groups" },
    columns: [{ label: "Group" }, ...STAT_COLUMNS],
    rows: byGroup
      .sort((a, b) => (a.stats.slaRatio ?? 2) - (b.stats.slaRatio ?? 2) || b.stats.waits - a.stats.waits)
      .map(({ groupKey, stats }) => ({
        key: groupKey,
        cells: [ctx.groupName(groupKey), ...statCells(stats)],
        sort: [ctx.groupName(groupKey).toLowerCase(), ...statSort(stats)],
        sub: [groupKey],
      })),
  };
  const replierTable: ReportTable = {
    id: "members",
    sheet: "Breakdown",
    title: "By who answered",
    description: "The waits each person's reply closed. Waits never answered belong to nobody here, so this table's Never answered column is empty by definition.",
    noun: { singular: "person", plural: "people" },
    columns: [{ label: "Answered by" }, ...STAT_COLUMNS.filter((c) => c.label !== "Never answered" && c.label !== "Still waiting")],
    rows: byReplier
      .sort((a, b) => b.stats.waits - a.stats.waits)
      .map(({ replier, stats }) => {
        const cells = statCells(stats);
        const sort = statSort(stats);
        const keep = (_: unknown, i: number) => i !== 3 && i !== 4;
        return {
          key: replier,
          cells: [ctx.memberName(replier), ...cells.filter(keep)],
          sort: [ctx.memberName(replier).toLowerCase(), ...sort.filter(keep)],
          muted: replier === "BUSINESS",
        };
      }),
  };
  const bucketTable: ReportTable = {
    id: "buckets",
    sheet: "Breakdown",
    title: `By ${granularity}`,
    description: "Waits counted in the bucket they started.",
    noun: granularity === "day" ? { singular: "day", plural: "days" } : granularity === "week" ? { singular: "week", plural: "weeks" } : { singular: "month", plural: "months" },
    columns: [{ label: bucketColumnLabel(granularity) }, ...STAT_COLUMNS],
    rows: [...buckets.entries()].map(([key, list]) => {
      const stats = responseStats(list);
      return { key, cells: [bucketLabel(key, granularity), ...statCells(stats)], sort: [key, ...statSort(stats)] };
    }),
  };

  return {
    id: "response-sla",
    title: "Response SLA",
    question: "How fast are customers answered, and how often within the target?",
    tiles: [
      {
        label: "Within SLA",
        value: percent(overall.slaRatio),
        hint: `${count(overall.within)} of ${count(overall.within + overall.late + overall.never)} decided waits`,
        tone: overall.slaRatio === null ? "neutral" : overall.slaRatio >= 0.9 ? "success" : "warning",
      },
      { label: "Median first response", value: duration(overall.medianSeconds), hint: "answered waits" },
      { label: "Average", value: duration(overall.averageSeconds), hint: "pulled up by slow ones" },
      { label: "90th percentile", value: duration(overall.p90Seconds), hint: "9 in 10 answered within" },
      { label: "Worst", value: duration(overall.maxSeconds) },
      { label: "Breached", value: count(overall.late + overall.never), hint: `${count(overall.never)} never answered`, tone: overall.never > 0 ? "danger" : "neutral" },
      { label: "Still waiting", value: count(overall.pending), hint: "inside their time — not counted" },
      { label: "Customer waits", value: count(overall.waits) },
    ],
    visuals: [
      {
        kind: "columns",
        title: "Median first response",
        description: `Minutes, per ${granularity}.`,
        unit: "min",
        data: [...buckets.entries()].map(([key, list]) => ({
          label: bucketLabel(key, granularity),
          value: Math.round(((responseStats(list).medianSeconds ?? 0) / 60) * 10) / 10,
        })),
      },
    ],
    tables: [groupTable, replierTable, bucketTable],
    notes: [],
    formulas: [
      {
        title: "SLA target",
        text: `A wait's target is its Missed threshold: the group's escalation first-alert time if it has a priority (${Object.entries(ctx.data.rules.policyMinutes)
          .map(([p, m]) => `${p} ${m} min`)
          .join(", ") || "none set"}), otherwise "missed after" (${ctx.data.rules.missedAfterMinutes} min).`,
      },
      {
        title: "SLA %",
        text: "Answered within the target ÷ (within + answered late + never answered). Waits still inside their target are left out until they are decided.",
      },
      {
        title: "Response time",
        text: "From the customer message that started the wait to the reply that ended it, over answered waits only. Median is the headline because one wait answered the next morning drags the average past every honest reading; the 90th percentile and the worst sit beside it.",
      },
    ],
    selects: [],
    usesGranularity: true,
    emptyMessage: waits.length === 0 ? `No customer waits started in ${ctx.data.range.label} for these filters.` : null,
  };
}

// ---------------------------------------------------------------------------------------------

const OUTCOME_ORDER: SupportOutcome[] = ["NEVER_ANSWERED", "WAITING", "ANSWERED_LATE", "ANSWERED"];
/** The customer's first line is loaded for at most this many rows; the table says when it stopped. */
const MAX_BODIES = 2000;

export async function buildMissedSupport(ctx: ReportContext): Promise<BuiltReport> {
  const status = ctx.params.status && (ctx.params.status === "all" || ctx.params.status in SUPPORT_OUTCOME_LABELS) ? ctx.params.status : "attention";
  const waits = waitsInScope(ctx);
  const shown = waits
    .filter((w) => {
      const outcome = outcomeOf(w);
      return status === "all" ? true : status === "attention" ? outcome !== "ANSWERED" : outcome === status;
    })
    .sort((a, b) => b.askedAt - a.askedAt);
  const tally = (o: SupportOutcome) => waits.filter((w) => outcomeOf(w) === o).length;

  // The customer's message that started each shown wait (the newest MAX_BODIES), matched on group and
  // exact timestamp. Text is truncated in SQL so a long message never crosses whole.
  const wanted = shown.slice(0, MAX_BODIES);
  const bodyRows = wanted.length
    ? await prisma.$queryRaw<Array<{ wgid: string; ms: bigint | number; body: string }>>`
        SELECT DISTINCT ON (g."whatsappGroupId", m."timestampWa")
          g."whatsappGroupId" AS wgid,
          round(extract(epoch from m."timestampWa") * 1000)::bigint AS ms,
          left(m."body", 240) AS body
        FROM "Message" m
        JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
        WHERE m."projectId" = ${await activeProjectId()}
          AND m."timestampWa" >= ${new Date(Math.min(...wanted.map((w) => w.askedAt)))}
          AND m."timestampWa" <= ${new Date(Math.max(...wanted.map((w) => w.askedAt)))}
          AND m."direction" = 'INCOMING'
          AND g."whatsappGroupId" IN (${Prisma.join([...new Set(wanted.map((w) => w.groupKey))])})
          AND round(extract(epoch from m."timestampWa") * 1000)::bigint IN (${Prisma.join([...new Set(wanted.map((w) => w.askedAt))])})
          ${ctx.filters.accountId ? Prisma.sql`AND m."accountId" = ${ctx.filters.accountId}` : Prisma.empty}
        ORDER BY g."whatsappGroupId", m."timestampWa", m."id"`
    : [];
  const bodies = new Map(bodyRows.map((r) => [`${r.wgid}|${Number(r.ms)}`, r.body]));
  const nowMs = ctx.now.getTime();

  const table: ReportTable = {
    id: "waits",
    sheet: "Detailed",
    title: `Customer waits (${count(shown.length)})`,
    description: "Newest first. The customer's message is the one that started the wait.",
    noun: { singular: "wait", plural: "waits" },
    columns: [
      { label: "Customer asked", muted: true },
      { label: "Group" },
      { label: "Status" },
      { label: "Customer's message" },
      { label: "Waited" },
      { label: "Target" },
      { label: "Answered by" },
      { label: "Answered", muted: true },
      { label: "Charged to" },
    ],
    rows: shown.map((w, index) => {
      const outcome = outcomeOf(w);
      const assigned = assignedOf(ctx, w.groupKey);
      const waited = w.waitSeconds ?? Math.max(0, Math.round((nowMs - w.askedAt) / 1000));
      const body = bodies.get(`${w.groupKey}|${w.askedAt}`);
      return {
        key: `${w.groupKey}|${w.askedAt}`,
        cells: [
          when(w.askedAt),
          ctx.groupName(w.groupKey),
          SUPPORT_OUTCOME_LABELS[outcome],
          body ?? (index < MAX_BODIES ? "—" : "(not loaded)"),
          w.waitSeconds === null ? `${duration(waited)} so far` : duration(waited),
          duration(w.thresholdSeconds),
          w.repliedBy ? ctx.memberName(w.repliedBy) : "—",
          when(w.repliedAt),
          // Recall is credited to the late replier; the miss itself to the group's assignee.
          outcome === "ANSWERED" || outcome === "WAITING" ? "—" : ctx.memberName(assigned),
        ],
        sort: [
          w.askedAt,
          ctx.groupName(w.groupKey).toLowerCase(),
          OUTCOME_ORDER.indexOf(outcome),
          (body ?? "").toLowerCase(),
          waited,
          w.thresholdSeconds,
          w.repliedBy ? ctx.memberName(w.repliedBy).toLowerCase() : "~",
          w.repliedAt ?? 0,
          ctx.memberName(assigned).toLowerCase(),
        ],
        sub: [null, w.groupKey],
      };
    }),
  };

  return {
    id: "missed",
    title: "Missed Support",
    question: "Which customer waits went unanswered or were answered late?",
    tiles: [
      { label: "Never answered", value: count(tally("NEVER_ANSWERED")), hint: "past the target, no reply", tone: tally("NEVER_ANSWERED") > 0 ? "danger" : "neutral" },
      { label: "Waiting", value: count(tally("WAITING")), hint: "not answered, still inside the target", tone: tally("WAITING") > 0 ? "warning" : "neutral" },
      { label: "Answered late", value: count(tally("ANSWERED_LATE")), hint: "Recall: missed, then answered" },
      { label: "Answered", value: count(tally("ANSWERED")), hint: "within the target", tone: "success" },
      { label: "Customer waits", value: count(waits.length) },
    ],
    visuals: [],
    tables: [table],
    notes:
      shown.length > MAX_BODIES
        ? [{ tone: "info", text: `The customer's message is shown for the newest ${count(MAX_BODIES)} waits; narrow the period or the groups to see the rest.` }]
        : [],
    formulas: [
      {
        title: "Statuses",
        text: "Waiting = not answered and still inside the target. Answered = answered within it. Answered late = answered after it (the Team Report's Recall). Never answered = not answered and already past it (the Team Report's Missed minus Recall).",
      },
      {
        title: "Charged to",
        text: "As on the Team Report: a missed wait belongs to the group's assigned team member, or \"Unassigned\". Recall is credited to whoever answered late.",
      },
    ],
    selects: [
      {
        name: "status",
        label: "Show",
        value: status,
        options: [
          { value: "attention", label: "Waiting, late and never answered" },
          { value: "all", label: "Every wait" },
          ...OUTCOME_ORDER.map((o) => ({ value: o, label: SUPPORT_OUTCOME_LABELS[o] })),
        ],
      },
    ],
    usesGranularity: false,
    emptyMessage: waits.length === 0 ? `No customer waits started in ${ctx.data.range.label} for these filters.` : null,
  };
}
