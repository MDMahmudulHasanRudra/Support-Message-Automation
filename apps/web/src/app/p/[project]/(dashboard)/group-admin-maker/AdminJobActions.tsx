"use client";

import { useState, useTransition } from "react";
import { useProjectRouter } from "@/components/ProjectLink";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { cancelGroupAdminPromotion, resumeGroupAdminPromotion } from "@/server/actions/groupAdminPromotion";

/** Cancel (any active job) and Resume (a paused one). */
export function AdminJobActions({ jobId, canCancel, canResume }: { jobId: string; canCancel: boolean; canResume: boolean }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ error?: string; success?: string }>) =>
    startTransition(async () => {
      const result = await action();
      setConfirming(false);
      if (result.error) showToast({ tone: "danger", title: "Not done", description: result.error });
      else showToast({ tone: "success", title: result.success ?? "Done" });
      router.refresh();
    });

  if (!canCancel && !canResume) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {canResume ? (
        <Button type="button" onClick={() => run(() => resumeGroupAdminPromotion(jobId))} loading={pending}>
          Resume
        </Button>
      ) : null}
      {canCancel ? (
        <Button type="button" variant="danger" onClick={() => setConfirming(true)} disabled={pending}>
          Cancel job
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => run(() => cancelGroupAdminPromotion(jobId))}
        loading={pending}
        tone="danger"
        title="Cancel this job?"
        description="Groups already promoted stay promoted. The groups not yet processed are left as they are."
        confirmLabel="Cancel job"
      />
    </div>
  );
}
