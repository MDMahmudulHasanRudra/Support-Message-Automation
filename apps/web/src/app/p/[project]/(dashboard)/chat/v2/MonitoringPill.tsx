"use client";

import { ChevronDown, ExternalLink } from "lucide-react";
import Link from "@/components/ProjectLink";
import { useEffect, useRef, useState } from "react";

/**
 * Whether this group is monitored, as a pill in the v2 header (CHAT_UI_V2.md §13), with a short
 * explanation and the way to change it. Deliberately NOT a switch: turning monitoring on lets rules and
 * AI answer customers in the group, which is a decision made on the Groups page with its own
 * permission and confirmation — not a click beside the composer. This only reports, and links there.
 * Hidden on a phone, where the header has no room; the group's info is one tap on its avatar.
 */
export function MonitoringPill({ monitored, aiOn }: { monitored: boolean; aiOn: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative max-sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-9 items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[12px] font-medium text-[color:var(--color-foreground)] transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
      >
        <span className={`size-2 rounded-full ${monitored ? "bg-[var(--wa-green)]" : "bg-[var(--color-warning)]"}`} aria-hidden />
        {monitored ? "Monitored" : "Not monitored"}
        <ChevronDown className={`size-3.5 text-[color:var(--color-muted-foreground)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open ? (
        <div role="dialog" aria-label="Monitoring" className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 text-[12.5px] leading-relaxed shadow-[var(--shadow-lg)] animate-scale-in">
          <p className="font-semibold text-[color:var(--color-foreground)]">{monitored ? "This group is monitored" : "This group is not monitored"}</p>
          <p className="mt-1 text-[color:var(--color-muted-foreground)]">
            {monitored
              ? `Rules${aiOn ? " and AI" : ""} may answer customers here, within the account's limits.`
              : "Messages are stored and shown here, but no rule or AI answers in this group."}
          </p>
          <Link
            href="/groups"
            className="mt-2.5 inline-flex items-center gap-1 font-medium text-[color:var(--color-accent-fg)] hover:underline"
            onClick={() => setOpen(false)}
          >
            Change it in Groups
            <ExternalLink className="size-3" aria-hidden />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
