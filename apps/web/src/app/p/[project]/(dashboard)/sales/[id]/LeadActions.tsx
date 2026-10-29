"use client";

import { useState, useTransition } from "react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { LEAD_STAGE_LABELS, LEAD_STAGES, type LeadStage } from "@support-automation/shared";
import { Alert, Button, ButtonLink, ConfirmDialog, Field, Input, Textarea, useToast } from "@/components/ui";
import { addLeadNote, deleteLead, moveLeadStage } from "@/server/actions/sales";

function useRun() {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ error?: string; success?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (r.error) {
        setError(r.error);
        return;
      }
      showToast({ tone: "success", title: r.success ?? "Done" });
      after?.();
      router.refresh();
    });
  };
  return { pending, error, run, router };
}

/** Stage buttons, Lost with its reason, and "Create order" which closes the lead as won. */
export function LeadStageControls({ leadId, stage, hasOrder }: { leadId: string; stage: LeadStage; hasOrder: boolean }) {
  const { pending, error, run, router } = useRun();
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState("");
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {LEAD_STAGES.filter((s) => s !== stage && s !== "LOST").map((s) => (
          <Button key={s} size="sm" variant={s === "WON" ? "primary" : "secondary"} loading={pending} onClick={() => run(() => moveLeadStage(leadId, s, ""))}>
            {LEAD_STAGE_LABELS[s]}
          </Button>
        ))}
        {stage !== "LOST" ? (
          <Button size="sm" variant="secondary" onClick={() => setLosing(true)}>
            Lost…
          </Button>
        ) : null}
        {!hasOrder ? (
          <ButtonLink href={`/commerce/orders/new?lead=${leadId}`} variant="primary">
            Create order
          </ButtonLink>
        ) : null}
        {!hasOrder ? (
          <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        ) : null}
      </div>
      {losing ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Why was it lost?">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="w-72" placeholder="Price, timing, chose another shop…" />
          </Field>
          <Button variant="danger" loading={pending} onClick={() => run(() => moveLeadStage(leadId, "LOST", reason), () => setLosing(false))}>
            Mark lost
          </Button>
          <Button variant="ghost" onClick={() => setLosing(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        tone="danger"
        loading={pending}
        title="Delete this lead?"
        description="The lead and its history are removed. To keep the record, mark it Lost instead."
        confirmLabel="Delete"
        onConfirm={() =>
          run(() => deleteLead(leadId), () => {
            setDeleting(false);
            router.push("/sales");
          })
        }
      />
    </div>
  );
}

export function LeadNoteForm({ leadId }: { leadId: string }) {
  const { pending, error, run } = useRun();
  const [note, setNote] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addLeadNote(leadId, note), () => setNote(""));
      }}
    >
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="What was said, what was promised…" className="min-h-0" />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" size="sm" loading={pending}>
        Add note
      </Button>
    </form>
  );
}
