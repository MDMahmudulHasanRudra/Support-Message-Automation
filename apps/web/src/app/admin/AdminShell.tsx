"use client";

import { usePathname } from "next/navigation";
import { Blocks, Building2, ChevronRight, FolderKanban, LayoutDashboard, Menu, Palette, ShieldCheck, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageEpoch } from "@/components/NavigationProgress";
import { IntentLink } from "@/components/ProjectLink";
import { usePendingNavigation } from "@/lib/navigationPending";
import { ProjectSwitcher, type SwitcherProject } from "@/components/ProjectSwitcher";
import { SupportSessionBanner, type SupportSessionBannerInfo } from "@/components/SupportSessionBanner";
import { ThemeToggle } from "@/app/p/[project]/(dashboard)/ThemeToggle";
import { CommandPalette } from "@/app/p/[project]/(dashboard)/CommandPalette";
import { navIconClass, navItemClass, ShellSearch, ShellUserMenu } from "@/components/shell/ShellParts";
import { navGroupsFor, type NavLink } from "@/app/p/[project]/(dashboard)/navigation";
import { isGlobalPage, workspaceOpenHref } from "@/lib/workspace";
import { UsersAccessTabs, usersAccessTabFor } from "@/components/shell/UsersAccessTabs";

/**
 * The Main Admin Portal's frame. Deliberately small, and deliberately the same visual language as
 * the project portal (DashboardShell + Sidebar): the same sidebar surface, the same nav item, the
 * same header. It is a management layer ABOVE the projects, not a second copy of their modules.
 *
 * The WORKSPACE entries are the project portal's own modules, from the same navigation and filtered
 * by the same role check. Each opens `/admin/workspace?to=<page>`, which picks the project on the
 * server and shows the project's OWN page with the projects as tabs (lib/workspace.ts). Global
 * modules — the ones whose data is not a project's — sit under Main Admin instead.
 */
interface AdminNavItem {
  href: string;
  label: string;
  icon: NavLink["icon"];
  exact: boolean;
  /** Drawn indented under the item above it. */
  sub?: boolean;
}

/** All Conversations and Operations are shown page by page; every other module is one entry. */
const EXPANDED_GROUPS = new Set(["support", "operations"]);

