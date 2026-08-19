"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ignoreIssueResolutionEvent } from "@/server/actions/issues";

export function IgnoreEventButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          await ignoreIssueResolutionEvent(eventId);
          router.refresh();
        })
      }
    >
      Ignore
    </Button>
  );
}
