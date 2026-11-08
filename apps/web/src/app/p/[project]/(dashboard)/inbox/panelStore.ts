"use client";

import { useSyncExternalStore } from "react";
import type { WorkspaceData } from "@/server/inboxWorkspace";

/**
 * What the conversation header and the reply box need to know about the side panel, without loading the
 * conversation a second time: the panel publishes the data it was given, and they read it. Presentation only;
 * every action they call checks permissions again. Nothing published = the project has the panel off, and the
 * header's toggle and the composer's extra tabs simply do not appear.
 */

export type PanelTab = "details" | "notes" | "copilot" | "followups" | "tickets" | "files";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

let published: WorkspaceData | null = null;
export function publishWorkspace(data: WorkspaceData | null) {
  if (published === data) return;
  published = data;
  emit();
}
export function useWorkspaceInfo(): WorkspaceData | null {
  return useSyncExternalStore(subscribe, () => published, () => null);
}

// Whether the desktop column is shown, remembered per browser. The header's toggle is the only control.
const COLLAPSE_KEY = "inbox-workspace-collapsed";
export function readPanelCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
export function writePanelCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
  } catch {
    /* private mode: the panel still works, it just does not remember */
  }
  emit();
}
export function usePanelCollapsed(): boolean {
  return useSyncExternalStore(subscribe, readPanelCollapsed, () => false);
}

// Below the desktop width the panel is a sheet over the thread. Something outside it asks for it through here.
let sheetOpen = false;
let requestedTab: PanelTab | null = null;
export function setPanelSheetOpen(value: boolean) {
  if (sheetOpen === value) return;
  sheetOpen = value;
  emit();
}
export function usePanelSheetOpen(): boolean {
  return useSyncExternalStore(subscribe, () => sheetOpen, () => false);
}
export function usePanelTabRequest(): PanelTab | null {
  return useSyncExternalStore(subscribe, () => requestedTab, () => null);
}
export function clearPanelTabRequest() {
  requestedTab = null;
}

const isDesktopPanel = () => window.matchMedia("(min-width: 1280px)").matches;

/** Open the panel, on a given tab if asked: the column on a desktop, the sheet on anything smaller. */
export function openPanel(tab?: PanelTab) {
  requestedTab = tab ?? requestedTab;
  if (isDesktopPanel()) writePanelCollapsed(false);
  else setPanelSheetOpen(true);
  emit();
}

export function togglePanel() {
  if (isDesktopPanel()) writePanelCollapsed(!readPanelCollapsed());
  else setPanelSheetOpen(!sheetOpen);
}
