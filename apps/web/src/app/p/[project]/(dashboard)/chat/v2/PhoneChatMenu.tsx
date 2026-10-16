"use client";

import { Archive, ArchiveRestore, Loader2, MoreVertical, Pin, PinOff, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readRichCommand, setWhatsAppChatState } from "@/server/actions/chatRich";
import type { ConversationRef } from "@/server/chatThreadV2";

/**
 * Pin / archive this chat ON THE WHATSAPP PHONE (CHAT_RICH_MESSAGING.md §6). Deliberately apart from
 * the inbox's own pin and archive, which arrange this shared inbox for the team: this changes how the
 * chat sits on the business phone itself, and neither one ever changes monitoring or AI.
 *
 * WhatsApp does not tell this connection whether a chat is pinned or archived until asked, so both
 * directions are offered and the answer says what happened ("already pinned" included).
 */
export function PhoneChatMenu({ conversation, accountLabel }: { conversation: ConversationRef; accountLabel: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: "info" | "bad" } | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 6000);
    return () => clearTimeout(timer);
  }, [status]);

  async function run(change: { pin: boolean } | { archive: boolean }, words: { doing: string; done: string; already: string }) {
    setOpen(false);
    setBusy(true);
    setStatus({ text: `${words.doing} on ${accountLabel}'s phone…`, tone: "info" });
    const queued = await setWhatsAppChatState(conversation, change);
    if (queued.error || !queued.commandId) {
      setBusy(false);
      setStatus({ text: queued.error ?? "Nothing was changed.", tone: "bad" });
      return;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const state = await readRichCommand(queued.commandId);
      if (state.status === "DONE") {
        setBusy(false);
        setStatus({ text: state.changed === false ? words.already : words.done, tone: "info" });
        return;
      }
      if (state.status === "FAILED" || state.status === "UNKNOWN") {
        setBusy(false);
        setStatus({ text: `WhatsApp did not make the change${state.error ? `: ${state.error}` : "."}`, tone: "bad" });
        return;
      }
    }
    setBusy(false);
    setStatus({ text: "Still waiting for the worker. Check the phone in a minute.", tone: "info" });
  }

  const item =
    "flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-left text-[13px] hover:bg-[var(--color-neutral-bg)] focus-visible:bg-[var(--color-neutral-bg)] focus-visible:outline-none";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="On the WhatsApp phone"
        aria-expanded={open}
        aria-haspopup="menu"
        title="Pin or archive on the WhatsApp phone"
        className="flex size-10 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] sm:size-8"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MoreVertical className="size-4" aria-hidden />}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-64 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)] animate-scale-in">
          <p className="flex items-center gap-1.5 px-3 pb-1.5 pt-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
            <Smartphone className="size-3" aria-hidden />
            On {accountLabel}&apos;s WhatsApp phone
          </p>
          <button type="button" role="menuitem" className={item} onClick={() => run({ pin: true }, { doing: "Pinning", done: "Pinned on the phone.", already: "It was already pinned (WhatsApp allows three pinned chats)." })}>
            <Pin className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
            Pin chat
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => run({ pin: false }, { doing: "Unpinning", done: "Unpinned on the phone.", already: "It was not pinned." })}>
            <PinOff className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
            Unpin chat
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => run({ archive: true }, { doing: "Archiving", done: "Archived on the phone. Monitoring and AI are unchanged.", already: "It was already archived." })}>
            <Archive className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
            Archive chat
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => run({ archive: false }, { doing: "Unarchiving", done: "Unarchived on the phone.", already: "It was not archived." })}>
            <ArchiveRestore className="size-4 text-[color:var(--color-muted-foreground)]" aria-hidden />
            Unarchive chat
          </button>
          <p className="px-3 pb-1 pt-1.5 text-[10.5px] leading-snug text-[color:var(--color-muted-foreground)]">
            This changes the phone only. The inbox&apos;s own pin and archive are in the conversation list.
          </p>
        </div>
      ) : null}
      {status ? (
        <p
          role="status"
          className={`absolute right-0 top-full z-30 mt-1 w-64 rounded-[var(--radius-md)] border px-3 py-2 text-[12px] shadow-[var(--shadow-md)] animate-fade-in-rise ${
            status.tone === "bad"
              ? "border-[var(--color-danger-border,var(--color-border))] bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)]"
              : "border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[color:var(--color-foreground)]"
          }`}
        >
          {status.text}
        </p>
      ) : null}
    </div>
  );
}
