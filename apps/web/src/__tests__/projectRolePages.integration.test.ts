import "./helpers/requireTestDatabase";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import { keysForSectionAccess, type SectionAccess } from "@/app/p/[project]/(dashboard)/projectSections";

/**
 * Page-level project roles (PROJECT_ROLES.md, "Pages"), across two projects, through the real checks.
 *
 * What must hold:
 *   - nobody without a page selection changes: a global role, a key-only project role, a Lead, a Main Admin;
 *   - a selection opens only its pages (everything else is refused, including pages with no key);
 *   - Read looks and Full changes, on THAT page — a sibling page sharing the key does not count;
 *   - an action bound to its own page cannot be reached from a sibling page posting it;
 *   - the same login has another selection in another project;
 *   - both kill switches work and delete nothing;
 *   - what is saved is sanitised, and the keys are derived on the server, never taken from the form.
 */

let current: Session;
let path: string | null = null;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], projects: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
// The page a request is for, as the proxy reports it (`x-softify-project-path`). The project itself
// comes from `runWithProject`, which takes precedence over any header.
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers(path === null ? {} : { "x-softify-project-path": path }),
}));

const { runWithProject, forgetProjectAccessDecisions } = await import("@/server/projectContext");
const { getPageAccess, getGrantedPermissionKeys, hasPermission, blockedPagePath } = await import("@/server/permissions");
const { checkPermission, pageAccess, requireAccess, requireProjectPage, PAGE_DENIED_ERROR } = await import("@/server/authorize");
const accounts = await import("@/server/actions/accounts");
const actions = await import("@/server/actions/projectAdmin");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;

async function globalRole(name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(r.id);
  return r.id;
}
async function person(name: string, roleId: string | null): Promise<Session> {
  const u = await rawPrisma.user.create({
    data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId },
  });
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
/** Run as `who`, in `project`, on the page `at` (null = a request with no page, e.g. an OAuth callback). */
const on = <T,>(who: Session, project: Project, at: string | null, fn: () => Promise<T>) => {
  current = who;
  path = at;
  return runWithProject(project, fn);
};
const can = (who: Session, project: Project, at: string | null, key: string) => on(who, project, at, () => hasPermission(who, key as never));
const redirected = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if ((err as Error).message.startsWith("REDIRECT ")) return (err as Error).message.slice("REDIRECT ".length);
    throw err;
  }
  return null;
};
const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const value of [v].flat()) f.append(k, value);
  return f;
};

const PAGES_A: SectionAccess = { "/groups": "FULL", "/accounts": "READ", "dashboard:tiles": "READ" };
const PAGES_B: SectionAccess = { "/accounts": "FULL" };
const people = {} as Record<"mainAdmin" | "legacy" | "lead" | "keyOnly" | "member", Session>;
const roles = {} as Record<"pagesA" | "keysOnlyA" | "pagesB", string>;

beforeAll(async () => {
  people.mainAdmin = await person("PgMain", await globalRole("PG main", ["projects.view", "projects.manage", "whatsapp.view", "whatsapp.manage"]));
  people.legacy = await person("PgLegacy", await globalRole("PG legacy", ["whatsapp.view", "whatsapp.manage"]));
  people.lead = await person("PgLead", null);
  people.keyOnly = await person("PgKeyOnly", null);
  people.member = await person("PgMember", null);
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.mainAdmin.userId }, rawPrisma);
    ids.projects.push(p.id);
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("PagesA");
  B = await make("PagesB");
  await rawPrisma.projectAccess.createMany({
    data: [
      ...[people.legacy, people.lead, people.keyOnly, people.member].map((p) => ({ projectId: A.id, userId: p.userId })),
      { projectId: B.id, userId: people.member.userId },
    ],
    skipDuplicates: true,
  });
  const role = (projectId: string, name: string, sectionAccess: SectionAccess | null, keys?: string[]) =>
    rawPrisma.projectRole
      .create({ data: { projectId, name, sectionAccess: sectionAccess ?? undefined, permissionKeys: keys ?? keysForSectionAccess(sectionAccess ?? {}) } })
      .then((r) => r.id);
  roles.pagesA = await role(A.id, "Groups desk", PAGES_A);
  roles.keysOnlyA = await role(A.id, "Key only", null, ["whatsapp.view", "whatsapp.manage"]);
  roles.pagesB = await role(B.id, "Accounts desk", PAGES_B);
  await rawPrisma.projectMemberRole.createMany({
    data: [
      { projectId: A.id, userId: people.lead.userId, isLead: true, projectRoleId: roles.pagesA },
      { projectId: A.id, userId: people.keyOnly.userId, projectRoleId: roles.keysOnlyA },
      { projectId: A.id, userId: people.member.userId, projectRoleId: roles.pagesA },
      { projectId: B.id, userId: people.member.userId, projectRoleId: roles.pagesB },
      // Even holding a page-selected role, a Main Admin is governed by their global role.
      { projectId: A.id, userId: people.mainAdmin.userId, projectRoleId: roles.pagesA },
    ],
  });
});

