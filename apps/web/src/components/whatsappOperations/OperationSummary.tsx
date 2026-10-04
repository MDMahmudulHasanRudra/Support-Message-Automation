import Link from "@/components/ProjectLink";
import { Alert, Badge, type BadgeColor, ProgressBar, StatTile } from "@/components/ui";
import { isWorkingOperationState, type WhatsAppOperation, type WhatsAppOperationState } from "@support-automation/shared";

/**
 * One WhatsApp operation, as read from the database: `compact` in the job indicator, full on a
 * module page. Presentation only — every figure comes from the job rows the worker writes.
 */

export const OPERATION_STATE_COLOR: Record<WhatsAppOperationState, BadgeColor> = {
  CHECKING: "blue",
  RUNNING: "blue",
  WAITING_ACCOUNT: "yellow",
  REVIEW: "blue",
  PAUSED: "yellow",
  COMPLETED: "green",
  PARTIAL: "yellow",
  FAILED: "red",
  CANCELLED: "gray",
  STOPPED: "gray",
};

const COUNT_TONE_CLASS = {
  success: "text-[color:var(--color-success-fg)]",
  warning: "text-[color:var(--color-warning-fg)]",
  danger: "text-[color:var(--color-danger-fg)]",
  neutral: "text-[color:var(--color-foreground)]",
} as const;

const n = (value: number) => value.toLocaleString("en-US");
const percent = (op: WhatsAppOperation) => (op.total > 0 ? Math.floor((op.processed / op.total) * 100) : 0);

function StateBadge({ op }: { op: WhatsAppOperation }) {
  return (
    <Badge color={OPERATION_STATE_COLOR[op.state]} dot pulse={isWorkingOperationState(op.state) && op.state !== "WAITING_ACCOUNT"}>
      {op.stateLabel}
    </Badge>
  );
}

export function OperationSummary({ op, compact = false }: { op: WhatsAppOperation; compact?: boolean }) {
  if (compact) {
    return (
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link href={op.href} className="block truncate text-[13px] font-semibold text-[color:var(--color-foreground)] hover:underline">
              {op.title}
            </Link>
            <p className="tabular truncate text-xs text-[color:var(--color-muted-foreground)]">
              {op.target} · via {op.accountLabel}
            </p>
          </div>
          <StateBadge op={op} />
        </div>
        <div className="mt-2 mb-1 flex items-baseline justify-between text-xs text-[color:var(--color-muted-foreground)]">
          <span className="tabular">
            <span className="font-medium text-[color:var(--color-foreground)]">
              {n(op.processed)} / {n(op.total)}
            </span>{" "}
            {op.progressLabel.toLowerCase()}
          </span>
          <span className="tabular">{percent(op)}%</span>
        </div>
        <ProgressBar value={op.processed} max={op.total} />
        {op.current ? <p className="mt-1.5 truncate text-xs text-[color:var(--color-muted-foreground)]">{op.current}</p> : null}
        <p className="tabular mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[color:var(--color-muted-foreground)]">
          {op.counts.map((c) => (
            <span key={c.label}>
              {c.label} <span className={`font-medium ${COUNT_TONE_CLASS[c.tone]}`}>{n(c.value)}</span>
            </span>
          ))}
        </p>
        {op.detail && op.state !== "RUNNING" ? <p className="mt-1.5 text-xs text-[color:var(--color-muted-foreground)]">{op.detail}</p> : null}
      </div>
    );
  }

  const needsAttention = op.state === "WAITING_ACCOUNT" || op.state === "PAUSED" || op.state === "REVIEW";
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-[color:var(--color-muted-foreground)]">{op.title}</p>
          <p className="tabular text-base font-semibold text-[color:var(--color-foreground)]">{op.target}</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">via {op.accountLabel}</p>
        </div>
        <div className="flex items-center gap-3">
          <StateBadge op={op} />
          <Link href={op.href} className="link text-[13px]">
            {op.state === "REVIEW" ? "Review" : "View details"}
          </Link>
        </div>
      </div>
      {op.detail && needsAttention ? (
        <div className="mb-3">
          <Alert tone={op.state === "REVIEW" ? "info" : "warning"}>{op.detail}</Alert>
        </div>
      ) : null}
      <div className="mb-2 flex items-baseline justify-between text-[13px] text-[color:var(--color-muted-foreground)]">
        <span>{op.progressLabel}</span>
        <span className="tabular font-medium text-[color:var(--color-foreground)]">
          {n(op.processed)} / {n(op.total)} · {percent(op)}%
        </span>
      </div>
      <ProgressBar value={op.processed} max={op.total} />
      {op.current ? <p className="mt-2 truncate text-[13px] text-[color:var(--color-muted-foreground)]">{op.current}</p> : null}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {op.counts.map((c) => (
          <StatTile key={c.label} label={c.label} value={n(c.value)} tone={c.tone} />
        ))}
      </div>
    </div>
  );
}
