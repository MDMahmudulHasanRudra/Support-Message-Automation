"use client";

import { SendHorizontal } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { Alert, Button, Textarea } from "@/components/ui";
import { sendChatMessage, type ChatSendState } from "@/server/actions/chat";

const INITIAL: ChatSendState = {};

/**
 * Writes one reply into the outbound queue. Enter sends, Shift+Enter starts a new line —
 * the convention every chat client already uses, so it needs no label.
 */
export function Composer({
  groupId,
  disabledReason,
}: {
  groupId: string;
  /** Non-null when sending is impossible right now (account offline, group left). */
  disabledReason?: string | null;
}) {
  const sendToGroup = sendChatMessage.bind(null, groupId);
  const [state, formAction, pending] = useActionState(sendToGroup, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Clear only once the action has actually resolved and re-rendered, never in onSubmit:
    // resetting synchronously would wipe the textarea before React reads its FormData and
    // submit an empty message (the same trap FloatingAiChat documents).
    if (state.sentAt) formRef.current?.reset();
  }, [state.sentAt]);

  if (disabledReason) {
    return (
      <div className="border-t border-[var(--color-border)] p-4 sm:px-6">
        <Alert tone="warning">{disabledReason}</Alert>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:px-6 sm:py-4">
      {state.error ? (
        <div className="mb-3">
          <Alert tone="danger">{state.error}</Alert>
        </div>
      ) : null}

      <form ref={formRef} action={formAction} className="flex items-end gap-2">
        <label htmlFor="chat-body" className="sr-only">
          Message
        </label>
        <Textarea
          id="chat-body"
          name="body"
          rows={1}
          required
          maxLength={4096}
          placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
          className="min-h-10 resize-none py-2.5"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
        />
        <Button type="submit" loading={pending} aria-label="Send message" className="h-10 shrink-0 px-3.5">
          {pending ? null : <SendHorizontal className="size-4" aria-hidden />}
        </Button>
      </form>

      <p className="mt-2 text-[10px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        Sent through the same outbound queue as automated replies, so account rate limits still
        apply. Delivery usually takes a couple of seconds.
      </p>
    </div>
  );
}
