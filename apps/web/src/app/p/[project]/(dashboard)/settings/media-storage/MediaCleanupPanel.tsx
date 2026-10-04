"use client";

import { useState, useTransition } from "react";
import { formatMediaBytes, MEDIA_CLEANUP_CONFIRMATION } from "@support-automation/shared";
import { Alert, Badge, type BadgeColor, Button, Card, ConfirmDialog, Field, Input, ProgressBar, SectionHeader, Select, useToast } from "@/components/ui";
import { cancelMediaCleanup, previewMediaCleanup, startMediaCleanup, type MediaCleanupPreview } from "@/server/actions/mediaStorage";
import { useProjectRouter } from "@/components/ProjectLink";
import type { MediaCleanupJobView } from "@/server/mediaStorageReports";

type JobRow = MediaCleanupJobView & { olderThanLabel: string; createdLabel: string; completedLabel: string | null };

const STATUS_LABEL: Record<MediaCleanupJobView["status"], { text: string; color: BadgeColor }> = {
  SCHEDULED: { text: "Scheduled", color: "blue" },
  RUNNING: { text: "Running", color: "blue" },
  COMPLETED: { text: "Completed", color: "green" },
  FAILED: { text: "Failed", color: "red" },
  CANCELLED: { text: "Cancelled", color: "gray" },
};

const OPTIONS = [
  { days: "90", label: "3 months" },
  { days: "180", label: "6 months" },
  { days: "365", label: "12 months" },
];

/**
 * "Delete media older than…": preview first (real counts from the media rows), then a confirmation
 * that has to be typed. The server schedules a job and returns; the worker removes the files in
 * batches, and this panel shows its real progress — files processed against the candidates counted
 * when it started.
 */
