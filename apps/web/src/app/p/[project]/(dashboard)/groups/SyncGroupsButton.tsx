"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useTransition } from "react";

import { RefreshCw } from "lucide-react";
import { Button, useToast } from "@/components/ui";
import { requestSyncAllGroups } from "@/server/actions/accounts";

export function SyncGroupsButton() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const { showToast } = useToast();

  function handleClick() {
    startTransition(async () => {
      const result = await requestSyncAllGroups();
      const total = result.accountsQueued + result.alreadyRunning;
      showToast({
        tone: "info",
        title: result.accountsQueued > 0 ? "Group sync requested" : total > 0 ? "Sync already in progress" : "Nothing to sync",
        description:
          total === 0
            ? "No WhatsApp accounts to sync."
            : [
                result.accountsQueued > 0
                  ? `Started for ${result.accountsQueued} account(s). Each account syncs on its own, so groups appear here as each one finishes.`
                  : null,
                result.alreadyRunning > 0 ? `${result.alreadyRunning} account(s) were already syncing.` : null,
              ]
                .filter(Boolean)
                .join(" "),
      });
      router.refresh();
    });
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleClick} loading={isPending}>
      <RefreshCw className="size-3.5" aria-hidden />
      Sync Groups
    </Button>
  );
}
