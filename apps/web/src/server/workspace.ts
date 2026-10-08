import { cookies } from "next/headers";
import { featureForPath, isPermissionKey } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { accessibleProjects } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { navPermissionFor } from "@/app/p/[project]/(dashboard)/navigation";
import { WORKSPACE_PROJECT_COOKIE, workspaceTabsFor, type WorkspaceProject } from "@/lib/workspace";

/**
 * The Main Admin Workspace's projects (MAIN_ADMIN_WORKSPACE.md §3):
 *
 *     user → may enter the project → the page's feature is on there → the existing permission
 *
 * `accessibleProjects` is exactly what the project switcher lists (access rows, or every project for
 * a Main Admin; never an archived one), and `disabledFeaturesFor` is what already hides a module's
 * nav link. Nothing here is new authority: it decides which tabs are DRAWN. Opening one runs the
 * project page's own checks in that project.
 */
export async function workspaceProjects(session: Session): Promise<WorkspaceProject[]> {
  const projects = await accessibleProjects(session.userId);
  return Promise.all(
    projects.map(async (project) => ({
      slug: project.slug,
      name: project.name,
      status: project.status,
      disabledFeatures: [...(await disabledFeaturesFor(project.id))],
    })),
  );
}

/**
 * Which project a workspace page opens in when the Main Admin sidebar asks for it: the remembered
 * project if this page can open there, otherwise the first project that can. Null when none can —
 * the role lacks the page's permission, or no project the viewer may enter has the module on.
 */
export async function chooseWorkspaceProject(session: Session, projectPath: string): Promise<WorkspaceProject | null> {
  const key = navPermissionFor(projectPath);
  if (key && isPermissionKey(key) && !(await hasPermission(session, key))) return null;
  const projects = await workspaceProjects(session);
  // A global page opens in any project the viewer may enter: its data is the same in all of them.
  const candidates = featureForPath(projectPath) ? workspaceTabsFor(projects, projectPath) : projects;
  if (candidates.length === 0) return null;
  const remembered = await rememberedProject();
  return candidates.find((p) => p.slug === remembered) ?? candidates[0]!;
}

async function rememberedProject(): Promise<string | undefined> {
  try {
    return (await cookies()).get(WORKSPACE_PROJECT_COOKIE)?.value;
  } catch {
    return undefined; // no request (tests): nothing remembered
  }
}
