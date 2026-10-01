"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, Search, X } from "lucide-react";
import { Button, Checkbox, Input } from "@/components/ui";

/**
 * The reports' Groups filter: choose one or several WhatsApp groups by name. It submits ONE hidden
 * field, `groups`, holding the chosen WhatsApp group ids joined with commas — so a report with groups
 * chosen is still a plain URL that can be bookmarked, and the export route (which reads the URL)
 * gets exactly the same selection. Nothing chosen = every group, the reports' default.
 *
 * Searching covers every group; only the first RENDER_LIMIT matches are drawn, and the panel says so,
 * so a list that stops short never reads as a list that ended (the GroupPicker rule).
 */
const RENDER_LIMIT = 200;

export function GroupFilter({
  groups,
  selected: initial,
  onApply,
  max = 200,
}: {
  groups: Array<{ whatsappGroupId: string; name: string; isMonitored: boolean }>;
  selected: string[];
  /** Called after the hidden field holds the new selection, to submit the form. */
  onApply: () => void;
  /** The most groups a report accepts (the server's MAX_FILTER_GROUPS); more cannot be ticked. */
  max?: number;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  const [applied, setApplied] = useState<string[]>(initial);
  const rootRef = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Map(groups.map((g) => [g.whatsappGroupId, g.name])), [groups]);

  useEffect(() => {
    if (!open) return;
    /** Closing without Apply forgets the ticks: what the report shows is what was applied. */
    const close = () => {
      setOpen(false);
      setSelected(new Set(applied));
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, applied]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = needle ? groups.filter((g) => g.name.toLowerCase().includes(needle) || g.whatsappGroupId.includes(needle)) : groups;
    // Chosen groups first, so they never scroll out of reach.
    return [...list.filter((g) => selected.has(g.whatsappGroupId)), ...list.filter((g) => !selected.has(g.whatsappGroupId))];
  }, [groups, search, selected]);

  function apply(next: string[]) {
    // Rendered synchronously so the form being submitted already carries the new selection. The
    // field is controlled on purpose: React rewrites a hidden input's default value on every render,
    // which silently undid a value set on the node directly.
    flushSync(() => {
      setApplied(next);
      setOpen(false);
    });
    onApply();
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      // The server keeps only the first `max`; refusing the tick here says so instead of dropping
      // groups silently after Apply.
      else if (next.size < max) next.add(id);
      return next;
    });
  }

  const summary =
    applied.length === 0 ? "All groups" : applied.length === 1 ? (names.get(applied[0]!) ?? "1 group") : `${applied.length.toLocaleString("en-US")} groups`;

  return (
    <div ref={rootRef} className="relative">
      <input type="hidden" name="groups" value={applied.join(",")} readOnly />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-9.5 w-56 cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-left text-sm text-[color:var(--color-foreground)] shadow-[var(--shadow-xs)] transition-colors hover:border-[var(--color-muted-foreground)]/60 focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] focus-visible:outline-none"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className="size-3.5 shrink-0 text-[color:var(--color-muted-foreground)]" aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Choose groups"
          className="absolute top-full left-0 z-[var(--z-floating)] mt-1.5 w-[min(22rem,calc(100vw-2rem))] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-lg)]"
        >
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[color:var(--color-subtle-foreground)]" aria-hidden />
            <Input
              type="search"
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search groups"
              aria-label="Search groups"
              className="pl-8 text-[13px]"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto" aria-label="Groups">
            {matches.slice(0, RENDER_LIMIT).map((group) => (
              <li key={group.whatsappGroupId}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-[13px] text-[color:var(--color-foreground)] hover:bg-[var(--color-neutral-bg)]">
                  <Checkbox checked={selected.has(group.whatsappGroupId)} onChange={() => toggle(group.whatsappGroupId)} />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  {group.isMonitored ? <span className="shrink-0 text-[11px] text-[color:var(--color-subtle-foreground)]">monitored</span> : null}
                </label>
              </li>
            ))}
            {matches.length === 0 ? <li className="px-2 py-3 text-[13px] text-[color:var(--color-muted-foreground)]">No group matches “{search}”.</li> : null}
          </ul>
          {selected.size >= max ? (
            <p className="px-2 pt-1 text-[11px] text-[color:var(--color-warning-fg)]">
              At most {max} groups can be chosen at once. Untick one to choose another.
            </p>
          ) : null}
          {matches.length > RENDER_LIMIT ? (
            <p className="px-2 pt-1 text-[11px] text-[color:var(--color-subtle-foreground)]">
              Showing {RENDER_LIMIT} of {matches.length.toLocaleString("en-US")} — search to find the rest.
            </p>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-2">
            <button
              type="button"
              className="link inline-flex cursor-pointer items-center gap-1 text-[13px]"
              onClick={() => {
                setSelected(new Set());
                apply([]);
              }}
            >
              <X className="size-3" aria-hidden />
              All groups
            </button>
            <Button type="button" size="sm" onClick={() => apply([...selected])}>
              Apply{selected.size ? ` (${selected.size.toLocaleString("en-US")})` : ""}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
