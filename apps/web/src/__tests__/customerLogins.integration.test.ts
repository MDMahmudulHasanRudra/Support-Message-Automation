import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ensureDefaultRoles, prisma as rawPrisma } from "@support-automation/db";

/**
 * Each customer has its own logins. "admin" at one customer says nothing about "admin" at another: the same username
 * and email may exist in both, sign-in is decided by the customer's address, and a password from one never opens the
 * other. Inside one customer a username still belongs to one person.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const host = { a: `a-${tag}.example.test`, b: `b-${tag}.example.test`, admin: `admin-${tag}.example.test` };
const USERNAME = `admin${tag}`;
const EMAIL = `owner-${tag}@example.test`;
const PASSWORD = { a: "password-of-customer-a", b: "password-of-customer-b" };
const request = { host: "" };
const jar = new Map<string, string>();

vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "x-relqivo-host": request.host, "user-agent": "vitest" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string | { name: string }) => void jar.delete(typeof name === "string" ? name : name.name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${to}`), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

const { login } = await import("@/app/(auth)/login/actions");
const { forgetHostScopes } = await import("@/server/hostScope");
const { runWithTenant } = await import("@/server/tenant");
const { platformPrisma } = await import("@/server/db");
const { createUserWithAccess } = await import("@/server/adminUsers");
const { customerPasswordLength, passwordLengthForUser, projectPasswordLength } = await import("@/server/passwordPolicy");
const { getSession } = await import("@/server/auth");

const fx = {} as { a: string; b: string; projectA: string; projectB: string; roleA: string; roleB: string; userA: string; userB: string };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

/** The result of a sign-in, and the customer of the session it made. */
async function signIn(on: string, password: string): Promise<{ ok: boolean; userId?: string }> {
  request.host = on;
  jar.clear();
  forgetHostScopes();
  try {
    const result = await login({}, form({ username: USERNAME, password }));
    if (result.error) return { ok: false };
  } catch (err) {
    if (!String((err as Error).message).startsWith("NEXT_REDIRECT")) throw err;
  }
  const session = await getSession();
  return { ok: Boolean(session), userId: session?.userId };
}

const newLogin = (tenant: string, projectId: string, roleId: string, values: { username: string; email?: string | null; password: string }) =>
  runWithTenant(tenant, () =>
    createUserWithAccess(platformPrisma, {
      username: values.username,
      name: "Owner",
      email: values.email ?? null,
      password: values.password,
      confirmPassword: values.password,
      permissionModuleId: roleId,
      employee: null,
      access: [{ projectId, level: "FULL" }],
    }),
  );

