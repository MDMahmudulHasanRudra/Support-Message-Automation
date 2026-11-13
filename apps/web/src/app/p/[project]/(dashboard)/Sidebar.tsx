"use client";

import { enumLabel } from "@/lib/displayLabels";
import { Badge } from "@/components/ui";
import { navIconClass, navItemClass } from "@/components/shell/ShellParts";
import { Blocks, Building2, ChevronDown, ChevronsLeft, ChevronsRight, FolderKanban, LayoutDashboard, Palette, ShieldCheck, UserRound, X } from "lucide-react";
import Link, { useProjectHref } from "@/components/ProjectLink";
import { useNavHighlight } from "@/lib/navigationPending";
import { usePathname, useSearchParams } from "next/navigation";
import { stripProjectPrefix } from "@/lib/projectPaths";
import { useMemo, useSyncExternalStore } from "react";
import { OVERVIEW_LINK, isGroupActive, isLinkActive, isNavActive, type NavGroup, type NavLink } from "./navigation";
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

/**
 * Which parent modules the reader has opened by hand, as an external store for the same reason as
 * the collapse preference above. The snapshot is the raw stored string, so it is referentially
 * stable between renders; the component parses it. The parent holding the current page is always
 * open regardless, so this only ever records the OTHERS somebody chose to keep open.
 */
const OPEN_GROUPS_KEY = "sidebar-open-groups";
const openGroupListeners = new Set<() => void>();
let openGroupsCache: string | null = null;

function openGroupsSnapshot(): string {
  if (openGroupsCache === null) {
    try {
      openGroupsCache = window.localStorage.getItem(OPEN_GROUPS_KEY) ?? "[]";
    } catch {
      openGroupsCache = "[]";
    }
  }
  return openGroupsCache;
}

function openGroupsServerSnapshot(): string {
  return "[]";
}

function subscribeOpenGroups(onChange: () => void): () => void {
  openGroupListeners.add(onChange);
  return () => openGroupListeners.delete(onChange);
}

