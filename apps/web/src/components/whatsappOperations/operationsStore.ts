"use client";

import { useEffect, useSyncExternalStore } from "react";
import { operationPollMs, type WhatsAppOperation } from "@support-automation/shared";
import { readWhatsAppOperations } from "@/server/actions/whatsappOperations";

/**
 * One poll of the project's WhatsApp operations, shared by everything on the page that shows them —
 * the job indicator in the shell and a module page's "current operations" section read the same
 * snapshot instead of each running its own loop.
 *
 * The browser only READS here. The jobs run in the worker and live in the database, so this store
 * can be thrown away by a navigation, a refresh or a closed tab without the job noticing; the next
 * page simply reads where it has got to.
 *
 * Pacing comes from `operationPollMs`: every 3s while the worker is moving something, 15s while a
 * job waits on a person, 30s otherwise (so a job started in another tab or by a colleague still
 * shows up). Nothing is fetched while the tab is hidden; coming back fetches at once.
 */

interface Snapshot {
  /** The project these operations belong to — a snapshot is never shown under another project. */
  project: string | null;
  ops: WhatsAppOperation[];
  loaded: boolean;
}

const EMPTY: Snapshot = { project: null, ops: [], loaded: false };
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let project: string | null = null;

function emit(next: Snapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  timer = setTimeout(() => {
    // Hidden: stop here. `onVisibility` fetches the moment the tab is looked at again.
    if (document.visibilityState === "hidden") return;
    void refreshWhatsAppOperations();
  }, operationPollMs(snapshot.ops));
}

/** Fetches now. Safe to call often: a fetch already in flight is not doubled. */
export async function refreshWhatsAppOperations(): Promise<void> {
  if (inFlight || listeners.size === 0 || project === null) return;
  inFlight = true;
  const askedFor = project;
  try {
    const ops = await readWhatsAppOperations();
    // The project changed while this was in flight: the answer belongs to the old one.
    if (askedFor === project) emit({ project: askedFor, ops, loaded: true });
  } catch {
    // A failed poll keeps the last answer; the next one tries again.
  } finally {
    inFlight = false;
    schedule();
  }
}

function onVisibility() {
  if (document.visibilityState === "visible") void refreshWhatsAppOperations();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    // After the committing render's effects, so the project they set is the one asked about.
    queueMicrotask(() => void refreshWhatsAppOperations());
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

/** Switching project drops the other project's snapshot and asks again. */
function selectProject(slug: string) {
  if (project === slug) return;
  project = slug;
  emit({ project: slug, ops: [], loaded: false });
  void refreshWhatsAppOperations();
}

export function useWhatsAppOperations(projectSlug: string): { ops: WhatsAppOperation[]; loaded: boolean } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => selectProject(projectSlug), [projectSlug]);
  return current.project === projectSlug ? current : { ops: [], loaded: false };
}

// ---------------------------------------------------------------------------------------------
// Finished jobs a viewer has dismissed from the indicator. A per-viewer convenience, so it lives in
// this browser only; the job's own page keeps every result regardless.

const DISMISSED_KEY = "whatsapp-operations-dismissed";
const dismissedListeners = new Set<() => void>();
let dismissedCache: string | null = null;

function dismissedSnapshot(): string {
  if (dismissedCache === null) {
    try {
      dismissedCache = window.localStorage.getItem(DISMISSED_KEY) ?? "[]";
    } catch {
      dismissedCache = "[]";
    }
  }
  return dismissedCache;
}

function parseDismissed(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function useDismissedOperations(): Set<string> {
  const raw = useSyncExternalStore(
    (listener) => {
      dismissedListeners.add(listener);
      return () => dismissedListeners.delete(listener);
    },
    dismissedSnapshot,
    () => "[]",
  );
  return new Set(parseDismissed(raw));
}

export function dismissOperation(id: string): void {
  // The newest fifty are plenty: a finished job leaves the indicator by itself after twelve hours.
  const next = [id, ...parseDismissed(dismissedSnapshot()).filter((x) => x !== id)].slice(0, 50);
  dismissedCache = JSON.stringify(next);
  try {
    window.localStorage.setItem(DISMISSED_KEY, dismissedCache);
  } catch {
    /* private mode — still works for this tab */
  }
  dismissedListeners.forEach((listener) => listener());
}
