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
      {failedCount > 0 ? (
        <Button variant="secondary" onClick={() => setDialog("retry")}>
          Retry {failedCount} Failed Group(s)
        </Button>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
        loading={isPending}
        tone={dialog === "stop" ? "danger" : "primary"}
        title={dialog === "stop" ? "Stop this job?" : `Retry ${failedCount} failed group(s)?`}
        description={
          dialog === "stop"
            ? "Still-pending groups will be cancelled. A group already being processed is left to finish."
            : "Resets retry attempts for failed groups only — groups the number was already added to are never touched."
        }
        confirmLabel={dialog === "stop" ? "Stop Job" : "Retry"}
      />
    </div>
  );
}
