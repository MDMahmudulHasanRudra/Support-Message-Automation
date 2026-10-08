"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { Building2, ChevronRight, FolderKanban, LayoutDashboard, LogOut, ShieldCheck } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { ProjectSwitcher, type SwitcherProject } from "@/components/ProjectSwitcher";
import { ThemeToggle } from "@/app/p/[project]/(dashboard)/ThemeToggle";
import { navGroupsFor, type NavLink } from "@/app/p/[project]/(dashboard)/navigation";
import { isGlobalPage, workspaceOpenHref } from "@/lib/workspace";

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
}

/** Support is shown page by page (WhatsApp Chat, Messages, Escalations); every other module is one entry. */
const EXPANDED_GROUPS = new Set(["Support"]);

function buildSections(granted: ReadonlySet<string>): Array<{ title: string; items: AdminNavItem[] }> {
  const groups = navGroupsFor(granted);
  const open = (link: NavLink, label = link.label): AdminNavItem => ({ href: workspaceOpenHref(link.href), label, icon: link.icon, exact: false });
  const isGlobal = (links: NavLink[]) => links.every((link) => isGlobalPage(link.href));
  return [
    {
      title: "Main Admin",
      items: [
        { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
        { href: "/admin/projects", label: "Projects", icon: FolderKanban, exact: false },
        ...(granted.has("configuration.view") ? [{ href: "/admin/configuration", label: "Configuration", icon: Building2, exact: false }] : []),
        ...(granted.has("users.view") ? [{ href: "/admin/users", label: "Users & Permissions", icon: ShieldCheck, exact: false }] : []),
        // The other global modules (Release Notes) are the project portal's own pages, opened without tabs.
        ...groups
          .filter((g) => isGlobal(g.links) && g.label !== "Users & Permissions")
          .map((g) => ({ ...open(g.links[0]!, g.label), icon: g.icon })),
      ],
    },
    {
      title: "Workspace",
      items: groups
        .filter((g) => !isGlobal(g.links))
        .flatMap((g) => (EXPANDED_GROUPS.has(g.label) ? g.links.map((link) => open(link)) : [{ ...open(g.links[0]!, g.label), icon: g.icon }])),
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
}: {
  children: ReactNode;
  /** Permission keys the role grants — which workspace modules to offer. Presentation only. */
  grantedKeys: string[];
  username: string;
  projects: SwitcherProject[];
  canCreate: boolean;
  onLogout: () => Promise<void>;
}) {
  const pathname = usePathname();
  const sections = useMemo(() => buildSections(new Set(grantedKeys)), [grantedKeys]);
  const nav = sections.flatMap((section) => section.items);
  const currentLabel =
    nav.find((item) => isActive(pathname, item.href, item.exact))?.label ?? (pathname.startsWith("/admin/workspace") ? "Workspace" : nav[0]!.label);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-background)] lg:h-screen lg:flex-row lg:overflow-hidden">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <aside className="flex shrink-0 flex-col border-b border-[var(--color-border)] bg-[var(--color-surface-sunken)] lg:h-full lg:w-[var(--sidebar-width)] lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <ProjectSwitcher current={null} projects={projects} canViewAdmin canCreate={canCreate} />
        </div>
        <nav aria-label="Main Admin" className="flex gap-0.5 overflow-x-auto px-2.5 pb-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-6">
          {sections.map((section) => (
            <div key={section.title} className="flex shrink-0 gap-0.5 lg:flex-col lg:pb-3">
              <p className="hidden px-3 pt-1 pb-2 text-[10px] font-semibold tracking-[0.06em] text-[color:var(--color-subtle-foreground)] uppercase lg:block">
                {section.title}
              </p>
              {section.items.map((item) => {
                const active = isActive(pathname, item.href, item.exact);
                const Icon = item.icon;
                return (
                  <NextLink
                    key={item.href}
                    href={item.href}
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
                    <Icon className={`size-4 shrink-0 ${active ? "text-[color:var(--color-accent)]" : "text-[color:var(--color-subtle-foreground)]"}`} aria-hidden />
                    <span className="truncate">{item.label}</span>
                  </NextLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="hidden space-y-2.5 border-t border-[var(--color-border)] p-3 lg:block">
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-[13px] sm:px-6">
          <span className="shrink-0 font-medium text-[color:var(--color-accent)]">Main Admin</span>
          <ChevronRight className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
          <span className="truncate font-medium text-[color:var(--color-foreground)]">{currentLabel}</span>
          <span className="flex-1" />
          <span className="truncate text-xs text-[color:var(--color-muted-foreground)]">{username}</span>
        </header>
        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[var(--space-content-max)] px-5 py-7 sm:px-8 sm:py-9">{children}</div>
        </main>
      </div>
    </div>
  );
}
