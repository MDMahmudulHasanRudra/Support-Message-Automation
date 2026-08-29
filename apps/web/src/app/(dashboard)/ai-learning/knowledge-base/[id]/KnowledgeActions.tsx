"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";
import {
  restoreKnowledgeVersion,
  setKnowledgeStatus,
  setKnowledgeVerified,
} from "@/server/actions/aiKnowledge";

export function KnowledgeStatusActions({ itemId, status }: { itemId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function apply(next: "ACTIVE" | "INACTIVE" | "ARCHIVED") {
    startTransition(async () => {
      await setKnowledgeStatus(itemId, next);
      router.refresh();
    });
  }

  return (
    <div className="flex gap-2">
      {status !== "ACTIVE" ? (
        <Button variant="secondary" size="sm" loading={pending} onClick={() => apply("ACTIVE")}>
          Activate
        </Button>
      ) : (
        <Button variant="secondary" size="sm" loading={pending} onClick={() => apply("INACTIVE")}>
          Deactivate
        </Button>
      )}
      {status !== "ARCHIVED" ? (
        <Button variant="ghost" size="sm" loading={pending} onClick={() => apply("ARCHIVED")}>
          Archive
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The exit from the review queue. An entry the knowledge builder distilled from a conversation
 * arrives unverified; this is how a person confirms it reads correctly, or sends it back.
 */
export function KnowledgeVerifyAction({ itemId, verified }: { itemId: string; verified: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function apply(next: boolean) {
    startTransition(async () => {
      await setKnowledgeVerified(itemId, next);
      router.refresh();
    });
  }

  if (verified) {
    return (
      <Button variant="ghost" size="sm" loading={pending} onClick={() => apply(false)}>
        Mark unverified
      </Button>
    );
  }

  return (
    <Button variant="secondary" size="sm" loading={pending} onClick={() => apply(true)}>
      Mark verified
    </Button>
  );
}

export function RestoreVersionButton({ itemId, version }: { itemId: string; version: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      await restoreKnowledgeVersion(itemId, version);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Restore
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirm}
        loading={pending}
        title={`Restore version ${version}?`}
        description="This adds a new version copying this one's content — nothing is deleted."
        confirmLabel="Restore"
      />
    </>
  );
}
