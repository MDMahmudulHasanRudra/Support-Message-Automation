import "./helpers/requireTestDatabase";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS, PROJECT_LEAD_KEYS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Two-level permissions (PROJECT_ROLES.md), across two projects.
 *
 * What must hold:
 *   - a user with no project-level role (every user that exists today) keeps EXACTLY their global role;
 *   - a project role decides what a member may do in that project only — the same login can hold a
 *     different role, or nothing, in another project;
 *   - a project's Lead runs that project (members and roles) and nothing else: never another project,
 *     never a platform key, never themselves, another Lead or a Main Admin;
 *   - nothing a project stores can carry a platform key (filtered in code, refused by the database);
 *   - the kill switch puts every user back on their global role without deleting anything.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[] };

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

const { runWithProject, forgetProjectAccessDecisions } = await import("@/server/projectContext");
const { getGrantedPermissionKeys, hasPermission } = await import("@/server/permissions");
const { privilegeRefusal } = await import("@/server/privilegeGuard");
const adminData = await import("@/server/adminUsers");
const actions = await import("@/server/actions/projectAdmin");

type Project = { id: string; slug: string; name: string; status: "ACTIVE"; accessLevel?: "READ" | "WRITE" | "FULL" };
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
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
const enter = (project: Project, userId: string) => rawPrisma.projectAccess.create({ data: { projectId: project.id, userId } });
const as = <T,>(who: Session, project: Project, fn: () => Promise<T>) => {
  current = who;
  return runWithProject(project, fn);
};
const keysOf = async (who: Session, project: Project) => (await as(who, project, () => getGrantedPermissionKeys(who))).sort();
const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const value of [v].flat()) f.append(k, value);
  return f;
};
const redirected = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    if ((err as Error).message.startsWith("REDIRECT ")) return (err as Error).message.slice("REDIRECT ".length);
    throw err;
  }
  return null;
};

const LEGACY_KEYS = ["messages.view", "messages.reply", "automation_rules.view", "users.view"];
const people = {} as Record<"mainAdmin" | "legacy" | "lead" | "leadB" | "member" | "shared", Session>;
const roles = {} as Record<"agentA" | "viewerA" | "agentB", string>;

beforeAll(async () => {
  people.mainAdmin = await person("MainAdmin", await globalRole("PR main", ["projects.view", "projects.manage", "messages.view", "users.create"]));
  people.legacy = await person("Legacy", await globalRole("PR legacy", LEGACY_KEYS));
  people.lead = await person("Lead", null);
  people.leadB = await person("LeadB", null);
  people.member = await person("Member", null);
  people.shared = await person("Shared", null);
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.mainAdmin.userId }, rawPrisma);
    ids.projects.push(p.id);
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("RolesA");
  B = await make("RolesB");
  for (const who of [people.legacy, people.lead, people.member, people.shared, people.leadB]) await enter(A, who.userId);
  await enter(B, people.shared.userId);
  await enter(B, people.leadB.userId);

  roles.agentA = (await rawPrisma.projectRole.create({ data: { projectId: A.id, name: "Agent", permissionKeys: ["messages.view", "messages.reply"] } })).id;
  roles.viewerA = (await rawPrisma.projectRole.create({ data: { projectId: A.id, name: "Viewer", permissionKeys: ["messages.view"] } })).id;
  roles.agentB = (await rawPrisma.projectRole.create({ data: { projectId: B.id, name: "Agent", permissionKeys: ["automation_rules.view", "automation_rules.edit"] } })).id;
  await rawPrisma.projectMemberRole.createMany({
    data: [
      { projectId: A.id, userId: people.lead.userId, isLead: true },
      { projectId: A.id, userId: people.member.userId, projectRoleId: roles.agentA },
      { projectId: A.id, userId: people.shared.userId, projectRoleId: roles.viewerA },
      { projectId: A.id, userId: people.leadB.userId, projectRoleId: roles.viewerA },
      { projectId: B.id, userId: people.shared.userId, projectRoleId: roles.agentB },
      { projectId: B.id, userId: people.leadB.userId, isLead: true },
    ],
  });
});

