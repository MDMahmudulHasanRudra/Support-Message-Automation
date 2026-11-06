"use client";

import { useEffect, useRef, useState } from "react";
import NextLink from "next/link";
import { ChevronDown, LogOut, Search, UserRound } from "lucide-react";

/**
 * The parts both portals' headers share (DashboardShell and AdminShell), so the project software and the Main
 * Admin Portal read as one product. They sit inside the deep field, which re-scopes the colour tokens.
 */

function initials(username: string): string {
  const letters = username.replace(/[^\p{L}\p{N}]/gu, "");
  return (letters.slice(0, 2) || "?").toUpperCase();
}

/** Opens the page finder. Looks like the search field it behaves as. */
export function ShellSearch({ onOpen, placeholder = "Jump to a page…" }: { onOpen: () => void; placeholder?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Jump to a page"
      className="flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-[var(--radius-md)] bg-white/[0.08] px-3 text-[color:var(--color-muted-foreground)] ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/[0.12] hover:text-[color:var(--color-foreground)] max-sm:size-9 max-sm:justify-center max-sm:bg-transparent max-sm:px-0 max-sm:ring-0 sm:w-72"
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left text-[13px] max-sm:hidden">{placeholder}</span>
      <kbd className="rounded-[var(--radius-xs)] bg-white/10 px-1.5 py-0.5 text-[10.5px] font-medium max-sm:hidden">⌘K</kbd>
    </button>
  );
}

/** Who is signed in: name, role when known, their account and sign out. */
export function ShellUserMenu({ username, role, accountHref = "/account", onLogout }: { username: string; role?: string; accountHref?: string; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${username}`}
        className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] py-1 pl-1 pr-1.5 transition-colors hover:bg-white/[0.08]"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-[var(--tide-active)] text-[11.5px] font-semibold text-white ring-1 ring-inset ring-white/20">{initials(username)}</span>
        <span className="min-w-0 text-left max-md:hidden">
          <span className="block max-w-[9rem] truncate text-[13px] font-medium leading-tight text-[color:var(--color-foreground)]">{username}</span>
          {role ? <span className="block max-w-[9rem] truncate text-[11px] leading-tight text-[color:var(--color-muted-foreground)]">{role}</span> : null}
        </span>
        <ChevronDown className="size-3.5 text-[color:var(--color-muted-foreground)] max-md:hidden" aria-hidden />
      </button>
      {open ? (
        <div role="menu" className="animate-scale-in absolute right-0 top-full z-[var(--z-floating)] mt-2 w-52 origin-top-right rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]">
          <div className="truncate px-2.5 py-2 text-[13px] font-medium text-[color:var(--color-foreground)]">{username}</div>
          <div className="my-1 border-t border-[var(--color-border)]" />
          {/* My account (ACCOUNT_SELF_SERVICE.md): outside every project, so a plain link, never ProjectLink. */}
          <NextLink
            href={accountHref}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
          >
            <UserRound className="size-3.5" aria-hidden />
            My account
          </NextLink>
          <form
            action={async () => {
              setOpen(false);
              await onLogout();
            }}
          >
            <button
              type="submit"
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-danger-bg)] hover:text-[color:var(--color-danger-fg)]"
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

/** One sidebar row's classes, the same in both portals. */
export function navItemClass(active: boolean, extra = ""): string {
  return `group relative flex items-center gap-2.5 rounded-[var(--radius-md)] py-[7px] pr-2.5 pl-3 text-[13.5px] transition-[background-color,color] duration-[var(--duration-fast)] ${extra} ${
    active ? "bg-[var(--tide-active)] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]" : "text-[color:var(--color-muted-foreground)] hover:bg-white/[0.07] hover:text-[color:var(--color-foreground)]"
  }`;
}

/** The sidebar row's icon. */
export function navIconClass(active: boolean): string {
  return `size-[18px] shrink-0 transition-colors ${active ? "text-white" : "text-[color:var(--color-subtle-foreground)] group-hover:text-[color:var(--color-muted-foreground)]"}`;
}
