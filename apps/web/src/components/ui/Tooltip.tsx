"use client";

import { useId, useState, type ReactNode } from "react";

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="animate-scale-in pointer-events-none absolute bottom-full left-1/2 z-[var(--z-floating)] mb-2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--color-background)] shadow-[var(--shadow-lg)]"
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
