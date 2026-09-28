
import { activeProjectId } from "@/server/projectContext";
import { prisma } from "@/server/db";
import { getDhakaDayRange } from "@/lib/supportActivityPeriod";

/**
 * Read helpers backing the /overview metrics charts. Server-component-only — no
 * "use server" directive, these are never invoked from a client event handler
 * (same convention as dashboardSummary.ts, which sits beside this file).
 *
 * Every series is bucketed on Asia/Dhaka boundaries via the same
 * `getDhakaDayRange` the Support Activity reports use, so "today" means the same
 * thing everywhere in the app rather than whatever timezone the container runs in.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const VOLUME_DAYS = 14;
const LOAD_HOURS = 24;
const BUSIEST_GROUP_LIMIT = 6;

const dayLabelFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Dhaka",
  month: "short",
  day: "numeric",
});
const hourLabelFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Dhaka",
  hour: "numeric",
  hour12: true,
});

export interface TimeBucket {
  /** Axis label, already formatted in Asia/Dhaka. */
  label: string;
  value: number;
  startMs: number;
}

export interface Slice {
  key: string;
  label: string;
  value: number;
  /** A CSS color expression — a `--chart-*` slot for identity, a status token for state. */
  color: string;
}

/**
 * Both message-volume series come out of a single aggregate query.
 *
 * The fourteen daily counts and twenty-four hourly counts these charts need would have
 * been thirty-eight separate counts, so this used to select one column over the whole
 * fourteen-day window and bucket it in Node — which meant transferring and deserialising
 * every incoming message of the last fortnight on every render of the landing page.
 * Postgres buckets it instead: `date_trunc` to the hour returns at most 14 × 24 rows, and
 * because Dhaka is a whole-hour offset from UTC, hour buckets nest exactly inside the Dhaka
 * day boundaries the daily series uses, so one grouping feeds both series with the same
 * bucket semantics as before. Served by `Message`'s `[direction, createdAt]` index.
 */
export async function getMessageLoadSeries(nowMs: number) {
  const todayStartMs = getDhakaDayRange(new Date(nowMs)).start.getTime();
  const dayWindowStartMs = todayStartMs - (VOLUME_DAYS - 1) * DAY_MS;

  // Dhaka is a whole-hour offset from UTC, so flooring the UTC instant to the hour
  // lands on a Dhaka hour boundary too.
  const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const hourWindowStartMs = currentHourStartMs - (LOAD_HOURS - 1) * HOUR_MS;

  const buckets = await prisma.$queryRaw<Array<{ bucketStart: Date; messageCount: bigint }>>`
    SELECT date_trunc('hour', m."createdAt") AS "bucketStart", COUNT(*) AS "messageCount"
    FROM "Message" m
    WHERE m."direction" = 'INCOMING'::"MessageDirection"
      AND m."projectId" = ${await activeProjectId()}
      AND m."createdAt" >= ${new Date(dayWindowStartMs)}
    GROUP BY 1
  `;

  const daily: TimeBucket[] = Array.from({ length: VOLUME_DAYS }, (_, index) => {
    const startMs = dayWindowStartMs + index * DAY_MS;
    return { label: dayLabelFormat.format(new Date(startMs)), value: 0, startMs };
  });
  const hourly: TimeBucket[] = Array.from({ length: LOAD_HOURS }, (_, index) => {
    const startMs = hourWindowStartMs + index * HOUR_MS;
    return { label: hourLabelFormat.format(new Date(startMs)), value: 0, startMs };
  });

  for (const bucket of buckets) {
    const ms = bucket.bucketStart.getTime();
    const count = Number(bucket.messageCount);

    const dayIndex = Math.floor((ms - dayWindowStartMs) / DAY_MS);
    if (dayIndex >= 0 && dayIndex < VOLUME_DAYS) daily[dayIndex].value += count;

    const hourIndex = Math.floor((ms - hourWindowStartMs) / HOUR_MS);
    if (hourIndex >= 0 && hourIndex < LOAD_HOURS) hourly[hourIndex].value += count;
  }

  // Week-over-week on whole days: the two halves of the same window, so the
  // comparison never straddles a partial day at one end and not the other.
  const lastSeven = daily.slice(VOLUME_DAYS - 7).reduce((sum, b) => sum + b.value, 0);
  const priorSeven = daily.slice(0, VOLUME_DAYS - 7).reduce((sum, b) => sum + b.value, 0);
  const peakHour = hourly.reduce((best, bucket) => (bucket.value > best.value ? bucket : best), hourly[0]);

  return {
    daily,
    hourly,
    windowTotal: daily.reduce((sum, b) => sum + b.value, 0),
    lastSeven,
    priorSeven,
    /** Null when there is no prior week to compare against — not a 0% change. */
    weekOverWeekPercent: priorSeven === 0 ? null : Math.round(((lastSeven - priorSeven) / priorSeven) * 100),
    peakHourLabel: peakHour && peakHour.value > 0 ? peakHour.label : null,
    peakHourValue: peakHour?.value ?? 0,
  };
}

