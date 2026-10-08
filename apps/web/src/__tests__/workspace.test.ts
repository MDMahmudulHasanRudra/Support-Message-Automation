import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { PROJECT_HEADER, PROJECT_PATH_HEADER, projectHref, stripProjectPrefix, WORKSPACE_HEADER } from "@/lib/projectPaths";
import {
  featuresOffEverywhere,
  isGlobalPage,
  parseWorkspacePath,
  readProjectSegment,
  safeWorkspaceTarget,
  workspaceHref,
  workspaceOpenHref,
  workspaceTabsFor,
  WORKSPACE_PROJECT_COOKIE,
  type WorkspaceProject,
} from "@/lib/workspace";
import { ALL_NAV_LINKS } from "@/app/p/[project]/(dashboard)/navigation";
import { PROJECT_FEATURES, featureForPath } from "@support-automation/shared";

/**
 * The Main Admin Workspace's URL and tab layer (MAIN_ADMIN_WORKSPACE.md §3), for EVERY module. A
 * workspace URL must carry its project to the server exactly like `/p/<slug>/…` does — from the
 * path, never from anything the client sends — and render the project's own page; the tabs must be
 * one rule applied the same way to every module. Pure: no database, no Next server.
 */

/** What proxy.ts did with a request: where it rewrote it, and the request headers it forwarded. */
function proxied(path: string, init: { headers?: Record<string, string>; method?: string } = {}) {
  const response = proxy(new NextRequest(new URL(path, "http://localhost:3000"), init));
  const read = (name: string) => response.headers.get(`x-middleware-request-${name}`);
  const rewrite = response.headers.get("x-middleware-rewrite");
  return {
    project: read(PROJECT_HEADER),
    path: read(PROJECT_PATH_HEADER),
    workspace: read(WORKSPACE_HEADER),
    rewrite: rewrite ? new URL(rewrite).pathname + new URL(rewrite).search : null,
    redirect: response.headers.get("location"),
    setCookie: response.headers.get("set-cookie") ?? "",
  };
}

const project = (slug: string, disabledFeatures: WorkspaceProject["disabledFeatures"] = [], status: WorkspaceProject["status"] = "ACTIVE"): WorkspaceProject => ({
  slug,
  name: slug,
  status,
  disabledFeatures,
});
const ISP = project("isp-digital");
const EDUFY = project("edufy", ["TEAM_REPORTS", "BULK_MESSAGING"]);
const BIZNIFY = project("biznify", ["WHATSAPP_CHAT"], "SUSPENDED");
const ALL = [ISP, EDUFY, BIZNIFY];
const slugs = (tabs: WorkspaceProject[]) => tabs.map((t) => t.slug);

describe("workspace URLs", () => {
  it("read the project and the page inside it, for any module", () => {
    expect(parseWorkspacePath("/admin/workspace/isp-digital")).toEqual({ slug: "isp-digital", projectPath: "/" });
    expect(parseWorkspacePath("/admin/workspace/isp-digital/")).toEqual({ slug: "isp-digital", projectPath: "/" });
    expect(parseWorkspacePath("/admin/workspace/edufy/chat/abc123")).toEqual({ slug: "edufy", projectPath: "/chat/abc123" });
    expect(parseWorkspacePath("/admin/workspace/edufy/rules/42/edit?x=1")).toEqual({ slug: "edufy", projectPath: "/rules/42/edit" });
    expect(parseWorkspacePath("/admin/workspace/biznify/ai-learning/knowledge-base")).toEqual({ slug: "biznify", projectPath: "/ai-learning/knowledge-base" });
  });

  it("are null for the workspace start, other admin pages, the portal and malformed slugs", () => {
    for (const path of ["/admin/workspace", "/admin/workspace?to=/chat", "/admin", "/admin/projects/x", "/p/isp-digital/chat", "/admin/workspace/ISP", "/admin/workspace/-x/chat"]) {
      expect(parseWorkspacePath(path), path).toBeNull();
    }
  });

  it("a `to=` target can only ever be a project page", () => {
    expect(safeWorkspaceTarget("/messages?decision=IGNORE")).toBe("/messages?decision=IGNORE");
    for (const bad of [null, "", "https://evil.test", "//evil.test", "/admin/projects", "/p/biznify/chat", "\\\\evil", "/x\\y", "chat"]) {
      expect(safeWorkspaceTarget(bad as string | null), String(bad)).toBe("/overview");
    }
    expect(workspaceOpenHref("/messages?decision=IGNORE")).toBe("/admin/workspace?to=%2Fmessages%3Fdecision%3DIGNORE");
  });
});

