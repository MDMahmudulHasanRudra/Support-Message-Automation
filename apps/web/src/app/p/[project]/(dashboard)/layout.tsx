import { requireAdminPortalHost } from "@/server/hostScope";
import { workspaceBillingNotice } from "@/server/platform/billing";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { requireSession } from "@/server/auth";
import { requireProjectPage } from "@/server/authorize";
import { getGrantedPermissionKeys, getPageAccess } from "@/server/permissions";
import { logout } from "@/server/actions/session";
import { accessibleProjects, activeProjectSlug } from "@/server/projectContext";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import { inWorkspace } from "@/server/projectPaths";
import { workspaceProjects } from "@/server/workspace";
import { WORKSPACE_BASE } from "@/lib/workspace";

import { DashboardShell } from "./DashboardShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  // The Main Admin Workspace (MAIN_ADMIN_WORKSPACE.md) renders THIS layout and the project's own
  // pages — proxy.ts rewrites /admin/workspace/<slug>/… here. It is part of the Main Admin Portal,
  // so it needs the portal's key; and a project that is no longer one of the viewer's (access
  // removed, archived, never theirs) goes back to the workspace start rather than to a 404 that
  // would strand them outside the portal. Both are decided BEFORE the project step below, which
  // then runs exactly as it does in the portal.
  const workspace = await inWorkspace();
  let workspaceTabs = null;
  if (workspace) {
    // The Workspace is part of the portal: never on a customer's or an unknown address (SaaS §3.3).
    await requireAdminPortalHost();
    const granted = new Set(await getGrantedPermissionKeys(session));
    if (!granted.has("projects.view")) notFound();
    workspaceTabs = await workspaceProjects(session);
    const slug = await activeProjectSlug();
    if (!workspaceTabs.some((p) => p.slug === slug)) redirect(`${WORKSPACE_BASE}?unavailable=1`);
  }

  // The project step before anything else renders: a project this user cannot enter is a 404,
  // whatever the page below would have shown (MULTI_PROJECT_PLAN.md §7).
  const project = await requireProjectPage();
  const [settings, grantedKeys, switchable, disabledFeatures, pageAccess] = await Promise.all([
    prisma.automationSettings.findUnique({ where: { id: "global" } }),
    // For what the shell SHOWS — which links, whether the assistant. Every page and action still
    // makes its own check; this only stops the sidebar offering pages that would refuse.
    getGrantedPermissionKeys(session),
    // What the project switcher lists: exactly the projects this user may enter.
    accessibleProjects(session.userId),
    // Modules this project is not entitled to (MULTI_PROJECT_PLAN.md §9) — hidden from the nav.
    activeDisabledFeatures(),
    // The pages this member's project role opens (PROJECT_ROLES.md), or null — keys alone decide.
    getPageAccess(session),
  ]);

  // SaaS (SAAS_PLATFORM_PLAN.md §10, §12): a held workspace tells everybody why nothing saves;
  // "payment due" and "ends soon" go to the people who can act on them — the customer's Main Admins.
  const billingNotice = await workspaceBillingNotice(project.id, grantedKeys.includes("projects.manage"));

  return (
    <DashboardShell
      billingNotice={billingNotice}
      supportSession={session.support ? { operatorUsername: session.support.operatorUsername, reason: session.support.reason, expiresAt: session.support.expiresAt.toISOString() } : null}
      username={session.username}
      automationEnabled={Boolean(settings?.automationEnabled)}
      automationMode={settings?.mode ?? "SAFE_AUTO_REPLY"}
      onLogout={logout}
      grantedKeys={grantedKeys}
      project={{ name: project.name, slug: project.slug, status: project.status }}
      switchableProjects={switchable.map(({ name, slug, status }) => ({ name, slug, status }))}
      disabledFeatures={[...disabledFeatures]}
      pageAccess={pageAccess}
      workspaceProjects={workspaceTabs}
    >
      {children}
    </DashboardShell>
  );
}
