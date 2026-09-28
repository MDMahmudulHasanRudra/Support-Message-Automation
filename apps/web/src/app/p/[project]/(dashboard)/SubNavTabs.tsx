"use client";

import Link from "@/components/ProjectLink";
import type { NavLink } from "./navigation";

/**
 * Tabs across the top of pages that share one sidebar entry — Messages (All / Needs attention /
 * Ignored), Knowledge Base (Entries / Pending review / Import), Patterns, Automation Rules,
 * Broadcast, Release Notes.
 *
 * Drawn by DashboardShell, keyed off the current path, so none of those pages changed: each is still
 * its own route with its own permission check. Only tabs the role can open are passed in. Real links,
 * so middle-click, ctrl-click, back/forward and a pasted URL all behave as they always did.
 */
export function SubNavTabs({ tabs, activeHref }: { tabs: NavLink[]; activeHref: string | null }) {
  return (
    <nav aria-label="Section" className="-mt-2 mb-6 overflow-x-auto border-b border-[var(--color-border)]">
      <ul className="flex min-w-max gap-1">
        {tabs.map((tab) => {
          const active = tab.href === activeHref;
          const Icon = tab.icon;
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`relative -mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors duration-[var(--duration-fast)] ${
                  active
                    ? "border-[var(--color-accent)] font-medium text-[color:var(--color-foreground)]"
                    : "border-transparent text-[color:var(--color-muted-foreground)] hover:border-[var(--color-border-strong)] hover:text-[color:var(--color-foreground)]"
                }`}
              >
                <Icon className={`size-3.5 ${active ? "text-[color:var(--color-accent)]" : ""}`} aria-hidden />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
