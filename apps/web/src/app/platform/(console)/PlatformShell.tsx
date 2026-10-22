"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Briefcase, CreditCard, Globe, LayoutDashboard, LifeBuoy, LogOut, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/app/p/[project]/(dashboard)/ThemeToggle";

/**
 * The Nexora platform's frame (SAAS_PLATFORM_PLAN.md §12, Layer 1). The same visual language as the
 * software's own portal, deliberately a different place: no project switcher, no customer modules —
 * it manages customers, it never works inside one (support access opens the customer's own address).
 */
const NAV = [
  { href: "/platform", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/platform/customers", label: "Customers", icon: Briefcase, exact: false },
  { href: "/platform/domains", label: "Domains", icon: Globe, exact: false },
  { href: "/platform/plans", label: "Plans & billing", icon: CreditCard, exact: false },
  { href: "/platform/support", label: "Support access", icon: LifeBuoy, exact: false },
  { href: "/platform/operators", label: "Operators", icon: ShieldCheck, exact: false },
  { href: "/platform/settings", label: "Settings", icon: Settings, exact: false },
  { href: "/platform/activity", label: "Activity", icon: Activity, exact: false },
] as const;

const isActive = (pathname: string, href: string, exact: boolean) => (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));

export function PlatformShell({ children, operator, productName, onLogout }: { children: ReactNode; operator: string; productName: string; onLogout: () => Promise<void> }) {
  const pathname = usePathname();
  const current = NAV.find((item) => isActive(pathname, item.href, item.exact))?.label ?? "Overview";
  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-background)] lg:h-screen lg:flex-row lg:overflow-hidden">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="flex shrink-0 flex-col border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] lg:h-full lg:w-[var(--sidebar-width)] lg:border-r lg:border-b-0">
        <div className="px-4 py-4">
          <p className="text-[13px] font-semibold tracking-[-0.01em] text-[color:var(--color-foreground)]">{productName}</p>
          <p className="text-[11px] text-[color:var(--color-muted-foreground)]">Platform</p>
        </div>
        <nav aria-label="Platform" className="flex gap-0.5 overflow-x-auto px-2.5 pb-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-6">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href, item.exact);
            const Icon = item.icon;
            return (
              <NextLink
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex shrink-0 items-center gap-2.5 rounded-[var(--radius-md)] py-1.5 pr-2.5 pl-3 text-[13px] transition-[background-color,color] duration-[var(--duration-fast)] ${
                  active
                    ? "bg-[var(--color-neutral-bg)] font-medium text-[color:var(--color-foreground)]"
                    : "text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)]/60 hover:text-[color:var(--color-foreground)]"
                }`}
              >
                <span aria-hidden className={`absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-[var(--color-accent)] ${active ? "scale-y-100" : "scale-y-0"}`} />
                <Icon className={`size-4 shrink-0 ${active ? "text-[color:var(--color-accent)]" : "text-[color:var(--color-subtle-foreground)]"}`} aria-hidden />
                <span className="truncate">{item.label}</span>
              </NextLink>
            );
          })}
        </nav>
        <div className="hidden space-y-2.5 border-t border-[var(--color-border)] p-3 lg:block">
          <ThemeToggle />
          <form action={onLogout}>
            <button
              type="submit"
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-muted-foreground)] hover:border-[var(--color-danger-border)] hover:bg-[var(--color-danger-bg)] hover:text-[color:var(--color-danger-fg)]"
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[13px] sm:px-6">
          <span className="shrink-0 font-medium text-[color:var(--color-accent)]">Platform</span>
          <span className="text-[color:var(--color-subtle-foreground)]">/</span>
          <span className="truncate font-medium text-[color:var(--color-foreground)]">{current}</span>
          <span className="flex-1" />
          <span className="truncate text-xs text-[color:var(--color-muted-foreground)]">{operator}</span>
        </header>
        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[var(--space-content-max)] px-5 py-7 sm:px-8 sm:py-9">{children}</div>
        </main>
      </div>
    </div>
  );
}
