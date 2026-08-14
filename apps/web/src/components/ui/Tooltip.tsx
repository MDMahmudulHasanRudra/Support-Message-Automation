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
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2.5 py-1.5 text-xs font-medium text-[color:var(--color-background)] shadow-[var(--shadow-md)]"
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
