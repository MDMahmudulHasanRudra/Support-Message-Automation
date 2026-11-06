"use client";

import { useState, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * A close button on the setup guide. The choice is one cookie per person and per place (each project, and the
 * Main Admin Portal), a year long, read by the server so a closed guide never flashes on the next visit. It only
 * hides a guide: nothing about the setup itself changes, and Quick actions can open it again.
 */
export function ClosableGuide({ cookieName, children }: { cookieName: string; children: ReactNode }) {
  const [closed, setClosed] = useState(false);
  if (closed) return null;
  return (
    <div className="relative">
      {children}
      <button
        type="button"
        aria-label="Close setup guide"
        title="Close setup guide"
        onClick={() => {
          document.cookie = `${cookieName}=1; path=/; max-age=31536000; samesite=lax`;
          // Reopened through ?guide=1: drop it, so a refresh stays closed.
          if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
          setClosed(true);
        }}
        className="absolute right-2.5 top-2.5 flex size-8 cursor-pointer items-center justify-center rounded-full text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
