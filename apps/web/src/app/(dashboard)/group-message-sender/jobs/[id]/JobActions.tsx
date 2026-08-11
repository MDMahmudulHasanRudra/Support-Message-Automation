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
          Retry {failedCount} Failed Message(s)
        </Button>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        onConfirm={confirm}
        loading={isPending}
        tone={dialog === "stop" ? "danger" : "primary"}
        title={dialog === "stop" ? "Stop this job?" : `Retry ${failedCount} failed message(s)?`}
        description={
          dialog === "stop"
            ? "Still-pending messages will be cancelled. A message already being sent is left to finish."
            : "Resets retry attempts for failed messages only — sent messages are never touched."
        }
        confirmLabel={dialog === "stop" ? "Stop Job" : "Retry"}
      />
    </div>
  );
}
