import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { templateModules } from "@support-automation/shared";
import type { Session } from "@/server/auth";
import type { PlatformOperatorSession } from "@/server/platform/auth";

/**
 * Platform approval of the approval-only modules (MODULE_APPROVALS.md), through the real Module Builder action,
 * the real platform approve/revoke actions and the database's own guards. Only the request plumbing and the
 * platform session are stubbed: `operator` null = no platform session (a customer's login has none).
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let current: Session;
let operator: PlatformOperatorSession | null = null;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("@/server/platform/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/platform/auth")>()),
  requireOperatorAction: async () => (operator ? { operator } : { denied: "Your platform session has ended. Sign in again." }),
  confirmOperatorPassword: async (_op: unknown, password: unknown) => password === "operator-password",
}));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { runWithTenant } = await import("@/server/tenant");
const { applyProjectModules } = await import("@/server/actions/projectModules");
const { getProjectModuleState } = await import("@/server/projectModules");
const { approveModule, revokeModuleApproval } = await import("@/server/platform/actions/moduleApprovals");

const created = { customers: [] as string[], projects: [] as string[], users: [] as string[], roles: [] as string[] };
let customerA = "";
let customerB = "";
let projectA = "";
let projectA2 = "";
let projectB = "";
let adminA: Session;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const inA = <T,>(fn: () => Promise<T>) => runWithTenant(customerA, fn);
const state = async (id: string) => (await inA(() => getProjectModuleState(id)))!;
const isOn = async (projectId: string, key: string) => Boolean((await rawPrisma.projectFeature.findUnique({ where: { projectId_key: { projectId, key } } }))?.enabled);
const switchOn = async (projectId: string, keys: string[]) => {
  const s = await state(projectId);
  return inA(() => applyProjectModules(projectId, { modules: [...s.enabled, ...keys], declined: [], baseType: null, expectedVersion: s.version, reason: "test" }));
};
const approve = (customerId: string, fields: Record<string, string>) =>
  approveModule(customerId, {}, form({ scope: "ALL", reason: "Approved in test", operatorPassword: "operator-password", ...fields }));
const activeApproval = (customerId: string, featureKey: string, targetProjectId: string | null) =>
  rawPrisma.moduleApproval.findFirst({ where: { customerId, featureKey, targetProjectId, revokedAt: null } });

beforeAll(async () => {
  customerA = (await rawPrisma.customer.create({ data: { name: `Approvals A ${tag}` } })).id;
  customerB = (await rawPrisma.customer.create({ data: { name: `Approvals B ${tag}` } })).id;
  created.customers.push(customerA, customerB);
  const permissions = await Promise.all(
    ["projects.view", "projects.manage"].map((key) => rawPrisma.permission.upsert({ where: { key }, create: { key, label: key, category: "Test" }, update: {}, select: { id: true } })),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `Approvals admin ${tag}`, customerId: customerA, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  created.roles.push(role.id);
  const user = await rawPrisma.user.create({ data: { username: `apradmin_${tag}`, name: "Approvals admin", passwordHash: "x", permissionModuleId: role.id, customerId: customerA } });
  created.users.push(user.id);
  adminA = { userId: user.id, username: user.username, email: "", name: user.name, tenant: customerA };
  current = adminA;
  const make = async (label: string, customerId: string) =>
    (await createProjectWithDefaults({ name: `Approvals ${label} ${tag}`, slug: `apr-${label}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId }, rawPrisma)).id;
  projectA = await make("a", customerA);
  projectA2 = await make("a2", customerA);
  projectB = await make("b", customerB);
  created.projects.push(projectA, projectA2, projectB);
});

afterAll(async () => {
  await rawPrisma.$executeRawUnsafe('ALTER TABLE "ProjectModuleConfigChange" DISABLE TRIGGER "ProjectModuleConfigChange_append_only"');
  try {
    await rawPrisma.projectModuleConfigChange.deleteMany({ where: { projectId: { in: created.projects } } });
  } finally {
    await rawPrisma.$executeRawUnsafe('ALTER TABLE "ProjectModuleConfigChange" ENABLE TRIGGER "ProjectModuleConfigChange_append_only"');
  }
  // Approvals cannot be deleted directly (audit trail); they go with their customer, deleted below.
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: { in: created.projects } } });
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: { in: created.projects } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: created.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: created.roles } } });
  await rawPrisma.project.updateMany({ where: { id: { in: created.projects } }, data: { status: "ARCHIVED", customerId: null } });
  await rawPrisma.customer.deleteMany({ where: { id: { in: created.customers } } });
});

describe("without approval", () => {
  it("a customer's Main Admin cannot switch on any approval-only module, and nothing is written", async () => {
    for (const key of ["SOCIAL_STUDIO", "WHATSAPP_AVATARS", "CLIENT_SMART_IMPORT"]) {
      const before = (await state(projectA)).version;
      const r = await switchOn(projectA, [key]);
      expect(r.error, key).toBeTruthy();
      expect(r.issues).toContainEqual(expect.objectContaining({ code: "NEEDS_APPROVAL", key }));
      expect(await isOn(projectA, key)).toBe(false);
      expect((await state(projectA)).version).toBe(before);
    }
  });

  it("a customer's login cannot approve: the platform actions refuse without a platform session", async () => {
    operator = null;
    const r = await approve(customerA, { featureKey: "SOCIAL_STUDIO" });
    expect(r.error).toMatch(/platform session/);
    expect(await activeApproval(customerA, "SOCIAL_STUDIO", null)).toBeNull();
  });
});

describe("approving", () => {
  beforeAll(() => {
    operator = { sessionId: "s", operatorId: "op_test", username: `op_${tag}`, name: "Operator", canSupport: true, stepUpAt: new Date() };
  });

  it("needs the operator's password and a reason, and only approval-only modules", async () => {
    expect((await approve(customerA, { featureKey: "SOCIAL_STUDIO", operatorPassword: "wrong" })).error).toMatch(/password/);
    expect((await approve(customerA, { featureKey: "SOCIAL_STUDIO", reason: " " })).error).toMatch(/reason/);
    expect((await approve(customerA, { featureKey: "OMNICHANNEL" })).error).toMatch(/approval-only/);
    expect(await activeApproval(customerA, "SOCIAL_STUDIO", null)).toBeNull();
  });

  it("another customer's approval never reaches this customer, and an approval cannot name another customer's workspace", async () => {
    expect((await approve(customerB, { featureKey: "SOCIAL_STUDIO" })).success).toBeTruthy();
    expect((await switchOn(projectA, ["SOCIAL_STUDIO"])).issues).toContainEqual(expect.objectContaining({ code: "NEEDS_APPROVAL" }));
    // Through the action…
    expect((await approve(customerB, { featureKey: "WHATSAPP_AVATARS", scope: projectA })).error).toMatch(/not one of this customer's/);
    // …and the database refuses it even when written directly.
    await expect(rawPrisma.moduleApproval.create({ data: { customerId: customerB, targetProjectId: projectA, featureKey: "WHATSAPP_AVATARS", reason: "x", approvedByUsername: "x" } })).rejects.toThrow(/same customer/);
  });

  it("a workspace approval lets the Main Admin switch it on there, and only there; approving switches nothing on", async () => {
    const r = await approve(customerA, { featureKey: "SOCIAL_STUDIO", scope: projectA });
    expect(r.success).toMatch(/nothing was switched on/);
    expect(await isOn(projectA, "SOCIAL_STUDIO")).toBe(false);
    expect((await switchOn(projectA, ["SOCIAL_STUDIO"])).success).toBeTruthy();
    expect(await isOn(projectA, "SOCIAL_STUDIO")).toBe(true);
    expect((await switchOn(projectA2, ["SOCIAL_STUDIO"])).issues).toContainEqual(expect.objectContaining({ code: "NEEDS_APPROVAL" }));
    // Approving the same thing twice is refused, not duplicated.
    expect((await approve(customerA, { featureKey: "SOCIAL_STUDIO", scope: projectA })).error).toMatch(/already approved/);
  });

  it("an approved Main Admin may switch it off and on again", async () => {
    const s = await state(projectA);
    expect((await inA(() => applyProjectModules(projectA, { modules: s.enabled.filter((k) => k !== "SOCIAL_STUDIO"), declined: [], baseType: null, expectedVersion: s.version, reason: "" }))).success).toBeTruthy();
    expect(await isOn(projectA, "SOCIAL_STUDIO")).toBe(false);
    expect((await switchOn(projectA, ["SOCIAL_STUDIO"])).success).toBeTruthy();
  });

  it("the approval record cannot be rewritten", async () => {
    const row = (await activeApproval(customerA, "SOCIAL_STUDIO", projectA))!;
    await expect(rawPrisma.moduleApproval.update({ where: { id: row.id }, data: { reason: "rewritten" } })).rejects.toThrow(/cannot be rewritten/);
    await expect(rawPrisma.moduleApproval.update({ where: { id: row.id }, data: { featureKey: "WHATSAPP_AVATARS" } })).rejects.toThrow(/cannot be rewritten/);
  });
});

describe("revoking", () => {
  it("switches the module off in the same step, records why in the module history, and refuses switching it on again", async () => {
    const row = (await activeApproval(customerA, "SOCIAL_STUDIO", projectA))!;
    const before = await state(projectA);
    const r = await revokeModuleApproval(row.id, {}, form({ reason: "Pilot ended", operatorPassword: "operator-password" }));
    expect(r.success).toMatch(/Switched off/);
    expect(await isOn(projectA, "SOCIAL_STUDIO")).toBe(false);
    const after = await state(projectA);
    expect(after.version).toBe(before.version + 1);
    expect(after.history[0]).toMatchObject({ actorUsername: `platform:op_${tag}`, reason: expect.stringContaining("Pilot ended") });
    expect(after.history[0]!.previousModules).toContain("SOCIAL_STUDIO");
    expect(after.history[0]!.modules).not.toContain("SOCIAL_STUDIO");
    const revoked = await rawPrisma.moduleApproval.findUnique({ where: { id: row.id } });
    expect(revoked).toMatchObject({ revokeReason: "Pilot ended", revokedByUsername: `op_${tag}` });
    expect((await switchOn(projectA, ["SOCIAL_STUDIO"])).issues).toContainEqual(expect.objectContaining({ code: "NEEDS_APPROVAL" }));
    // Revoked once, for good: it cannot be revoked again, or un-revoked.
    expect((await revokeModuleApproval(row.id, {}, form({ reason: "again", operatorPassword: "operator-password" }))).error).toMatch(/already revoked/);
    await expect(rawPrisma.moduleApproval.update({ where: { id: row.id }, data: { revokedAt: null, revokedByUsername: null } })).rejects.toThrow(/revoked module approval/);
  });

  it("a stale Module Builder page cannot switch it back on after the revocation", async () => {
    // Approve, open the builder (version v), revoke, then submit the page opened before the revocation.
    expect((await approve(customerA, { featureKey: "WHATSAPP_AVATARS", scope: projectA })).success).toBeTruthy();
    const opened = await state(projectA);
    const row = (await activeApproval(customerA, "WHATSAPP_AVATARS", projectA))!;
    expect((await revokeModuleApproval(row.id, {}, form({ reason: "Changed mind", operatorPassword: "operator-password" }))).success).toBeTruthy();
    const r = await inA(() =>
      applyProjectModules(projectA, { modules: [...opened.enabled, "WHATSAPP_AVATARS", "WHATSAPP_CHAT"], declined: [], baseType: null, expectedVersion: opened.version, reason: "" }),
    );
    expect(r.error).toBeTruthy();
    expect(await isOn(projectA, "WHATSAPP_AVATARS")).toBe(false);
  });

  it("with dependencies: switching on Smart Import adds Client Management; revoking takes only Smart Import away", async () => {
    expect((await approve(customerA, { featureKey: "CLIENT_SMART_IMPORT" })).success).toBeTruthy();
    expect((await switchOn(projectA2, ["CLIENT_SMART_IMPORT"])).success).toBeTruthy();
    expect(await isOn(projectA2, "CLIENT_CENTER")).toBe(true);
    expect(await isOn(projectA2, "CLIENT_SMART_IMPORT")).toBe(true);
    const row = (await activeApproval(customerA, "CLIENT_SMART_IMPORT", null))!;
    expect((await revokeModuleApproval(row.id, {}, form({ reason: "Plan change", operatorPassword: "operator-password" }))).success).toMatch(/Switched off/);
    expect(await isOn(projectA2, "CLIENT_SMART_IMPORT")).toBe(false);
    expect(await isOn(projectA2, "CLIENT_CENTER")).toBe(true);
  });

  it("revoking one customer's approval touches no other customer's workspace", async () => {
    // Customer B's own Social Studio approval (customer-wide, from above), switched on directly in B's project.
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: projectB, key: "SOCIAL_STUDIO" } }, create: { projectId: projectB, key: "SOCIAL_STUDIO", enabled: true }, update: { enabled: true } });
    expect(await isOn(projectB, "SOCIAL_STUDIO")).toBe(true);
    expect(templateModules("DEFAULT")).not.toContain("SOCIAL_STUDIO");
    // Every revocation above was customer A's: B's project kept its module.
    expect(await isOn(projectB, "SOCIAL_STUDIO")).toBe(true);
    const bRow = (await activeApproval(customerB, "SOCIAL_STUDIO", null))!;
    expect((await revokeModuleApproval(bRow.id, {}, form({ reason: "B done", operatorPassword: "operator-password" }))).success).toBeTruthy();
    expect(await isOn(projectB, "SOCIAL_STUDIO")).toBe(false);
  });
});

describe("the audit record", () => {
  let id = "";
  beforeAll(async () => {
    id = (await rawPrisma.moduleApproval.create({ data: { customerId: customerA, targetProjectId: projectA2, featureKey: "WHATSAPP_AVATARS", reason: "audit test", approvedByUsername: "test" } })).id;
  });

  it("refuses revocation details on an active approval, and a partial or reasonless revocation", async () => {
    await expect(rawPrisma.moduleApproval.update({ where: { id }, data: { revokeReason: "sneaky" } })).rejects.toThrow(/together with the revocation/);
    await expect(rawPrisma.moduleApproval.update({ where: { id }, data: { revokedByUsername: "x", revokedByOperatorId: "x" } })).rejects.toThrow(/together with the revocation/);
    await expect(rawPrisma.moduleApproval.update({ where: { id }, data: { revokedAt: new Date() } })).rejects.toThrow(/operator and a reason/);
    await expect(rawPrisma.moduleApproval.update({ where: { id }, data: { revokedAt: new Date(), revokedByOperatorId: "op", revokedByUsername: "op", revokeReason: "  " } })).rejects.toThrow(/operator and a reason/);
    await expect(
      rawPrisma.moduleApproval.update({ where: { id }, data: { revokedAt: new Date(Date.now() + 86_400_000), revokedByOperatorId: "op", revokedByUsername: "op", revokeReason: "future" } }),
    ).rejects.toThrow(/after the approval and not in the future/);
    expect(await rawPrisma.moduleApproval.findUnique({ where: { id } })).toMatchObject({ revokedAt: null, revokeReason: null, revokedByUsername: null, revokedByOperatorId: null });
  });

  it("accepts one complete revocation, then never changes again", async () => {
    await rawPrisma.moduleApproval.update({ where: { id }, data: { revokedAt: new Date(), revokedByOperatorId: "op", revokedByUsername: "op", revokeReason: "complete" } });
    await expect(rawPrisma.moduleApproval.update({ where: { id }, data: { revokeReason: "edited later" } })).rejects.toThrow(/revoked module approval cannot be changed/);
    await expect(rawPrisma.moduleApproval.update({ where: { id }, data: { revokedByUsername: "someone else" } })).rejects.toThrow(/revoked module approval cannot be changed/);
  });

  it("cannot be deleted directly", async () => {
    await expect(rawPrisma.moduleApproval.delete({ where: { id } })).rejects.toThrow(/audit trail/);
    expect(await rawPrisma.moduleApproval.findUnique({ where: { id } })).not.toBeNull();
  });
});

describe("concurrency (real PostgreSQL locks)", () => {
  beforeAll(() => {
    operator = { sessionId: "s", operatorId: "op_test", username: `op_${tag}`, name: "Operator", canSupport: true, stepUpAt: new Date() };
  });

  it("an enable waiting on the approval lock holds no Project row, so a revocation in flight cannot deadlock with it", async () => {
    expect((await approve(customerA, { featureKey: "SOCIAL_STUDIO", scope: projectA2 })).success).toBeTruthy();
    const opened = await state(projectA2);

    // A revocation in flight, in the order revoke uses: the customer's approval lock first, then the Project row.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => (lockHeld = resolve));
    const revocation = rawPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`module-approval:${customerA}`}))`;
        lockHeld();
        await gate;
        await tx.project.update({ where: { id: projectA2 }, data: { moduleConfigVersion: { increment: 1 } } });
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    await held;

    // The Main Admin's enable starts while the lock is held. With the old order it took the Project row and then
    // waited for the lock; the revocation then waited for the row — PostgreSQL's deadlock detector aborted one.
    const enabling = inA(() =>
      applyProjectModules(projectA2, { modules: [...opened.enabled, "SOCIAL_STUDIO"], declined: [], baseType: null, expectedVersion: opened.version, reason: "race" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
    release();

    await expect(revocation).resolves.toBeUndefined();
    const r = await enabling;
    // The revocation moved the version on first, so the enable is refused as stale — never a deadlock error.
    expect(r.error).toMatch(/changed this project's modules/);
    expect(await isOn(projectA2, "SOCIAL_STUDIO")).toBe(false);
    const row = (await activeApproval(customerA, "SOCIAL_STUDIO", projectA2))!;
    expect((await revokeModuleApproval(row.id, {}, form({ reason: "cleanup", operatorPassword: "operator-password" }))).success).toBeTruthy();
  });

  it("enable and revoke fired together, repeatedly: no deadlock, and the module always ends switched off", async () => {
    for (let round = 0; round < 12; round++) {
      expect((await approve(customerA, { featureKey: "SOCIAL_STUDIO", scope: projectA2 })).success, `round ${round}`).toBeTruthy();
      const row = (await activeApproval(customerA, "SOCIAL_STUDIO", projectA2))!;
      const opened = await state(projectA2);
      const enable = () =>
        inA(() => applyProjectModules(projectA2, { modules: [...opened.enabled, "SOCIAL_STUDIO"], declined: [], baseType: null, expectedVersion: opened.version, reason: `round ${round}` }));
      const revoke = () => revokeModuleApproval(row.id, {}, form({ reason: `round ${round}`, operatorPassword: "operator-password" }));
      // Alternate which one starts first, with a little stagger, so both interleavings are exercised.
      const [first, second] = round % 2 === 0 ? [enable, revoke] : [revoke, enable];
      const results = await Promise.allSettled([first(), new Promise((resolve) => setTimeout(resolve, round % 3)).then(second)]);
      for (const result of results) expect(result.status, `round ${round}: ${result.status === "rejected" ? String(result.reason) : ""}`).toBe("fulfilled");
      expect((await rawPrisma.moduleApproval.findUnique({ where: { id: row.id } }))!.revokedAt).not.toBeNull();
      expect(await isOn(projectA2, "SOCIAL_STUDIO"), `round ${round}`).toBe(false);
    }
  });
});

