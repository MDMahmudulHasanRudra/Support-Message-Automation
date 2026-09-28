import { projectHref } from "@/lib/projectPaths";
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
 * the path is returned unchanged.
 */
export async function projectPath(path: string): Promise<string> {
  return projectHref(path, await activeProjectSlug());
}
