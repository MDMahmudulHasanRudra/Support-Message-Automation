"use client";

import { useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/** One labeled block inside a HelpButton's dialog — consistent heading/spacing for every module's help content. */
export function HelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6 last:mb-0">
      <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">
        <span className="h-3.5 w-[3px] rounded-full bg-[var(--color-primary)]" aria-hidden />
        {title}
      </h3>
      <div className="max-w-[68ch] space-y-2 pl-[11px] text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {children}
      </div>
    </div>
  );
}

/**
 * Every module page gets one of these next to its title (via PageHeader's `actions` prop) — opens
 * a scrollable dialog explaining what the module does, what each control means, and how to
 * configure it. Content is authored per-page as a set of `HelpSection`s passed in as children.
 */
export function HelpButton({ moduleTitle, children }: { moduleTitle: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <CircleHelp className="size-3.5" aria-hidden />
        Help
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${moduleTitle} — Help`} size="lg">
        {children}
      </Dialog>
    </>
  );
}
