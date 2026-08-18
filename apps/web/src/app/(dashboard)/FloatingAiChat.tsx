"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Bot, Send, X } from "lucide-react";
import { Alert, Badge, Button, Textarea } from "@/components/ui";
import { sendAiAdminMessage, type AiAdminChatState } from "@/server/actions/aiAdminChat";

const INITIAL_STATE: AiAdminChatState = { turns: [] };

export function FloatingAiChat() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(sendAiAdminMessage, INITIAL_STATE);
  const formRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    // Clear the composer only once the action has actually resolved and re-rendered with the new
    // turns — resetting synchronously in onSubmit would clear the textarea's value before React
    // captures the FormData for the action, submitting an empty message.
    formRef.current?.reset();
  }, [state.turns.length]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open AI Admin Assistant"
        className="fixed bottom-6 right-6 z-50 flex size-14 cursor-pointer items-center justify-center rounded-full bg-[image:var(--gradient-primary)] text-[var(--color-on-primary)] shadow-[var(--shadow-lg)] transition-transform duration-150 hover:scale-105"
      >
        <Bot className="size-6" aria-hidden />
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex h-[520px] w-[380px] max-w-[calc(100vw-3rem)] flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[color:var(--color-primary)]">
            <Bot className="size-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-semibold text-[color:var(--color-foreground)]">AI Admin Assistant</p>
            <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Read-only — can&apos;t change settings yet</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {state.turns.length === 0 ? (
          <p className="text-sm text-[color:var(--color-muted-foreground)]">
            Ask about support activity, connected accounts, groups, priority cases, AI settings, or broadcast
            jobs — e.g. &ldquo;how many groups were supported today?&rdquo; or &ldquo;আজকে কে সবচেয়ে বেশি support
            দিয়েছে?&rdquo;
          </p>
        ) : (
          state.turns.map((turn, i) => (
            <div key={i} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-[var(--radius-md)] px-3 py-2 text-sm whitespace-pre-wrap ${
                  turn.role === "user"
                    ? "bg-[image:var(--gradient-primary)] text-[var(--color-on-primary)]"
                    : "bg-[var(--color-neutral-bg)] text-[color:var(--color-foreground)]"
                }`}
              >
                {turn.text}
              </div>
            </div>
          ))
        )}
        {pending ? (
          <div className="flex justify-start">
            <Badge color="gray" dot>
              Thinking…
            </Badge>
          </div>
        ) : null}
      </div>

      {state.error ? (
        <div className="px-4 pb-2">
          <Alert tone="danger" title="Something went wrong">
            {state.error}
          </Alert>
        </div>
      ) : null}

      <form ref={formRef} action={formAction} className="flex items-end gap-2 border-t border-[var(--color-border)] p-3">
        <Textarea
          name="message"
          placeholder="Ask a question…"
          rows={1}
          required
          className="min-h-9 resize-none py-2"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
        />
        <Button type="submit" size="sm" loading={pending} aria-label="Send">
          <Send className="size-4" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
