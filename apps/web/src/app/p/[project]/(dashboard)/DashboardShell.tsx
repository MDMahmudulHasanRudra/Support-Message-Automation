"use client";

import { ChevronRight, LogOut, Menu, Search } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { stripProjectPrefix } from "@/lib/projectPaths";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import NextLink from "next/link";
import { WorkspaceModeContext } from "@/components/ProjectLink";
import { featuresOffEverywhere, isGlobalPage, workspaceOpenHref, type WorkspaceProject } from "@/lib/workspace";
import { featureForPath } from "@support-automation/shared";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { CommandPalette } from "./CommandPalette";
import { FloatingAiChat } from "./FloatingAiChat";
import { WhatsAppJobCenter } from "@/components/whatsappOperations/WhatsAppJobCenter";
import {
  isSettingsPath,
  navGroupsFor,
  navPermissionFor,
  resolveNavLocation,
  settingsSectionsFor,
  tabsForLocation,
  ALL_NAV_LINKS,
  type NavGroup,
} from "./navigation";
import { SubNavTabs } from "./SubNavTabs";
import { SettingsNav } from "./SettingsNav";
import { MAIN_ADMIN_LINKS, Sidebar } from "./Sidebar";
import type { SwitcherProject } from "@/components/ProjectSwitcher";
import { Alert } from "@/components/ui";
import { pathAllowedByFeatures } from "@support-automation/shared";

/** First one or two letters of a username, for the header identity chip — "rudra" → "RU". */
function userInitials(username: string): string {
  const letters = username.replace(/[^\p{L}\p{N}]/gu, "");
  return (letters.slice(0, 2) || "?").toUpperCase();
}

/**
 * The header's user/profile menu. Every capability here already exists in the sidebar footer
 * (identity, sign out) — this is the ERP-conventional PLACE for it, not a second implementation:
 * it calls the same `onLogout` action DashboardShell already holds, rather than a new one.
 */
