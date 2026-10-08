import { headers } from "next/headers";
import { projectHref, WORKSPACE_HEADER } from "@/lib/projectPaths";
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
 * the path is returned unchanged. A request that came through the Main Admin Workspace stays in it
 * (lib/workspace.ts); the project is the same either way.
 */
export async function projectPath(path: string): Promise<string> {
  return projectHref(path, await activeProjectSlug(), await inWorkspace());
}

/** Whether this request came through the Main Admin Workspace (proxy.ts sets the header; clients cannot). */
export async function inWorkspace(): Promise<boolean> {
  try {
    return (await headers()).get(WORKSPACE_HEADER) === "1";
  } catch {
    return false; // after() work and tests have no request: plain project URLs
  }
}