describe("links on a workspace page", () => {
  it("stay in the workspace AND in the same project, for every module", () => {
    for (const href of ["/chat/abc", "/messages?decision=IGNORE", "/groups", "/team-report", "/rules/tester", "/ai-learning/knowledge-base", "/conversation-learning", "/settings"]) {
      expect(projectHref(href, "edufy", true), href).toBe(`/admin/workspace/edufy${href}`);
    }
    expect(projectHref("/", "edufy", true)).toBe("/admin/workspace/edufy");
    expect(workspaceHref("/overview", "edufy")).toBe("/admin/workspace/edufy/overview");
  });

  it("leave outside-project and external links alone, and are unchanged outside the workspace", () => {
    expect(projectHref("/admin", "edufy", true)).toBe("/admin");
    expect(projectHref("/admin/workspace?to=/team-report", "edufy", true)).toBe("/admin/workspace?to=/team-report");
    expect(projectHref("https://example.com/chat", "edufy", true)).toBe("https://example.com/chat");
    expect(projectHref("/chat/abc", "edufy")).toBe("/p/edufy/chat/abc");
    expect(projectHref("/chat/abc", "edufy", false)).toBe("/p/edufy/chat/abc");
  });

  it("the active-state helper sees the page inside the project", () => {
    expect(stripProjectPrefix("/admin/workspace/edufy/chat/abc")).toBe("/chat/abc");
    expect(stripProjectPrefix("/admin/workspace/edufy")).toBe("/");
    expect(stripProjectPrefix("/p/edufy/chat/abc")).toBe("/chat/abc");
  });
});

describe("project tabs: one rule for every module", () => {
  it("WhatsApp Chat: every project with WhatsApp Chat on", () => {
    expect(slugs(workspaceTabsFor(ALL, "/chat"))).toEqual(["isp-digital", "edufy"]);
    expect(slugs(workspaceTabsFor(ALL, "/chat/some-group-id"))).toEqual(["isp-digital", "edufy"]);
  });

  it("Reports and Bulk Messaging: a project with the feature off gets no tab", () => {
    expect(slugs(workspaceTabsFor(ALL, "/team-report"))).toEqual(["isp-digital", "biznify"]);
    expect(slugs(workspaceTabsFor(ALL, "/group-message-sender/history"))).toEqual(["isp-digital", "biznify"]);
  });

  it("modules without a feature flag (Messages, Groups, Rules, Settings, Overview) show every project the viewer may enter", () => {
    for (const path of ["/overview", "/messages", "/groups", "/rules", "/rules/tester", "/automation-control", "/settings", "/notifications", "/logs"]) {
      expect(slugs(workspaceTabsFor(ALL, path)), path).toEqual(["isp-digital", "edufy", "biznify"]);
    }
  });

  it("global pages have no tabs at all", () => {
    for (const path of ["/users", "/users/abc/edit", "/permissions", "/settings/security", "/release-notes", "/release-notes/manage"]) {
      expect(isGlobalPage(path), path).toBe(true);
      expect(workspaceTabsFor(ALL, path), path).toEqual([]);
    }
    expect(isGlobalPage("/settings")).toBe(false);
    expect(isGlobalPage("/users-report")).toBe(false);
  });

  it("the status travels with the tab, so a suspended project shows as such", () => {
    expect(workspaceTabsFor(ALL, "/rules").find((t) => t.slug === "biznify")?.status).toBe("SUSPENDED");
  });

  it("never invents a project: the tabs are always a subset of what the server said the viewer may enter", () => {
    for (const link of ALL_NAV_LINKS) {
      const tabs = workspaceTabsFor([EDUFY], link.href);
      expect(tabs.every((t) => t.slug === "edufy"), link.href).toBe(true);
    }
    expect(workspaceTabsFor([], "/chat")).toEqual([]);
  });

  it("every feature's pages lose exactly that project's tab", () => {
    for (const feature of PROJECT_FEATURES) {
      for (const route of feature.routes.filter((r) => !r.startsWith("/api/"))) {
        const off = project("off", [feature.key]);
        expect(slugs(workspaceTabsFor([ISP, off], route)), `${feature.key} ${route}`).toEqual(["isp-digital"]);
      }
    }
  });

  it("the sidebar only drops a module when it is off in EVERY project", () => {
    expect(featuresOffEverywhere(ALL)).toEqual([]);
    expect(featuresOffEverywhere([EDUFY, project("x", ["BULK_MESSAGING"])])).toEqual(["BULK_MESSAGING"]);
    expect(featuresOffEverywhere([])).toEqual([]);
  });

  it("every project module in the navigation is covered: a project page or a declared global one", () => {
    const pages = ALL_NAV_LINKS.map((l) => l.href.split("?")[0]!);
    const global = pages.filter(isGlobalPage);
    expect(global.sort()).toEqual(["/permissions", "/release-notes", "/release-notes/manage", "/settings/security", "/users"]);
    // Every other page gets tabs from the same function, filtered by its own feature.
    for (const page of pages.filter((p) => !isGlobalPage(p))) {
      const feature = featureForPath(page);
      expect(workspaceTabsFor([ISP], page).length, page).toBe(1);
      if (feature) expect(workspaceTabsFor([project("off", [feature])], page), page).toEqual([]);
    }
  });
});

