"use client";

import { useEffect, useSyncExternalStore } from "react";
import { operationPollMs, type WhatsAppOperation } from "@support-automation/shared";
import { clearWhatsAppOperation, readWhatsAppOperations, type ClearOperationResult } from "@/server/actions/whatsappOperations";

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
  const own = current.project === projectSlug ? current : { ops: [] as WhatsAppOperation[], loaded: false };
  const ops = useWithoutCleared(own.ops);
  return { ops, loaded: own.loaded };
}

// ---------------------------------------------------------------------------------------------
// Clearing an operation from the viewer's tracker (WhatsAppOperationDismissal, per user, on the
// server). The server's reader already leaves cleared operations out, so after a refresh they stay
// gone on every surface and every device. This set only bridges the moment between the click and
// the next poll, and the server-rendered list a module page starts from — keyed by id AND state, so
// an operation that moves on (a review continued, a job finished) shows again, exactly as the server
// rule does.

const clearedKeys = new Set<string>();
const clearedListeners = new Set<() => void>();
let clearedVersion = 0;
const clearKey = (op: Pick<WhatsAppOperation, "id" | "state">) => `${op.id}:${op.state}`;

/** Drops operations the viewer has just cleared (until the server's own filter takes over). */
export function useWithoutCleared(ops: WhatsAppOperation[]): WhatsAppOperation[] {
  useSyncExternalStore(
    (listener) => {
      clearedListeners.add(listener);
      return () => clearedListeners.delete(listener);
    },
    () => clearedVersion,
    () => 0,
  );
  return clearedKeys.size ? ops.filter((op) => !clearedKeys.has(clearKey(op))) : ops;
}

/**
 * Clears (or, for a job still running, hides) one operation for the signed-in person, on the server.
 * Display only — it never cancels or changes the job. Resolves to the server's answer.
 */
export async function clearOperation(op: WhatsAppOperation): Promise<ClearOperationResult> {
  clearedKeys.add(clearKey(op));
  clearedVersion += 1;
  clearedListeners.forEach((listener) => listener());
  try {
    const result = await clearWhatsAppOperation(op.kind, op.id);
    if (result.error) throw new Error(result.error);
    void refreshWhatsAppOperations();
    return result;
  } catch (err) {
    clearedKeys.delete(clearKey(op));
    clearedVersion += 1;
    clearedListeners.forEach((listener) => listener());
    return { error: (err as Error).message || "The operation could not be cleared. Try again." };
  }
}
