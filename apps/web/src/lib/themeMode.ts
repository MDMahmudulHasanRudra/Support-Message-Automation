import { useSyncExternalStore } from "react";
import { THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/themes";

/**
 * Light / Dark / System, for the browser only. The applied mode is `data-theme` on <html> (globals.css
 * reads it; "system" removes it), stored per browser in localStorage and applied before first paint
 * by the root layout's inline script. Every control that sets it goes through `applyThemeMode`, and
 * every control that shows it reads `useThemeMode`, so the header toggle and My account → Appearance
 * always agree, even when both are on screen.
 */

const CHANGE_EVENT = "sa-theme-change";

function read(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    // Private mode / blocked storage: "system" is what the page is showing.
    return "system";
  }
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_MODE_STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The stored mode; "system" while rendering on the server, so hydration stays quiet. */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, read, () => "system");
}

export function applyThemeMode(next: ThemeMode): void {
  if (next === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", next);
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
  } catch {
    // The choice just won't survive a reload; the current page is still themed.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
