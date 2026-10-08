import { DHAKA_OFFSET_MS } from "./dhakaDay.js";

/**
 * Reporting data health (SUPPORT_INTELLIGENCE_IMPLEMENTATION_AUDIT.md, stage 1): how much a report
 * period's figures can be trusted, decided from two facts and nothing else —
 *
 *   - the project's verified-from moment: before it, collection health was not recorded, so missing
 *     messages cannot be ruled out ("historical / unverified");
 *   - CollectionGap rows: periods an account was not collecting, and whether the catch-up sweep
 *     recovered them.
 *
 * Pure, so the page, the export and the tests read the same rules. A report never claims more than
 * this says: "no stored message" is "no communication RECORDED" unless the period is HEALTHY.
 */

export const DATA_HEALTH_STATUSES = ["HEALTHY", "WARNING", "DATA_GAP", "UNVERIFIED_HISTORY"] as const;
export type DataHealthStatus = (typeof DATA_HEALTH_STATUSES)[number];

export const DATA_HEALTH_LABELS: Record<DataHealthStatus, string> = {
  HEALTHY: "Verified",
  WARNING: "Verified — a collection pause was recovered",
  DATA_GAP: "Data gap",
  UNVERIFIED_HISTORY: "Historical / unverified",
};

/**
 * The confidence vocabulary every Support Intelligence figure uses. One list, so a label means the
 * same thing on every page.
 */
export const DATA_CONFIDENCE_LABELS = {
  VERIFIED: "Verified",
  HISTORICAL_UNVERIFIED: "Historical / unverified",
  INFERRED: "Inferred",
  LOW_CONFIDENCE: "Low confidence",
  INSUFFICIENT_SAMPLE: "Insufficient sample",
  DATA_GAP: "Data gap",
} as const;
export type DataConfidence = keyof typeof DATA_CONFIDENCE_LABELS;

/** One CollectionGap row, as the data-health rule needs it. Times in milliseconds. */
export interface CollectionGapInput {
  accountId: string;
  accountLabel: string;
  cause: string;
  startedAt: number;
  /** Null while the gap is still open. */
  endedAt: number | null;
  /** RECOVERED | PARTIAL | FAILED | NOT_ATTEMPTED, or null when no sweep has been recorded. */
  recoveryStatus: string | null;
  recoveredCount: number;
  recoveryNote: string | null;
}

export interface DataHealthGap extends CollectionGapInput {
  /** True when messages from this gap may be missing: still open, or not fully recovered. */
  incomplete: boolean;
  /** The sentence a report shows for it. */
  text: string;
}

export interface DataHealth {
  status: DataHealthStatus;
  label: string;
  /** One sentence for the top of the report. */
  headline: string;
  verifiedFrom: number | null;
  /** The part of the period before the verified-from moment, or null when none of it is. */
  unverified: { from: number; to: number } | null;
  /** Gaps overlapping the period, oldest first. */
  gaps: DataHealthGap[];
  /** Every caveat, in reading order: unverified history first, then each gap. */
  warnings: string[];
}

const CAUSE_LABELS: Record<string, string> = {
  DISCONNECTED: "disconnected",
  WORKER_RESTART: "the worker restarted",
  NOT_COLLECTING: "connected but not receiving messages",
  UNREADABLE: "the session could not be read",
  NEEDS_HUMAN: "waiting to be linked again from the phone",
  STUCK_RECONNECTING: "stuck reconnecting",
  RECONNECTING: "reconnecting",
  QR_AVAILABLE: "waiting for a QR scan",
  QR_EXPIRED: "the linking code expired",
  LINK_ABANDONED: "linking was abandoned",
  AUTH_FAILED: "WhatsApp rejected the saved session",
  ERROR: "a session error",
};

