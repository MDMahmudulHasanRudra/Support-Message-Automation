"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { registerComposer } from "@/lib/composerBridge";
import { Lock, SendHorizontal } from "lucide-react";
import { CHANNELS, validateChannelText, type ChannelType } from "@support-automation/shared";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, useToast } from "@/components/ui";
import { sendChannelReplyAction } from "@/server/actions/channelInbox";

/**
 * The reply box for a Messenger / Instagram / Telegram conversation (OMNICHANNEL.md §8).
 *
 * It never sends anything itself: the action queues the reply and the worker sends it. Each message
 * carries a nonce made once when it is typed, so a double press or a re-submitted request queues it
 * once. Drafts are kept per conversation in this browser, like WhatsApp Chat's composer — a draft is
 * one person's unfinished thought and does not belong in a shared table.
 */

const DRAFT_KEY = (id: string) => `channel-draft:${id}`;
const newNonce = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function readDraft(id: string): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY(id)) ?? "";
  } catch {
    return "";
  }
}
const noSubscription = () => () => undefined;

function writeDraft(id: string, value: string) {
  try {
    if (value) window.localStorage.setItem(DRAFT_KEY(id), value);
    else window.localStorage.removeItem(DRAFT_KEY(id));
  } catch {
    /* private mode: drafts are a convenience */
  }
}

export function ChannelComposer({
  conversationId,
  type,
  via,
  disabledReason,
  humanAgentReply,
}: {
  conversationId: string;
  type: ChannelType;
  via: string;
  disabledReason: string | null;
  humanAgentReply: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  // The saved draft is read through useSyncExternalStore rather than copied into state from an effect:
  // localStorage cannot be read while rendering on the server, and the server snapshot ("") is what
  // the first client render matches before the draft appears.
  const stored = useSyncExternalStore(noSubscription, () => readDraft(conversationId), () => "");
  const [edited, setEdited] = useState<string | null>(null);
  const text = edited ?? stored;
  const setText = setEdited;
  const [nonce, setNonce] = useState(newNonce);
  const [pending, startTransition] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(text);
  // The inbox workspace's Copilot can fill this box (lib/composerBridge.ts); sending stays the Send button.
  useEffect(() => {
    latest.current = text;
    return registerComposer({
      fill(next) {
        setText(next);
        writeDraft(conversationId, next);
        box.current?.focus();
      },
      read: () => latest.current,
    });
  });

  const def = CHANNELS[type];
  const size = def.maxTextUnit === "bytes" ? new TextEncoder().encode(text.trim()).length : [...text.trim()].length;
  const problem = text.trim() ? validateChannelText(type, text) : null;

  const send = () => {
    if (pending || disabledReason || !text.trim() || problem) return;
    const body = text;
    startTransition(async () => {
      const result = await sendChannelReplyAction(conversationId, body, nonce);
      if (result.error) {
        showToast({ tone: "danger", title: result.error });
        return;
      }
      setText("");
      writeDraft(conversationId, "");
      setNonce(newNonce());
      router.refresh();
      box.current?.focus();
    });
  };

  if (disabledReason) {
    return (
      <div className="flex shrink-0 items-start gap-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-5 py-3.5 text-[12.5px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <p>{disabledReason}</p>
      </div>
    );
  }

  return (
    <form
      className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 pb-3 pt-2.5 sm:px-5"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {humanAgentReply ? (
        <p className="mb-2 rounded-[var(--radius-sm)] bg-[var(--color-info-bg)] px-2.5 py-1.5 text-[11.5px] text-[color:var(--color-info-fg)]">
          More than 24 hours have passed, so this reply goes out tagged as a person&apos;s (Meta&apos;s Human Agent tag). Only a person may send it.
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Reply on {def.label}</span>
          <textarea
            ref={box}
            rows={2}
            value={text}
            disabled={pending}
            onChange={(e) => {
              setText(e.target.value);
              writeDraft(conversationId, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Reply on ${def.label} as ${via}…`}
            className="block max-h-48 min-h-[2.75rem] w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13.5px] leading-relaxed text-[color:var(--color-foreground)] placeholder:text-[color:var(--color-subtle-foreground)] focus:border-[var(--color-focus-ring)] focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)]/30 disabled:opacity-60"
          />
        </label>
        <Button type="submit" size="md" disabled={!text.trim() || Boolean(problem)} loading={pending} aria-label="Send reply">
          {pending ? null : <SendHorizontal className="size-4" aria-hidden />}
          Send
        </Button>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-[color:var(--color-subtle-foreground)]">
        <span>Enter to send · Shift+Enter for a new line</span>
        <span className={`tabular ${problem ? "font-medium text-[color:var(--color-danger-fg)]" : ""}`} title={problem ?? undefined}>
          {size}/{def.maxText}
          {def.maxTextUnit === "bytes" ? " bytes" : ""}
        </span>
      </div>
    </form>
  );
}
