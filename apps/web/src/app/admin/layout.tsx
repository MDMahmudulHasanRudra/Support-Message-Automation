import { requireMainAdminPage } from "@/server/mainAdmin";
import { accessibleProjects } from "@/server/projectContext";
import { getGrantedPermissionKeys } from "@/server/permissions";
import { logout } from "@/server/actions/session";
import { AdminShell } from "./AdminShell";
import type { Metadata } from "next";
import { getBranding } from "@/server/branding";
import { headerAvatarUrl } from "@/server/account";

export async function generateMetadata(): Promise<Metadata> {
  const { productName } = await getBranding();
  return { title: { default: "Main Admin", template: `%s · Main Admin · ${productName}` } };
}

/**
 * A customer's own Main Admin Portal (MULTI_PROJECT_PLAN.md §8; SAAS_PLATFORM_PLAN.md §12), at /admin
 * — outside every project, inside one customer's software: its projects, users and roles only. Needs
 * `projects.view`; without it the portal is a 404, like a project the user cannot enter. The RELQIVO
 * platform is a separate area (/platform) with its own sign-in.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { session, canManage } = await requireMainAdminPage();
  const [projects, grantedKeys, avatarUrl] = await Promise.all([accessibleProjects(session.userId), getGrantedPermissionKeys(session), headerAvatarUrl(session.userId)]);
  return (
    <AdminShell
      username={session.username}
      projects={projects.map(({ name, slug, status }) => ({ name, slug, status }))}
      canCreate={canManage}
      grantedKeys={grantedKeys}
      avatarUrl={avatarUrl}
      onLogout={logout}
      supportSession={session.support ? { operatorUsername: session.support.operatorUsername, reason: session.support.reason, expiresAt: session.support.expiresAt.toISOString() } : null}
    >
      {children}
    </AdminShell>
  );
}
