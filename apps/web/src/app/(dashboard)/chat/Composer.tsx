"use client";

import { SendHorizontal } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { Alert, Button, Textarea } from "@/components/ui";
import { sendChatMessage, type ChatSendState } from "@/server/actions/chat";
import { SavedReplyManager } from "./SavedReplyManager";
import { SavedReplyPicker, type SavedReplyOption } from "./SavedReplyPicker";

const INITIAL: ChatSendState = {};

/** Where an unsent draft lives, per conversation. */
const draftKey = (groupId: string) => `chat-draft:${groupId}`;

/**
 * Writes one reply into the outbound queue. Enter sends, Shift+Enter starts a new line —
 * the convention every chat client already uses, so it needs no label.
 *
 * Drafts survive leaving the conversation. Triage means moving between conversations constantly,
 * and losing a half-written reply because you checked something in another group is the kind of
 * small loss that teaches people not to trust the box. Kept in localStorage rather than the
 * database: a draft is this person's unfinished thought on this machine, and syncing it to a
 * shared table would show a colleague words nobody chose to send.
 */
export function Composer({
  groupId,
  disabledReason,
  savedReplies,
}: {
  groupId: string;
  /** Non-null when sending is impossible right now (account offline, group left). */
  disabledReason?: string | null;
  savedReplies: SavedReplyOption[];
}) {
  const sendToGroup = sendChatMessage.bind(null, groupId);
  const [state, formAction, pending] = useActionState(sendToGroup, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [managingReplies, setManagingReplies] = useState(false);

  // Restore on arrival. Keyed by group, so switching conversations swaps drafts rather than
  // carrying one into the wrong chat — the worst possible failure for this feature.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    try {
      textarea.value = window.localStorage.getItem(draftKey(groupId)) ?? "";
    } catch {
      // Private mode, or storage disabled. A composer that works without drafts is fine; one that
      // fails to render because storage threw is not.
    }
  }, [groupId]);

  useEffect(() => {
    // Clear only once the action has actually resolved and re-rendered, never in onSubmit:
    // resetting synchronously would wipe the textarea before React reads its FormData and
    // submit an empty message (the same trap FloatingAiChat documents).
    if (!state.sentAt) return;
    formRef.current?.reset();
    try {
      window.localStorage.removeItem(draftKey(groupId));
    } catch {
      /* see above */
    }
  }, [state.sentAt, groupId]);

  function rememberDraft(value: string) {
    try {
      if (value.trim()) window.localStorage.setItem(draftKey(groupId), value);
      else window.localStorage.removeItem(draftKey(groupId));
    } catch {
      /* see above */
    }
  }

  /**
   * Drops a saved reply in at the cursor rather than replacing what is there — somebody who has
   * typed "Assalamualaikum, " and then reaches for a saved paragraph means to keep both.
   */
  function insertSavedReply(body: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    // A space only where one is actually needed, so the join does not read as a typo either way.
    const separator = before && !/\s$/.test(before) ? " " : "";

    textarea.value = `${before}${separator}${body}${after}`;
    const caret = before.length + separator.length + body.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    rememberDraft(textarea.value);
  }

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

        <SavedReplyPicker
          replies={savedReplies}
          onInsert={insertSavedReply}
          onManage={() => setManagingReplies(true)}
        />

        <Textarea
          ref={textareaRef}
          id="chat-body"
          name="body"
          rows={1}
          required
          maxLength={4096}
          placeholder="Type a message…  (Enter to send, Shift+Enter for a new line)"
          className="min-h-10 resize-none py-2.5"
          onChange={(event) => rememberDraft(event.target.value)}
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

      <SavedReplyManager
        open={managingReplies}
        onClose={() => setManagingReplies(false)}
        replies={savedReplies}
      />
    </div>
  );
}
