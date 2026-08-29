"use client";

import { Badge, BrandMark } from "@/components/ui";
import { LogOut, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { NAV_GROUPS, OVERVIEW_LINK, isNavActive, type NavLink } from "./navigation";
import { ThemeToggle } from "./ThemeToggle";

function NavItem({ link, active }: { link: NavLink; active: boolean }) {
  const Icon = link.icon;
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2.5 rounded-[var(--radius-md)] py-1.5 pl-3 pr-2.5 text-[13px] transition-[background-color,color] duration-[var(--duration-fast)] ${
        active
          ? "bg-[var(--color-neutral-bg)] font-medium text-[color:var(--color-foreground)]"
          : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]/60 hover:text-[color:var(--color-foreground)]"
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-1.5 left-0 w-[2px] origin-center rounded-full bg-[var(--color-primary)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-spring)] ${
          active ? "scale-y-100" : "scale-y-0"
        }`}
      />
      <Icon
        className={`size-4 shrink-0 transition-colors ${
          active
            ? "text-[color:var(--color-foreground)]"
            : "text-[color:var(--color-subtle-foreground)] group-hover:text-[color:var(--color-muted-foreground)]"
        }`}
        aria-hidden
      />
      <span className="truncate">{link.label}</span>
    </Link>
  );
}

export function Sidebar({
  username,
  automationEnabled,
  automationMode,
  onLogout,
  mobileOpen,
  onMobileClose,
}: {
  username: string;
  automationEnabled: boolean;
  automationMode: string;
  onLogout: () => Promise<void>;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <>
      {mobileOpen ? (
        <div
          aria-hidden
          onClick={onMobileClose}
          className="fixed inset-0 z-[var(--z-nav-scrim)] bg-black/40 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}
      <aside
        style={{ width: "var(--sidebar-width)" }}
        className={`fixed inset-y-0 left-0 z-[var(--z-nav)] flex h-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] shadow-[var(--shadow-xl)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)] lg:static lg:z-auto lg:translate-x-0 lg:shadow-none ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-4 py-4">
          <BrandMark className="size-8 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold leading-tight tracking-[-0.01em] text-[color:var(--color-foreground)]">
              Support Automation
            </p>
            <p className="truncate text-[11px] text-[color:var(--color-muted-foreground)]">{username}</p>
          </div>
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close navigation"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] lg:hidden"
          >
            <X className="size-4.5" aria-hidden />
          </button>
        </div>

        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          <div className="px-2.5 pb-1">
            <NavItem link={OVERVIEW_LINK} active={isNavActive(pathname, searchParams, OVERVIEW_LINK.href)} />
          </div>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-2.5 pb-6 pt-4">
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="mb-1.5 px-3 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                  {group.label}
                </p>
                <div className="space-y-px">
                  {group.links.map((link) => (
                    <NavItem key={link.href} link={link} active={isNavActive(pathname, searchParams, link.href)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div className="space-y-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3">
          <div className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2">
            <Badge color={automationEnabled ? "green" : "red"} dot pulse={automationEnabled}>
              {automationEnabled ? "Enabled" : "Paused"}
            </Badge>
            <span className="truncate text-[10px] font-medium tracking-[0.02em] text-[color:var(--color-muted-foreground)]">
              {automationMode}
            </span>
          </div>

          <ThemeToggle />

          <form action={onLogout}>
            <button
              type="submit"
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-danger-border)] hover:bg-[var(--color-danger-bg)] hover:text-[color:var(--color-danger-fg)]"
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
