import { prisma } from "@support-automation/db";
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
 * Both message-volume series come out of a single scan.
 *
 * `Message` carries no index on `createdAt`/`direction`, so every dated count over
 * it is a sequential scan; the fourteen daily counts and twenty-four hourly counts
 * these charts need would have been thirty-eight of them. Selecting one column over
 * the window and bucketing in memory is one scan instead — and it replaced the seven
 * that used to back the overview sparkline.
 */
export async function getMessageLoadSeries(nowMs: number) {
  const todayStartMs = getDhakaDayRange(new Date(nowMs)).start.getTime();
  const dayWindowStartMs = todayStartMs - (VOLUME_DAYS - 1) * DAY_MS;

  // Dhaka is a whole-hour offset from UTC, so flooring the UTC instant to the hour
  // lands on a Dhaka hour boundary too.
  const currentHourStartMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const hourWindowStartMs = currentHourStartMs - (LOAD_HOURS - 1) * HOUR_MS;

  const rows = await prisma.message.findMany({
    where: { direction: "INCOMING", createdAt: { gte: new Date(dayWindowStartMs) } },
    select: { createdAt: true },
  });

  const daily: TimeBucket[] = Array.from({ length: VOLUME_DAYS }, (_, index) => {
    const startMs = dayWindowStartMs + index * DAY_MS;
    return { label: dayLabelFormat.format(new Date(startMs)), value: 0, startMs };
  });
  const hourly: TimeBucket[] = Array.from({ length: LOAD_HOURS }, (_, index) => {
    const startMs = hourWindowStartMs + index * HOUR_MS;
    return { label: hourLabelFormat.format(new Date(startMs)), value: 0, startMs };
  });

  for (const row of rows) {
    const ms = row.createdAt.getTime();

    const dayIndex = Math.floor((ms - dayWindowStartMs) / DAY_MS);
    if (dayIndex >= 0 && dayIndex < VOLUME_DAYS) daily[dayIndex].value += 1;

    const hourIndex = Math.floor((ms - hourWindowStartMs) / HOUR_MS);
    if (hourIndex >= 0 && hourIndex < LOAD_HOURS) hourly[hourIndex].value += 1;
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
const DECISION_SLOTS: Array<{ key: string; label: string; color: string }> = [
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
