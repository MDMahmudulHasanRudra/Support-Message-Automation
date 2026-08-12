"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
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
      showToast({
        tone: "info",
        title: "Group sync requested",
        description:
          result.accountsQueued > 0
            ? `Queued for ${result.accountsQueued} account(s). The worker picks this up within a few seconds — new/renamed/left groups will update here once it's done.`
            : "No WhatsApp accounts to sync.",
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
