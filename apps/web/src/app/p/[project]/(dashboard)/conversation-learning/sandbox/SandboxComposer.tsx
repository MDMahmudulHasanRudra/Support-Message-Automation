"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useRef, useState, useTransition } from "react";

import { Send } from "lucide-react";
import { Button, Textarea, useToast } from "@/components/ui";
import { sendSandboxMessage } from "@/server/actions/sandbox";

/**
 * The sandbox's message box. Queues a turn and returns — the worker answers it within a
 * couple of seconds and the page's own polling brings the reply in (see the page's
 * AutoRefresh), the same DB-mediated hand-off the rest of this app uses for worker work.
 */
export function SandboxComposer({ sessionId, waiting }: { sessionId: string; waiting: boolean }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [value, setValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const boxRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const body = value.trim();
    if (!body || waiting) return;

    startTransition(async () => {
      const result = await sendSandboxMessage(sessionId, body);
      if (!result.ok) {
        showToast({ tone: "danger", title: "Couldn't send that", description: result.error });
        return;
      }
      setValue("");
      router.refresh();
      boxRef.current?.focus();
    });
  }

  return (
    <div className="flex items-end gap-2">
      <Textarea
        ref={boxRef}
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={waiting}
        placeholder={
          waiting ? "Waiting for the AI to answer…" : "Type a message the way a customer would…"
        }
        // Enter sends, Shift+Enter is a newline — the convention the chat composer already uses,
        // and what anyone testing a conversation expects.
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button onClick={submit} loading={isPending} disabled={waiting || value.trim().length === 0}>
        <Send className="size-3.5" aria-hidden />
        Send
      </Button>
    </div>
  );
}