// Fixed order, so a slot follows the decision rather than its current rank — a
// quiet day must not repaint AUTO_REPLY in SUPPORT_REQUIRED's color. Mirrors
// packages/engine's FinalDecision union.
export const DECISION_SLOTS: Array<{ key: string; label: string; color: string }> = [
  { key: "AUTO_REPLY", label: "Auto-replied", color: "var(--chart-1)" },
  { key: "SUPPORT_REQUIRED", label: "Support required", color: "var(--chart-2)" },
  { key: "ACTIONED", label: "Side-effect only", color: "var(--chart-3)" },
  { key: "IGNORE", label: "Ignored", color: "var(--chart-4)" },
  { key: "NO_MATCH", label: "No rule matched", color: "var(--chart-5)" },
  { key: "STOPPED", label: "Stopped", color: "var(--chart-6)" },
];

/**
 * What the rule engine actually decided in the last 24h. The single most useful
 * question about a rule engine — a rising "No rule matched" share is the signal
 * that the ruleset has fallen behind what customers are asking.
 */
export async function getDecisionMix(nowMs: number) {
  const since = new Date(nowMs - 24 * HOUR_MS);
  const groups = await prisma.automationExecution.groupBy({
    by: ["decision"],
    where: { createdAt: { gte: since } },
    _count: { decision: true },
  });

  const counts = new Map(groups.map((g) => [g.decision, g._count.decision]));
  const slices: Slice[] = DECISION_SLOTS.map((slot) => ({
    ...slot,
    value: counts.get(slot.key) ?? 0,
  })).filter((slice) => slice.value > 0);

  // Anything the engine emits that this list doesn't know about is folded into a
  // neutral "Other" rather than being given a generated seventh hue.
  const knownKeys = new Set(DECISION_SLOTS.map((s) => s.key));
  const otherTotal = groups
    .filter((g) => !knownKeys.has(g.decision))
    .reduce((sum, g) => sum + g._count.decision, 0);
  if (otherTotal > 0) {
    slices.push({ key: "OTHER", label: "Other", value: otherTotal, color: "var(--color-border-strong)" });
  }

  return { slices, total: slices.reduce((sum, s) => sum + s.value, 0) };
}

/**
 * Plain-language wording for a raw `AutomationExecution.decision` string, reusing the exact same
 * labels the donut chart above renders — so the trace column on the Live Traffic table and the
 * "Automation decisions" chart never describe the same outcome two different ways. Falls back to
 * the raw value for anything the engine emits that this list doesn't yet know about, rather than
 * hiding it.
 */
export function decisionLabel(decision: string): string {
  return DECISION_SLOTS.find((slot) => slot.key === decision)?.label ?? decision;
}

// These segments mean good/bad, so they wear the app's status tokens rather than
// the categorical chart slots — a green bar here reads the same as a green badge.
const OUTBOUND_SLOTS: Array<{ key: string; label: string; color: string; statuses: string[] }> = [
  { key: "SENT", label: "Sent", color: "var(--color-success)", statuses: ["SENT"] },
  { key: "QUEUED", label: "In queue", color: "var(--color-border-strong)", statuses: ["PENDING", "PROCESSING"] },
  { key: "RATE_LIMITED", label: "Rate-limited", color: "var(--color-warning)", statuses: ["RATE_LIMITED"] },
  { key: "FAILED", label: "Failed", color: "var(--color-danger)", statuses: ["FAILED"] },
  { key: "SKIPPED", label: "Skipped or cancelled", color: "var(--color-muted-foreground)", statuses: ["SKIPPED", "CANCELLED"] },
];