afterEach(() => {
  delete process.env.PROJECT_ROLES_DISABLED;
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

describe("1. compatibility: nobody who has no project-level role changes", () => {
  it("a user with only a global role holds exactly that role in every project, as before", async () => {
    expect(await keysOf(people.legacy, A)).toEqual([...LEGACY_KEYS].sort());
    await as(people.legacy, A, async () => {
      for (const key of LEGACY_KEYS) expect(await hasPermission(people.legacy, key as never)).toBe(true);
      expect(await hasPermission(people.legacy, "project_members.manage")).toBe(false);
    });
  });

  it("a Main Admin keeps their global role inside every project", async () => {
    expect(await keysOf(people.mainAdmin, A)).toEqual(["messages.view", "projects.manage", "projects.view", "users.create"]);
  });

  it("the kill switch puts everybody back on their global role, and deletes nothing", async () => {
    process.env.PROJECT_ROLES_DISABLED = "true";
    expect(await keysOf(people.lead, A)).toEqual([]);
    expect(await keysOf(people.member, A)).toEqual([]);
    delete process.env.PROJECT_ROLES_DISABLED;
    expect(await keysOf(people.member, A)).toEqual(["messages.reply", "messages.view"]);
    expect(await rawPrisma.projectMemberRole.count({ where: { projectId: A.id } })).toBe(4);
  });
});

describe("2. project roles are per project", () => {
  it("a member's project role is what they may do there; the access level still narrows it", async () => {
    expect(await keysOf(people.member, A)).toEqual(["messages.reply", "messages.view"]);
    await as(people.member, { ...A, accessLevel: "READ" }, async () => {
      expect(await hasPermission(people.member, "messages.view")).toBe(true);
      expect(await hasPermission(people.member, "messages.reply")).toBe(false);
    });
  });

  it("the same login holds a different role in each project", async () => {
    expect(await keysOf(people.shared, A)).toEqual(["messages.view"]);
    expect(await keysOf(people.shared, B)).toEqual(["automation_rules.edit", "automation_rules.view"]);
  });

  it("a member of A has nothing in B", async () => {
    expect(await keysOf(people.member, B)).toEqual([]);
  });
});

describe("3. a Lead runs their own project, and only that", () => {
  it("holds every project key and the project's administration in the project they lead — no platform key", async () => {
    const keys = await keysOf(people.lead, A);
    expect(keys).toEqual([...PROJECT_LEAD_KEYS].sort());
    for (const key of ["projects.manage", "projects.view", "users.create", "permissions.edit", "configuration.manage"]) expect(keys).not.toContain(key);
  });

  it("is nobody in another project, and the actions refuse there", async () => {
    expect(await keysOf(people.lead, B)).toEqual([]);
    const result = await as(people.lead, B, () => actions.removeProjectMember(people.shared.userId));
    expect(result.error).toBeTruthy();
    expect(await rawPrisma.projectAccess.count({ where: { projectId: B.id, userId: people.shared.userId } })).toBe(1);
  });

  it("creates a project role, and a platform key smuggled into the form is dropped", async () => {
    const to = await redirected(
      as(people.lead, A, () =>
        actions.createProjectRole(
          {},
          form({
            name: "Billing",
            // The keys are derived from the pages on the server; a submitted key list is ignored, and a
            // platform page is not a page a project role can hold.
            sectionAccess: JSON.stringify({ "/clients": "READ", "/users": "FULL", "/project-members": "FULL" }),
            permissionKeys: ["clients.view", "projects.manage", "users.create", "project_members.manage"],
          }),
        ),
      ),
    );
    expect(to).toBe("/p/x/project-roles");
    const role = await rawPrisma.projectRole.findFirstOrThrow({ where: { projectId: A.id, name: "Billing" } });
    expect(role.permissionKeys).toEqual(["clients.view"]);
    expect(role.sectionAccess).toEqual({ "/clients": "READ" });
  });

  it("creates a member for this project only: no global role, enters A only, holds the chosen role", async () => {
    const to = await redirected(
      as(people.lead, A, () =>
        actions.createProjectMember(
          {},
          form({ username: `newbie_${tag}`, name: "Newbie", password: "a-long-password-1", confirmPassword: "a-long-password-1", projectRoleId: roles.viewerA }),
        ),
      ),
    );
    expect(to).toBe("/p/x/project-members?created=1");
    const created = await rawPrisma.user.findUniqueOrThrow({ where: { username: `newbie_${tag}` }, select: { id: true, permissionModuleId: true, projectAccess: { select: { projectId: true } } } });
    expect(created.permissionModuleId).toBeNull();
    expect(created.projectAccess.map((a) => a.projectId)).toEqual([A.id]);
    const newbie = { userId: created.id, username: `newbie_${tag}`, email: "", name: "Newbie" } as Session;
    expect(await keysOf(newbie, A)).toEqual(["messages.view"]);
    expect(await keysOf(newbie, B)).toEqual([]);
  });

  it("cannot give a member a role of another project", async () => {
    const result = await as(people.lead, A, () => actions.setMemberProjectRole(people.member.userId, roles.agentB));
    expect(result.error).toMatch(/no longer exists in this project/);
    expect((await rawPrisma.projectMemberRole.findFirstOrThrow({ where: { projectId: A.id, userId: people.member.userId } })).projectRoleId).toBe(roles.agentA);
  });

  it("cannot manage themselves, another Lead, or a Main Admin", async () => {
    await rawPrisma.projectAccess.createMany({ data: [{ projectId: A.id, userId: people.mainAdmin.userId }], skipDuplicates: true });
    await rawPrisma.projectMemberRole.create({ data: { projectId: A.id, userId: people.mainAdmin.userId, projectRoleId: roles.viewerA } });
    for (const target of [people.lead.userId, people.mainAdmin.userId]) {
      expect((await as(people.lead, A, () => actions.setMemberProjectRole(target, roles.agentA))).error).toBeTruthy();
      expect((await as(people.lead, A, () => actions.removeProjectMember(target))).error).toBeTruthy();
      expect((await as(people.lead, A, () => actions.resetProjectMemberPassword(target, "another-long-pass"))).error).toBeTruthy();
    }
    // ...and the Main Admin's own rights in A are untouched by the role row a project could hold for them.
    expect(await keysOf(people.mainAdmin, A)).toContain("projects.manage");
    await rawPrisma.projectMemberRole.deleteMany({ where: { projectId: A.id, userId: people.mainAdmin.userId } });
  });

  it("changes a shared member's role here, but never the login another project also uses", async () => {
    expect((await as(people.lead, A, () => actions.setMemberProjectRole(people.shared.userId, roles.agentA))).error).toBeUndefined();
    expect(await keysOf(people.shared, A)).toEqual(["messages.reply", "messages.view"]);
    expect(await keysOf(people.shared, B)).toEqual(["automation_rules.edit", "automation_rules.view"]); // B unchanged
    expect((await as(people.lead, A, () => actions.resetProjectMemberPassword(people.shared.userId, "another-long-pass"))).error).toMatch(/only a Main Admin/);
    expect((await as(people.lead, A, () => actions.setProjectMemberActive(people.shared.userId, false))).error).toMatch(/only a Main Admin/);
  });

  it("resets the password of a login that belongs to this project alone, and signs it out everywhere", async () => {
    await rawPrisma.userSession.create({ data: { userId: people.member.userId, secretHash: `h-${tag}`, expiresAt: new Date(Date.now() + 3_600_000) } });
    expect((await as(people.lead, A, () => actions.resetProjectMemberPassword(people.member.userId, "short"))).error).toBeTruthy();
    expect((await as(people.lead, A, () => actions.resetProjectMemberPassword(people.member.userId, "a-brand-new-password"))).error).toBeUndefined();
    expect(await rawPrisma.userSession.count({ where: { userId: people.member.userId, revokedAt: null } })).toBe(0);
  });

  it("will not delete a role somebody holds; deletes it once nobody does", async () => {
    expect((await as(people.lead, A, () => actions.deleteProjectRole(roles.agentA))).error).toMatch(/still given/);
    const unused = await rawPrisma.projectRole.create({ data: { projectId: A.id, name: "Unused", permissionKeys: [] } });
    expect((await as(people.lead, A, () => actions.deleteProjectRole(unused.id))).error).toBeUndefined();
    // Another project's role is not even found from A.
    expect((await as(people.lead, A, () => actions.deleteProjectRole(roles.agentB))).error).toMatch(/no longer exists/);
  });

  it("removes a member from this project only: the access and the project role go, the login stays", async () => {
    expect((await as(people.lead, A, () => actions.removeProjectMember(people.member.userId))).error).toBeUndefined();
    expect(await rawPrisma.projectAccess.count({ where: { projectId: A.id, userId: people.member.userId } })).toBe(0);
    expect(await rawPrisma.projectMemberRole.count({ where: { projectId: A.id, userId: people.member.userId } })).toBe(0);
    expect(await rawPrisma.user.count({ where: { id: people.member.userId } })).toBe(1);
  });
});

describe("4. only a Main Admin designates a Lead, and nobody else gets project administration", () => {
  it("making someone Lead grants FULL access; removing their access removes the Lead flag too", async () => {
    const extra = await person("LeadLater", null);
    expect(await adminData.setUserProjectLead(rawPrisma, extra.userId, B.id, true)).toEqual({ ok: true, changed: true });
    expect(await rawPrisma.projectAccess.findUniqueOrThrow({ where: { projectId_userId: { projectId: B.id, userId: extra.userId } } })).toMatchObject({ level: null });
    expect(await keysOf(extra, B)).toContain("project_members.manage");
    await adminData.setUserProjectAccess(rawPrisma, extra.userId, B.id, null);
    expect(await rawPrisma.projectMemberRole.count({ where: { projectId: B.id, userId: extra.userId } })).toBe(0);
    await adminData.setUserProjectAccess(rawPrisma, extra.userId, B.id, "FULL");
    expect(await keysOf(extra, B)).toEqual([]); // re-granted access does not revive the old Lead flag
  });

  it("adding a project-administration key to a platform role is a Main Admin's call", async () => {
    expect(await privilegeRefusal(people.legacy.userId, { grantsKeys: ["project_members.manage"] })).toMatch(/Only a Main Admin/);
    expect(await privilegeRefusal(people.mainAdmin.userId, { grantsKeys: ["project_members.manage"] })).toBeNull();
  });
});

describe("5. the database refuses what code must never write", () => {
  it("a project role holding a platform key", async () => {
    await expect(rawPrisma.projectRole.create({ data: { projectId: A.id, name: `Bad ${tag}`, permissionKeys: ["messages.view", "projects.manage"] } })).rejects.toThrow();
  });

  it("a member given another project's role", async () => {
    await expect(rawPrisma.projectMemberRole.create({ data: { projectId: A.id, userId: people.legacy.userId, projectRoleId: roles.agentB } })).rejects.toThrow();
  });
});
