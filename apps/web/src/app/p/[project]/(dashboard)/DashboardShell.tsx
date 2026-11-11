"use client";

import { SupportSessionBanner, type SupportSessionBannerInfo } from "@/components/SupportSessionBanner";
import { Bot, ChevronRight, Menu } from "lucide-react";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { ShellSearch, ShellUserMenu } from "@/components/shell/ShellParts";
import { usePathname, useSearchParams } from "next/navigation";
import { useNavigationEpoch } from "@/lib/navigationPending";
import { stripProjectPrefix } from "@/lib/projectPaths";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import NextLink from "next/link";
import { WorkspaceModeContext } from "@/components/ProjectLink";
import { featuresOffEverywhere, isGlobalPage, workspaceOpenHref, type WorkspaceProject } from "@/lib/workspace";
import { featureForPath } from "@support-automation/shared";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { CommandPalette } from "./CommandPalette";
import { FloatingAiChat, openAiAssistant } from "./FloatingAiChat";
import { useBranding } from "@/components/BrandingProvider";
import { WhatsAppJobCenter } from "@/components/whatsappOperations/WhatsAppJobCenter";
import { FollowUpBadge } from "@/components/followUps/FollowUpBadge";
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
import { ADMIN_USERS_OVERVIEW_LINK, MAIN_ADMIN_LINKS, Sidebar } from "./Sidebar";
import type { SwitcherProject } from "@/components/ProjectSwitcher";
import { Alert } from "@/components/ui";
import { pathAllowedByFeatures } from "@support-automation/shared";
import { canOpenPath, type SectionAccess } from "./projectSections";

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
  avatarUrl = null,
  automationEnabled,
  automationMode,
  onLogout,
  grantedKeys,
  project,
  switchableProjects,
  disabledFeatures,
  pageAccess,
  workspaceProjects,
  billingNotice,
  supportSession,
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
  /**
   * The pages this member's project role opens (PROJECT_ROLES.md), or null when no page selection
   * applies. Only those pages are offered — sidebar, settings rail, tabs and ⌘K. Presentation only.
   */
  pageAccess?: SectionAccess | null;
  /** The workspace's subscription notice (SaaS), or null. A "danger" notice means the workspace is held. */
  billingNotice?: { tone: "danger" | "warning" | "info"; title: string; message: string } | null;
  /** Set during a RELQIVO support session (SAAS_PLATFORM_PLAN.md §12): a banner on every page. */
  supportSession?: SupportSessionBannerInfo | null;
  username: string;
  /** The signed-in person's photo for the header, or null for initials. */
  avatarUrl?: string | null;
  automationEnabled: boolean;
  automationMode: string;
  onLogout: () => Promise<void>;
  /** Permission keys this user's role grants — presentation only; see navigation.navPermissionFor. */
  grantedKeys: string[];
}) {
  const granted = useMemo(() => new Set(grantedKeys), [grantedKeys]);
  const featuresOff = useMemo(() => new Set(disabledFeatures), [disabledFeatures]);
  const pages = useMemo(() => (pageAccess ? (href: string) => canOpenPath(href, pageAccess) : undefined), [pageAccess]);
  const inWorkspace = Boolean(workspaceProjects);
  // In the workspace the sidebar offers every module that is on in ANY of the viewer's projects; one
  // that is off in THIS project opens in a project that has it (lib/workspace.ts workspaceOpenHref).
  // Global modules (Users & Permissions, Release Notes) move up to the Main Admin section.
  const { navGroups, globalGroups } = useMemo(() => {
    if (!workspaceProjects) return { navGroups: navGroupsFor(granted, featuresOff, pages), globalGroups: [] as NavGroup[] };
    const groups = navGroupsFor(granted, new Set(featuresOffEverywhere(workspaceProjects))).map((group) => ({
      ...group,
      links: group.links.map((link) => {
        const feature = featureForPath(link.href);
        return feature && featuresOff.has(feature) ? { ...link, href: workspaceOpenHref(link.href), tabs: undefined } : link;
      }),
    }));
    const isGlobal = (group: NavGroup) => group.links.every((link) => isGlobalPage(link.href));
    return { navGroups: groups.filter((g) => !isGlobal(g)), globalGroups: groups.filter(isGlobal) };
  }, [granted, featuresOff, workspaceProjects, pages]);
  const settingsSections = useMemo(() => settingsSectionsFor(granted, featuresOff, pages), [granted, featuresOff, pages]);
  const paletteLinks = useMemo(
    () =>
      ALL_NAV_LINKS.filter((link) => {
        const key = navPermissionFor(link.href);
        return (key === null || granted.has(key)) && pathAllowedByFeatures(link.href, featuresOff) && (pages === undefined || pages(link.href));
      }),
    [granted, featuresOff, pages],
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = stripProjectPrefix(usePathname());
  const navigationEpoch = useNavigationEpoch();
  const { productName } = useBranding();
  // WhatsApp Chat on a phone is a full-screen app, not a page in a card: no padding around it, and
  // nothing floating over its composer (see the content div and the floating controls below).
  // The same goes for the unified inbox, and on a desktop both fill the window: three panes in a page card
  // left the conversation itself a few letters wide.
  const isChatPage = pathname === "/chat" || pathname.startsWith("/chat/") || pathname === "/conversations" || pathname.startsWith("/conversations/");
  const phoneChat = isChatPage && !inWorkspace;
  const fullBleed = phoneChat;
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
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--tide-bg)]">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      {supportSession ? <SupportSessionBanner info={supportSession} /> : null}
      <header className="tide-field flex h-14 shrink-0 items-center gap-2 bg-[var(--tide-bg)] px-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-white/[0.08] hover:text-[color:var(--color-foreground)] lg:hidden"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        {/* The project switcher IS the header's brand: the name at the top of every page is the project being
            worked on, and the menu under it lists exactly the projects this user may enter. */}
        <div className="flex min-w-0 flex-1 lg:w-[calc(var(--sidebar-width)-1.25rem)] lg:flex-none">
          <ProjectSwitcher current={inWorkspace ? null : project} projects={switchableProjects} canViewAdmin={granted.has("projects.view")} canCreate={granted.has("projects.manage")} />
        </div>

        {/* Where am I, resolved from the nav tree, so detail routes still show the module they belong to. */}
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px] max-lg:hidden">
          {inWorkspace ? (
            <>
              <NextLink href="/admin" className="shrink-0 font-medium text-[color:var(--color-accent)] hover:underline">
                Main Admin
              </NextLink>
              <ChevronRight className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
            </>
          ) : null}
          {location && location.group !== "Dashboard" ? (
            <>
              <span className="truncate text-[color:var(--color-muted-foreground)]">{location.group}</span>
              <ChevronRight className="size-3.5 shrink-0 text-[color:var(--color-subtle-foreground)]" aria-hidden />
            </>
          ) : null}
          <span className="truncate font-medium text-[color:var(--color-foreground)]">{location?.label ?? productName}</span>
        </nav>

        <div className="hidden flex-1 lg:block" />

        <ShellSearch onOpen={() => setPaletteOpen(true)} />

        {/* The inbox has no room for a floating button over its composer, so the assistant opens from here. */}
        {isChatPage && granted.has("ai_learning.view") ? (
          <button
            type="button"
            onClick={openAiAssistant}
            aria-label="Open AI Admin Assistant"
            title="AI Admin Assistant"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-white/[0.08] hover:text-[color:var(--color-foreground)]"
          >
            <Bot className="size-[18px]" aria-hidden />
          </button>
        ) : null}

        {/* My overdue + due-today follow-ups (FOLLOW_UPS.md); in-app only, renders nothing at zero. */}
        {granted.has("messages.view") && !featuresOff.has("FOLLOW_UPS") ? <FollowUpBadge /> : null}

        <ShellUserMenu username={username} role={granted.has("projects.manage") ? "Main Admin" : undefined} onLogout={onLogout} avatarUrl={avatarUrl} />
      </header>

      <div className="flex min-h-0 flex-1">
      <Sidebar
        automationEnabled={automationEnabled}
        automationMode={automationMode}
        navGroups={navGroups}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        workspace={
          inWorkspace
            ? {
                // Users & Permissions (App Users, Permission Modules) sits under Main Admin with the portal's
                // own overview first, so every login and role is managed from one group; Release Notes
                // stays a global module. Project Members / Project Roles stay in the workspace below.
                globalGroups: globalGroups.map((g) =>
                  g.id === "users-permissions" && granted.has("users.view") ? { ...g, links: [ADMIN_USERS_OVERVIEW_LINK, ...g.links] } : g,
                ),
                mainAdminLinks: MAIN_ADMIN_LINKS.filter((l) => l.key === null || granted.has(l.key)).map(({ href, label, icon }) => ({ href, label, icon })),
              }
            : null
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-background)] lg:rounded-tl-[22px]">
          <div
            // Moving between conversations keeps the list's scroll, search and filters, and the reply box its draft.
            key={isChatPage ? "inbox" : `${pathname}#${navigationEpoch}`}
            // In the workspace the project tabs sit above the page: full-height pages (the chat
            // inbox) read this to leave room for them.
            // On a phone (below `sm`) the chat drops the page padding and fills the screen under the
            // 3.25rem top bar, so the inset there is just that bar.
            style={
              inWorkspace
                ? ({ "--chat-inset": "10rem", "--chat-inset-sm": "11.5rem" } as CSSProperties)
                : phoneChat
                  ? ({ "--chat-inset": "3.5rem", "--chat-inset-sm": "3.5rem" } as CSSProperties)
                  : undefined
            }
            data-bleed={fullBleed ? "" : undefined}
            className={fullBleed ? "group/page w-full" : `group/page mx-auto w-full ${isChatPage ? "px-5 py-7 sm:px-8" : "max-w-[var(--space-content-max)] px-4 py-6 sm:px-7 sm:py-7"}`}
          >
            {workspaceProjects && workspaceCurrent ? (
              <WorkspaceTabs projects={workspaceProjects} current={workspaceCurrent} pathname={pathname} search={searchParams} />
            ) : null}
            {billingNotice ? (
              <div className={fullBleed ? "p-3" : "mb-5"}>
                <Alert tone={billingNotice.tone} title={billingNotice.title}>
                  {billingNotice.message}
                </Alert>
              </div>
            ) : null}
            {(project.status === "SUSPENDED" && billingNotice?.tone !== "danger") || project.status === "ARCHIVED" ? (
              <div className={fullBleed ? "p-3" : "mb-5"}>
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
      </div>

      {/* Mounted only while open, so each invocation starts from an empty query. */}
      {paletteOpen ? <CommandPalette onClose={closePalette} links={paletteLinks} /> : null}
      {/* Only for roles that can use it: every send is refused without ai_learning.view, and a
          floating button on every page that always answers "not allowed" is worse than none. */}
      {granted.has("ai_learning.view") ? (
        <div className={isChatPage ? "max-sm:hidden" : undefined}>
          <FloatingAiChat hideLauncher={isChatPage} />
        </div>
      ) : null}
      {/* Long-running WhatsApp jobs stay visible on every page (Add Number to Groups, Groups Admin
          Maker). Offered to whoever may see those modules; the reader refuses everyone else anyway. */}
      {granted.has("bulk_messaging.view") && !featuresOff.has("BULK_MESSAGING") ? (
        <div className={isChatPage ? "max-sm:hidden" : undefined}>
          <WhatsAppJobCenter projectSlug={project.slug} besideAiChat={granted.has("ai_learning.view")} overInbox={isChatPage} />
        </div>
      ) : null}
    </div>
    </WorkspaceModeContext.Provider>
  );
}
