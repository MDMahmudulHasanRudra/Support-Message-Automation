"use client";

import { useState, useTransition } from "react";
import { BellRing } from "lucide-react";
import { useToast } from "@/components/ui";
import { markChatWaiting } from "@/server/actions/chatOrganisation";

/**
 * Puts this conversation back in the "waiting" list.
 *
 * Opening a conversation clears it from that list, which is what makes the list usable — but it
 * means a conversation you opened, glanced at and could not deal with disappears from the one place
 * that would have reminded you. This is how you put it back: "I have seen it, it still needs
 * somebody."
 *
 * Only useful while the customer's message is genuinely unanswered, so the thread page renders it
 * only then rather than leaving a control that would do nothing.
 */
export function MarkWaitingButton({ groupId }: { groupId: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const { showToast } = useToast();

  if (done) {
    return (
      <span className="hidden text-[11px] text-[color:var(--color-muted-foreground)] sm:inline">
        Back in the waiting list
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={pending}
      title="Put this back in the waiting list"
      onClick={() =>
        startTransition(async () => {
          const result = await markChatWaiting(groupId);
          if (result.error) {
            showToast({ tone: "danger", title: result.error });
            return;
          }
          setDone(true);
          showToast({
            tone: "success",
            title: "Marked as waiting",
            description: "It is back in the waiting list until somebody replies.",
          });
        })
      }
      className="flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 text-[11px] font-medium text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
    >
      <BellRing className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">Mark as waiting</span>
    </button>
  );
}
