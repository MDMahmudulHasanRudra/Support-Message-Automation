import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { PROJECT_HEADER, PROJECT_PATH_HEADER, projectHref, stripProjectPrefix, WORKSPACE_MODULE_HEADER } from "@/lib/projectPaths";
import { parseWorkspacePath, workspaceHref, WORKSPACE_MODULES, WORKSPACE_PROJECT_COOKIE } from "@/lib/workspace";
import { featureForPath, isPermissionKey, isProjectFeatureKey } from "@support-automation/shared";

/**
 * The Main Admin Workspace's URL layer (MAIN_ADMIN_WORKSPACE.md §3). A workspace URL must carry its
 * project to the server EXACTLY like `/p/<slug>/…` does — from the path, never from anything the
 * client sends — and the links rendered inside a workspace module must stay in the same project.
 * Pure: no database, no Next server.
 */

/** The request headers proxy.ts forwarded, as Next encodes them on the middleware response. */
function forwarded(path: string, init: { headers?: Record<string, string>; method?: string } = {}) {
  const response = proxy(new NextRequest(new URL(path, "http://localhost:3000"), init));
  const read = (name: string) => response.headers.get(`x-middleware-request-${name}`);
  return {
    project: read(PROJECT_HEADER),
    path: read(PROJECT_PATH_HEADER),
    module: read(WORKSPACE_MODULE_HEADER),
    redirect: response.headers.get("location"),
    setCookie: response.headers.get("set-cookie") ?? "",
  };
}

describe("parseWorkspacePath", () => {
  it("reads the module, the project and the module's own path", () => {
    expect(parseWorkspacePath("/admin/workspace/whatsapp-chat/isp-digital")).toMatchObject({ slug: "isp-digital", projectPath: "/chat" });
    expect(parseWorkspacePath("/admin/workspace/whatsapp-chat/isp-digital/")).toMatchObject({ projectPath: "/chat" });
    expect(parseWorkspacePath("/admin/workspace/whatsapp-chat/bizify/abc123")).toMatchObject({ slug: "bizify", projectPath: "/chat/abc123" });
    expect(parseWorkspacePath("/admin/workspace/whatsapp-chat/bizify/archived?x=1")).toMatchObject({ projectPath: "/chat/archived" });
    expect(parseWorkspacePath("/admin/workspace/whatsapp-chat/isp-digital")?.module.key).toBe("whatsapp-chat");
  });

  it("is null for anything that is not a listed module in a well-formed project", () => {
    for (const path of [
      "/admin/workspace/whatsapp-chat", // the start page: no project
      "/admin/workspace/rules/isp-digital", // not a workspace module
      "/admin/workspace/whatsapp-chat/ISP", // not a slug
      "/admin/workspace/whatsapp-chat/-x",
      "/admin/projects/isp-digital",
      "/p/isp-digital/chat",
      "/admin/workspace",
    ]) {
      expect(parseWorkspacePath(path), path).toBeNull();
    }
  });

  it("every module names a real feature, a real permission and a real feature route", () => {
    for (const mod of WORKSPACE_MODULES) {
      expect(isProjectFeatureKey(mod.feature)).toBe(true);
      expect(isPermissionKey(mod.permission)).toBe(true);
      // The module's pages must belong to its feature, or switching the feature off would not close the workspace page.
      expect(featureForPath(mod.projectPath)).toBe(mod.feature);
    }
  });
});

describe("links inside a workspace module", () => {
  it("keep the module's own pages in the workspace, in the same project", () => {
    expect(projectHref("/chat", "bizify", "whatsapp-chat")).toBe("/admin/workspace/whatsapp-chat/bizify");
    expect(projectHref("/chat/abc", "bizify", "whatsapp-chat")).toBe("/admin/workspace/whatsapp-chat/bizify/abc");
    expect(projectHref("/chat/archived", "bizify", "whatsapp-chat")).toBe("/admin/workspace/whatsapp-chat/bizify/archived");
    expect(projectHref("/chat?filter=waiting", "bizify", "whatsapp-chat")).toBe("/admin/workspace/whatsapp-chat/bizify?filter=waiting");
  });

  it("send every other page to the SAME project's portal", () => {
    expect(projectHref("/groups", "bizify", "whatsapp-chat")).toBe("/p/bizify/groups");
    expect(projectHref("/messages?group=x", "bizify", "whatsapp-chat")).toBe("/p/bizify/messages?group=x");
    // A path that merely starts with the same letters is not the module.
    expect(projectHref("/chatter", "bizify", "whatsapp-chat")).toBe("/p/bizify/chatter");
    expect(workspaceHref("/chatter", "bizify", "whatsapp-chat")).toBeNull();
  });

  it("leave outside-project and external links alone, and behave exactly as before without a module", () => {
    expect(projectHref("/admin", "bizify", "whatsapp-chat")).toBe("/admin");
    expect(projectHref("https://example.com/chat", "bizify", "whatsapp-chat")).toBe("https://example.com/chat");
    expect(projectHref("/chat/abc", "bizify")).toBe("/p/bizify/chat/abc");
    expect(projectHref("/chat/abc", "bizify", "not-a-module")).toBe("/p/bizify/chat/abc");
  });

  it("the active-state helper sees the module's path inside the project", () => {
    expect(stripProjectPrefix("/admin/workspace/whatsapp-chat/bizify/abc")).toBe("/chat/abc");
    expect(stripProjectPrefix("/admin/workspace/whatsapp-chat/bizify")).toBe("/chat");
    expect(stripProjectPrefix("/p/bizify/chat/abc")).toBe("/chat/abc");
  });
});

describe("proxy: a workspace URL carries its project exactly like /p/<slug>/…", () => {
  it("sets the project, the path inside it and the module, from the URL", () => {
    const f = forwarded("/admin/workspace/whatsapp-chat/bizify/abc");
    expect(f).toMatchObject({ project: "bizify", path: "/chat/abc", module: "whatsapp-chat" });
    expect(f.setCookie).toContain(`${WORKSPACE_PROJECT_COOKIE}=bizify`);
  });

  it("a Server Action POST carries the project of the page it was posted to", () => {
    expect(forwarded("/admin/workspace/whatsapp-chat/bizify/abc", { method: "POST" })).toMatchObject({ project: "bizify", path: "/chat/abc" });
  });

  it("discards project headers the client sent, on workspace URLs and everywhere else", () => {
    const forged = { [PROJECT_HEADER]: "isp-digital", [PROJECT_PATH_HEADER]: "/rules", [WORKSPACE_MODULE_HEADER]: "whatsapp-chat" };
    expect(forwarded("/admin/workspace/whatsapp-chat/bizify", { headers: forged })).toMatchObject({ project: "bizify", path: "/chat", module: "whatsapp-chat" });
    // Outside a workspace module nothing is forwarded at all — the forged copies included.
    for (const path of ["/admin", "/admin/projects", "/admin/workspace/whatsapp-chat", "/admin/workspace/rules/isp-digital"]) {
      expect(forwarded(path, { headers: forged }), path).toMatchObject({ project: null, path: null, module: null });
    }
  });

  it("the project portal is unchanged", () => {
    expect(forwarded("/p/bizify/chat/abc")).toMatchObject({ project: "bizify", path: "/chat/abc", module: null });
  });

  it("the remembered workspace project never becomes the request's project", () => {
    const f = forwarded("/admin/workspace/whatsapp-chat", { headers: { cookie: `${WORKSPACE_PROJECT_COOKIE}=bizify` } });
    expect(f.project).toBeNull();
  });
});
