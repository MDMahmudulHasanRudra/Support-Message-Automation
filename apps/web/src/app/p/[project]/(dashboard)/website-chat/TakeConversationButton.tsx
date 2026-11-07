"use client";

import { useTransition } from "react";
import { Button, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { assignChannelConversationAction } from "@/server/actions/channelInbox";

/** Takes a conversation nobody holds, so a colleague looking at the same board sees it is being handled. */
export function TakeConversationButton({ id }: { id: string }) {
  const [busy, start] = useTransition();
  const { showToast } = useToast();
  const router = useProjectRouter();
  return (
    <Button
      size="sm"
      loading={busy}
      onClick={() =>
        start(async () => {
          const result = await assignChannelConversationAction(id, true);
          showToast({ tone: result.error ? "danger" : "success", title: result.error ?? "Assigned to you." });
          router.refresh();
        })
      }
    >
      Take
    </Button>
  );
}
