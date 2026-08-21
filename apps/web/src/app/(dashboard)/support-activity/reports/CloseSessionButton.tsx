"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog } from "@/components/ui";
import { closeSupportSessionManually } from "@/server/actions/supportSessions";

/**
 * Admin-facing manual close for an OPEN support session that never received a completion keyword.
 * The server action's own claim-style guard handles the case where the automatic keyword path (or
 * another admin) closes it first — surfaced here as a plain message rather than a crash.
 */
export function CloseSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [alreadyClosed, setAlreadyClosed] = useState(false);
  const [isPending, startTransition] = useTransition();

  function confirmClose() {
    if (alreadyClosed) {
      setOpen(false);
      setAlreadyClosed(false);
      router.refresh();
      return;
    }
    startTransition(async () => {
      const result = await closeSupportSessionManually(sessionId);
      if (!result.ok && result.alreadyClosed) {
        setAlreadyClosed(true);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Close Session
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => {
          setOpen(false);
          setAlreadyClosed(false);
        }}
        onConfirm={confirmClose}
        loading={isPending}
        tone="primary"
        title="Close this support session?"
        description={
          alreadyClosed
            ? "This session was already completed (by a completion keyword or another admin) — refresh to see its final duration."
            : "Use this when a team member resolved the request but never sent a configured completion keyword. The session will be marked completed as of now."
        }
        confirmLabel={alreadyClosed ? "OK" : "Close Session"}
      />
    </>
  );
}
