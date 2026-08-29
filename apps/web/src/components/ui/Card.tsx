import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xs),var(--highlight-top)] transition-[box-shadow,border-color] duration-[var(--duration-base)] ease-[var(--ease-out)] ${className}`}
    >
      {children}
    </div>
  );
}
