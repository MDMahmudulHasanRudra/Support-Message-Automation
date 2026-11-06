"use client";

import { useEffect, useState } from "react";
import { AlarmClock } from "lucide-react";
import Link from "@/components/ProjectLink";
import { readFollowUpBadge } from "@/server/actions/followUps";

const POLL_MS = 60_000;

/**
 * The top bar's follow-up reminder (FOLLOW_UPS.md): how many of MY open follow-ups are overdue or due
 * before Dhaka midnight. In-app only — nothing is sent anywhere. Polls once a minute while the tab is
 * visible; the reader refuses as zero, so a role or project without follow-ups simply shows nothing.
 */
export function FollowUpBadge() {
  const [counts, setCounts] = useState<{ overdue: number; dueToday: number }>({ overdue: 0, dueToday: 0 });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = () => {
      readFollowUpBadge()
        .then((c) => {
          if (!cancelled) setCounts(c);
        })
        .catch(() => undefined);
    };
    const start = () => {
      if (timer === null && document.visibilityState === "visible") {
        load();
        timer = setInterval(load, POLL_MS);
      }
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const total = counts.overdue + counts.dueToday;
  if (total === 0) return null;
  const label = `${counts.overdue} overdue, ${counts.dueToday} due today — open my follow-ups`;
  return (
    <Link
      href="/follow-ups"
      title={label}
      aria-label={label}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] px-2 text-xs font-semibold tabular-nums ring-1 ring-inset ${
        counts.overdue > 0
          ? "bg-[var(--color-danger-bg)] text-[color:var(--color-danger-fg)] ring-[var(--color-danger-border)]"
          : "bg-[var(--color-warning-bg)] text-[color:var(--color-warning-fg)] ring-[var(--color-warning-border)]"
      }`}
    >
      <AlarmClock className="size-4" aria-hidden />
      {total}
    </Link>
  );
}
