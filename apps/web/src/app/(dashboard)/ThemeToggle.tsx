"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export const THEME_STORAGE_KEY = "sa-theme";

type ThemePreference = "light" | "system" | "dark";

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * A three-way segmented control rather than the usual sun/moon flip, because
 * "follow the OS" is a real third state and a two-position switch cannot express
 * it. The applied theme is an attribute on <html> (`data-theme`), which
 * globals.css reads; "system" removes the attribute and lets the
 * prefers-color-scheme media query take over again.
 *
 * A tiny inline script in the root layout applies the stored value before first
 * paint. This component only re-reads it after mount, so the server and client
 * render the same markup and hydration stays quiet.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Private mode / blocked storage — the default "system" is already correct.
    }
    if (stored !== "light" && stored !== "dark") return;
    // Deferred via a microtask (fires before the next paint, so no visible delay)
    // rather than called directly in the effect body — matches the convention used
    // in DashboardShell/Dialog and satisfies react-hooks/set-state-in-effect.
    queueMicrotask(() => setPreference(stored as ThemePreference));
  }, []);

  function apply(next: ThemePreference) {
    setPreference(next);
    if (next === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", next);
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Preference just won't survive a reload; the current page is still themed.
    }
  }

  return (
    <div
      role="group"
      aria-label="Color theme"
      className="flex items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-0.5"
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const selected = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => apply(option.value)}
            aria-pressed={selected}
            title={`${option.label} theme`}
            className={`flex h-6 flex-1 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ${
              selected
                ? "bg-[var(--color-surface)] text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)]"
                : "text-[color:var(--color-subtle-foreground)] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
