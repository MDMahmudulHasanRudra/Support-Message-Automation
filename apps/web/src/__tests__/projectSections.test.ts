import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isProjectAssignableKey, PERMISSIONS, PROJECT_ASSIGNABLE_PERMISSIONS } from "@support-automation/shared";
import {
  NAV_GROUPS,
  navGroupsFor,
  navPermissionFor,
  REPORT_PAGES,
  SETTINGS_SECTIONS,
  settingsSectionsFor,
} from "@/app/p/[project]/(dashboard)/navigation";
import {
  ACCESS_MODULES,
  ALL_SECTIONS,
  canOpenPath,
  claimForPath,
  DASHBOARD_PARTS,
  keysForSectionAccess,
  pathPermitsKey,
  sanitizeSectionAccess,
  sectionAccessFromKeys,
  sectionById,
  sectionsPermitKey,
  writeKeysOf,
  type SectionAccess,
} from "@/app/p/[project]/(dashboard)/projectSections";

/**
 * Page-level project roles (PROJECT_ROLES.md, "Pages"). The catalogue is derived from the sidebar, so
 * these tests hold it to the CODE rather than to itself: every real page file and export route must
 * belong to a section, every key a page checks must be one its section gives, and the bound actions
 * must be bound to the pages that actually call them.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DASHBOARD_DIR = join(SRC, "app", "p", "[project]", "(dashboard)");
const API_DIR = join(SRC, "app", "p", "[project]", "api");

function filesNamed(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesNamed(full, name));
    else if (entry === name) out.push(full);
  }
  return out;
}

/** A route directory as the URL path the proxy reports: groups dropped, dynamic segments filled in. */
function routeOf(base: string, dir: string, prefix = ""): string {
  const parts = relative(base, dir)
    .split(sep)
    .filter((p) => p && !(p.startsWith("(") && p.endsWith(")")))
    // A report's id is part of what decides its section; any other dynamic segment is just an id.
    .map((p) => (p === "[report]" ? "missed" : p.startsWith("[") ? "x1" : p));
  return `${prefix}/${parts.join("/")}`.replace(/\/$/, "") || "/";
}

