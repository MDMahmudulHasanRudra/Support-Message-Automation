"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, PenLine } from "lucide-react";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_TYPING_MS, type ConversationRef } from "@support-automation/shared";
import { presenceHeartbeat } from "@/server/actions/inboxLifecycle";

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
        if (alive) setPeers(r.peers);
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