afterEach(() => {
  delete process.env.PROJECT_ROLES_DISABLED;
  delete process.env.PROJECT_ROLE_PAGES_DISABLED;
  path = null;
  forgetProjectAccessDecisions();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.projectMemberRole.deleteMany({ where });
  await rawPrisma.projectRole.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where });
  const created = await rawPrisma.user.findMany({ where: { username: { endsWith: `_${tag}` } }, select: { id: true } });
  await rawPrisma.userSession.deleteMany({ where: { userId: { in: created.map((u) => u.id) } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: created.map((u) => u.id) } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  await rawPrisma.$disconnect();
});

describe("1. nobody without a page selection changes", () => {
  it("a global role, a key-only project role, a Lead and a Main Admin have no page selection and keep every page their keys open", async () => {
    for (const who of [people.legacy, people.keyOnly, people.lead, people.mainAdmin]) {
      expect(await on(who, A, "/team-members", () => getPageAccess(who)), who.name).toBeNull();
      expect(await on(who, A, "/team-members", () => blockedPagePath()), who.name).toBeNull();
    }
    expect(await can(people.legacy, A, "/team-members", "whatsapp.manage")).toBe(true);
    expect(await can(people.keyOnly, A, "/team-members", "whatsapp.manage")).toBe(true);
    expect(await can(people.lead, A, "/team-members", "whatsapp.manage")).toBe(true);
    expect(await can(people.mainAdmin, A, "/team-members", "whatsapp.manage")).toBe(true);
  });
});

describe("2. a page selection opens only its pages", () => {
  it("is the member's in this project", async () => {
    expect(await on(people.member, A, "/overview", () => getPageAccess(people.member))).toEqual(PAGES_A);
    expect(await on(people.member, A, "/overview", () => getGrantedPermissionKeys(people.member))).toEqual(["whatsapp.view", "whatsapp.manage"]);
  });

  it("refuses every other page, including a sibling that shares the key and pages that check no key", async () => {
    expect(await on(people.member, A, "/groups", () => blockedPagePath())).toBeNull();
    expect(await on(people.member, A, "/accounts", () => blockedPagePath())).toBeNull();
    expect(await on(people.member, A, "/overview", () => blockedPagePath())).toBeNull();
    expect(await on(people.member, A, "/team-members", () => blockedPagePath())).toBe("/team-members");
    expect(await on(people.member, A, "/reports", () => blockedPagePath())).toBe("/reports");
    expect(await on(people.member, A, "/ignored", () => blockedPagePath())).toBe("/ignored");
    expect(await on(people.member, A, "/somewhere-new", () => blockedPagePath())).toBe("/somewhere-new");
    // Through the page gate itself: the member holds whatsapp.view, but Team Members is not theirs.
    expect(await redirected(on(people.member, A, "/team-members", () => requireAccess("whatsapp.view")))).toBe("/p/x/overview?page=%2Fteam-members");
    expect(await redirected(on(people.member, A, "/groups", () => requireAccess("whatsapp.view")))).toBeNull();
    // A page that checks no key (the reports hub, a legacy redirect) is held by the page step alone.
    expect(await redirected(on(people.member, A, "/reports", () => requireProjectPage()))).toBe("/p/x/overview?page=%2Freports");
    expect(await redirected(on(people.member, A, "/needs-attention", () => requireProjectPage()))).toBe("/p/x/overview?page=%2Fneeds-attention");
    expect(await redirected(on(people.member, A, "/overview", () => requireProjectPage()))).toBeNull();
  });
});

describe("3. Read looks, Full changes — on that page", () => {
  it("lets a Full page change things and a Read page only look", async () => {
    expect(await can(people.member, A, "/groups", "whatsapp.manage")).toBe(true);
    expect(await can(people.member, A, "/accounts", "whatsapp.view")).toBe(true);
    expect(await can(people.member, A, "/accounts", "whatsapp.manage")).toBe(false);
    expect(await can(people.member, A, "/overview", "whatsapp.view")).toBe(true);
    expect(await can(people.member, A, "/overview", "whatsapp.manage")).toBe(false);
    expect(await can(people.member, A, "/team-members", "whatsapp.view")).toBe(false);
  });

  it("words the refusal so the member knows who decides, and shows a Read page view-only", async () => {
    expect(await on(people.member, A, "/accounts", () => checkPermission("whatsapp.manage"))).toEqual({ denied: PAGE_DENIED_ERROR });
    expect((await on(people.member, A, "/accounts", () => pageAccess("whatsapp.view", "whatsapp.manage"))).canManage).toBe(false);
    expect((await on(people.member, A, "/groups", () => pageAccess("whatsapp.view", "whatsapp.manage"))).canManage).toBe(true);
  });

  it("with no page in the request, only reads — unless the action names its own page", async () => {
    expect(await can(people.member, A, null, "whatsapp.view")).toBe(true);
    expect(await can(people.member, A, null, "whatsapp.manage")).toBe(false);
    expect("session" in (await on(people.member, A, null, () => checkPermission("whatsapp.manage", { sections: ["/groups"] })))).toBe(true);
    expect("session" in (await on(people.member, A, null, () => checkPermission("whatsapp.manage", { sections: ["/accounts"] })))).toBe(false);
  });
});

