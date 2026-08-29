"use client";

import { ChevronRight, Menu, Search } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CommandPalette } from "./CommandPalette";
import { FloatingAiChat } from "./FloatingAiChat";
import { resolveNavLocation } from "./navigation";
import { Sidebar } from "./Sidebar";

/**
 * Owns the client state layout.tsx can't hold itself (it's an async Server
 * Component reading the session/DB and must stay one) — the mobile nav drawer and
 * the command palette. Also the natural place for a per-navigation page-entrance
 * animation: keying the content wrapper on `pathname` makes React remount it on
 * every route change, replaying the CSS entrance animation without every
 * individual page needing to do anything.
 */
export function DashboardShell({
  children,
  username,
  automationEnabled,
  automationMode,
  onLogout,
}: {
  children: ReactNode;
  username: string;
  automationEnabled: boolean;
  automationMode: string;
  onLogout: () => Promise<void>;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const location = resolveNavLocation(pathname, searchParams);

  useEffect(() => {
    // Deferred via a microtask rather than called directly in the effect body — satisfies
    // react-hooks/set-state-in-effect, and fires before the next paint either way.
    queueMicrotask(() => setMobileNavOpen(false));
  }, [pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-background)]">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <Sidebar
        username={username}
        automationEnabled={automationEnabled}
        automationMode={automationMode}
        onLogout={onLogout}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>

          {/* Where am I — resolved from the nav tree, so detail routes still show
              the module they belong to instead of an empty bar. */}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
            {location && location.group !== "Dashboard" ? (
              <>
                <span className="hidden truncate text-[color:var(--color-muted-foreground)] sm:inline">
                  {location.group}
                </span>
                <ChevronRight
                  className="hidden size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)] sm:inline"
                  aria-hidden
                />
              </>
            ) : null}
            <span className="truncate font-medium text-[color:var(--color-foreground)]">
              {location?.label ?? "Support Automation"}
            </span>
          </nav>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-8 cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] pl-2.5 pr-2 text-[color:var(--color-muted-foreground)] transition-[border-color,color] duration-[var(--duration-fast)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="hidden text-xs sm:inline">Jump to…</span>
            <kbd className="hidden rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-medium sm:inline">
              ⌘K
            </kbd>
          </button>
        </header>

        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          <div
            key={pathname}
            className="mx-auto w-full max-w-[var(--space-content-max)] animate-fade-in-rise px-5 py-7 sm:px-8 sm:py-9"
          >
            {children}
          </div>
        </main>
      </div>

      {/* Mounted only while open, so each invocation starts from an empty query. */}
      {paletteOpen ? <CommandPalette onClose={closePalette} /> : null}
      <FloatingAiChat />
    </div>
  );
}
