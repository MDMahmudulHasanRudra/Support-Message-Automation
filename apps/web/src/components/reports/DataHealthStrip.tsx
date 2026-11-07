import { formatDhakaMoment, formatHoursMinutes } from "@support-automation/shared";
import { Alert, StatusDot } from "@/components/ui";
import type { ReportDataHealth } from "@/server/dataHealth";

/**
 * How far a report's figures can be trusted, above the figures. One quiet line: a restart or a dropped session is
 * normal, is recorded by itself, and most of it is recovered. A box appears only when collection is stopped right now,
 * because that is the one case somebody has to act on. The details are always one click away.
 */
export function DataHealthStrip({ health }: { health: ReportDataHealth }) {
  const open = health.gaps.filter((gap) => gap.endedAt === null);
  const details =
    health.warnings.length > 0 ? (
      <details className="w-full">
        <summary className="cursor-pointer text-xs underline underline-offset-2">Details</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
          {health.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          <span>Last message stored: {health.lastMessageAt ? formatDhakaMoment(health.lastMessageAt) : "none"}</span>
          <span>Last processed: {health.lastProcessedAt ? formatDhakaMoment(health.lastProcessedAt) : "never"}</span>
          <span>Pauses recorded from: {health.verifiedFrom ? formatDhakaMoment(health.verifiedFrom) : "not set"}</span>
        </div>
      </details>
    ) : null;

  if (open.length > 0) {
    return (
      <div className="mb-4" aria-label="Data health">
        <Alert tone="warning" title={`${open[0]!.accountLabel} is not collecting messages right now`}>
          <p>Messages arriving now are not being stored. Check the number on WhatsApp Accounts; when it is back, what it can still read is recovered by itself.</p>
          <div className="mt-1.5">{details}</div>
        </Alert>
      </div>
    );
  }

  const incomplete = health.gaps.filter((gap) => gap.incomplete);
  const lostSeconds = incomplete.reduce((sum, gap) => sum + Math.max(0, ((gap.endedAt ?? gap.startedAt) - gap.startedAt) / 1000), 0);
  const line =
    incomplete.length > 0
      ? `${incomplete.length} short ${incomplete.length === 1 ? "pause" : "pauses"} in collection this period (${formatHoursMinutes(lostSeconds)}). A few messages from then may be missing.`
      : health.gaps.length > 0
        ? "Collection paused briefly this period, and everything was recovered."
        : health.status === "UNVERIFIED_HISTORY"
          ? "Part of this period is from before pauses were recorded."
          : "Collection was healthy for the whole period.";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[color:var(--color-muted-foreground)]" aria-label="Data health">
      <StatusDot color={incomplete.length > 0 ? "yellow" : "green"} />
      <span>{line}</span>
      {details}
    </div>
  );
}