describe("proxy: a workspace URL renders the project page, with the project from the URL", () => {
  it("rewrites to the project page and sets the project headers from the path", () => {
    const r = proxied("/admin/workspace/edufy/chat/abc?filter=waiting");
    expect(r).toMatchObject({ project: "edufy", path: "/chat/abc", workspace: "1", rewrite: "/p/edufy~ws/chat/abc?filter=waiting", redirect: null });
    expect(r.setCookie).toContain(`${WORKSPACE_PROJECT_COOKIE}=edufy`);
    expect(proxied("/admin/workspace/edufy")).toMatchObject({ project: "edufy", path: "/", rewrite: "/p/edufy~ws" });
    expect(proxied("/admin/workspace/biznify/rules/42/edit")).toMatchObject({ project: "biznify", path: "/rules/42/edit", rewrite: "/p/biznify~ws/rules/42/edit" });
  });

  it("a Server Action POST is rewritten the same way, carrying the project of the page it was posted to", () => {
    expect(proxied("/admin/workspace/edufy/chat/abc", { method: "POST" })).toMatchObject({ project: "edufy", path: "/chat/abc", rewrite: "/p/edufy~ws/chat/abc" });
  });

  it("discards project and workspace headers the client sent, everywhere", () => {
    const forged = { [PROJECT_HEADER]: "isp-digital", [PROJECT_PATH_HEADER]: "/rules", [WORKSPACE_HEADER]: "1" };
    expect(proxied("/admin/workspace/edufy/chat", { headers: forged })).toMatchObject({ project: "edufy", path: "/chat", workspace: "1" });
    for (const path of ["/admin", "/admin/projects", "/admin/workspace", "/admin/workspace?to=/chat"]) {
      expect(proxied(path, { headers: forged }), path).toMatchObject({ project: null, path: null, workspace: null, rewrite: null });
    }
    // The portal never carries the workspace flag, even when the client sends it.
    expect(proxied("/p/edufy/chat", { headers: forged })).toMatchObject({ project: "edufy", path: "/chat", workspace: null, rewrite: null });
  });

  it("the rewritten route is never a way in by itself: requested directly it carries no project", () => {
    expect(readProjectSegment("edufy~ws")).toEqual({ slug: "edufy", workspace: true });
    expect(readProjectSegment("edufy%7Ews")).toEqual({ slug: "edufy", workspace: true });
    expect(readProjectSegment("edufy")).toEqual({ slug: "edufy", workspace: false });
    expect(proxied("/p/edufy~ws/chat", { headers: { [PROJECT_HEADER]: "edufy", [WORKSPACE_HEADER]: "1" } })).toMatchObject({ project: null, workspace: null, rewrite: null });
  });

  it("the remembered workspace project never becomes a request's project", () => {
    expect(proxied("/admin/workspace?to=/chat", { headers: { cookie: `${WORKSPACE_PROJECT_COOKIE}=edufy` } }).project).toBeNull();
  });
});
