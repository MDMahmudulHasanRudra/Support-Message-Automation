"use client";

import { useState, useTransition } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Button, ConfirmDialog, Field, Input, useToast } from "@/components/ui";
import { assignSupportCases, cancelSupportCases } from "@/server/actions/supportAssignment";
import type { AssignableMember } from "@/server/supportAssignment";
import { AssignDialog } from "../AssignDialog";

/** Assign / reassign / cancel one case from its detail page — the same actions as the list. */
export function CaseActions({ id, unassigned, members }: { id: string; unassigned: boolean; members: AssignableMember[] }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [dialog, setDialog] = useState<"assign" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, startTransition] = useTransition();

  const assign = (memberId: string) =>
    startTransition(async () => {
      const result = await assignSupportCases({ ids: [id], memberId, reassign: !unassigned });
      setDialog(null);
      if (result.error || !(result.assigned || result.reassigned)) {
        showToast({ tone: "danger", title: "Not assigned", description: result.error ?? result.skipped?.[0]?.reason });
        return;
      }
      showToast({
        tone: "success",
        title: unassigned ? "Assigned" : "Reassigned",
        description: result.notifySkipped ? "The WhatsApp notification could not be queued — see the history below." : undefined,
      });
      router.refresh();
    });

  const cancel = () =>
    startTransition(async () => {
      const result = await cancelSupportCases({ ids: [id], reason });
      setDialog(null);
      setReason("");
      if (result.error || !result.cancelled) {
        showToast({ tone: "danger", title: "Not cancelled", description: result.error ?? "It had already finished." });
        return;
      }
      showToast({ tone: "success", title: "Case cancelled" });
      router.refresh();
    });

  return (
    <div className="flex gap-2">
      <Button variant="secondary" onClick={() => setDialog("cancel")} disabled={busy}>
        Cancel case
      </Button>
      <Button onClick={() => setDialog("assign")} disabled={busy}>
        {unassigned ? "Assign" : "Reassign"}
      </Button>
      <AssignDialog
        key={dialog ?? "none"}
        open={dialog === "assign"}
        onClose={() => setDialog(null)}
        onConfirm={(memberId) => assign(memberId)}
        members={members}
        caseCount={1}
        assignedCount={0}
        busy={busy}
      />
      <ConfirmDialog
        open={dialog === "cancel"}
        onClose={() => (setDialog(null), setReason(""))}
        onConfirm={cancel}
        title="Cancel this case?"
        description="This closes the case as not needing support. No message or chat history changes and nobody is notified. If the customer writes again, a new case opens."
        confirmLabel="Cancel case"
        tone="danger"
        loading={busy}
      >
        <Field label="Reason (optional)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
