"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, PenLine } from "lucide-react";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_TYPING_MS, type ConversationRef } from "@support-automation/shared";
import { presenceHeartbeat } from "@/server/actions/inboxLifecycle";
import { publishPresencePeers, usePresencePeers } from "./panelStore";

export type PresencePeerView = { userId: string; name: string; typing: boolean };
type Peer = PresencePeerView;

/** A keystroke counts as typing; at most one extra heartbeat this often, on top of the regular ones. */
const TYPING_PING_MS = 3_000;

/**
 * Inbox V3 agent presence (V3-05): "Rahim is viewing", "Nusrat is typing…" for the OTHER people with this
 * conversation open. Sends a heartbeat while the tab is visible (none while it is hidden, so a backgrounded
 * tab stops counting as viewing), and one early when this person starts typing in the page. Only who and
 * whether — never what anybody typed.
 */
export function useConversationPresence(conversationRef: ConversationRef, enabled: boolean): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  const lastTyped = useRef(0);
  const lastPing = useRef(0);
  const refKey = JSON.stringify(conversationRef);

  useEffect(() => {
    if (!enabled) return;
    const ref = JSON.parse(refKey) as ConversationRef;
    let alive = true;
    const beat = async () => {
      if (document.visibilityState !== "visible") return;
      lastPing.current = Date.now();
      const typing = Date.now() - lastTyped.current < PRESENCE_TYPING_MS;
      try {
        const r = await presenceHeartbeat(ref, typing);
        if (alive) {
          setPeers(r.peers);
          publishPresencePeers(r.peers);
        }
      } catch {
        // A failed heartbeat shows nobody rather than an error: presence is a hint, never a gate.
      }
    };
    const onInput = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      lastTyped.current = Date.now();
      if (Date.now() - lastPing.current > TYPING_PING_MS) void beat();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    void beat();
    const timer = window.setInterval(() => void beat(), PRESENCE_HEARTBEAT_MS);
    document.addEventListener("input", onInput, true);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      publishPresencePeers([]);
      window.clearInterval(timer);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refKey, enabled]);

  return enabled ? peers : [];
}

/** Display only: the people the hook found. Rendered wherever the panel body is; the hook runs once. */
export function PresenceBanner({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  const typing = peers.filter((p) => p.typing);
  const viewing = peers.filter((p) => !p.typing);
  const names = (list: Peer[]) => (list.length <= 2 ? list.map((p) => p.name).join(" and ") : `${list[0]!.name} and ${list.length - 1} others`);
  return (
    <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-border)] bg-[var(--color-warning-bg)] px-3 py-1.5 text-[11.5px] text-[color:var(--color-warning-fg)]">
      {typing.length ? (
        <span className="inline-flex items-center gap-1 font-medium">
          <PenLine className="size-3.5" aria-hidden />
          {names(typing)} {typing.length === 1 ? "is" : "are"} typing…
        </span>
      ) : null}
      {viewing.length ? (
        <span className="inline-flex items-center gap-1">
          <Eye className="size-3.5" aria-hidden />
          {names(viewing)} {viewing.length === 1 ? "is" : "are"} viewing
        </span>
      ) : null}
    </div>
  );
}

/**
 * The line right above a reply box: "Rahim is typing…" (or "… is viewing") for the OTHER people with this
 * conversation open, so two people do not answer the same chat. Reads what the panel heartbeat found; renders
 * nothing when nobody else is here.
 */
export function TypingNotice({ className = "" }: { className?: string }) {
  const peers = usePresencePeers();
  if (peers.length === 0) return null;
  const typing = peers.filter((p) => p.typing);
  const viewing = peers.filter((p) => !p.typing);
  const names = (list: Peer[]) => (list.length <= 2 ? list.map((p) => p.name).join(" and ") : `${list[0]!.name} and ${list.length - 1} others`);
  return (
    <div role="status" aria-live="polite" className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] ${className}`}>
      {typing.length ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-warning-bg)] px-2.5 py-1 font-medium text-[color:var(--color-warning-fg)] ring-1 ring-[var(--color-warning-border)]">
          <span className="flex gap-0.5" aria-hidden>
            <span className="size-1 animate-pulse rounded-full bg-current" />
            <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
            <span className="size-1 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
          </span>
          {names(typing)} {typing.length === 1 ? "is" : "are"} typing a reply…
        </span>
      ) : null}
      {viewing.length ? (
        <span className="inline-flex items-center gap-1 text-[color:var(--color-muted-foreground)]">
          <Eye className="size-3.5" aria-hidden />
          {names(viewing)} {viewing.length === 1 ? "is" : "are"} also in this chat
        </span>
      ) : null}
    </div>
  );
}