export function MediaCleanupPanel({ canManage, activeJob, jobs }: { canManage: boolean; activeJob: MediaCleanupJobView | null; jobs: JobRow[] }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [choice, setChoice] = useState("90");
  const [customDays, setCustomDays] = useState("30");
  const [preview, setPreview] = useState<MediaCleanupPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const days = choice === "custom" ? customDays : choice;

  function runPreview() {
    setError(null);
    startTransition(async () => {
      const result = await previewMediaCleanup(days);
      if (result.error) {
        setError(result.error);
        setPreview(null);
        return;
      }
      setPreview(result);
    });
  }

  function confirmDelete() {
    startTransition(async () => {
      const result = await startMediaCleanup({ olderThanDays: days, confirmation: typed });
      setConfirmOpen(false);
      setTyped("");
      if (result.error) {
        setError(result.error);
        return;
      }
      setPreview(null);
      showToast({ tone: "success", title: "Cleanup scheduled", description: "The worker is removing the files in the background. Progress shows below." });
      router.refresh();
    });
  }

  function cancel(jobId: string) {
    startTransition(async () => {
      const result = await cancelMediaCleanup(jobId);
      if (result.error) setError(result.error);
      router.refresh();
    });
  }

  const progress =
    activeJob && activeJob.totalCandidates ? Math.min(100, Math.round((activeJob.processedCount / Math.max(activeJob.totalCandidates, 1)) * 100)) : null;

  return (
    <Card>
      <SectionHeader
        title="Storage cleanup"
        description="Remove stored files older than a date, now. Messages and their text stay; only the files go."
      />

      {activeJob ? (
        <div className="mb-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge color="blue" dot pulse>{STATUS_LABEL[activeJob.status].text}</Badge>
              <span className="text-[13px] text-[color:var(--color-foreground)]">
                {activeJob.trigger === "RETENTION" ? "Retention cleanup" : "Manual cleanup"}
              </span>
            </div>
            {canManage ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => cancel(activeJob.id)} disabled={pending}>
                Stop cleanup
              </Button>
            ) : null}
          </div>
          {activeJob.totalCandidates !== null ? (
            <>
              <div className="mt-3">
                <ProgressBar value={progress ?? 0} />
              </div>
              <p className="tabular mt-2 text-[12px] text-[color:var(--color-muted-foreground)]">
                Processed {activeJob.processedCount.toLocaleString("en-US")} of {activeJob.totalCandidates.toLocaleString("en-US")} ·
                removed {activeJob.deletedCount.toLocaleString("en-US")} · freed {formatMediaBytes(activeJob.freedBytes)}
                {activeJob.failedCount ? ` · ${activeJob.failedCount.toLocaleString("en-US")} kept after an error` : ""}
              </p>
            </>
          ) : (
            <p className="mt-2 text-[12px] text-[color:var(--color-muted-foreground)]">Waiting for the worker to start it — usually within a few seconds.</p>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Delete media older than">
            <Select value={choice} onChange={(e) => (setChoice(e.target.value), setPreview(null))}>
              {OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
              <option value="custom">Custom number of days…</option>
            </Select>
          </Field>
          {choice === "custom" ? (
            <Field label="Days">
              <Input type="number" min={7} max={3650} value={customDays} onChange={(e) => (setCustomDays(e.target.value), setPreview(null))} className="w-28" />
            </Field>
          ) : null}
          <Button type="button" variant="secondary" onClick={runPreview} loading={pending && !confirmOpen} disabled={Boolean(activeJob)}>
            Preview cleanup
          </Button>
          {activeJob ? <span className="pb-2 text-[12px] text-[color:var(--color-muted-foreground)]">One cleanup at a time.</span> : null}
        </div>
      ) : null}

      {preview && !activeJob ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] bg-[var(--color-surface-sunken)] p-4">
          <div className="tabular text-[13px] text-[color:var(--color-foreground)]">
            <div>
              Older than: <strong>{preview.olderThanDays} days</strong>
            </div>
            <div>
              Files to delete: <strong>{(preview.files ?? 0).toLocaleString("en-US")}</strong>
            </div>
            <div>
              Storage to free: <strong>{formatMediaBytes(preview.bytes ?? 0)}</strong>
            </div>
          </div>
          <Button type="button" variant="danger" onClick={() => setConfirmOpen(true)} disabled={!preview.files}>
            {preview.files ? "Delete…" : "Nothing to delete"}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => (setConfirmOpen(false), setTyped(""))}
        onConfirm={confirmDelete}
        title={`Delete media older than ${preview?.olderThanDays ?? days} days?`}
        description={`This permanently removes ${(preview?.files ?? 0).toLocaleString("en-US")} stored file(s) — images, videos, audio, documents and any other attachments — freeing ${formatMediaBytes(preview?.bytes ?? 0)}. Messages and their text remain. This cannot be undone.`}
        confirmLabel="Delete media"
        tone="danger"
        loading={pending}
        confirmDisabled={typed.trim() !== MEDIA_CLEANUP_CONFIRMATION}
      >
        <Field label={`Type ${MEDIA_CLEANUP_CONFIRMATION} to confirm`}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </Field>
      </ConfirmDialog>

      {jobs.length ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-[11px] tracking-[0.04em] text-[color:var(--color-subtle-foreground)] uppercase">
                <th className="py-2 pr-3 font-medium">Started</th>
                <th className="py-2 pr-3 font-medium">Kind</th>
                <th className="py-2 pr-3 font-medium">Older than</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 text-right font-medium">Removed</th>
                <th className="py-2 text-right font-medium">Freed</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                  <td className="py-2 pr-3 text-[color:var(--color-muted-foreground)]">
                    {job.createdLabel}
                    {job.requestedBy ? <div className="text-[11px]">by {job.requestedBy}</div> : null}
                  </td>
                  <td className="py-2 pr-3">{job.trigger === "RETENTION" ? "Retention" : "Manual"}</td>
                  <td className="py-2 pr-3 text-[color:var(--color-muted-foreground)]">{job.olderThanLabel}</td>
                  <td className="py-2 pr-3">
                    <Badge color={STATUS_LABEL[job.status].color}>{STATUS_LABEL[job.status].text}</Badge>
                    {job.lastError ? <div className="mt-1 max-w-[18rem] text-[11px] leading-snug text-[color:var(--color-muted-foreground)]">{job.lastError}</div> : null}
                  </td>
                  <td className="tabular py-2 pr-3 text-right">{job.deletedCount.toLocaleString("en-US")}</td>
                  <td className="tabular py-2 text-right">{formatMediaBytes(job.freedBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
