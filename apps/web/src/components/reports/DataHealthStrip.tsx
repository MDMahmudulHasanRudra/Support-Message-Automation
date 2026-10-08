import { formatDhakaMoment } from "@support-automation/shared";
import { Alert, StatusDot } from "@/components/ui";
import type { ReportDataHealth } from "@/server/dataHealth";

/**
 * How far a report's figures can be trusted, above the figures. It reads like a caveat, not a
 * warning light, whenever the period is fine; it says exactly which hours may be incomplete when it is
 * not. Built from the same data-health rule the export's Summary sheet carries.
 */
export function DataHealthStrip({ health }: { health: ReportDataHealth }) {
  const facts = (
    <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[color:var(--color-muted-foreground)]">
      <span>Last message stored: {health.lastMessageAt ? formatDhakaMoment(health.lastMessageAt) : "none"}</span>
      <span>Last processed: {health.lastProcessedAt ? formatDhakaMoment(health.lastProcessedAt) : "never"}</span>
      <span>Verified from: {health.verifiedFrom ? formatDhakaMoment(health.verifiedFrom) : "not set"}</span>
    </span>
  );

  if (health.status === "HEALTHY") {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[color:var(--color-muted-foreground)]" aria-label="Data health">
        <span className="inline-flex items-center gap-1.5 font-medium text-[color:var(--color-foreground)]">
          <StatusDot color="green" /> {health.label}
        </span>
        <span>{health.headline}</span>
        {facts}
      </div>
    );
  }

  return (
    <div className="mb-4" aria-label="Data health">
      <Alert tone={health.status === "DATA_GAP" ? "warning" : "info"} title={`Data health: ${health.label}`}>
        <p>{health.headline}</p>
        {health.warnings.length > 0 ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs underline">
              {health.warnings.length === 1 ? "Details" : `Details (${health.warnings.length})`}
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              {health.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="mt-1.5">{facts}</div>
      </Alert>
    </div>
  );
}
