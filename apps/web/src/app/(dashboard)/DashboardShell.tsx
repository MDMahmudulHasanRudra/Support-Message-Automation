"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { FloatingAiChat } from "./FloatingAiChat";
import { Sidebar } from "./Sidebar";

/**
 * Owns the one bit of client state layout.tsx can't hold itself (it's an async Server
 * Component reading the session/DB and must stay one) — whether the mobile nav drawer is open.
 * Also the natural place for a per-navigation page-entrance animation: keying the content
 * wrapper on `pathname` makes React remount it on every route change, replaying the CSS
 * entrance animation without every individual page needing to do anything.
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
  const pathname = usePathname();

  useEffect(() => {
    // Deferred via a microtask rather than called directly in the effect body — satisfies
    // react-hooks/set-state-in-effect, and fires before the next paint either way.
    queueMicrotask(() => setMobileNavOpen(false));
  }, [pathname]);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-background)]">
      <Sidebar
        username={username}
        automationEnabled={automationEnabled}
        automationMode={automationMode}
        onLogout={onLogout}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)]"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <span className="truncate text-sm font-semibold text-[color:var(--color-foreground)]">
            Support Automation
          </span>
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div key={pathname} className="mx-auto max-w-[1560px] animate-fade-in-rise px-6 py-7 sm:px-8">
            {children}
          </div>
        </main>
      </div>
      <FloatingAiChat />
    </div>
  );
}
