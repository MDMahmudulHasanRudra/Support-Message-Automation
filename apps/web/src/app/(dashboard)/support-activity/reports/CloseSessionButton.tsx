"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, useToast } from "@/components/ui";
import { formatDateTime } from "@/lib/date";
import { formatElapsedShort } from "@/lib/duration";
import { closeSupportSessionManually } from "@/server/actions/supportSessions";

/**
 * Admin-facing manual close for an OPEN support session that never received a completion keyword.
 * The server action's own claim-style guard handles the case where the automatic keyword path (or
 * another admin) closes it first — surfaced as a plain, friendly toast rather than a raw error.
 */
export function CloseSessionButton({
  sessionId,
  groupName,
  startedAtIso,
}: {
  sessionId: string;
  groupName: string;
  startedAtIso: string;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const startedAt = new Date(startedAtIso);

  function confirmClose() {
    startTransition(async () => {
      try {
        const result = await closeSupportSessionManually(sessionId);
        if (!result.ok && result.alreadyClosed) {
          setOpen(false);
          showToast({
            tone: "info",
            title: "This session is no longer open",
            description: "It was already completed — refreshing to show its final duration.",
          });
          router.refresh();
          return;
        }
        setOpen(false);
        showToast({ tone: "success", title: "Support session closed", description: `${groupName}'s session is now marked completed.` });
        router.refresh();
      } catch {
        showToast({
          tone: "danger",
          title: "Couldn't close this session",
          description: "Please refresh the page and try again.",
        });
      }
    });
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} aria-label={`Close support session for ${groupName}`}>
        Close
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={confirmClose}
        loading={isPending}
        tone="primary"
        title="Close support session?"
        confirmLabel="Close Session"
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[color:var(--color-muted-foreground)]">Group</dt>
          <dd className="font-medium text-[color:var(--color-foreground)]">{groupName}</dd>
          <dt className="text-[color:var(--color-muted-foreground)]">Started</dt>
          <dd>{formatDateTime(startedAt)}</dd>
          <dt className="text-[color:var(--color-muted-foreground)]">Current duration</dt>
          <dd className="tabular-nums">{formatElapsedShort(startedAt)}</dd>
        </dl>
        <p className="mt-4 text-sm text-[color:var(--color-muted-foreground)]">
          Use this when a team member resolved the request but never sent a configured completion
          keyword. Are you sure this support session has been resolved?
        </p>
      </ConfirmDialog>
    </>
  );
}
