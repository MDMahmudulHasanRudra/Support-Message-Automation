"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, MoreHorizontal, MoreVertical } from "lucide-react";
import Link from "@/components/ProjectLink";

export interface RowMenuItem {
  label: string;
  icon?: ReactNode;
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/**
 * A row's "more actions" menu. Positioned `fixed` from its button, so a table's sideways scroll box
 * cannot clip it; closes on an outside click, Escape, scrolling and resizing. Items the viewer may not
 * use are passed `hidden`: the menu never offers what the server would refuse.
 */
export function RowMenu({ items, label = "More actions", horizontal = false, buttonText }: { items: RowMenuItem[]; label?: string; horizontal?: boolean; /** A labelled button ("Export") instead of the dots. */ buttonText?: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const visible = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [pos]);

  if (!visible.length) return null;
  const Icon = horizontal ? MoreHorizontal : MoreVertical;
  const itemCls = (danger?: boolean) =>
    `flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13px] ${danger ? "text-[color:var(--color-danger-fg)] hover:bg-[var(--color-danger-bg)]" : "hover:bg-[var(--color-neutral-bg)]"}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        onClick={() => {
          if (pos) {
            setPos(null);
            return;
          }
          const r = button.current!.getBoundingClientRect();
          const width = buttonText ? 240 : 208;
          const height = visible.length * 36 + 12;
          const top = r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - height - 4) : r.bottom + 4;
          setPos({ top, left: Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width)) });
        }}
        className={
          buttonText
            ? "inline-flex h-9.5 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 text-sm font-medium shadow-[var(--shadow-xs)] hover:bg-[var(--color-neutral-bg)]"
            : "inline-flex size-8 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
        }
      >
        {buttonText ? (
          <>
            {buttonText} <ChevronDown className="size-4" aria-hidden />
          </>
        ) : (
          <Icon className="size-4" aria-hidden />
        )}
      </button>
      {pos ? (
        <div ref={menu} role="menu" style={{ top: pos.top, left: pos.left }} className="fixed z-50 min-w-52 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-lg)]">
          {visible.map((item) =>
            item.href ? (
              <Link key={item.label} role="menuitem" href={item.href} className={itemCls(item.danger)} onClick={() => setPos(null)}>
                {item.icon}
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={itemCls(item.danger)}
                onClick={() => {
                  setPos(null);
                  item.onSelect?.();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </>
  );
}
