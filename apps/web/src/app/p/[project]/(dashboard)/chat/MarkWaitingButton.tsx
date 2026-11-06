"use client";

import { useState, useTransition } from "react";
import { BellRing, Check } from "lucide-react";
import { useToast } from "@/components/ui";
import { markChatWaiting, markPersonalChatWaiting } from "@/server/actions/chatOrganisation";

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
 *
 * A group is named by its row id; a personal (1:1) chat, which has no row, by account and chat id.
 */
export function MarkWaitingButton({ labelled = false, ...props }: ({ groupId: string } | { accountId: string; chatId: string }) & { /** Inside a menu: a full row with its name. */ labelled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const { showToast } = useToast();

  if (done) {
    return (
      <span title="Back in the waiting list" className="flex size-8 shrink-0 items-center justify-center text-[color:var(--color-success-fg)]">
        <Check className="size-4" aria-hidden />
        <span className="sr-only">Back in the waiting list</span>
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
          const result = "groupId" in props ? await markChatWaiting(props.groupId) : await markPersonalChatWaiting(props.accountId, props.chatId);
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
      aria-label="Mark as waiting"
      className={
        labelled
          ? "flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] text-[color:var(--color-foreground)] hover:bg-[var(--color-neutral-bg)] disabled:opacity-50"
          : "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] disabled:opacity-50 max-sm:hidden"
      }
    >
      <BellRing className="size-3.5" aria-hidden />
      {labelled ? "Mark as waiting" : null}
    </button>
  );
}
