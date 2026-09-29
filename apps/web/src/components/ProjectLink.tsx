"use client";

import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useMemo, type ComponentProps } from "react";
import { projectHref } from "@/lib/projectPaths";
import { parseWorkspacePath } from "@/lib/workspace";

/**
 * The current page's project slug, from the `[project]` route segment (null outside a project).
 * The segment is `/p/[project]` in the project portal and `/admin/workspace/<module>/[project]` in
 * the Main Admin Workspace; proxy.ts reads the same segment for the server.
 */
export function useProjectSlug(): string | null {
  const params = useParams<{ project?: string }>();
  return typeof params?.project === "string" ? params.project : null;
}

/** The Main Admin Workspace module this page is shown in, or null in the project portal. */
function useWorkspaceModuleKey(): string | null {
  const pathname = usePathname();
  return pathname ? (parseWorkspacePath(pathname)?.module.key ?? null) : null;
}

/** Prefixes a project-relative path with the current project — see lib/projectPaths.ts. */
export function useProjectHref(): (href: string) => string {
  const slug = useProjectSlug();
  const workspaceModule = useWorkspaceModuleKey();
  return (href) => projectHref(href, slug, workspaceModule);
}

/**
 * `next/link`, but a project-relative href ("/rules") resolves inside the CURRENT project. Every
 * link in the app goes through this, including hrefs that arrive as data (navigation, dashboard
 * tiles, report rows), so none of them can point into a project other than the one rendered.
 */
export default function Link({ href, ...props }: ComponentProps<typeof NextLink>) {
  const toProject = useProjectHref();
  const resolved =
    typeof href === "string"
      ? toProject(href)
      : href && typeof href === "object" && typeof href.pathname === "string"
        ? { ...href, pathname: toProject(href.pathname) }
        : href;
  return <NextLink href={resolved} {...props} />;
}

/** `useRouter`, with `push`/`replace`/`prefetch` resolving project-relative paths the same way. */
export function useProjectRouter(): ReturnType<typeof useRouter> {
  const router = useRouter();
  const slug = useProjectSlug();
  const workspaceModule = useWorkspaceModuleKey();
  // Memoised: callers put the router in effect dependency lists, and a new object every render
  // would re-run those effects on every render.
  return useMemo(
    () => ({
      ...router,
      push: (href, options) => router.push(projectHref(href, slug, workspaceModule), options),
      replace: (href, options) => router.replace(projectHref(href, slug, workspaceModule), options),
      prefetch: (href, options) => router.prefetch(projectHref(href, slug, workspaceModule), options),
    }),
    [router, slug, workspaceModule],
  );
}
