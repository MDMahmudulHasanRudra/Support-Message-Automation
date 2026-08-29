"use client";

import { CornerDownLeft, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ALL_NAV_LINKS } from "./navigation";

/**
 * Keyboard-first navigation across the ~45 destinations in the sidebar. With
 * eleven nav groups, finding a page by scrolling is the slowest path to it; this
 * is the fast one. Navigation only — it cannot perform any action, so there is
 * nothing here that could change system state by accident.
 *
 * Mounted only while open (see DashboardShell), so every open starts from a
 * clean query and highlight without an effect to reset them.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ALL_NAV_LINKS;
    // Every whitespace-separated term must appear somewhere in "group label",
    // so "teams set" finds Teams Integration → Settings.
    const terms = needle.split(/\s+/);
    return ALL_NAV_LINKS.filter((link) => {
      const haystack = `${link.group} ${link.label}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [query]);

  // Derived rather than stored: typing shrinks the list, and a stored index would
  // need an effect to clamp itself back into range on every keystroke.
  const safeIndex = activeIndex < results.length ? activeIndex : 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [safeIndex]);

  function commit(index: number) {
    const target = results[index];
    if (!target) return;
    onClose();
    router.push(target.href);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(results.length === 0 ? 0 : (safeIndex + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(results.length === 0 ? 0 : (safeIndex - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(safeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-[var(--z-palette)] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[3px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search pages"
        onKeyDown={handleKeyDown}
        className="animate-scale-in relative flex max-h-[62vh] w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)]"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4">
          <Search className="size-4 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Jump to a page…"
            aria-label="Search pages"
            aria-controls="command-palette-results"
            autoComplete="off"
            spellCheck={false}
            className="h-12 flex-1 bg-transparent text-sm text-[color:var(--color-foreground)] outline-none placeholder:text-[color:var(--color-muted-foreground)]"
          />
          <kbd className="rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-muted-foreground)]">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          aria-label="Pages"
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-[color:var(--color-muted-foreground)]">
              No page matches “{query}”.
            </p>
          ) : (
            results.map((link, index) => {
              const Icon = link.icon;
              const active = index === safeIndex;
              return (
                <button
                  key={`${link.group}-${link.href}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => commit(index)}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors duration-[var(--duration-fast)] ${
                    active ? "bg-[var(--color-neutral-bg)]" : ""
                  }`}
                >
                  <Icon
                    className={`size-4 shrink-0 ${active ? "text-[color:var(--color-foreground)]" : "text-[color:var(--color-subtle-foreground)]"}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--color-foreground)]">
                    {link.label}
                  </span>
                  <span className="shrink-0 text-[11px] text-[color:var(--color-muted-foreground)]">
                    {link.group}
                  </span>
                  {active ? (
                    <CornerDownLeft
                      className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]"
                      aria-hidden
                    />
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
