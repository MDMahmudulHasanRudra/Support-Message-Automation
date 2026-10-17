"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Columns3, RotateCcw } from "lucide-react";
import { useProjectRouter as useRouter } from "@/components/ProjectLink";
import { Button, Checkbox, Dialog, useToast } from "@/components/ui";
import { resetListColumns, saveListColumns } from "@/server/actions/clientExtras";

export interface ChooserColumn {
  key: string;
  label: string;
  locked?: boolean;
}

/**
 * "Customize columns": which columns THIS person sees on a list, and in what order, saved per person
 * per project. Only columns the server already allowed them are offered, and the server re-checks
 * the selection on save — a preference can never widen what is read for them.
 */
export function ColumnChooser({ list, available, selected }: { list: "clients" | "billing"; available: ChooserColumn[]; selected: string[] }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<string[]>(selected);
  const [busy, start] = useTransition();
  const byKey = new Map(available.map((c) => [c.key, c]));
  // Chosen ones first (in their order), then the rest as offered.
  const rows = [...order.filter((k) => byKey.has(k)), ...available.map((c) => c.key).filter((k) => !order.includes(k))];

  const toggle = (key: string) => setOrder((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  const move = (key: string, delta: number) =>
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= prev.length || byKey.get(prev[j]!)?.locked) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  function save() {
    start(async () => {
      const r = await saveListColumns(list, order);
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  }
  function reset() {
    start(async () => {
      const r = await resetListColumns(list);
      showToast({ tone: r.ok ? "success" : "danger", title: r.message });
      if (r.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          setOrder(selected);
          setOpen(true);
        }}
      >
        <Columns3 className="size-3.5" aria-hidden /> Customize columns
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Customize columns"
        description="Choose what you see and in which order. Saved for you only, in this project."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={busy}>
              <RotateCcw className="size-3.5" aria-hidden /> Reset to default
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="button" onClick={save} loading={busy}>
                Save columns
              </Button>
            </div>
          </div>
        }
      >
        <ul className="max-h-[55vh] space-y-1 overflow-y-auto pr-1">
          {rows.map((key) => {
            const col = byKey.get(key)!;
            const on = order.includes(key);
            const index = order.indexOf(key);
            return (
              <li key={key} className="flex items-center gap-3 rounded-[var(--radius-md)] px-2 py-1.5 hover:bg-[var(--color-neutral-bg)]">
                <Checkbox id={`col-${key}`} checked={on} disabled={col.locked} onChange={() => toggle(key)} />
                <label htmlFor={`col-${key}`} className="flex-1 text-sm">
                  {col.label}
                  {col.locked ? <span className="ml-2 text-xs text-[color:var(--color-muted-foreground)]">always shown</span> : null}
                </label>
                {on && !col.locked ? (
                  <span className="flex gap-1">
                    <button type="button" aria-label={`Move ${col.label} up`} disabled={index <= 1} onClick={() => move(key, -1)} className="rounded p-1 text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-border)] disabled:opacity-30">
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button type="button" aria-label={`Move ${col.label} down`} disabled={index === order.length - 1} onClick={() => move(key, 1)} className="rounded p-1 text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-border)] disabled:opacity-30">
                      <ArrowDown className="size-3.5" />
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Dialog>
    </>
  );
}
