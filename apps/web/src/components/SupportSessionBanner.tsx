"use client";

import { useEffect, useState } from "react";
import { LifeBuoy } from "lucide-react";
import { endSupportSession } from "@/server/actions/supportSession";

export interface SupportSessionBannerInfo {
  operatorUsername: string;
  reason: string;
  expiresAt: string;
}

/**
 * Shown on every page of a Nexora support session (SAAS_PLATFORM_PLAN.md §12): who, why, how long is
 * left, and a way out. It cannot be dismissed — the session must always be recognisable as one.
 */
export function SupportSessionBanner({ info }: { info: SupportSessionBannerInfo }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.max(0, Math.ceil((new Date(info.expiresAt).getTime() - now) / 60_000));
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-2 text-[13px] text-[color:var(--color-warning-fg)]">
      <LifeBuoy className="size-4 shrink-0" aria-hidden />
      <span className="font-medium">Nexora support session — {info.operatorUsername}</span>
      <span className="min-w-0 flex-1 truncate opacity-80">{info.reason}</span>
      <span className="shrink-0">{minutes > 0 ? `ends in ${minutes} min` : "ending"}</span>
      <form action={endSupportSession}>
        <button type="submit" className="cursor-pointer rounded-[var(--radius-md)] border border-current px-2 py-0.5 text-xs font-medium">
          End session · return to platform
        </button>
      </form>
    </div>
  );
}
