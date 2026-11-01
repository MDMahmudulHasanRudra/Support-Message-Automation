"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, MailPlus, X } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Alert, Button, Dialog, Field, Select, Textarea, useToast } from "@/components/ui";
import { approveMessageBatch, closeMessageBatch, listTemplateOptions, prepareMessageBatch, type BatchRecipientInput, type TemplateOption } from "@/server/actions/clientMessages";
import { MESSAGE_BATCH_APPROVAL_HOURS, MESSAGE_BATCH_MAX_RECIPIENTS } from "@support-automation/shared";

/** Approve / reject (another person) or cancel (the preparer) one batch that is waiting. */
export function BatchDecision({ batchId, isSubmitter, canApprove, canReject, canCancel }: { batchId: string; isSubmitter: boolean; canApprove: boolean; canReject: boolean; canCancel: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busy, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) {
        setRejecting(false);
        router.refresh();
      }
    });
  return (
    <>
      {canApprove ? (
        <Button size="sm" loading={busy} onClick={() => run(() => approveMessageBatch(batchId))}>
          <Check className="size-4" aria-hidden /> Approve and queue
        </Button>
      ) : null}
      {canReject ? (
        <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
          <X className="size-4" aria-hidden /> Reject
        </Button>
      ) : null}
      {canCancel ? (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => closeMessageBatch(batchId, "CANCEL", ""))}>
          Cancel
        </Button>
      ) : null}
      {isSubmitter ? <span className="text-xs text-[color:var(--color-muted-foreground)]">Someone else must approve it.</span> : null}
      <Dialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="Reject this batch?"
        description="Nothing is sent. The preparer sees your reason."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              Keep it
            </Button>
            <Button variant="danger" disabled={!note.trim()} loading={busy} onClick={() => run(() => closeMessageBatch(batchId, "REJECT", note))}>
              Reject
            </Button>
          </div>
        }
      >
        <Field label="Reason">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
        </Field>
      </Dialog>
    </>
  );
}

/**
 * "Bulk email" from a list selection: choose a template, then the batch is PREPARED (filled in, checked per
 * recipient) and waits for another person's approval. Says exactly how many were selected; nothing outside the
 * selection is ever included.
 */
export function BulkEmailButton({ recipients, disabled, label = "Bulk email…" }: { recipients: BatchRecipientInput[]; disabled?: boolean; label?: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [busy, start] = useTransition();
  useEffect(() => {
    if (!open || templates) return;
    void listTemplateOptions().then((list) => {
      const usable = list.filter((t) => t.channel === "EMAIL" || t.channel === "ANY");
      setTemplates(usable);
      setTemplateId(usable[0]?.id ?? "");
    });
  }, [open, templates]);
  const tooMany = recipients.length > MESSAGE_BATCH_MAX_RECIPIENTS;
  return (
    <>
      <Button size="sm" variant="secondary" disabled={disabled || recipients.length === 0} onClick={() => setOpen(true)}>
        <MailPlus className="size-3.5" aria-hidden /> {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Bulk email to ${recipients.length} selected`}
        description={`Only the ${recipients.length} you selected. Each is filled in and checked; someone else must approve within ${MESSAGE_BATCH_APPROVAL_HOURS} hours before anything is sent.`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              disabled={!templateId || tooMany}
              loading={busy}
              onClick={() =>
                start(async () => {
                  const r = await prepareMessageBatch(templateId, recipients);
                  showToast({ tone: r.ok ? "success" : "danger", title: r.message });
                  if (r.ok && r.batchId) {
                    setOpen(false);
                    router.push(`/clients/messages?batch=${r.batchId}`);
                  }
                })
              }
            >
              Prepare for approval
            </Button>
          </div>
        }
      >
        {tooMany ? <Alert tone="warning">One batch takes at most {MESSAGE_BATCH_MAX_RECIPIENTS} recipients. Narrow the selection.</Alert> : null}
        {templates && templates.length === 0 ? (
          <Alert tone="info">No active Email or Any-channel template. Create one under Clients → Client Messages → Message Templates.</Alert>
        ) : (
          <Field label="Template">
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!templates}>
              {(templates ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.categoryLabel} · {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Dialog>
    </>
  );
}
