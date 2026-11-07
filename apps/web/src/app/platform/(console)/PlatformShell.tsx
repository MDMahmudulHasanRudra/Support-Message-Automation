"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Briefcase, ChevronRight, CreditCard, Globe, LayoutDashboard, LifeBuoy, LogOut, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/app/p/[project]/(dashboard)/ThemeToggle";
import { navIconClass, navItemClass } from "@/components/shell/ShellParts";
import { BrandMark } from "@/components/ui";

/**
 * The RELQIVO platform's frame (SAAS_PLATFORM_PLAN.md §12, Layer 1). The same visual language as the
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
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--tide-bg)]">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <header className="tide-field flex h-14 shrink-0 items-center gap-2 bg-[var(--tide-bg)] px-3 sm:gap-3 sm:px-4">
        <BrandMark className="size-8 shrink-0" />
        <div className="min-w-0 lg:w-[calc(var(--sidebar-width)-3.5rem)]">
          <p className="truncate text-[13px] font-semibold leading-tight text-white">{productName}</p>
          <p className="text-[11px] leading-tight text-[color:var(--color-muted-foreground)]">Platform</p>
        </div>
        <span className="hidden min-w-0 items-center gap-1.5 text-[13px] sm:flex">
          <span className="text-[color:var(--color-muted-foreground)]">Platform</span>
          <ChevronRight className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
          <span className="truncate font-medium text-white">{current}</span>
        </span>
        <span className="flex-1" />
        <span className="hidden truncate text-xs text-[color:var(--color-muted-foreground)] sm:block">{operator}</span>
        <form action={onLogout}>
          <button
            type="submit"
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-xs font-medium text-[color:var(--color-muted-foreground)] transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
          >
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </button>
        </form>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="tide-field flex shrink-0 flex-col bg-[var(--tide-bg)] lg:h-full lg:w-[var(--sidebar-width)]">
          <nav aria-label="Platform" className="flex gap-0.5 overflow-x-auto px-2.5 pb-2.5 lg:flex-1 lg:flex-col lg:overflow-y-auto lg:pt-2">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href, item.exact);
              const Icon = item.icon;
              return (
                <NextLink key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={navItemClass(active, "shrink-0")}>
                  <Icon className={navIconClass(active)} aria-hidden />
                  <span className="truncate">{item.label}</span>
                </NextLink>
              );
            })}
          </nav>
          <div className="hidden p-3 lg:block">
            <ThemeToggle />
          </div>
        </aside>
        <main id="main-content" className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--color-background)] lg:rounded-tl-[22px]">
          <div className="mx-auto w-full max-w-[var(--space-content-max)] px-5 py-7 sm:px-8 sm:py-9">{children}</div>
        </main>
      </div>
    </div>
  );
}
