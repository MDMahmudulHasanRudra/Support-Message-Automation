"use client";

import { Forward, Loader2, Search, User, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, Input } from "@/components/ui";
import { searchConversations } from "@/server/actions/chatSearch";
import { forwardChatMessage } from "@/server/actions/chatRich";
import type { ConversationSummary } from "@/server/chatInbox";

/**
 * Forward one stored message to ONE other conversation of the same account (CHAT_RICH_MESSAGING.md
 * §5). One target per press on purpose: forwarding to many is a broadcast, and broadcasts have their
 * own page with their own throttles. The target is searched across all of this account's
 * conversations; choosing it asks once more before anything is queued.
 */
export function ForwardDialog({
  accountId,
  accountLabel,
  messageId,
  preview,
  currentKey,
  onClose,
  onForwarded,
}: {
  accountId: string;
  accountLabel: string;
  messageId: string;
  preview: string;
  /** The open conversation (a group row id or a personal chat id) — never offered as a target. */
  currentKey: string | null;
  onClose: () => void;
  onForwarded: (targetName: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; list: ConversationSummary[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<ConversationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function onQuery(value: string) {
    setQuery(value);
    setTarget(null);
    if (timer.current) clearTimeout(timer.current);
    if (value.trim().length < 2) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      const list = await searchConversations(accountId, value);
      setSearching(false);
      // Kept WITH the query it answered, so a slow answer never lands under a newer one.
      setResults({ query: value, list: list.filter((c) => c.id !== currentKey && c.chatId !== currentKey).slice(0, 20) });
    }, 300);
  }

  async function confirm() {
    if (!target) return;
    setPending(true);
    const result = await forwardChatMessage(
      messageId,
      target.kind === "GROUP" ? { accountId, groupId: target.id } : { accountId, personalChatId: target.chatId },
    );
    setPending(false);
    if (result.error) setError(result.error);
    else onForwarded(target.name);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Forward message"
      description={`Forwarded from ${accountLabel} to one conversation, through the same queue and limits as a typed message.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={confirm} loading={pending} disabled={!target}>
            <Forward className="size-4" aria-hidden />
            {target ? `Forward to ${target.name.length > 24 ? `${target.name.slice(0, 24)}…` : target.name}` : "Forward"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <p className="line-clamp-3 rounded-[var(--radius-md)] border-l-[3px] border-[var(--color-accent)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[12.5px]" dir="auto">
          {preview || "Media"}
        </p>
        <label className="relative block">
          <span className="sr-only">Search this account&apos;s conversations</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[color:var(--color-muted-foreground)]" aria-hidden />
          <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Search groups and chats by name…" className="pl-8" autoFocus />
        </label>
        {searching ? (
          <p className="flex items-center gap-2 text-[12px] text-[color:var(--color-muted-foreground)]">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Searching…
          </p>
        ) : results && results.query === query ? (
          results.list.length === 0 ? (
            <p className="text-[12.5px] text-[color:var(--color-muted-foreground)]">No conversation of {accountLabel} matches “{query}”.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)]" role="listbox" aria-label="Conversations">
              {results.list.map((c) => (
                <li key={`${c.kind}-${c.id}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={target?.id === c.id}
                    onClick={() => setTarget(c)}
                    className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] ${target?.id === c.id ? "bg-[var(--color-accent-bg)]" : "hover:bg-[var(--color-neutral-bg)]"}`}
                  >
                    {c.kind === "GROUP" ? <Users className="size-4 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden /> : <User className="size-4 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    {c.kind === "GROUP" && c.isMonitored ? <span className="shrink-0 text-[10.5px] text-[color:var(--color-muted-foreground)]">monitored</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-[12px] text-[color:var(--color-muted-foreground)]">Type at least two letters of a group or contact name.</p>
        )}
      </div>
    </Dialog>
  );
}