function buildSections(granted: ReadonlySet<string>, hasProjects: boolean): Array<{ title: string; items: AdminNavItem[] }> {
  const groups = navGroupsFor(granted);
  const open = (link: NavLink, label = link.label): AdminNavItem => ({ href: workspaceOpenHref(link.href), label, icon: link.icon, exact: false });
  const isGlobal = (links: NavLink[]) => links.every((link) => isGlobalPage(link.href));
  return [
    {
      title: "Main Admin",
      items: [
        { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
        { href: "/admin/projects", label: "Projects", icon: FolderKanban, exact: false },
        // SaaS (SAAS_PLATFORM_PLAN.md): customers and the addresses that open their workspaces.
        ...(granted.has("configuration.view") ? [{ href: "/admin/configuration", label: "Organization", icon: Building2, exact: false }] : []),
        // Users & Permissions: the overview, then App Users and Permission Modules (the same in every
        // project, opened without project tabs) — one place for every login and every role.
        ...(granted.has("users.view") ? [{ href: "/admin/users", label: "Users & Access", icon: ShieldCheck, exact: false }] : []),
        ...groups
          .filter((g) => g.id === "users-permissions")
          .flatMap((g) => g.links.map((link) => ({ ...open(link), sub: true }))),
        // White labeling (BRANDING.md): anyone in the portal can see it; saving needs projects.manage.
        { href: "/admin/branding", label: "Branding Settings", icon: Palette, exact: false },
        // Reusable module selections (PROJECT_MODULES.md §8); editing needs projects.manage.
        { href: "/admin/module-templates", label: "Project Templates", icon: Blocks, exact: false },
        // The other global modules (Release Notes) are the project portal's own pages, opened without tabs.
        ...groups
          .filter((g) => isGlobal(g.links) && g.id !== "users-permissions")
          .map((g) => ({ ...open(g.links[0]!, g.label), icon: g.icon })),
        // The signed-in person's own profile, password, two-step sign-in and devices (ACCOUNT_SELF_SERVICE.md).
        { href: "/admin/account", label: "My Account", icon: UserRound, exact: false },
      ],
    },
    // No project yet: nothing to open, so the Workspace menu is left out (the pages refuse without one anyway).
    {
      title: "Workspace",
      items: (hasProjects ? groups : [])
        .filter((g) => !isGlobal(g.links))
        .flatMap((g, _i, all) => {
          if (EXPANDED_GROUPS.has(g.id ?? "")) return g.links.map((link) => open(link));
          const taken = all.some((other) => EXPANDED_GROUPS.has(other.id ?? "") && other.links.some((link) => link.label === g.label));
          return [{ ...open(g.links[0]!, taken ? `${g.label}: ${g.links[0]!.label}` : g.label), icon: g.icon }];
        }),
    },
  ];
}

function isActive(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminShell({
  children,
  username,
  projects,
  canCreate,
  onLogout,
  grantedKeys,
  supportSession,
  avatarUrl = null,
}: {
  children: ReactNode;
  /** Permission keys the role grants — which workspace modules to offer. Presentation only. */
  grantedKeys: string[];
  username: string;
  projects: SwitcherProject[];
  canCreate: boolean;
  onLogout: () => Promise<void>;
  /** Set during a RELQIVO support session (SAAS_PLATFORM_PLAN.md §12): a banner on every page. */
  supportSession?: SupportSessionBannerInfo | null;
  avatarUrl?: string | null;
}) {
  const pathname = usePathname();
  const pendingNav = usePendingNavigation();
  const hasProjects = projects.some((p) => p.status !== "ARCHIVED");
  const sections = useMemo(() => buildSections(new Set(grantedKeys), hasProjects).filter((s) => s.items.length > 0), [grantedKeys, hasProjects]);
  const nav = sections.flatMap((section) => section.items);
  const currentLabel =
    nav.find((item) => isActive(pathname, item.href, item.exact))?.label ?? (pathname.startsWith("/admin/workspace") ? "Workspace" : nav[0]!.label);

  // Below `lg` the sidebar is a drawer (the project portal's pattern: DashboardShell + Sidebar).
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
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
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    // Closes on navigation. Deferred via a microtask rather than set in the effect body, as in
    // DashboardShell (react-hooks/set-state-in-effect).
    queueMicrotask(() => setNavOpen(false));
  }, [pathname]);

  useEffect(() => {
    if (navOpen) {
      wasOpen.current = true;
      closeButtonRef.current?.focus();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") setNavOpen(false);
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }
    // Focus goes back to the button that opened it — but only after it was actually open, never on
    // the first render or a navigation that found it closed.
    if (wasOpen.current) {
      wasOpen.current = false;
      if (window.matchMedia("(max-width: 63.99rem)").matches) menuButtonRef.current?.focus();
    }
  }, [navOpen]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--tide-bg)]">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {supportSession ? <SupportSessionBanner info={supportSession} /> : null}
      <header className="tide-field flex h-14 shrink-0 items-center gap-2 bg-[var(--tide-bg)] px-3 sm:gap-3 sm:px-4">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
          aria-controls="admin-navigation"
          aria-expanded={navOpen}
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-white/[0.08] hover:text-[color:var(--color-foreground)] lg:hidden"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <div className="flex min-w-0 flex-1 lg:w-[calc(var(--sidebar-width)-1.25rem)] lg:flex-none">
          <ProjectSwitcher current={null} projects={projects} canViewAdmin canCreate={canCreate} />
        </div>
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] max-lg:hidden">
          <span className="truncate text-[color:var(--color-muted-foreground)]">Main Admin</span>
          <ChevronRight className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
          <span aria-current="page" className="truncate font-medium text-[color:var(--color-foreground)]">
            {currentLabel}
          </span>
        </nav>
        <div className="hidden flex-1 lg:block" />
        <ShellSearch onOpen={() => setPaletteOpen(true)} />
        <ShellUserMenu username={username} role="Main Admin" accountHref="/admin/account" onLogout={onLogout} avatarUrl={avatarUrl} />
      </header>

      <div className="flex min-h-0 flex-1">
        {navOpen ? <div aria-hidden onClick={() => setNavOpen(false)} className="fixed inset-0 z-[var(--z-nav-scrim)] bg-black/40 backdrop-blur-[2px] lg:hidden" /> : null}
        <aside
          id="admin-navigation"
          aria-label="Main Admin navigation"
          // Below lg: an off-canvas drawer, `invisible` while closed so its links are out of the tab order.
          className={`tide-field fixed inset-y-0 left-0 z-[var(--z-nav)] flex h-full w-[min(var(--sidebar-width),85vw)] shrink-0 flex-col bg-[var(--tide-bg)] shadow-[var(--shadow-xl)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-out)] lg:visible lg:relative lg:z-[1] lg:w-[var(--sidebar-width)] lg:translate-x-0 lg:shadow-none ${
            navOpen ? "visible translate-x-0" : "invisible -translate-x-full"
          }`}
        >
          <div className="flex items-center justify-end px-3 pt-3 lg:hidden">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => setNavOpen(false)}
              aria-label="Close navigation"
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-white/[0.08] hover:text-[color:var(--color-foreground)]"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <nav aria-label="Main Admin" className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2.5 pb-6 pt-2">
            {sections.map((section) => (
              <div key={section.title} className="flex flex-col gap-0.5 pb-3">
                <p className="px-3 pb-1.5 pt-2 text-[11px] font-medium text-[color:var(--color-subtle-foreground)]">{section.title}</p>
                {section.items.map((item) => {
                  const active = pendingNav?.navItem ? pendingNav.target === item.href : isActive(pathname, item.href, item.exact);
                  const Icon = item.icon;
                  return (
                    <IntentLink key={item.href} href={item.href} data-nav-item="" onClick={() => setNavOpen(false)} aria-current={active ? "page" : undefined} className={navItemClass(active, item.sub ? "ml-[1.1rem] !pl-2.5" : "")}>
                      <Icon className={navIconClass(active)} aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </IntentLink>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="border-t border-[var(--color-border)] p-3">
            <ThemeToggle />
          </div>
        </aside>

        <main id="main-content" className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-[var(--color-background)] lg:rounded-tl-[22px]">
          <div className="mx-auto w-full max-w-[var(--space-content-max)] px-4 py-6 sm:px-7 sm:py-7">
            {usersAccessTabFor(pathname) ? <UsersAccessTabs active={usersAccessTabFor(pathname)!} canViewRoles={grantedKeys.includes("permissions.view")} /> : null}
            <PageEpoch>{children}</PageEpoch>
          </div>
        </main>
      </div>
      {paletteOpen ? <CommandPalette onClose={closePalette} links={sections.flatMap((section) => section.items.map(({ href, label, icon }) => ({ href, label, icon, group: section.title })))} /> : null}
    </div>
  );
}