beforeAll(async () => {
  await rawPrisma.platformDomainSettings.deleteMany({});
  for (const k of ["a", "b"] as const) {
    const customer = await rawPrisma.customer.create({ data: { name: `${k} ${tag}` } });
    const roles = await ensureDefaultRoles(rawPrisma, customer.id);
    const project = await createProjectWithDefaults({ name: `${k} ${tag}`, slug: `${k}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: customer.id }, rawPrisma);
    fx[k] = customer.id;
    fx[k === "a" ? "projectA" : "projectB"] = project.id;
    fx[k === "a" ? "roleA" : "roleB"] = roles.administratorId;
    await rawPrisma.customerDomain.create({ data: { customerId: customer.id, hostname: host[k], status: "ACTIVE", verificationToken: `t-${k}-${tag}`, activatedAt: new Date() } });
  }
  await rawPrisma.platformDomainSettings.create({ data: { id: "default", hostRoutingEnabled: true, rootDomain: "example.test", adminHostnames: [host.admin], publicIps: ["203.0.113.10"] } });
  forgetHostScopes();
});

beforeEach(() => forgetHostScopes());

afterAll(async () => {
  await rawPrisma.platformDomainSettings.deleteMany({});
  await rawPrisma.customerDomain.deleteMany({ where: { hostname: { contains: tag } } });
  await rawPrisma.securitySettings.deleteMany({ where: { customerId: { in: [fx.a, fx.b] } } });
  forgetHostScopes();
});

describe("the same username in two customers", () => {
  it("both customers can have it, with the same email too", async () => {
    const a = await newLogin(fx.a, fx.projectA, fx.roleA, { username: USERNAME, email: EMAIL, password: PASSWORD.a });
    const b = await newLogin(fx.b, fx.projectB, fx.roleB, { username: USERNAME, email: EMAIL, password: PASSWORD.b });
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    fx.userA = (a as { userId: string }).userId;
    fx.userB = (b as { userId: string }).userId;
    expect(fx.userA).not.toBe(fx.userB);
  });

  it("inside one customer a username and an email still belong to one person", async () => {
    expect(await newLogin(fx.a, fx.projectA, fx.roleA, { username: USERNAME, password: "another-long-password" })).toMatchObject({ ok: false });
    expect(await newLogin(fx.a, fx.projectA, fx.roleA, { username: `other${tag}`, email: EMAIL, password: "another-long-password" })).toMatchObject({ ok: false });
    // The database itself refuses, whatever code tries.
    await expect(rawPrisma.user.create({ data: { username: USERNAME, name: "x", passwordHash: "x", customerId: fx.a } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("each address signs in its own person, and one customer's password never opens the other", async () => {
    expect(await signIn(host.a, PASSWORD.a)).toEqual({ ok: true, userId: fx.userA });
    expect(await signIn(host.b, PASSWORD.b)).toEqual({ ok: true, userId: fx.userB });
    expect((await signIn(host.a, PASSWORD.b)).ok).toBe(false);
    expect((await signIn(host.b, PASSWORD.a)).ok).toBe(false);
  });

  it("the platform address signs in neither", async () => {
    expect((await signIn(host.admin, PASSWORD.a)).ok).toBe(false);
  });

  it("a failed sign-in at one customer does not count against the other's person", async () => {
    await rawPrisma.user.updateMany({ where: { id: { in: [fx.userA, fx.userB] } }, data: { failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null } });
    await signIn(host.a, "wrong-password-here");
    expect((await rawPrisma.user.findUniqueOrThrow({ where: { id: fx.userA }, select: { failedLoginAttempts: true } })).failedLoginAttempts).toBe(1);
    const b = await rawPrisma.user.findUniqueOrThrow({ where: { id: fx.userB }, select: { failedLoginAttempts: true } });
    expect(b.failedLoginAttempts).toBe(0);
    await rawPrisma.user.update({ where: { id: fx.userA }, data: { failedLoginAttempts: 0, lastFailedLoginAt: null, lockedUntil: null } });
  });
});

describe("how long a password must be", () => {
  it("is 8 until a customer chooses, and each customer chooses for itself", async () => {
    expect(await customerPasswordLength(fx.a)).toBe(8);
    await rawPrisma.securitySettings.upsert({ where: { customerId: fx.a }, update: { minPasswordLength: 6 }, create: { id: `security-${fx.a}`, customerId: fx.a, minPasswordLength: 6 } });
    expect(await customerPasswordLength(fx.a)).toBe(6);
    expect(await customerPasswordLength(fx.b)).toBe(8);
    expect(await newLogin(fx.a, fx.projectA, fx.roleA, { username: `six${tag}`, password: "sixsix" })).toMatchObject({ ok: true });
    expect(await newLogin(fx.b, fx.projectB, fx.roleB, { username: `six${tag}`, password: "sixsix" })).toMatchObject({ ok: false });
  });

  it("a project's own length wins for that project, and for somebody only in it", async () => {
    await rawPrisma.project.update({ where: { id: fx.projectB }, data: { minPasswordLength: 20 } });
    expect(await projectPasswordLength(fx.projectB)).toBe(20);
    expect(await projectPasswordLength(fx.projectA)).toBe(6);
    expect(await passwordLengthForUser(fx.userB)).toBe(20);
    expect(await newLogin(fx.b, fx.projectB, fx.roleB, { username: `long${tag}`, password: "only-sixteen-len" })).toMatchObject({ ok: false });
    await rawPrisma.project.update({ where: { id: fx.projectB }, data: { minPasswordLength: null } });
  });

  it("the database refuses a length outside the limits", async () => {
    await expect(rawPrisma.project.update({ where: { id: fx.projectB }, data: { minPasswordLength: 3 } })).rejects.toBeTruthy();
    await expect(rawPrisma.securitySettings.update({ where: { customerId: fx.a }, data: { minPasswordLength: 500 } })).rejects.toBeTruthy();
  });
});
