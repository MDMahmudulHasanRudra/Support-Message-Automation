"use client";

import { useEffect, useRef } from "react";
import { useProjectHref, useProjectRouter } from "@/components/ProjectLink";

/** A burst of messages is one refresh, not ten. */
const MIN_GAP_MS = 700;
/** While the live connection is up, a slow refresh still catches anything it does not cover. */
const CONNECTED_REFRESH_MS = 20_000;
const RECONNECT_MS = 60_000;

/**
 * Keeps an inbox current (AGENT_APP.md): refreshes as soon as the server says something changed, and falls
 * back to the old fixed refresh whenever the live connection is not up. Like AutoRefresh it stops completely
 * while the tab is hidden, and catches up on the way back.
 */
export function LiveRefresh({ intervalMs = 4000, allProjects = false }: { intervalMs?: number; allProjects?: boolean }) {
  const router = useProjectRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });
  const url = `${useProjectHref()("/api/inbox/live")}${allProjects ? "?projects=all" : ""}`;

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let waiting: ReturnType<typeof setTimeout> | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let last = 0;

    const refresh = () => {
      const wait = MIN_GAP_MS - (Date.now() - last);
      if (wait <= 0) {
        last = Date.now();
        routerRef.current.refresh();
      } else if (!waiting) {
        waiting = setTimeout(() => {
          waiting = null;
          last = Date.now();
          routerRef.current.refresh();
        }, wait);
      }
    };
    const pollEvery = (ms: number) => {
      if (poll) clearInterval(poll);
      poll = setInterval(refresh, ms);
    };
    const stop = () => {
      source?.close();
      source = null;
      if (poll) clearInterval(poll);
      poll = null;
      if (waiting) clearTimeout(waiting);
      waiting = null;
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
    };
    const start = () => {
      pollEvery(intervalMs);
      if (typeof EventSource === "undefined") return;
      const live = new EventSource(url);
      source = live;
      live.onopen = () => pollEvery(CONNECTED_REFRESH_MS);
      live.addEventListener("change", refresh);
      live.onerror = () => {
        pollEvery(intervalMs);
        // CLOSED means the browser will not retry by itself (a refusal, or the feature switched off).
        if (live.readyState === EventSource.CLOSED) {
          source = null;
          reconnect = setTimeout(() => {
            reconnect = null;
            if (document.visibilityState !== "hidden") start();
          }, RECONNECT_MS);
        }
      };
    };
    const onVisibility = () => {
      stop();
      if (document.visibilityState === "hidden") return;
      refresh();
      start();
    };

    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, intervalMs]);

  return null;
}
