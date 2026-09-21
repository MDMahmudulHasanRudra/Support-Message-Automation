"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";

type DialogKind = "stop" | "retry" | null;

export function JobActions({
  showStop,
  failedCount,
  onStop,
  onRetry,
}: {
  showStop: boolean;
  failedCount: number;
  onStop: () => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      if (dialog === "stop") await onStop();
      if (dialog === "retry") await onRetry();
      setDialog(null);
      router.refresh();
    });
  }

  if (!showStop && failedCount === 0) return null;

  return (
    <div className="mb-4 flex gap-2">
      {showStop ? (
        <Button variant="danger" onClick={() => setDialog("stop")}>
          Stop Job
        </Button>
      ) : null}
      {/* Re-check, never a blind re-attempt. A failed add may have failed because the person
          joined in the meantime, so retrying straight away would spend another add to be told so.
          Sending them back through the membership check turns that into a skip costing nothing —
          and puts the answer in front of a person again before anything is sent. */}
      {failedCount > 0 ? (
        <Button variant="secondary" onClick={() => setDialog("retry")}>
          Re-check {failedCount} Failed
        </Button>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
        loading={isPending}
        tone={dialog === "stop" ? "danger" : "primary"}
        title={dialog === "stop" ? "Stop this job?" : `Re-check ${failedCount} failed entr${failedCount === 1 ? "y" : "ies"}?`}
        description={
          dialog === "stop"
            ? "Still-pending groups will be cancelled. A group already being processed is left to finish."
            : "Reads each group's members again and brings the job back to the review screen. Anyone who has since joined is reported as already a member instead of being added again. Nothing is sent until you confirm the new results."
        }
        confirmLabel={dialog === "stop" ? "Stop Job" : "Re-check"}
      />
    </div>
  );
}