/** Delivery health for everything the outbound queue handled in the last 24h. */
export async function getDeliveryOutcomes(nowMs: number) {
  const since = new Date(nowMs - 24 * HOUR_MS);
  const groups = await prisma.outboundMessage.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { status: true },
  });

  const counts = new Map(groups.map((g) => [String(g.status), g._count.status]));
  const slices: Slice[] = OUTBOUND_SLOTS.map((slot) => ({
    key: slot.key,
    label: slot.label,
    color: slot.color,
    value: slot.statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0),
  })).filter((slice) => slice.value > 0);

  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const sent = slices.find((s) => s.key === "SENT")?.value ?? 0;

  return {
    slices,
    total,
    /** Null rather than 100% when nothing was queued at all. */
    successRate: total === 0 ? null : Math.round((sent / total) * 100),
  };
}

/**
 * Where the week's support load actually lands. Answers "which groups should the
 * team be staffed for" — and makes an unexpectedly loud group obvious.
 */
export async function getBusiestGroups(nowMs: number) {
  const since = new Date(nowMs - 7 * DAY_MS);
  const grouped = await prisma.message.groupBy({
    by: ["groupId"],
    where: { direction: "INCOMING", createdAt: { gte: since }, groupId: { not: null } },
    _count: { groupId: true },
    orderBy: { _count: { groupId: "desc" } },
    take: BUSIEST_GROUP_LIMIT,
  });

  const groupIds = grouped.map((g) => g.groupId).filter((id): id is string => id !== null);
  if (groupIds.length === 0) return { groups: [] as Array<{ id: string; name: string; value: number }> };

  const named = await prisma.whatsAppGroup.findMany({
    where: { id: { in: groupIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(named.map((g) => [g.id, g.name]));

  return {
    groups: groupIds.map((id, index) => ({
      id,
      name: nameById.get(id) ?? "Unknown group",
      value: grouped[index]._count.groupId,
    })),
  };
}


/**
 * Whether AI is carrying more of the load or less, day by day.
 *
 * The dashboard had no view of the AI layer at all, which is the part of this system most likely
 * to change behaviour week to week — a knowledge entry added, a response mode widened, a model
 * swapped. A single "AI replied N times" counter cannot show a trend reversing; two series can.
 *
 * Handovers are not failures and are not coloured as such. A handover is the safety rule working:
 * a question nothing verified covers went to a person, which is the designed outcome. What matters
 * is the ratio moving, in either direction, for a reason somebody can name.
 */
export async function getAiOutcomeSeries(nowMs: number) {
  const todayStartMs = getDhakaDayRange(new Date(nowMs)).start.getTime();
  const windowStartMs = todayStartMs - (VOLUME_DAYS - 1) * DAY_MS;

  const rows = await prisma.$queryRaw<Array<{ bucket: Date; outcome: string; count: bigint }>>`
    SELECT
      date_trunc('day', d."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka') AS bucket,
      d."outcome"::text                                          AS outcome,
      COUNT(*)                                                   AS count
    FROM "AiFallbackDecision" d
    WHERE d."projectId" = ${await activeProjectId()}
      AND d."createdAt" >= ${new Date(windowStartMs)}
    GROUP BY bucket, d."outcome"
    ORDER BY bucket
  `;

  // `createdAt` is a timestamp WITHOUT time zone holding UTC, so the double AT TIME ZONE above is
  // load-bearing: 'UTC' first makes it an instant, 'Asia/Dhaka' then gives the wall clock there.
  // The single-argument form this used to have INTERPRETS the value as already being Dhaka time and
  // shifts it six hours the wrong way — every decision between Dhaka midnight and noon landed on
  // the previous day. The bucket comes back as a bare Dhaka-midnight timestamp, which Prisma hands
  // over as that calendar date at 00:00Z, so slicing the ISO date reads it straight back.
  // Same form as getActivityTrend, pinned in queryRewrites.integration.test.ts.
  const keyed = new Map<string, { replied: number; handedOver: number }>();
  for (const row of rows) {
    const key = row.bucket.toISOString().slice(0, 10);
    const entry = keyed.get(key) ?? { replied: 0, handedOver: 0 };
    if (row.outcome === "AI_REPLIED") entry.replied += Number(row.count);
    else entry.handedOver += Number(row.count);
    keyed.set(key, entry);
  }

  const replied: TimeBucket[] = [];
  const handedOver: TimeBucket[] = [];
  let totalReplied = 0;
  let totalHandedOver = 0;

  for (let i = 0; i < VOLUME_DAYS; i += 1) {
    const startMs = windowStartMs + i * DAY_MS;
    const label = dayLabelFormat.format(new Date(startMs));
    const key = new Date(startMs + 6 * HOUR_MS).toISOString().slice(0, 10);
    const entry = keyed.get(key) ?? { replied: 0, handedOver: 0 };
    replied.push({ label, value: entry.replied, startMs });
    handedOver.push({ label, value: entry.handedOver, startMs });
    totalReplied += entry.replied;
    totalHandedOver += entry.handedOver;
  }

  const total = totalReplied + totalHandedOver;
  return {
    replied,
    handedOver,
    totalReplied,
    totalHandedOver,
    /** Share of AI-eligible messages answered without a person, or null when nothing was eligible. */
    answeredSharePercent: total === 0 ? null : Math.round((totalReplied / total) * 100),
  };
}

/**
 * How long customers waited for a first reply, per day.
 *
 * The number a support lead is judged on, and until now it existed only as a single figure on Team
 * Performance. A trend is what says whether last week's staffing change worked.
 *
 * Median per day rather than average, for the same reason the single figure uses it: one
 * conversation answered the next morning drags an average past every honest reading of that day.
 * Only messages that START a wait are measured, so a customer sending four lines in a row counts
 * once — the same definition as `getFirstResponseStats`, deliberately, since two response-time
 * numbers computed differently on two pages is worse than one.
 *
 * This is the heaviest query on the landing page: a window function over fourteen days of
 * messages, partitioned by group. It leans on `Message`'s `[groupId, timestampWa]` index for the
 * partition ordering and `[timestampWa]` for the range — check both still exist before wondering
 * why the dashboard got slow. If message volume ever makes this the bottleneck, the answer is a
 * nightly rollup table rather than a narrower window; the definition of a "wait" has to stay
 * identical to Team Performance's, and duplicating it in two shapes is how those drift apart.
 */
export async function getResponseTimeSeries(nowMs: number) {
  const todayStartMs = getDhakaDayRange(new Date(nowMs)).start.getTime();
  const windowStartMs = todayStartMs - (VOLUME_DAYS - 1) * DAY_MS;

  const rows = await prisma.$queryRaw<Array<{ bucket: Date; median: number | null }>>`
    WITH ordered AS (
      SELECT
        m."groupId" AS group_id,
        m."timestampWa" AS ts,
        (m."direction" = 'OUTGOING' OR m."isFromTeamMember" = true) AS is_reply
      FROM "Message" m
      JOIN "WhatsAppGroup" g ON g."id" = m."groupId"
      WHERE m."groupId" IS NOT NULL
        AND m."projectId" = ${await activeProjectId()}
        AND g."isMonitored" = true
        AND m."timestampWa" >= ${new Date(windowStartMs)}
    ),
    marked AS (
      SELECT
        ts,
        is_reply,
        LAG(is_reply) OVER (PARTITION BY group_id ORDER BY ts) AS prev_is_reply,
        MIN(ts) FILTER (WHERE is_reply) OVER (
          PARTITION BY group_id ORDER BY ts
          ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS next_reply_ts
      FROM ordered
    )
    SELECT
      date_trunc('day', ts AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')           AS bucket,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (next_reply_ts - ts)))::float
                                                                                   AS median
    FROM marked
    WHERE is_reply = false
      AND (prev_is_reply IS TRUE OR prev_is_reply IS NULL)
      AND next_reply_ts IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket
  `;

  const keyed = new Map(rows.map((row) => [row.bucket.toISOString().slice(0, 10), row.median]));

  const daily: TimeBucket[] = [];
  let latestWithData: number | null = null;
  for (let i = 0; i < VOLUME_DAYS; i += 1) {
    const startMs = windowStartMs + i * DAY_MS;
    const key = new Date(startMs + 6 * HOUR_MS).toISOString().slice(0, 10);
    const median = keyed.get(key) ?? null;
    // A day nobody was answered on is genuinely zero minutes of waiting measured, not a gap in the
    // chart — but it is also not "instant", so the caption reports how many days actually had data.
    const minutes = median == null ? 0 : Math.round(median / 60);
    daily.push({ label: dayLabelFormat.format(new Date(startMs)), value: minutes, startMs });
    if (median != null) latestWithData = minutes;
  }

  const measured = rows.length;
  return { daily, measured, latestMedianMinutes: latestWithData };
}

/**
 * Who delivered support over the last seven days — people or the AI layer.
 *
 * `aiOnlyGroups` is the figure worth watching and the reason this is here rather than a single
 * percentage: a group AI handled entirely is a group no colleague looked at, which is either the
 * automation working exactly as intended or a conversation quietly going unattended. The chart
 * states the fact; which of the two it is depends on the group.
 */
export async function getSupportActorMix(nowMs: number) {
  const todayStartMs = getDhakaDayRange(new Date(nowMs)).start.getTime();
  const start = new Date(todayStartMs - 6 * DAY_MS);

  const [byActor, aiGroups, humanGroups] = await Promise.all([
    prisma.supportActivity.groupBy({
      by: ["actor"],
      where: { occurredAt: { gte: start } },
      _count: { actor: true },
    }),
    prisma.supportActivity.findMany({
      where: { occurredAt: { gte: start }, actor: "AI" },
      select: { groupId: true },
      distinct: ["groupId"],
    }),
    prisma.supportActivity.findMany({
      where: { occurredAt: { gte: start }, actor: "TEAM_MEMBER" },
      select: { groupId: true },
      distinct: ["groupId"],
    }),
  ]);

  const humanSet = new Set(humanGroups.map((row) => row.groupId));
  const aiOnlyGroups = aiGroups.filter((row) => !humanSet.has(row.groupId)).length;

  const counts = new Map(byActor.map((row) => [row.actor, row._count.actor]));
  const human = counts.get("TEAM_MEMBER") ?? 0;
  const ai = counts.get("AI") ?? 0;

  const slices: Slice[] = [
    // Identity slots, not status colours: neither actor is a good or bad outcome, and painting AI
    // green or amber would editorialise a split the reader is meant to judge for themselves.
    { key: "TEAM_MEMBER", label: "People", value: human, color: "var(--chart-1)" },
    { key: "AI", label: "AI", value: ai, color: "var(--chart-3)" },
  ].filter((slice) => slice.value > 0);

  return { slices, total: human + ai, aiOnlyGroups };
}

/**
 * Messages per executive over the last seven days.
 *
 * Deliberately raw message counts rather than the presence-based duration on Team Performance.
 * A dashboard glance answers "who is carrying this week", and a count is the number nobody has to
 * read a definition to trust — time on support is the more careful measure and lives on the page
 * that can explain how it is derived.
 *
 * Filtered to TEAM_MEMBER explicitly, like every person-measuring report here, so AI work can
 * never be attributed to somebody who did not do it.
 */
export async function getExecutiveLoad(nowMs: number) {
  const todayStartMs = getDhakaDayRange(new Date(nowMs)).start.getTime();
  const start = new Date(todayStartMs - 6 * DAY_MS);

  const grouped = await prisma.supportActivity.groupBy({
    by: ["teamMemberId"],
    where: { occurredAt: { gte: start }, actor: "TEAM_MEMBER", teamMemberId: { not: null } },
    _count: { teamMemberId: true },
    orderBy: { _count: { teamMemberId: "desc" } },
    take: BUSIEST_GROUP_LIMIT,
  });
  if (grouped.length === 0) return { people: [] as Array<{ id: string; label: string; value: number }> };

  const members = await prisma.internalTeamMember.findMany({
    where: { id: { in: grouped.map((row) => row.teamMemberId as string) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(members.map((member) => [member.id, member.name]));

  return {
    people: grouped.map((row) => ({
      id: row.teamMemberId as string,
      // A deleted member's rows survive with a null name (SetNull), and dropping them would make
      // the totals here disagree with every other report.
      label: nameById.get(row.teamMemberId as string) ?? "(removed team member)",
      value: row._count.teamMemberId,
    })),
  };
}
