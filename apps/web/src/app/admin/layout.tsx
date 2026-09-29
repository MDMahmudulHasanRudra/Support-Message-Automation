import { requireMainAdminPage } from "@/server/mainAdmin";
import { accessibleProjects } from "@/server/projectContext";
import { logout } from "@/server/actions/session";
import { AdminShell } from "./AdminShell";

export const metadata = { title: { default: "Main Admin", template: "%s · Main Admin · Softify Assist" } };

/**
 * The Main Admin Portal (MULTI_PROJECT_PLAN.md §8), at /admin — outside every project. Needs
 * `projects.view`; without it the portal is a 404, like a project the user cannot enter.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { session, canManage } = await requireMainAdminPage();
  const projects = await accessibleProjects(session.userId);
  return (
    <AdminShell
      username={session.username}
      projects={projects.map(({ name, slug, status }) => ({ name, slug, status }))}
      canCreate={canManage}
      onLogout={logout}
    >
      {children}
    </AdminShell>
  );
}
