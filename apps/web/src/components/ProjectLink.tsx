"use client";

import NextLink from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { projectHref } from "@/lib/projectPaths";
import { parseWorkspacePath, readProjectSegment } from "@/lib/workspace";

/**
 * The current page's project slug, from the `[project]` route segment (null outside a project).
 * A Main Admin Workspace URL is rewritten to the same `/p/[project]` route (proxy.ts), so the
 * segment carries the project there too.
 */
export function useProjectSlug(): string | null {
  const params = useParams<{ project?: string }>();
  return typeof params?.project === "string" ? readProjectSegment(params.project).slug : null;
}

/**
 * Set by the dashboard shell when the page is shown in the Main Admin Workspace (the server knows
 * from the proxy's header). The browser path is checked too, so a link rendered outside the shell on
 * a workspace page still stays in the workspace.
 */
export const WorkspaceModeContext = createContext(false);

/** Whether this page is shown in the Main Admin Workspace rather than the project portal. */
export function useInWorkspace(): boolean {
  const fromShell = useContext(WorkspaceModeContext);
  const pathname = usePathname();
  const params = useParams<{ project?: string }>();
  const fromSegment = typeof params?.project === "string" && readProjectSegment(params.project).workspace;
  return fromShell || fromSegment || (pathname ? parseWorkspacePath(pathname) !== null : false);
}

/** Prefixes a project-relative path with the current project — see lib/projectPaths.ts. */
export function useProjectHref(): (href: string) => string {
  const slug = useProjectSlug();
  const workspace = useInWorkspace();
  return (href) => projectHref(href, slug, workspace);
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
  const workspace = useInWorkspace();
  // Memoised: callers put the router in effect dependency lists, and a new object every render
  // would re-run those effects on every render.
  return useMemo(
    () => ({
      ...router,
      push: (href, options) => router.push(projectHref(href, slug, workspace), options),
      replace: (href, options) => router.replace(projectHref(href, slug, workspace), options),
      prefetch: (href, options) => router.prefetch(projectHref(href, slug, workspace), options),
    }),
    [router, slug, workspace],
  );
}
