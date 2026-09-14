"use client";

import { Badge, BrandMark } from "@/components/ui";
import { ChevronsLeft, ChevronsRight, LogOut, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useSyncExternalStore } from "react";
import { NAV_GROUPS, OVERVIEW_LINK, isNavActive, type NavLink } from "./navigation";
import { ThemeToggle } from "./ThemeToggle";

/**
 * Collapse preference as an external store, not state seeded from an effect — same shape as the
 * chat inbox's density toggle (`ConversationList.tsx`), and for the same reason: `localStorage`
 * cannot be read on the server, so seeding from an effect would render the sidebar at the wrong
 * width for one frame on every load. Expanded is the safe server-rendered default; React re-reads
 * the real value immediately after hydration with no cascading render.
 */
const COLLAPSE_KEY = "sidebar-collapsed";
const collapseListeners = new Set<() => void>();
let collapseCache: boolean | null = null;

function collapseSnapshot(): boolean {
  if (collapseCache === null) {
    try {
      collapseCache = window.localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      collapseCache = false;
    }
  }
  return collapseCache;
}

function collapseServerSnapshot(): boolean {
  return false;
}

function subscribeCollapse(onChange: () => void): () => void {
  collapseListeners.add(onChange);
  return () => collapseListeners.delete(onChange);
}

function writeCollapse(collapsed: boolean): void {
  collapseCache = collapsed;
  try {
    window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    /* private mode, or storage disabled — the toggle still works for this tab */
  }
  collapseListeners.forEach((listener) => listener());
}

function NavItem({ link, active, collapsed }: { link: NavLink; active: boolean; collapsed: boolean }) {
  const Icon = link.icon;
  return (
    <Link
      href={link.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? link.label : undefined}
      className={`group relative flex items-center gap-2.5 rounded-[var(--radius-md)] py-1.5 pr-2.5 pl-3 text-[13px] transition-[background-color,color] duration-[var(--duration-fast)] ${
        collapsed ? "justify-center px-0" : ""
      } ${
        active
          ? "bg-[var(--color-neutral-bg)] font-medium text-[color:var(--color-foreground)]"
          : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]/60 hover:text-[color:var(--color-foreground)]"
      }`}
    >
      {/* The one place brand indigo appears on every page: the active-item rail. */}
      <span
        aria-hidden
        className={`absolute inset-y-1.5 left-0 w-[2px] origin-center rounded-full bg-[var(--color-accent)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-spring)] ${
          active ? "scale-y-100" : "scale-y-0"
        }`}
      />
      <Icon
        className={`size-4 shrink-0 transition-colors ${
          active
            ? "text-[color:var(--color-accent)]"
            : "text-[color:var(--color-subtle-foreground)] group-hover:text-[color:var(--color-muted-foreground)]"
        }`}
        aria-hidden
      />
      {collapsed ? null : <span className="truncate">{link.label}</span>}
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
  const collapsed = useSyncExternalStore(subscribeCollapse, collapseSnapshot, collapseServerSnapshot);
  const toggleCollapsed = useCallback(() => writeCollapse(!collapseSnapshot()), []);

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
        style={{ width: collapsed ? "var(--sidebar-width-collapsed)" : "var(--sidebar-width)" }}
        className={`fixed inset-y-0 left-0 z-[var(--z-nav)] flex h-full shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] shadow-[var(--shadow-xl)] transition-[transform,width] duration-[var(--duration-base)] ease-[var(--ease-out)] lg:static lg:z-auto lg:translate-x-0 lg:shadow-none ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className={`flex items-center gap-2.5 px-4 py-4 ${collapsed ? "justify-center px-2" : ""}`}>
          <BrandMark className="size-8 shrink-0" />
          {collapsed ? null : (
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold leading-tight tracking-[-0.01em] text-[color:var(--color-foreground)]">
                Softify Assist
              </p>
              <p className="truncate text-[11px] text-[color:var(--color-muted-foreground)]">{username}</p>
            </div>
          )}
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
            <NavItem link={OVERVIEW_LINK} active={isNavActive(pathname, searchParams, OVERVIEW_LINK.href)} collapsed={collapsed} />
          </div>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-2.5 pt-4 pb-6">
            {NAV_GROUPS.map((group, index) => {
              // A section header draws only where the section actually changes from the group
              // before it — the department name, one level up from the existing group labels,
              // never a repeat of the same word stacked five times in a row.
              const previousSection = index > 0 ? NAV_GROUPS[index - 1]!.section : null;
              const isNewSection = group.section !== previousSection;
              return (
                <div key={group.label}>
                  {isNewSection ? (
                    collapsed ? (
                      <div className={`mx-3 border-t border-[var(--color-border-strong)] ${index === 0 ? "mb-1.5" : "mt-4 mb-1.5"}`} />
                    ) : (
                      <p
                        className={`px-3 text-[10px] font-semibold tracking-[0.06em] text-[color:var(--color-subtle-foreground)] uppercase ${
                          index === 0 ? "mb-2" : "mt-2 mb-2"
                        }`}
                      >
                        {group.section}
                      </p>
                    )
                  ) : null}
                  {collapsed ? null : (
                    <p className="mb-1.5 px-3 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                      {group.label}
                    </p>
                  )}
                  <div className="space-y-px">
                    {group.links.map((link) => (
                      <NavItem
                        key={link.href}
                        link={link}
                        active={isNavActive(pathname, searchParams, link.href)}
                        collapsed={collapsed}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </nav>

        {/* Desktop-only collapse control — a floating rail toggle, the ERP-console convention,
            rather than another line competing for space in the already-dense footer below. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          className="absolute top-16 -right-3 hidden size-6 cursor-pointer items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[color:var(--color-muted-foreground)] shadow-[var(--shadow-sm)] transition-colors hover:text-[color:var(--color-foreground)] lg:flex"
        >
          {collapsed ? <ChevronsRight className="size-3.5" aria-hidden /> : <ChevronsLeft className="size-3.5" aria-hidden />}
        </button>

        <div className={`space-y-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-3 ${collapsed ? "px-2" : ""}`}>
          <div
            className={`flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 ${
              collapsed ? "justify-center" : "justify-between"
            }`}
            title={collapsed ? `Automation ${automationEnabled ? "enabled" : "paused"} — ${automationMode}` : undefined}
          >
            <Badge color={automationEnabled ? "green" : "red"} dot pulse={automationEnabled}>
              {collapsed ? "" : automationEnabled ? "Enabled" : "Paused"}
            </Badge>
            {collapsed ? null : (
              <span className="truncate text-[10px] font-medium tracking-[0.02em] text-[color:var(--color-muted-foreground)]">
                {automationMode}
              </span>
            )}
          </div>

          {collapsed ? null : <ThemeToggle />}

          <form action={onLogout}>
            <button
              type="submit"
              title={collapsed ? "Sign out" : undefined}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-danger-border)] hover:bg-[var(--color-danger-bg)] hover:text-[color:var(--color-danger-fg)]"
            >
              <LogOut className="size-3.5" aria-hidden />
              {collapsed ? null : "Sign out"}
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
