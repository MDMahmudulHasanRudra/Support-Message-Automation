"use client";

import Link from "@/components/ProjectLink";
import type { SettingsSection } from "./navigation";

/**
 * The Settings module's own navigation, drawn beside every settings page by DashboardShell.
 *
 * The settings pages still live at their original routes (see `SETTINGS_SECTIONS`), so a Next layout
 * cannot wrap them all. Rendering this from the shell, keyed off the path, is what makes twenty
 * separate pages read as one module without touching any of them.
 *
 * A rail beside the content on wide screens, a single sideways-scrolling strip on narrow ones: a
 * stacked list of twenty links above the form would push the thing you came to change below the
 * fold. Only sections the role can open are passed in, so nothing here leads to a refusal.
 */
export function SettingsNav({ sections, pathname }: { sections: SettingsSection[]; pathname: string }) {
  // Longest match wins, so an edit form under Resolution Rules lights Resolution Rules rather than
  // the Teams Connection page it also sits beneath.
  const activeHref =
    sections
      .flatMap((section) => section.links.map((link) => link.href))
      .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
      .sort((a, b) => b.length - a.length)[0] ?? null;

  return (
    <nav aria-label="Settings" className="mb-6 lg:mb-0">
      <p className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">Settings</p>

      {/* Narrow screens: one scrolling row of every page the role can open. */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden">
        {sections.flatMap((section) =>
          section.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.href === activeHref ? "page" : undefined}
              className={`shrink-0 rounded-full px-3 py-1 text-xs transition-colors ${
                link.href === activeHref
                  ? "bg-[var(--color-primary)] text-[var(--color-on-primary)]"
                  : "bg-[var(--color-neutral-bg)] text-[color:var(--color-neutral-fg)] hover:bg-[var(--color-border)]"
              }`}
            >
              {link.label}
            </Link>
          )),
        )}
      </div>

      {/* Wide screens: grouped by area, each group with a line saying what it covers. */}
      <div className="hidden space-y-5 lg:block">
        {sections.map((section) => (
          <div key={section.label}>
            <p className="px-3 text-[11px] font-medium uppercase tracking-[0.06em] text-[color:var(--color-subtle-foreground)]">
              {section.label}
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {section.links.map((link) => {
                const Icon = link.icon;
                const active = link.href === activeHref;
                return (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      className={`group relative flex items-center gap-2.5 rounded-[var(--radius-md)] py-1.5 pr-2.5 pl-3 text-[13px] transition-[background-color,color] duration-[var(--duration-fast)] ${
                        active
                          ? "bg-[var(--color-neutral-bg)] font-medium text-[color:var(--color-foreground)]"
                          : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]/60 hover:text-[color:var(--color-foreground)]"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-[var(--color-accent)] transition-transform duration-[var(--duration-base)] ${
                          active ? "scale-y-100" : "scale-y-0"
                        }`}
                      />
                      <Icon
                        className={`size-4 shrink-0 ${
                          active ? "text-[color:var(--color-accent)]" : "text-[color:var(--color-subtle-foreground)]"
                        }`}
                        aria-hidden
                      />
                      <span className="truncate">{link.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 px-3 text-[11px] leading-relaxed text-[color:var(--color-subtle-foreground)]">
              {section.description}
            </p>
          </div>
        ))}
      </div>
    </nav>
  );
}