export function describeGapCause(cause: string): string {
  return CAUSE_LABELS[cause] ?? cause.toLowerCase().replace(/_/g, " ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "4 Oct 2026, 14:20" in Asia/Dhaka — no Intl, so the server and the tests format identically. */
export function formatDhakaMoment(ms: number): string {
  const d = new Date(ms + DHAKA_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "4 Oct 2026, 14:20 – 15:05", or with both dates when the span crosses a Dhaka day. */
export function formatDhakaSpan(from: number, to: number): string {
  const a = formatDhakaMoment(from);
  const b = formatDhakaMoment(to);
  return a.slice(0, a.indexOf(",")) === b.slice(0, b.indexOf(",")) ? `${a} – ${b.slice(b.indexOf(",") + 2)}` : `${a} – ${b}`;
}

/** Whether a gap may have lost messages: still open, never swept, or swept only in part. */
export function gapIsIncomplete(gap: Pick<CollectionGapInput, "endedAt" | "recoveryStatus">): boolean {
  return gap.endedAt === null || gap.recoveryStatus !== "RECOVERED";
}

function gapText(gap: CollectionGapInput): string {
  const span = gap.endedAt === null ? `since ${formatDhakaMoment(gap.startedAt)} (still ongoing)` : `between ${formatDhakaSpan(gap.startedAt, gap.endedAt)}`;
  const who = `${gap.accountLabel}: ${describeGapCause(gap.cause)}`;
  if (gap.endedAt === null) return `Reporting data may be incomplete ${span} — ${who}.`;
  switch (gap.recoveryStatus) {
    case "RECOVERED":
      return `Collection paused ${span} (${who}); the messages sent meanwhile were recovered afterwards${gap.recoveredCount ? ` (${gap.recoveredCount})` : ""}.`;
    case "PARTIAL":
      return `Reporting data may be incomplete ${span} — ${who}; only part of it could be recovered.${gap.recoveryNote ? ` ${gap.recoveryNote}` : ""}`;
    case "FAILED":
      return `Reporting data may be incomplete ${span} — ${who}; recovery failed.${gap.recoveryNote ? ` ${gap.recoveryNote}` : ""}`;
    case "NOT_ATTEMPTED":
      return `Reporting data may be incomplete ${span} — ${who}; nothing could be recovered.${gap.recoveryNote ? ` ${gap.recoveryNote}` : ""}`;
    default:
      return `Reporting data may be incomplete ${span} — ${who}; no recovery was recorded.`;
  }
}

/**
 * The health of one report period.
 *
 * Precedence: a DATA_GAP (messages may be missing) outranks UNVERIFIED_HISTORY (they cannot be ruled
 * out), which outranks WARNING (a pause that was recovered), which outranks HEALTHY. An open gap is
 * measured to `now`.
 */
export function computeDataHealth(input: {
  periodStart: number;
  periodEnd: number;
  now: number;
  verifiedFrom: number | null;
  gaps: readonly CollectionGapInput[];
}): DataHealth {
  const { periodStart, periodEnd, now, verifiedFrom } = input;
  const gaps: DataHealthGap[] = input.gaps
    .filter((g) => g.startedAt < periodEnd && (g.endedAt ?? now) > periodStart)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((g) => ({ ...g, incomplete: gapIsIncomplete(g), text: gapText(g) }));

  const unverified =
    verifiedFrom === null
      ? { from: periodStart, to: periodEnd }
      : verifiedFrom > periodStart
        ? { from: periodStart, to: Math.min(verifiedFrom, periodEnd) }
        : null;

  const warnings: string[] = [];
  if (verifiedFrom === null) {
    warnings.push(
      "Reporting has not been verified for this project yet, so every period is historical / unverified: collection health was not recorded before, and missing messages cannot be ruled out. An admin sets the verified-from date in Support Activity Setup.",
    );
  } else if (unverified) {
    warnings.push(
      `Before ${formatDhakaMoment(verifiedFrom)} this period is historical / unverified: collection health was not recorded, so missing messages cannot be ruled out.`,
    );
  }
  for (const gap of gaps) warnings.push(gap.text);

  const status: DataHealthStatus = gaps.some((g) => g.incomplete)
    ? "DATA_GAP"
    : unverified
      ? "UNVERIFIED_HISTORY"
      : gaps.length
        ? "WARNING"
        : "HEALTHY";

  const incompleteCount = gaps.filter((g) => g.incomplete).length;
  const headline =
    status === "DATA_GAP"
      ? `${incompleteCount} collection gap${incompleteCount === 1 ? "" : "s"} in this period: some messages may not have been stored, so "no communication" here means "none recorded".`
      : status === "UNVERIFIED_HISTORY"
        ? verifiedFrom === null
          ? "Historical / unverified: reporting has not been verified for this project yet."
          : "Part of this period is historical / unverified."
        : status === "WARNING"
          ? "Collection paused during this period, and the messages were recovered."
          : "Verified: collection was healthy for the whole period.";

  return { status, label: DATA_HEALTH_LABELS[status], headline, verifiedFrom, unverified, gaps, warnings };
}

/**
 * The confidence a group's figures carry: DATA_GAP when one of its accounts had an incomplete gap in
 * the period, HISTORICAL_UNVERIFIED when the period is not verified, otherwise VERIFIED. For a
 * "no communication" row, anything but VERIFIED means "none recorded", never "none occurred".
 */
export function groupDataConfidence(health: DataHealth, accountIds: readonly string[]): DataConfidence {
  if (health.gaps.some((g) => g.incomplete && accountIds.includes(g.accountId))) return "DATA_GAP";
  if (health.unverified) return "HISTORICAL_UNVERIFIED";
  return "VERIFIED";
}