const KEY_CALL = /(?:pageAccess|requireAccess|checkPermission|requirePermission\(session,)\s*\(?\s*"([a-z_.]+)"(?:\s*,\s*"([a-z_.]+)")?/g;

function keysCalledIn(file: string): Array<{ open: string; manage: string | null; pageAccess: boolean }> {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(KEY_CALL)].map((m) => ({
    open: m[1]!,
    manage: m[0].startsWith("pageAccess") ? (m[2] ?? null) : null,
    pageAccess: m[0].startsWith("pageAccess"),
  }));
}

const sectionsOf = (ids: readonly string[]) => ids.map((id) => sectionById(id)!);
const allKeys = (ids: readonly string[]) => new Set(sectionsOf(ids).flatMap((s) => [...s.readKeys, ...s.writeKeys]));

describe("the catalogue mirrors the sidebar", () => {
  it("offers every sidebar page, settings page and report whose key a project may give — under its own id", () => {
    const links = [
      ...NAV_GROUPS.flatMap((g) => g.links.flatMap((l) => l.tabs ?? [l])),
      ...SETTINGS_SECTIONS.flatMap((s) => s.links),
      ...REPORT_PAGES,
    ];
    for (const link of links) {
      const path = link.href.split("?")[0]!;
      const key = navPermissionFor(path);
      if (key === null) continue; // the Settings / reports hubs and the Overview
      const claim = claimForPath(path);
      if (isProjectAssignableKey(key)) {
        expect(claim.kind === "SECTIONS" ? claim.ids : [], path).toContain(path);
      } else {
        expect(claim.kind, path).toBe("PLATFORM");
      }
    }
  });

  it("starts with the Dashboard and keeps the sidebar's module order", () => {
    const labels = ACCESS_MODULES.map((m) => m.label);
    expect(labels[0]).toBe("Dashboard");
    const navOrder = NAV_GROUPS.map((g) => g.label).filter((l) => labels.includes(l));
    expect(labels.filter((l) => navOrder.includes(l))).toEqual(navOrder);
    expect(labels).toContain("Settings");
    expect(labels).not.toContain("Users & Permissions"); // platform and project administration: never a role's
    expect(labels).not.toContain("Project Users & Permissions");
  });

  it("gives every key a project role may hold through some page, so nothing became impossible to grant", () => {
    const covered = new Set(ALL_SECTIONS.flatMap((s) => [...s.readKeys, ...s.writeKeys]));
    const missing = PROJECT_ASSIGNABLE_PERMISSIONS.map((p) => p.key).filter((k) => !covered.has(k));
    expect(missing).toEqual([]);
  });

  it("never treats one key as reading on one page and changing on another", () => {
    const read = new Set(ALL_SECTIONS.flatMap((s) => s.readKeys));
    const both = [...new Set(ALL_SECTIONS.flatMap((s) => s.writeKeys))].filter((k) => read.has(k));
    expect(both).toEqual([]);
  });

  it("holds no platform key anywhere", () => {
    for (const s of ALL_SECTIONS) for (const k of [...s.readKeys, ...s.writeKeys]) expect(isProjectAssignableKey(k), `${s.id} ${k}`).toBe(true);
  });
});

describe("the catalogue covers every real page and export route", () => {
  const pages = filesNamed(DASHBOARD_DIR, "page.tsx").map((file) => ({ file, route: routeOf(DASHBOARD_DIR, join(file, "..")) }));
  const apis = filesNamed(API_DIR, "route.ts").map((file) => ({ file, route: routeOf(API_DIR, join(file, ".."), "/api") }));

  it("found the pages and routes it is checking", () => {
    expect(pages.length).toBeGreaterThan(100);
    expect(apis.length).toBeGreaterThan(15);
  });

  it("puts every page under a section, the platform, or the Overview — never nowhere", () => {
    const unknown = [...pages, ...apis].filter(({ route }) => claimForPath(route).kind === "UNKNOWN").map((p) => p.route);
    expect(unknown).toEqual([]);
  });

  it("gives, through the section a page belongs to, every project key that page checks", () => {
    const problems: string[] = [];
    for (const { file, route } of [...pages, ...apis]) {
      const claim = claimForPath(route);
      if (claim.kind !== "SECTIONS") continue;
      const keys = allKeys(claim.ids);
      for (const call of keysCalledIn(file)) {
        for (const key of [call.open, call.manage].filter((k): k is string => k !== null && isProjectAssignableKey(k))) {
          if (!keys.has(key)) problems.push(`${route}: ${key} not given by ${claim.ids.join(", ")}`);
        }
        // A Read grant must open a page whose view key it gives (unless the page only opens to change something).
        if (call.pageAccess && isProjectAssignableKey(call.open)) {
          const openedByRead = sectionsOf(claim.ids).some((s) => s.levels.includes("READ") && s.readKeys.includes(call.open));
          const fullOnly = sectionsOf(claim.ids).every((s) => !s.levels.includes("READ"));
          if (!openedByRead && !fullOnly) problems.push(`${route}: Read does not open it (${call.open})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("binds each page-bound action file to the pages that actually import it", () => {
    const actionsDir = join(SRC, "server", "actions");
    const importers = [...filesNamed(DASHBOARD_DIR, "page.tsx"), ...walk(DASHBOARD_DIR), ...walk(join(SRC, "components"))];
    let bound = 0;
    for (const name of readdirSync(actionsDir)) {
      const src = readFileSync(join(actionsDir, name), "utf8");
      const sections = [...src.matchAll(/sections: \[([^\]]*)\]/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
      if (sections.length === 0) continue;
      bound += 1;
      for (const id of sections) expect(sectionById(id), `${name}: ${id}`).not.toBeNull();
      const actionModule = name.replace(/\.ts$/, "");
      for (const file of new Set(importers)) {
        if (!readFileSync(file, "utf8").includes(`@/server/actions/${actionModule}"`)) continue;
        expect(file.startsWith(DASHBOARD_DIR), `${name} imported outside a project page: ${file}`).toBe(true);
        const claim = claimForPath(routeOf(DASHBOARD_DIR, join(file, "..")));
        expect(claim.kind, file).toBe("SECTIONS");
        const ids = (claim as { ids: readonly string[] }).ids;
        expect(ids.some((id) => sections.includes(id)), `${name} is used on ${ids.join(", ")} but bound to ${sections.join(", ")}`).toBe(true);
      }
    }
    expect(bound).toBeGreaterThanOrEqual(7);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("what a selection opens and allows", () => {
  const sel: SectionAccess = { "/groups": "FULL", "/accounts": "READ", "/support-assignment/mine": "READ", "/reports/missed": "READ", "dashboard:tiles": "READ" };

  it("opens exactly the chosen pages, their detail pages, the Overview and platform pages", () => {
    expect(canOpenPath("/groups", sel)).toBe(true);
    expect(canOpenPath("/accounts", sel)).toBe(true);
    expect(canOpenPath("/team-members", sel)).toBe(false);
    expect(canOpenPath("/accounts/routing", sel)).toBe(false); // a settings page of its own, not part of Accounts
    expect(canOpenPath("/support-assignment/abc123", sel)).toBe(true); // a case opened from My assignments
    expect(canOpenPath("/support-assignment/unanswered", sel)).toBe(false);
    expect(canOpenPath("/reports", sel)).toBe(true); // the hub, for the one report
    expect(canOpenPath("/reports", {})).toBe(false);
    expect(canOpenPath("/overview", {})).toBe(true);
    expect(canOpenPath("/", {})).toBe(true);
    expect(canOpenPath("/users", {})).toBe(true); // platform: the global role decides
    expect(canOpenPath("/somewhere-new", sel)).toBe(false); // an unmapped page fails closed
  });

  it("reads anywhere it opens, and changes things only on a Full page", () => {
    expect(pathPermitsKey("/groups", sel, "whatsapp.manage")).toBe(true);
    expect(pathPermitsKey("/accounts", sel, "whatsapp.view")).toBe(true);
    expect(pathPermitsKey("/accounts", sel, "whatsapp.manage")).toBe(false);
    expect(pathPermitsKey("/team-members", sel, "whatsapp.view")).toBe(false);
    expect(pathPermitsKey("/overview", sel, "bulk_messaging.view")).toBe(true);
    expect(pathPermitsKey("/overview", sel, "whatsapp.manage")).toBe(false);
    expect(pathPermitsKey("/api/reports/missed/export", sel, "support_activity.view")).toBe(true);
    expect(pathPermitsKey("/api/reports/calls/export", sel, "support_activity.view")).toBe(false);
    expect(pathPermitsKey("/team-members", sel, "users.view")).toBe(true); // platform keys are the global role's business
  });

  it("holds a page-bound action to its own pages, whatever page it is posted from", () => {
    expect(sectionsPermitKey(["/accounts"], sel, "whatsapp.manage")).toBe(false); // Groups is Full, Accounts only Read
    expect(sectionsPermitKey(["/accounts"], sel, "whatsapp.view")).toBe(true);
    expect(sectionsPermitKey(["/accounts", "/groups"], sel, "whatsapp.manage")).toBe(true);
    expect(sectionsPermitKey(["/automation-control"], sel, "settings.edit")).toBe(false);
  });

  it("derives the keys from the pages, holds back what Fine-tune unticks, and gives none for the Dashboard", () => {
    expect(keysForSectionAccess({ "/groups": "FULL", "/accounts": "READ" })).toEqual(["whatsapp.view", "whatsapp.manage"]);
    expect(keysForSectionAccess({ "/groups": "FULL" }, ["whatsapp.manage"])).toEqual(["whatsapp.view"]);
    expect(keysForSectionAccess({ "/clients": "FULL" }, ["clients.delete"])).not.toContain("clients.delete");
    expect(keysForSectionAccess({ "/clients": "READ" }, ["clients.view"])).toEqual(["clients.view"]); // reading cannot be unticked
    expect(keysForSectionAccess(Object.fromEntries(DASHBOARD_PARTS.map((p) => [p.id, "READ"])))).toEqual([]);
    expect(writeKeysOf({ "/rules": "FULL", "/accounts": "READ" })).toEqual([
      "automation_rules.create",
      "automation_rules.edit",
      "automation_rules.delete",
      "automation_rules.activate",
      "automation_rules.bulk_import",
    ]);
  });

  it("keeps only known pages at a level each offers", () => {
    expect(
      sanitizeSectionAccess({
        "/groups": "FULL",
        "/rules/tester": "FULL", // read-only page: Full is not on offer
        "/group-message-sender": "READ", // only opens to send: Read is not on offer
        "/users": "FULL", // a platform page is never a role's
        "/made-up": "READ",
        "dashboard:stream": "READ",
        "dashboard:alerts": "FULL",
        "/accounts": "ADMIN",
      }),
    ).toEqual({ "/groups": "FULL", "dashboard:stream": "READ" });
    expect(sanitizeSectionAccess(null)).toEqual({});
    expect(sanitizeSectionAccess(["/groups"])).toEqual({});
  });

  it("reads a key-only role as the pages its keys opened, with the whole Dashboard", () => {
    const access = sectionAccessFromKeys(["whatsapp.view", "whatsapp.manage", "messages.view"]);
    expect(access["/accounts"]).toBe("FULL");
    expect(access["/teams"]).toBe("FULL");
    expect(access["/chat"]).toBe("READ");
    expect(access["/messages"]).toBe("READ");
    expect(access["/rules"]).toBeUndefined();
    for (const part of DASHBOARD_PARTS) expect(access[part.id]).toBe("READ");
    // And saving it gives back no key the role did not hold.
    expect(keysForSectionAccess(access).every((k) => ["whatsapp.view", "whatsapp.manage", "messages.view"].includes(k))).toBe(true);
  });

  it("offers in the sidebar only the chosen pages, even where a sibling shares the key", () => {
    const access: SectionAccess = { "/groups": "FULL", "/ai-learning/settings": "READ" };
    const granted = new Set(keysForSectionAccess(access));
    const filter = (href: string) => canOpenPath(href, access);
    const nav = navGroupsFor(granted, new Set(), filter);
    const hrefs = nav.flatMap((g) => g.links.map((l) => l.href));
    expect(hrefs).toContain("/groups");
    expect(hrefs).not.toContain("/accounts"); // same key (whatsapp.view), not chosen
    expect(hrefs).not.toContain("/team-members");
    expect(hrefs).toContain("/ai-learning/settings"); // the Settings link, pointed at the one settings page it may open
    expect(settingsSectionsFor(granted, new Set(), filter).flatMap((s) => s.links.map((l) => l.href))).toEqual(["/ai-learning/settings"]);
    // Without a filter, the same keys would offer every sibling — the behaviour of a key-only role, unchanged.
    expect(navGroupsFor(granted).flatMap((g) => g.links.map((l) => l.href))).toEqual(expect.arrayContaining(["/accounts", "/team-members", "/teams"]));
  });

  it("has a label for every permission the Fine-tune list can show", () => {
    const labelled = new Set(PERMISSIONS.map((p) => p.key));
    for (const s of ALL_SECTIONS) for (const k of s.writeKeys) expect(labelled.has(k)).toBe(true);
  });
});
