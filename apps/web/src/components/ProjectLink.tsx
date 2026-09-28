"use client";

import NextLink from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, type ComponentProps } from "react";
import { projectHref } from "@/lib/projectPaths";

/** The current page's project slug, from the `/p/[project]` route segment (null outside a project). */
export function useProjectSlug(): string | null {
  const params = useParams<{ project?: string }>();
  return typeof params?.project === "string" ? params.project : null;
}

/** Prefixes a project-relative path with the current project — see lib/projectPaths.ts. */
export function useProjectHref(): (href: string) => string {
  const slug = useProjectSlug();
  return (href) => projectHref(href, slug);
}

/**
 * `next/link`, but a project-relative href ("/rules") resolves inside the CURRENT project. Every
 * link in the app goes through this, including hrefs that arrive as data (navigation, dashboard
 * tiles, report rows), so none of them can point into a project other than the one rendered.
 */
export default function Link({ href, ...props }: ComponentProps<typeof NextLink>) {
  const slug = useProjectSlug();
  const resolved =
    typeof href === "string"
      ? projectHref(href, slug)
      : href && typeof href === "object" && typeof href.pathname === "string"
        ? { ...href, pathname: projectHref(href.pathname, slug) }
        : href;
  return <NextLink href={resolved} {...props} />;
}

/** `useRouter`, with `push`/`replace`/`prefetch` resolving project-relative paths the same way. */
export function useProjectRouter(): ReturnType<typeof useRouter> {
  const router = useRouter();
  const slug = useProjectSlug();
  // Memoised: callers put the router in effect dependency lists, and a new object every render
  // would re-run those effects on every render.
  return useMemo(
    () => ({
      ...router,
      push: (href, options) => router.push(projectHref(href, slug), options),
      replace: (href, options) => router.replace(projectHref(href, slug), options),
      prefetch: (href, options) => router.prefetch(projectHref(href, slug), options),
    }),
    [router, slug],
  );
}
