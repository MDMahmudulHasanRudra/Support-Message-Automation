import { describe, expect, it } from "vitest";
import {
  allowedProjectTransitions,
  canTransitionProject,
  isOperatingProjectStatus,
  isReadOnlyProjectStatus,
  PROJECT_STATUSES,
  suggestProjectSlug,
  validateProjectName,
  validateProjectSlug,
} from "../projects.js";
import { MAIN_ADMIN_CATEGORY, PERMISSIONS, READ_ONLY_PERMISSION_KEYS, SUPPORT_AGENT_PERMISSION_KEYS, SUPPORT_MANAGER_PERMISSION_KEYS } from "../permissions.js";
import {
  disabledProjectFeatures,
  featureForPath,
  featureForPermissionKey,
  pathAllowedByFeatures,
  PROJECT_FEATURES,
  resolveProjectFeatures,
} from "../projectFeatures.js";

describe("project slugs", () => {
  it("accepts the existing project and ordinary slugs", () => {
    for (const slug of ["isp-digital", "bizify", "acme-2", "a1"]) expect(validateProjectSlug(slug)).toBeNull();
  });

  it("refuses characters a URL segment should not carry, and hyphens at the edges or doubled", () => {
    for (const slug of ["ISP-Digital", "isp_digital", "isp digital", "-bizify", "bizify-", "biz--ify", "bízify", "b"]) {
      expect(validateProjectSlug(slug)).not.toBeNull();
    }
  });

  it("refuses an empty slug and one longer than 48", () => {
    expect(validateProjectSlug("")).not.toBeNull();
    expect(validateProjectSlug("a".repeat(49))).not.toBeNull();
    expect(validateProjectSlug("a".repeat(48))).toBeNull();
  });

  it("refuses reserved words", () => {
    for (const slug of ["admin", "api", "new", "open", "login", "p"]) expect(validateProjectSlug(slug)).toMatch(/reserved/);
  });

  it("suggests a valid slug from a name", () => {
    expect(suggestProjectSlug("Bizify")).toBe("bizify");
    expect(suggestProjectSlug("  ISP Digital ")).toBe("isp-digital");
    expect(suggestProjectSlug("Café & Co.")).toBe("cafe-co");
    expect(validateProjectSlug(suggestProjectSlug("A really long project name that goes on well past the limit"))).toBeNull();
  });
});

describe("project names", () => {
  it("requires a name and caps its length", () => {
    expect(validateProjectName("")).not.toBeNull();
    expect(validateProjectName("x".repeat(81))).not.toBeNull();
    expect(validateProjectName("Bizify")).toBeNull();
  });
});

describe("project lifecycle", () => {
  it("follows SETUP → ACTIVE ⇄ SUSPENDED → ARCHIVED", () => {
    expect(canTransitionProject("SETUP", "ACTIVE")).toBe(true);
    expect(canTransitionProject("ACTIVE", "SUSPENDED")).toBe(true);
    expect(canTransitionProject("SUSPENDED", "ACTIVE")).toBe(true);
    expect(canTransitionProject("SUSPENDED", "ARCHIVED")).toBe(true);
    expect(canTransitionProject("ACTIVE", "SETUP")).toBe(false);
    expect(allowedProjectTransitions("ARCHIVED")).toEqual([]);
  });

  it("is read-only exactly when it does not operate", () => {
    for (const status of PROJECT_STATUSES) expect(isReadOnlyProjectStatus(status)).toBe(!isOperatingProjectStatus(status));
    expect(isReadOnlyProjectStatus("SUSPENDED")).toBe(true);
    expect(isReadOnlyProjectStatus("ACTIVE")).toBe(false);
  });
});