describe("4. an action bound to its own page cannot be reached from a sibling page", () => {
  it("refuses an Accounts action posted from Groups, where the member holds the same key at Full", async () => {
    expect(await on(people.member, A, "/groups", () => accounts.addWhatsAppAccount(form({ label: `Sneaky ${tag}` })))).toEqual({ error: PAGE_DENIED_ERROR });
    expect(await redirected(on(people.member, A, "/groups", () => accounts.requestLogout("no-such-account")))).toBe("/p/x/overview?page=%2Faccounts");
    expect(await rawPrisma.whatsAppAccount.count({ where: { projectId: A.id, label: `Sneaky ${tag}` } })).toBe(0);
  });

  it("still runs where it belongs, and from every page it is bound to", async () => {
    // Accounts at Full in B: the permission check passes and the action's own validation answers.
    expect(await on(people.member, B, "/accounts", () => accounts.addWhatsAppAccount(form({ label: "" })))).toEqual({ error: "Label is required." });
    expect("session" in (await on(people.member, A, "/groups", () => checkPermission("whatsapp.manage", { sections: ["/accounts", "/groups"] })))).toBe(true);
  });
});

describe("5. another project, another selection", () => {
  it("gives the same login Accounts at Full in B and Read in A", async () => {
    expect(await on(people.member, B, "/accounts", () => getPageAccess(people.member))).toEqual(PAGES_B);
    expect(await can(people.member, B, "/accounts", "whatsapp.manage")).toBe(true);
    expect(await can(people.member, A, "/accounts", "whatsapp.manage")).toBe(false);
    expect(await can(people.member, B, "/groups", "whatsapp.view")).toBe(false);
  });
});

describe("6. the kill switches", () => {
  it("PROJECT_ROLE_PAGES_DISABLED drops the page selection and keeps the role's keys", async () => {
    process.env.PROJECT_ROLE_PAGES_DISABLED = "true";
    expect(await on(people.member, A, "/team-members", () => getPageAccess(people.member))).toBeNull();
    expect(await can(people.member, A, "/team-members", "whatsapp.manage")).toBe(true);
  });

  it("PROJECT_ROLES_DISABLED puts everybody on their global role (this member has none), and deletes nothing", async () => {
    process.env.PROJECT_ROLES_DISABLED = "true";
    expect(await on(people.member, A, "/groups", () => getGrantedPermissionKeys(people.member))).toEqual([]);
    expect(await on(people.member, A, "/groups", () => getPageAccess(people.member))).toBeNull();
    delete process.env.PROJECT_ROLES_DISABLED;
    expect((await rawPrisma.projectRole.findUniqueOrThrow({ where: { id: roles.pagesA } })).sectionAccess).toEqual(PAGES_A);
  });
});

describe("7. saving a role", () => {
  it("keeps only real pages at levels they offer, derives the keys, honours Fine-tune and ignores a submitted key list", async () => {
    const to = await redirected(
      on(people.lead, A, "/project-roles/new", () =>
        actions.createProjectRole(
          {},
          form({
            name: `Rules desk ${tag}`,
            sectionAccess: JSON.stringify({ "/rules": "FULL", "/rules/tester": "FULL", "/users": "FULL", "/nope": "READ", "dashboard:metrics": "READ" }),
            excludedKeys: ["automation_rules.delete", "messages.reply"],
            permissionKeys: ["projects.manage", "messages.reply"],
          }),
        ),
      ),
    );
    expect(to).toBe("/p/x/project-roles");
    const role = await rawPrisma.projectRole.findFirstOrThrow({ where: { projectId: A.id, name: `Rules desk ${tag}` } });
    expect(role.sectionAccess).toEqual({ "/rules": "FULL", "dashboard:metrics": "READ" });
    expect(role.permissionKeys).toEqual([
      "automation_rules.view",
      "automation_rules.create",
      "automation_rules.edit",
      "automation_rules.activate",
      "automation_rules.bulk_import",
      "automation_rules.bulk_export",
    ]);
  });

  it("turns a key-only role into a page-selected one when it is saved", async () => {
    const to = await redirected(
      on(people.lead, A, "/project-roles/x1", () =>
        actions.updateProjectRole(roles.keysOnlyA, {}, form({ name: "Key only", sectionAccess: JSON.stringify({ "/teams": "FULL" }) })),
      ),
    );
    expect(to).toBe("/p/x/project-roles");
    const role = await rawPrisma.projectRole.findUniqueOrThrow({ where: { id: roles.keysOnlyA } });
    expect(role.sectionAccess).toEqual({ "/teams": "FULL" });
    expect(role.permissionKeys).toEqual(["whatsapp.view", "whatsapp.manage"]);
    expect(await on(people.keyOnly, A, "/team-members", () => blockedPagePath())).toBe("/team-members");
    expect(await can(people.keyOnly, A, "/teams", "whatsapp.manage")).toBe(true);
  });

  it("is refused by the database unless it is an object", async () => {
    await expect(rawPrisma.projectRole.create({ data: { projectId: A.id, name: `Bad ${tag}`, sectionAccess: ["/groups"] } })).rejects.toThrow();
  });
});
