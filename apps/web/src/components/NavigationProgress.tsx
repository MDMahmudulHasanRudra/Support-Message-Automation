"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { finishNavigation, startNavigation, useNavigationEpoch, usePendingNavigation } from "@/lib/navigationPending";

/** Around a page's content, where the shell has no page key of its own: see PendingNavigation.remount. */
export function PageEpoch({ children }: { children: ReactNode }) {
  return <Fragment key={useNavigationEpoch()}>{children}</Fragment>;
}

/** A download or file, which must stay an ordinary browser request. */
function isFileAddress(url: URL): boolean {
  return url.pathname.includes("/api/") || /\.[a-z0-9]{2,5}$/i.test(url.pathname);
}

const here = () => window.location.pathname + window.location.search;

/**
 * Every page change in every portal goes through here, so none of them reloads the page.
 *
 * - A plain `<a href>` (ButtonLink, in 300+ places) and a GET filter or search form (24 pages) used to be a
 *   full page load: a white flash and all the JavaScript again. They now navigate in place. Both still work
 *   without JavaScript, because the markup is unchanged and these are only listeners.
 * - The bar appears only if the next page takes more than a moment, so a fast click shows nothing at all.
 */
export function NavigationProgress() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const pending = usePendingNavigation();

  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  // Before paint: a page that must start afresh is remounted without showing its old fields for a frame.
  useLayoutEffect(() => {
    finishNavigation();
  }, [pathname, search]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || isFileAddress(url)) return;
      const target = url.pathname + url.search;
      if (target === here()) return;
      // next/link has already taken a click it handles; anything else would be a full page load.
      const plainLink = !event.defaultPrevented;
      if (plainLink) {
        event.preventDefault();
        routerRef.current.push(target + url.hash);
      }
      startNavigation({
        target,
        navItem: anchor.hasAttribute("data-nav-item"),
        remount: plainLink && url.pathname === window.location.pathname,
      });
    };

    const onSubmit = (event: SubmitEvent) => {
      if (event.defaultPrevented) return;
      const form = event.target as HTMLFormElement;
      if (form.getAttribute("method")?.toLowerCase() !== "get") return;
      const opensElsewhere = form.getAttribute("target");
      if (opensElsewhere && opensElsewhere !== "_self") return;
      const url = new URL(form.getAttribute("action") ?? "", window.location.href);
      if (url.origin !== window.location.origin || isFileAddress(url)) return;
      const query = new URLSearchParams();
      new FormData(form, event.submitter).forEach((value, key) => {
        if (typeof value === "string") query.append(key, value);
      });
      const qs = query.toString();
      const target = url.pathname + (qs ? `?${qs}` : "");
      event.preventDefault();
      if (target === here()) {
        routerRef.current.refresh();
        return;
      }
      routerRef.current.push(target);
      startNavigation({ target, navItem: false, remount: url.pathname === window.location.pathname });
    };

    document.addEventListener("click", onClick);
    document.addEventListener("submit", onSubmit);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("submit", onSubmit);
    };
  }, []);

  return pending ? <div className="nav-progress" aria-hidden /> : null;
}
