import { headers } from "next/headers";
import { projectHref, WORKSPACE_MODULE_HEADER } from "@/lib/projectPaths";
import { activeProjectSlug } from "@/server/projectContext";

/**
 * A project-relative path ("/rules") as a real URL in the CURRENT request's project
 * ("/p/isp-digital/rules"), for `redirect()` and `revalidatePath()`:
 *
 *     redirect(await projectPath("/team-members"));
 *     revalidatePath(await projectPath("/rules"));
 *
 * Next's own functions are kept (they are synchronous, and `redirect` returning `never` is what
 * lets TypeScript narrow after it); only the path is resolved first. Outside a project — sign-in —
 * the path is returned unchanged. Inside a Main Admin Workspace module the module's own paths stay
 * in the workspace (lib/workspace.ts); the project is the same either way.
 */
export async function projectPath(path: string): Promise<string> {
  return projectHref(path, await activeProjectSlug(), await workspaceModuleKey());
}

async function workspaceModuleKey(): Promise<string | null> {
  try {
    return (await headers()).get(WORKSPACE_MODULE_HEADER);
  } catch {
    return null; // after() work and tests have no request: plain project URLs
  }
}
