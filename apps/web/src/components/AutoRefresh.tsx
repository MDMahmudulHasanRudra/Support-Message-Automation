"use client";

import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { useEffect } from "react";


/**
 * Polls the server component tree via router.refresh() so the QR code and
 * connection status update without a manual page reload. Only rendered
 * while the account is mid-connection (see accounts/page.tsx) — once
 * CONNECTED there is nothing changing worth polling for.
 *
 * **Paused while the tab is hidden**, which is not a micro-optimisation here. Every refresh
 * re-runs the whole server component tree, and on the chat inbox that is three database queries
 * including a LATERAL lookup per conversation. Support staff leave that tab open all day behind
 * other work, so a poll that keeps running while nobody is looking is the single largest source of
 * standing database load this app produces — hours of queries a day answering a question nobody is
 * asking.
 *
 * Refreshing once on the way back is what makes pausing safe rather than merely cheap: without it,
 * returning to the tab would show whatever was true when it was hidden, for up to a full interval,
 * which on an inbox reads as a broken page rather than a stale one.
 */
export function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer === null) timer = setInterval(() => router.refresh(), intervalMs);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      // Catch up immediately, then resume the interval. Whatever arrived while the tab was hidden
      // should be on screen by the time somebody has finished looking at it.
      router.refresh();
      start();
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, intervalMs]);

  return null;
}
