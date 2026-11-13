"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_MODE_STORAGE_KEY, type ThemeMode } from "@/lib/themes";
import { applyThemeMode, useThemeMode } from "@/lib/themeMode";

export const THEME_STORAGE_KEY = THEME_MODE_STORAGE_KEY;

type ThemePreference = ThemeMode;

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
 * paint. The stored value is read through `useThemeMode` (lib/themeMode.ts), which
 * renders "system" on the server so hydration stays quiet, and which My account →
 * Appearance shares, so the two controls always agree.
 */
export function ThemeToggle() {
  const preference = useThemeMode();
  const apply = applyThemeMode;

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