function UserMenu({ username, onLogout }: { username: string; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-[var(--color-accent-bg)] text-[11px] font-semibold text-[color:var(--color-accent-fg)] ring-1 ring-inset ring-[var(--color-accent-border)] transition-[box-shadow] duration-[var(--duration-fast)] hover:shadow-[var(--shadow-sm)]"
      >
        {userInitials(username)}
      </button>
      {open ? (
        <div
          role="menu"
          className="animate-scale-in absolute top-full right-0 z-[var(--z-floating)] mt-2 w-52 origin-top-right rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-lg)]"
        >
          <div className="truncate px-2.5 py-2 text-[13px] font-medium text-[color:var(--color-foreground)]">
            {username}
          </div>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <form
            action={async () => {
              setOpen(false);
              await onLogout();
            }}
          >
            <button
              type="submit"
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-danger-bg)] hover:text-[color:var(--color-danger-fg)]"
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

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
  grantedKeys,
  project,
  switchableProjects,
  disabledFeatures,
  workspaceProjects,
}: {
  children: ReactNode;
  /**
   * Set when the page is shown in the Main Admin Workspace (MAIN_ADMIN_WORKSPACE.md): the projects
   * the viewer may enter, each with its switched-off features, for the project tabs. The same page,
   * the same checks — only this chrome differs.
   */
  workspaceProjects?: WorkspaceProject[] | null;
  /** The project this page belongs to — named in the sidebar and the breadcrumb on every page. */
  project: SwitcherProject;
  /** Exactly the projects this user may enter (server-computed). */
  switchableProjects: SwitcherProject[];
  /** Features this project is not entitled to: their pages are not offered anywhere in the shell. */
  disabledFeatures: string[];
  username: string;
  automationEnabled: boolean;
  automationMode: string;
  onLogout: () => Promise<void>;
  /** Permission keys this user's role grants — presentation only; see navigation.navPermissionFor. */
  grantedKeys: string[];
}) {
  const granted = useMemo(() => new Set(grantedKeys), [grantedKeys]);
  const featuresOff = useMemo(() => new Set(disabledFeatures), [disabledFeatures]);
  const inWorkspace = Boolean(workspaceProjects);
  // In the workspace the sidebar offers every module that is on in ANY of the viewer's projects; one
  // that is off in THIS project opens in a project that has it (lib/workspace.ts workspaceOpenHref).
  // Global modules (Users & Permissions, Release Notes) move up to the Main Admin section.
  const { navGroups, globalGroups } = useMemo(() => {
    if (!workspaceProjects) return { navGroups: navGroupsFor(granted, featuresOff), globalGroups: [] as NavGroup[] };
    const groups = navGroupsFor(granted, new Set(featuresOffEverywhere(workspaceProjects))).map((group) => ({
      ...group,
      links: group.links.map((link) => {
        const feature = featureForPath(link.href);
        return feature && featuresOff.has(feature) ? { ...link, href: workspaceOpenHref(link.href), tabs: undefined } : link;
      }),
    }));
    const isGlobal = (group: NavGroup) => group.links.every((link) => isGlobalPage(link.href));
    return { navGroups: groups.filter((g) => !isGlobal(g)), globalGroups: groups.filter(isGlobal) };
  }, [granted, featuresOff, workspaceProjects]);
  const settingsSections = useMemo(() => settingsSectionsFor(granted, featuresOff), [granted, featuresOff]);
  const paletteLinks = useMemo(
    () =>
      ALL_NAV_LINKS.filter((link) => {
        const key = navPermissionFor(link.href);
        return (key === null || granted.has(key)) && pathAllowedByFeatures(link.href, featuresOff);
      }),
    [granted, featuresOff],
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = stripProjectPrefix(usePathname());
  const searchParams = useSearchParams();
  const location = resolveNavLocation(pathname, searchParams);
  // Pages sharing one sidebar entry show their siblings as tabs; see SubNavTabs.
  const tabSet = tabsForLocation(pathname, searchParams, navGroups);

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
  const workspaceCurrent = workspaceProjects?.find((p) => p.slug === project.slug) ?? null;

  return (
    <WorkspaceModeContext.Provider value={inWorkspace}>
    <div className="flex h-screen overflow-hidden bg-[var(--color-background)]">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <Sidebar
        automationEnabled={automationEnabled}
        automationMode={automationMode}
        onLogout={onLogout}
        navGroups={navGroups}
        project={project}
        switchableProjects={switchableProjects}
        canViewAdmin={granted.has("projects.view")}
        canCreateProject={granted.has("projects.manage")}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        workspace={
          inWorkspace
            ? {
                // Users & Permissions is the Main Admin's own page there; Release Notes stays a global module.
                globalGroups: globalGroups.filter((g) => g.label !== "Users & Permissions"),
                mainAdminLinks: MAIN_ADMIN_LINKS.filter((l) => l.key === null || granted.has(l.key)).map(({ href, label, icon }) => ({ href, label, icon })),
              }
            : null
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            {/* The project first, on every page: nobody should have to wonder whether they are
                changing ISP Digital or another project. */}
            {inWorkspace ? (
              <NextLink href="/admin" className="shrink-0 font-medium text-[color:var(--color-accent)] hover:underline">
                Main Admin
              </NextLink>
            ) : (
              <span className="max-w-[10rem] shrink-0 truncate font-medium text-[color:var(--color-accent)]">{project.name}</span>
            )}
            <ChevronRight className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
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
              {location?.label ?? "Softify Assist"}
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

          <UserMenu username={username} onLogout={onLogout} />
        </header>

        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          <div
            key={pathname}
            // In the workspace the project tabs sit above the page: full-height pages (the chat
            // inbox) read this to leave room for them.
            style={inWorkspace ? ({ "--chat-inset": "10rem", "--chat-inset-sm": "11.5rem" } as CSSProperties) : undefined}
            className="mx-auto w-full max-w-[var(--space-content-max)] animate-fade-in-rise px-5 py-7 sm:px-8 sm:py-9"
          >
            {workspaceProjects && workspaceCurrent ? (
              <WorkspaceTabs projects={workspaceProjects} current={workspaceCurrent} pathname={pathname} search={searchParams} />
            ) : null}
            {project.status === "SUSPENDED" || project.status === "ARCHIVED" ? (
              <div className="mb-5">
                <Alert tone="warning" title={`${project.name} is ${project.status === "ARCHIVED" ? "archived" : "suspended"} — read-only`}>
                  You can look at everything, but changes are not saved
                  {project.status === "SUSPENDED" ? " and nothing is sent until a Main Admin makes the project active again." : "."}
                </Alert>
              </div>
            ) : null}
            {tabSet ? <SubNavTabs tabs={tabSet.tabs} activeHref={tabSet.activeHref} /> : null}
            {/* Every configuration page gets the Settings rail beside it, whatever route it lives
                at, so the module reads as one place. See SettingsNav. */}
            {isSettingsPath(pathname) && settingsSections.length > 0 ? (
              <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10">
                <div className="lg:sticky lg:top-0 lg:self-start">
                  <SettingsNav sections={settingsSections} pathname={pathname} />
                </div>
                <div className="min-w-0">{children}</div>
              </div>
            ) : (
              children
            )}
          </div>
        </main>
      </div>

      {/* Mounted only while open, so each invocation starts from an empty query. */}
      {paletteOpen ? <CommandPalette onClose={closePalette} links={paletteLinks} /> : null}
      {/* Only for roles that can use it: every send is refused without ai_learning.view, and a
          floating button on every page that always answers "not allowed" is worse than none. */}
      {granted.has("ai_learning.view") ? <FloatingAiChat /> : null}
      {/* Long-running WhatsApp jobs stay visible on every page (Add Number to Groups, Groups Admin
          Maker). Offered to whoever may see those modules; the reader refuses everyone else anyway. */}
      {granted.has("bulk_messaging.view") && !featuresOff.has("BULK_MESSAGING") ? (
        <WhatsAppJobCenter projectSlug={project.slug} besideAiChat={granted.has("ai_learning.view")} />
      ) : null}
    </div>
    </WorkspaceModeContext.Provider>
  );
}
