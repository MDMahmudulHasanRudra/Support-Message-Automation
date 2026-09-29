import type { ProjectStatusValue } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import { hasPermission } from "@/server/permissions";
import { accessibleProjects } from "@/server/projectContext";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import type { WorkspaceModuleDefinition } from "@/lib/workspace";

/**
 * Which projects a Main Admin Workspace module shows as tabs (MAIN_ADMIN_WORKSPACE.md §3).
 *
 *     user → may enter the project → the project has the module's feature → the existing permission
 *
 * Each step can only remove a tab, and none of them is new: `accessibleProjects` is what the project
 * switcher lists, `disabledFeaturesFor` is what hides a module's nav link, `hasPermission` is the
 * permission check every page makes. The tabs are presentation. Opening one still runs the module's
 * own page checks in that project, so a tab that should not exist would still refuse.
 */

export interface WorkspaceTab {
  slug: string;
  name: string;
  status: ProjectStatusValue;
}

export type WorkspaceTabs =
  | { ok: true; tabs: WorkspaceTab[] }
  /** The viewer's role does not include the module's permission — in any project, since roles are not per project. */
  | { ok: false; reason: "NO_PERMISSION" };

export async function workspaceTabs(session: Session, mod: WorkspaceModuleDefinition): Promise<WorkspaceTabs> {
  if (!(await hasPermission(session, mod.permission))) return { ok: false, reason: "NO_PERMISSION" };
  const projects = await accessibleProjects(session.userId);
  const tabs: WorkspaceTab[] = [];
  for (const project of projects) {
    if ((await disabledFeaturesFor(project.id)).has(mod.feature)) continue;
    tabs.push({ slug: project.slug, name: project.name, status: project.status });
  }
  return { ok: true, tabs };
}
