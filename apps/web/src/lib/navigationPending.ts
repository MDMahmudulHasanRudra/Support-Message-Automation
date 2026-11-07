"use client";

import { useSyncExternalStore } from "react";

/**
 * Which page the person just asked for, while the current one stays on screen.
 *
 * A click keeps the page visible until the next one is ready (there are no full-page loading screens), so
 * the sidebar and the progress bar answer "did my click register?" straight away.
 */
export interface PendingNavigation {
  /** pathname + search of where they are going. */
  target: string;
  /** Came from a sidebar, tab or settings link, so that link lights up immediately. */
  navItem: boolean;
  /**
   * Same pathname, reached through what used to be a full page load (a GET form or a plain link): the page
   * is remounted when it arrives, so fields and client state start from the new URL as they always did.
   */
  remount: boolean;
}

let pending: PendingNavigation | null = null;
let epoch = 0;
let failsafe: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A redirect back to the same URL finishes without the address changing, so the bar must end by itself. */
const FAILSAFE_MS = 20_000;

export function startNavigation(next: PendingNavigation): void {
  pending = next;
  if (failsafe) clearTimeout(failsafe);
  failsafe = setTimeout(() => finishNavigation(), FAILSAFE_MS);
  emit();
}

/** The address changed: whatever was pending has arrived. */
export function finishNavigation(): void {
  if (failsafe) clearTimeout(failsafe);
  failsafe = null;
  if (!pending) return;
  if (pending.remount) epoch += 1;
  pending = null;
  emit();
}

/** For `router.push`, which goes round the click handler. Pushing the current URL is not a navigation. */
export function startPushNavigation(href: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(href, window.location.href);
  const target = url.pathname + url.search;
  if (target === window.location.pathname + window.location.search) return;
  startNavigation({ target, navItem: false, remount: false });
}

export function usePendingNavigation(): PendingNavigation | null {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}

/** Part of a page's React key: changes when a same-address navigation must start the page afresh. */
export function useNavigationEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch, () => 0);
}

/**
 * Whether a sidebar or tab link should look selected. A pending click on a nav link moves the highlight at
 * once; any other navigation leaves it alone. `href` is the link's resolved address.
 */
export function useNavHighlight(href: string, active: boolean): boolean {
  const next = usePendingNavigation();
  if (!next?.navItem) return active;
  return next.target === href;
}