function parseOpenGroups(raw: string): Set<string> {
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function toggleOpenGroup(label: string): void {
  const open = parseOpenGroups(openGroupsSnapshot());
  if (open.has(label)) open.delete(label);
  else open.add(label);
  openGroupsCache = JSON.stringify([...open]);
  try {
    window.localStorage.setItem(OPEN_GROUPS_KEY, openGroupsCache);
  } catch {
    /* private mode — still works for this tab */
  }
  openGroupListeners.forEach((listener) => listener());
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
  const toProject = useProjectHref();
  const lit = useNavHighlight(toProject(link.href), active);
  return (
    <Link
      href={link.href}
      intent
      data-nav-item=""
      aria-current={active ? "page" : undefined}
      title={collapsed ? link.label : undefined}
      className={navItemClass(lit, collapsed ? "justify-center !px-0" : "")}
    >
      <Icon className={navIconClass(lit)} aria-hidden />
      {collapsed ? null : <span className="truncate">{link.label}</span>}
    </Link>
  );
}

/**
 * The Main Admin Portal's own pages, at the top of the sidebar when a page is shown in the workspace.
 * Each needs the key its page checks; the shell filters them (presentation — the pages check again).
 */
export const MAIN_ADMIN_LINKS: Array<NavLink & { key: string | null }> = [
  { href: "/admin", label: "Admin Dashboard", icon: LayoutDashboard, key: null },
  { href: "/admin/projects", label: "Projects", icon: FolderKanban, key: null },
  { href: "/admin/configuration", label: "Organization", icon: Building2, key: "configuration.view" },
];

/** The portal's own pages drawn AFTER the global modules, so the order matches the Main Admin sidebar. */
export const MAIN_ADMIN_TAIL_LINKS: Array<NavLink & { key: string | null }> = [
  { href: "/admin/branding", label: "Branding Settings", icon: Palette, key: null },
  { href: "/admin/module-templates", label: "Project Templates", icon: Blocks, key: null },
  { href: "/admin/account", label: "My Account", icon: UserRound, key: null },
];

/**
 * The Main Admin Portal's own "Users & Permissions" overview (every login, its employee, role and
 * projects). In the workspace it heads the Users & Permissions group, beside App Users and Permission
 * Modules, so all three are in one place under Main Admin.
 */
export const ADMIN_USERS_OVERVIEW_LINK: NavLink = { href: "/admin/users", label: "Overview", icon: ShieldCheck };

function SectionLabel({ children, collapsed }: { children: string; collapsed: boolean }) {
  if (collapsed) return <div className="mx-2 my-1.5 border-t border-[var(--color-border)]" />;
  return (
    <p className="px-3 pt-2 pb-1.5 text-[10px] font-semibold tracking-[0.06em] text-[color:var(--color-subtle-foreground)] uppercase">
      {children}
    </p>
  );
}

export function Sidebar({
  automationEnabled,
  automationMode,
  mobileOpen,
  onMobileClose,
  navGroups,
  workspace,
}: {
  /**
   * Set in the Main Admin Workspace: the sidebar becomes the Main Admin's — its own pages and the
   * global modules first, then every project module under WORKSPACE. One sidebar; the project is
   * chosen by the tabs above the page, not by a second navigation.
   */
  workspace?: { globalGroups: NavGroup[]; mainAdminLinks: NavLink[]; mainAdminTailLinks?: NavLink[] } | null;
  automationEnabled: boolean;
  automationMode: string;
  mobileOpen: boolean;
  onMobileClose: () => void;
  /** The nav already reduced to what this role can open — see navigation.navGroupsFor. */
  navGroups: NavGroup[];
}) {
  const pathname = stripProjectPrefix(usePathname());
  const searchParams = useSearchParams();
  const storedCollapsed = useSyncExternalStore(subscribeCollapse, collapseSnapshot, collapseServerSnapshot);
  // Open or icons-only is the person's own choice, everywhere: the conversations no longer fold it by themselves
  // (owner, 13 Nov 2026). The collapse button is the only control, and it is remembered in this browser.
  const collapsed = !mobileOpen && storedCollapsed;
  const toggleCollapsed = () => writeCollapse(!collapseSnapshot());
  const openGroupsRaw = useSyncExternalStore(subscribeOpenGroups, openGroupsSnapshot, openGroupsServerSnapshot);
  const openGroups = useMemo(() => parseOpenGroups(openGroupsRaw), [openGroupsRaw]);

  const renderGroups = (groups: NavGroup[], offset: number) =>
    groups.map((group, groupIndex) => {
      const index = groupIndex + offset;
      // Icon rail: every page as an icon, a hairline between modules. Opening and closing
      // parents means nothing when there is no room for their names.
      if (collapsed) {
        return (
          <div key={group.label} className={index > 0 ? "mt-1.5 border-t border-[var(--color-border)] pt-1.5" : ""}>
            {group.links.map((link) => (
              <NavItem key={link.href} link={link} active={isLinkActive(pathname, searchParams, link)} collapsed />
            ))}
          </div>
        );
      }

      // A module holding one page is that page — a parent row above a single child would be
      // a click that leads nowhere new.
      if (group.links.length === 1) {
        const only = group.links[0]!;
        return (
          <NavItem key={group.label} link={only} active={isLinkActive(pathname, searchParams, only)} collapsed={false} />
        );
      }

      const containsCurrentPage = isGroupActive(pathname, searchParams, group);
      const open = containsCurrentPage || openGroups.has(group.label);
      const Icon = group.icon;
      const panelId = `nav-group-${index}`;
      return (
        <div key={group.label}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            // The module you are in stays open: closing it would hide the very page you are on.
            onClick={containsCurrentPage ? undefined : () => toggleOpenGroup(group.label)}
            className={`group flex w-full items-center gap-2.5 rounded-[var(--radius-md)] py-[7px] pr-2 pl-3 text-left text-[13.5px] transition-[background-color,color] duration-[var(--duration-fast)] ${
              containsCurrentPage
                ? "cursor-default font-medium text-[color:var(--color-foreground)]"
                : "cursor-pointer text-[color:var(--color-muted-foreground)] hover:bg-white/[0.07] hover:text-[color:var(--color-foreground)]"
            }`}
          >
            <Icon
              className={`size-[18px] shrink-0 ${containsCurrentPage ? "text-[color:var(--color-foreground)]" : "text-[color:var(--color-subtle-foreground)]"}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{group.label}</span>
            {containsCurrentPage ? null : (
              <ChevronDown
                className={`size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)] transition-transform duration-[var(--duration-fast)] ${
                  open ? "rotate-180" : ""
                }`}
                aria-hidden
              />
            )}
          </button>
          {open ? (
            <div id={panelId} className="mt-px mb-1.5 ml-[1.1rem] space-y-px border-l border-[var(--color-border)] pl-1.5">
              {group.links.map((link) => (
                <NavItem key={link.href} link={link} active={isLinkActive(pathname, searchParams, link)} collapsed={false} />
              ))}
            </div>
          ) : null}
        </div>
      );
    });

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
        className={`tide-field fixed inset-y-0 left-0 z-[var(--z-nav)] flex h-full shrink-0 flex-col bg-[var(--tide-bg)] shadow-[var(--shadow-xl)] transition-[transform,width] duration-[var(--duration-base)] ease-[var(--ease-out)] lg:relative lg:z-[1] lg:translate-x-0 lg:shadow-none ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-end px-3 pt-3 lg:hidden">
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close navigation"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-white/[0.08] hover:text-[color:var(--color-foreground)]"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col">
          {workspace ? (
            // In the workspace the Main Admin menu is long, so it scrolls WITH the modules below it: a fixed top
            // part left only the bottom of the sidebar scrolling.
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2.5 pb-6">
              <SectionLabel collapsed={collapsed}>Main Admin</SectionLabel>
              {workspace.mainAdminLinks.map((link) => (
                <NavItem key={link.href} link={link} active={false} collapsed={collapsed} />
              ))}
              <div className="space-y-0.5">{renderGroups(workspace.globalGroups, 100)}</div>
              {(workspace.mainAdminTailLinks ?? []).map((link) => (
                <NavItem key={link.href} link={link} active={false} collapsed={collapsed} />
              ))}
              <SectionLabel collapsed={collapsed}>Workspace</SectionLabel>
              <NavItem link={{ ...OVERVIEW_LINK, label: "Project Overview" }} active={isNavActive(pathname, searchParams, OVERVIEW_LINK.href)} collapsed={collapsed} />
              <div className="space-y-0.5 pt-2">{renderGroups(navGroups, 0)}</div>
            </div>
          ) : (
            <>
              <div className="px-2.5 pb-1">
                <NavItem link={OVERVIEW_LINK} active={isNavActive(pathname, searchParams, OVERVIEW_LINK.href)} collapsed={collapsed} />
              </div>

              <div className="scroll-quiet min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 pt-3 pb-6">
                {renderGroups(navGroups, 0)}
              </div>
            </>
          )}
        </nav>

        {/* Desktop-only collapse control — a floating rail toggle, the ERP-console convention,
            rather than another line competing for space in the already-dense footer below. */}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          className="absolute top-3 -right-3 z-10 hidden size-6 cursor-pointer items-center justify-center rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] text-[color:var(--color-muted-foreground)] shadow-[var(--shadow-sm)] transition-colors hover:text-[color:var(--color-foreground)] lg:flex"
        >
          {collapsed ? <ChevronsRight className="size-3.5" aria-hidden /> : <ChevronsLeft className="size-3.5" aria-hidden />}
        </button>

        <div className={`space-y-2.5 border-t border-[var(--color-border)] p-3 ${collapsed ? "px-2" : ""}`}>
          <div
            className={`flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 ${
              collapsed ? "justify-center" : "justify-between"
            }`}
            title={collapsed ? `Automation ${automationEnabled ? "enabled" : "paused"} — ${enumLabel(automationMode)}` : undefined}
          >
            <Badge color={automationEnabled ? "green" : "red"} dot pulse={automationEnabled}>
              {collapsed ? "" : automationEnabled ? "Enabled" : "Paused"}
            </Badge>
            {collapsed ? null : (
              <span className="truncate text-[10px] font-medium tracking-[0.02em] text-[color:var(--color-muted-foreground)]">
                {enumLabel(automationMode)}
              </span>
            )}
          </div>

          {collapsed ? null : <ThemeToggle />}

        </div>
      </aside>
    </>
  );
}
