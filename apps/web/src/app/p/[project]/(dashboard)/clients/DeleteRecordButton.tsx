"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { deleteClientNote, deleteDues, deletePayments, deleteSubscriptions } from "@/server/actions/clientDeletes";

type Kind = "subscription" | "invoice" | "payment" | "note";

const COPY: Record<Kind, { title: string; description: string }> = {
  subscription: {
    title: "Delete this subscription?",
    description: "The term is removed for good and the current plan is worked out again from what is left. Invoices raised for it stay. To end a real subscription, pause or cancel it instead — that keeps the history.",
  },
  invoice: {
    title: "Delete this invoice?",
    description: "It is removed for good with its history. If a recorded payment still settles it, it is kept — reverse or delete that payment first. To stop expecting money, waive or cancel it instead.",
  },
  payment: {
    title: "Delete this payment?",
    description: "The receipt is removed for good, and the invoices it settled are open again for its amount. If the money really was received, reverse it instead — a reversal keeps the record.",
  },
  note: { title: "Delete this note?", description: "The note is removed for good. The timeline records that a note was deleted, not what it said." },
};

/**
 * Delete for one record on a client's profile. Rendered only for someone allowed to delete (an
 * Administrator, or a role an Administrator gave `clients.delete`); the action checks again.
 */
export function DeleteRecordButton({ kind, id, label = "Delete" }: { kind: Kind; id: string; label?: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, start] = useTransition();
  return (
    <>
      <Button size="sm" variant="ghost" className="!text-[color:var(--color-danger-fg)] hover:!bg-[var(--color-danger-bg)]" onClick={() => setOpen(true)} disabled={busy}>
        <Trash2 className="size-3.5" aria-hidden /> {label}
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        loading={busy}
        tone="danger"
        title={COPY[kind].title}
        description={COPY[kind].description}
        confirmLabel="Delete permanently"
        onConfirm={() =>
          start(async () => {
            const r =
              kind === "subscription" ? await deleteSubscriptions([id]) : kind === "invoice" ? await deleteDues([id]) : kind === "payment" ? await deletePayments([id]) : await deleteClientNote(id);
            showToast({ tone: r.ok ? "success" : "danger", title: r.message });
            setOpen(false);
            router.refresh();
          })
        }
      />
    </>
  );
}
