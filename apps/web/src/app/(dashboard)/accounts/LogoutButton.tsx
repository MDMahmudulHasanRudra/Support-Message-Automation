"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { requestLogout } from "@/server/actions/accounts";

/**
 * ENGINEERING_STANDARDS.md §2: an operationally important, hard-to-reverse action (ends the
 * current session; restoring it needs a real phone to scan a new QR) must confirm before running,
 * not just submit on click like Reconnect/Resync Groups.
 */
export function LogoutButton() {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  if (done) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Logout requested — waiting for the worker to process it.</p>;
  }

  if (!confirming) {
    return (
      <Button variant="danger" onClick={() => setConfirming(true)}>
        Logout
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
      <p className="mb-2 text-sm font-medium text-red-800 dark:text-red-300">
        Are you sure? This will log out the connected WhatsApp account. You will need to scan a new QR code with a
        phone to reconnect — the current session cannot be restored automatically.
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={isPending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              await requestLogout();
              setDone(true);
            })
          }
        >
          {isPending ? "Logging out…" : "Confirm Logout"}
        </Button>
      </div>
    </div>
  );
}
