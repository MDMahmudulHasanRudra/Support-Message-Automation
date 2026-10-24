"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleSlash, Download, Loader2, RotateCw, StopCircle, Users, WifiOff, XCircle } from "lucide-react";
import Link, { useProjectHref } from "@/components/ProjectLink";
import { Alert, Button, Card, Dialog } from "@/components/ui";
import { cancelSmartImport, readSmartImportStatus, retrySmartImport, type SmartStatus } from "@/server/actions/smartImport";

/**
 * Smart Bulk Import, step 4 (SMART_IMPORT.md): the import as the SERVER reports it. Every number is
 * counted from the database's rows on each reading; nothing is animated toward a guess. Leaving the page
 * changes nothing — the import runs in the background, and coming back reads it again.
 */

const RUNNING = new Set(["QUEUED", "PROCESSING"]);
const STATUS_TEXT: Record<string, string> = {
  QUEUED: "Waiting to start",
  PROCESSING: "Importing",
  COMPLETED: "Finished",
  PARTIAL: "Finished, with rows not imported",
  FAILED: "Nothing could be imported",
  CANCELLED: "Stopped",
};

export function ImportProgress({
  jobId,
  initial,
  rowsKept,
  onBackToReview,
  onFinished,
}: {
  jobId: string;
  initial: SmartStatus | null;
  rowsKept: boolean;
  onBackToReview: () => void;
  /** Called once when a run this view was following ends, so the page can read the job again. */
  onFinished: () => void;
}) {
  const toProject = useProjectHref();
  const [status, setStatus] = useState<SmartStatus | null>(initial);
  const [offline, setOffline] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const failures = useRef(0);
  // A status still reading PREVIEW is the page's reading from before the confirmation landed: keep asking.
  const running = !status || RUNNING.has(status.status) || status.status === "PREVIEW";

  useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await readSmartImportStatus(jobId);
        if (!live) return;
        failures.current = 0;
        setOffline(false);
        if (next) {
          setStatus(next);
          if (!RUNNING.has(next.status) && next.status !== "PREVIEW") onFinished();
        }
      } catch {
        failures.current += 1;
        if (live) setOffline(true);
      }
      // Faster while something is moving; slower and backing off while the connection is down.
      if (live) timer = setTimeout(tick, document.hidden ? 5000 : Math.min(1500 * 2 ** failures.current, 15000));
    };
    timer = setTimeout(tick, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId, running, onFinished]);

  if (!status) {
    return (
      <Card className="flex items-center gap-2 p-6! text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Connecting to the import…
      </Card>
    );
  }

  const c = status.counts;
  const considered = Math.max(1, c.total - c.ignored);
  const settled = c.done - c.ignored;
  const percent = Math.min(100, Math.round((settled / considered) * 100));
  const notImported = c.invalid + c.failed;
  const finished = !RUNNING.has(status.status) && status.status !== "PREVIEW";

  return (
    <div className="space-y-4">
      <Card className="space-y-5 p-6!">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <StatusIcon status={status.status} />
            <div>
              <p className="text-[17px] font-semibold" aria-live="polite">
                {status.cancelRequested && status.status === "PROCESSING" ? "Stopping after the current batch…" : (STATUS_TEXT[status.status] ?? status.status)}
              </p>
              <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">
                {offline ? (
                  <span className="inline-flex items-center gap-1 text-[color:var(--color-warning-fg)]">
                    <WifiOff className="size-3.5" aria-hidden />
                    Reconnecting… last reading {new Date(status.readAt).toLocaleTimeString()}
                  </span>
                ) : running ? (
                  `Live from the server · ${new Date(status.readAt).toLocaleTimeString()}`
                ) : status.completedAt ? (
                  `Ended ${new Date(status.completedAt).toLocaleString()}`
                ) : null}
              </p>
            </div>
          </div>
          {status.status === "PROCESSING" && !status.cancelRequested ? (
            <Button variant="secondary" onClick={() => setConfirmStop(true)}>
              <StopCircle className="size-4" aria-hidden />
              Stop import
            </Button>
          ) : null}
          {status.status === "QUEUED" ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const r = await cancelSmartImport(jobId);
                setBusy(false);
                setMessage(r.message);
                if (r.ok) onBackToReview();
              }}
            >
              Not yet — back to review
            </Button>
          ) : null}
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between text-[12.5px]">
            <span>
              <span className="text-[20px] font-semibold tabular">{settled.toLocaleString()}</span>
              <span className="text-[color:var(--color-muted-foreground)]"> of {considered.toLocaleString()} rows done</span>
            </span>
            <span className="tabular text-[color:var(--color-muted-foreground)]">{percent}%</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-[var(--color-neutral-bg)]" role="progressbar" aria-valuemin={0} aria-valuemax={considered} aria-valuenow={settled} aria-label="Rows done">
            {status.status === "QUEUED" ? (
              <div className="h-full w-1/4 animate-pulse rounded-full bg-[var(--color-accent)]/50" />
            ) : (
              <div className={`h-full rounded-full transition-[width] duration-500 ${finished && notImported === 0 ? "bg-[var(--color-success)]" : "bg-[var(--color-accent)]"}`} style={{ width: `${percent}%` }} />
            )}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Count label="Created" value={c.created} tone="success" />
          <Count label="Updated" value={c.updated} tone="info" />
          <Count label="Skipped" value={c.skipped + c.ignored} />
          <Count label="Not imported" value={notImported} tone={notImported ? "danger" : undefined} />
          <Count label={finished ? "Not attempted" : "Waiting"} value={c.pending} />
        </dl>
        {message ? <Alert tone="info">{message}</Alert> : null}
      </Card>

      {finished ? (
        <Card className="flex flex-wrap items-center gap-2 p-4!">
          <Link href="/clients" className="inline-flex h-9.5 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-on-primary)] hover:bg-[var(--color-primary-hover)]">
            <Users className="size-4" aria-hidden />
            View clients
          </Link>
          {notImported > 0 && rowsKept ? (
            <a href={toProject(`/api/clients/import/${jobId}/problems`)} download className="inline-flex h-9.5 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-4 text-sm font-medium hover:bg-[var(--color-neutral-bg)]">
              <Download className="size-4" aria-hidden />
              Download rows not imported
            </a>
          ) : null}
          {(c.failed > 0 || c.pending > 0) && rowsKept ? (
            <Button
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const r = await retrySmartImport(jobId);
                setBusy(false);
                setMessage(r.message);
                if (r.ok) setStatus({ ...status, status: "QUEUED" });
              }}
            >
              <RotateCw className="size-4" aria-hidden />
              Retry {(c.failed + c.pending).toLocaleString()} row{c.failed + c.pending === 1 ? "" : "s"}
            </Button>
          ) : null}
          <Link href="/clients/import" className="inline-flex h-9.5 items-center rounded-[var(--radius-md)] px-3 text-sm font-medium text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]">
            Import another file
          </Link>
          {status.status === "CANCELLED" ? <p className="basis-full text-[12.5px] text-[color:var(--color-muted-foreground)]">Clients imported before the stop are kept; nothing was rolled back.</p> : null}
        </Card>
      ) : null}

      {confirmStop ? (
        <Dialog
          open
          onClose={() => setConfirmStop(false)}
          title="Stop this import?"
          description="It stops after the batch it is working on. Clients already imported stay imported — nothing is undone. You can retry the rest later."
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmStop(false)}>
                Keep importing
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await cancelSmartImport(jobId);
                  setBusy(false);
                  setConfirmStop(false);
                  setMessage(r.message);
                  if (r.ok) setStatus({ ...status, cancelRequested: true });
                }}
              >
                Stop after this batch
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  const cls = "size-10 shrink-0";
  if (status === "COMPLETED") return <CheckCircle2 className={`${cls} text-[color:var(--color-success)]`} aria-hidden />;
  if (status === "FAILED") return <XCircle className={`${cls} text-[color:var(--color-danger)]`} aria-hidden />;
  if (status === "CANCELLED") return <CircleSlash className={`${cls} text-[color:var(--color-muted-foreground)]`} aria-hidden />;
  if (status === "PARTIAL") return <CheckCircle2 className={`${cls} text-[color:var(--color-warning)]`} aria-hidden />;
  return (
    <span className={`${cls} flex items-center justify-center rounded-full bg-[var(--color-accent)]/10`}>
      <Loader2 className="size-5 animate-spin text-[color:var(--color-accent)]" aria-hidden />
    </span>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" | "info" }) {
  const color = tone === "success" ? "text-[color:var(--color-success-fg)]" : tone === "danger" ? "text-[color:var(--color-danger-fg)]" : tone === "info" ? "text-[color:var(--color-info-fg)]" : "";
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--color-neutral-bg)]/60 px-3 py-2.5">
      <dt className="text-[11.5px] text-[color:var(--color-muted-foreground)]">{label}</dt>
      <dd className={`text-[18px] font-semibold tabular ${color}`}>{value.toLocaleString()}</dd>
    </div>
  );
}