describe("the Main Admin keys leave the existing roles exactly as they were", () => {
  const mainAdminKeys = PERMISSIONS.filter((p) => p.category === MAIN_ADMIN_CATEGORY).map((p) => p.key);

  it("exist as projects.view and projects.manage", () => {
    expect(mainAdminKeys.sort()).toEqual(["projects.manage", "projects.view"]);
  });

  it("are not given to Read Only, Support Manager or Support Agent", () => {
    for (const key of mainAdminKeys) {
      expect(READ_ONLY_PERMISSION_KEYS).not.toContain(key);
      expect(SUPPORT_MANAGER_PERMISSION_KEYS).not.toContain(key);
      expect(SUPPORT_AGENT_PERMISSION_KEYS).not.toContain(key);
    }
  });

  it("Read Only still holds every other .view key", () => {
    const otherViews = PERMISSIONS.filter((p) => p.key.endsWith(".view") && p.category !== MAIN_ADMIN_CATEGORY).map((p) => p.key);
    expect([...READ_ONLY_PERMISSION_KEYS].sort()).toEqual(otherViews.sort());
  });
});

describe("project features", () => {
  it("default to on, and a stored row overrides its default", () => {
    const all = resolveProjectFeatures([]);
    expect(all).toHaveLength(PROJECT_FEATURES.length);
    expect(all.every((f) => f.enabled && f.isDefault)).toBe(true);
    const withOverride = resolveProjectFeatures([{ key: "AI_REPLY", enabled: false }]);
    expect(withOverride.find((f) => f.key === "AI_REPLY")).toMatchObject({ enabled: false, isDefault: false });
  });
});

describe("which feature a page or action belongs to", () => {
  it("maps pages by their path, longest prefix first", () => {
    expect(featureForPath("/chat")).toBe("WHATSAPP_CHAT");
    expect(featureForPath("/chat/abc123?x=1")).toBe("WHATSAPP_CHAT");
    expect(featureForPath("/support-activity")).toBe("SUPPORT_ACTIVITY");
    expect(featureForPath("/support-activity/team")).toBe("TEAM_REPORTS");
    expect(featureForPath("/support-activity/teamwork")).toBe("SUPPORT_ACTIVITY");
    expect(featureForPath("/conversation-learning/sandbox")).toBe("CONVERSATION_LEARNING");
    expect(featureForPath("/api/team-report/export")).toBe("TEAM_REPORTS");
    expect(featureForPath("/integrations/forge")).toBe("PRODUCT_KNOWLEDGE_FORGE");
  });

  it("leaves pages that belong to no feature alone — the core product is never switched off", () => {
    for (const path of ["/overview", "/messages", "/accounts", "/groups", "/rules", "/settings", "/ai-learning/settings", "/users", "/chatter"]) {
      expect(featureForPath(path)).toBeNull();
    }
  });

  it("maps only keys a single feature uses", () => {
    expect(featureForPermissionKey("bulk_messaging.manage")).toBe("BULK_MESSAGING");
    expect(featureForPermissionKey("messages.reply")).toBe("WHATSAPP_CHAT");
    expect(featureForPermissionKey("messages.view")).toBeNull();
    expect(featureForPermissionKey("support_activity.view")).toBeNull(); // shared with Team Report
    expect(featureForPermissionKey("ai_learning.manage")).toBeNull(); // shared with Forge and the assistant
  });

  it("no route or key belongs to two features", () => {
    const routes = PROJECT_FEATURES.flatMap((f) => f.routes);
    expect(new Set(routes).size).toBe(routes.length);
    const keys = PROJECT_FEATURES.flatMap((f) => f.permissionKeys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a disabled feature blocks exactly its own paths", () => {
    const disabled = disabledProjectFeatures([{ key: "WHATSAPP_CHAT", enabled: false }, { key: "AI_REPLY", enabled: true }]);
    expect([...disabled]).toEqual(["WHATSAPP_CHAT"]);
    expect(pathAllowedByFeatures("/chat/1", disabled)).toBe(false);
    expect(pathAllowedByFeatures("/messages", disabled)).toBe(true);
    expect(pathAllowedByFeatures("/ai-learning/activity", disabled)).toBe(true);
    expect(disabledProjectFeatures([]).size).toBe(0);
  });
});
