import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ensureDefaultRoles, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";

/**
 * One customer can neither see nor block another. A project's address, an employee number and a linked Google account
 * are each unique inside a customer, and what belongs to the software owner (Forge, which reads the owner's private
 * repositories with the installation's key) is out of a customer's reach whatever its switches say.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const host = { a: `a-${tag}.example.test`, b: `b-${tag}.example.test`, admin: `admin-${tag}.example.test` };
const SHARED_SLUG = `same-${tag}`;
const USERNAME = `admin${tag}`;
const PASSWORD = "a-long-enough-password";
const request: { host: string; project: string | null } = { host: "", project: null };
const jar = new Map<string, string>();

vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "x-relqivo-host": request.host, "user-agent": "vitest", ...(request.project ? { "x-softify-project": request.project } : {}) }),
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
const { requireActiveProject, ProjectAccessError } = await import("@/server/projectContext");
const { createProject } = await import("@/server/actions/projects");
const { nextEmployeeCode } = await import("@/server/configuration");
const { completeIdentityLink, GoogleIdentityError } = await import("@/server/google/identity");
const { disabledFeaturesFor, forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const { getProjectModuleState } = await import("@/server/projectModules");

const fx = {} as { a: string; b: string; projectA: string; projectB: string; roleA: string; roleB: string; userA: string; userB: string };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

async function signIn(on: string): Promise<void> {
  request.host = on;
  request.project = null;
  jar.clear();
  forgetHostScopes();
  try {
    await login({}, form({ username: USERNAME, password: PASSWORD }));
  } catch (err) {
    if (!String((err as Error).message).startsWith("NEXT_REDIRECT")) throw err;
  }
}

/** Google answering "this account is <subject>" for the identity link. */
const googleSays = (subject: string) =>
  (async (url: string | URL | Request) =>
    String(url).includes("token")
      ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600, token_type: "Bearer" }), { status: 200 })
      : new Response(JSON.stringify({ sub: subject, email: `${subject}@example.test`, name: "Person" }), { status: 200 })) as typeof fetch;
const googleConfig = { clientId: "id", clientSecret: "secret", redirectUri: "https://example.test/cb" };

beforeAll(async () => {
  await rawPrisma.platformDomainSettings.deleteMany({});
  for (const k of ["a", "b"] as const) {
    const customer = await rawPrisma.customer.create({ data: { name: `${k} ${tag}` } });
    const roles = await ensureDefaultRoles(rawPrisma, customer.id);
    const project = await createProjectWithDefaults({ name: `${k} ${tag}`, slug: `${k}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: customer.id }, rawPrisma);
    const manage = await rawPrisma.permission.upsert({ where: { key: "projects.manage" }, update: {}, create: { key: "projects.manage", label: "Manage Projects and Project Access", category: "Projects" } });
    await rawPrisma.permissionModulePermission.createMany({ data: [{ permissionModuleId: roles.administratorId, permissionId: manage.id }], skipDuplicates: true });
    fx[k] = customer.id;
    fx[k === "a" ? "projectA" : "projectB"] = project.id;
    fx[k === "a" ? "roleA" : "roleB"] = roles.administratorId;
    await rawPrisma.customerDomain.create({ data: { customerId: customer.id, hostname: host[k], status: "ACTIVE", verificationToken: `t-${k}-${tag}` } });
    const created = await runWithTenant(customer.id, () =>
      createUserWithAccess(platformPrisma, {
        username: USERNAME,
        name: "Owner",
        email: null,
        password: PASSWORD,
        confirmPassword: PASSWORD,
        permissionModuleId: roles.administratorId,
        employee: null,
        access: [{ projectId: project.id, level: "FULL" }],
      }),
    );
    fx[k === "a" ? "userA" : "userB"] = (created as { userId: string }).userId;
  }
  await rawPrisma.platformDomainSettings.create({ data: { id: "default", hostRoutingEnabled: true, rootDomain: "example.test", adminHostnames: [host.admin] } });
  forgetHostScopes();
});

beforeEach(() => forgetHostScopes());

afterAll(async () => {
  await rawPrisma.platformDomainSettings.deleteMany({});
  await rawPrisma.customerDomain.deleteMany({ where: { hostname: { contains: tag } } });
  await rawPrisma.securitySettings.deleteMany({ where: { customerId: { in: [fx.a, fx.b] } } });
  await rawPrisma.employeeCodeCounter.deleteMany({ where: { tenantKey: { in: [fx.a, fx.b] } } });
  forgetHostScopes();
});

describe("a project's address", () => {
  it("two customers may use the same one, and each person opens their own", async () => {
    const second = await createProjectWithDefaults({ name: "Same A", slug: SHARED_SLUG, status: "ACTIVE", creatorUserId: fx.userA, customerId: fx.a }, rawPrisma);
    const first = await createProjectWithDefaults({ name: "Same B", slug: SHARED_SLUG, status: "ACTIVE", creatorUserId: fx.userB, customerId: fx.b }, rawPrisma);
    await rawPrisma.projectAccess.createMany({
      data: [
        { projectId: second.id, userId: fx.userA },
        { projectId: first.id, userId: fx.userB },
      ],
      skipDuplicates: true,
    });

    await signIn(host.a);
    request.project = SHARED_SLUG;
    expect((await requireActiveProject()).id).toBe(second.id);

    await signIn(host.b);
    request.project = SHARED_SLUG;
    expect((await requireActiveProject()).id).toBe(first.id);
  });

  it("another customer's address is unknown, not forbidden", async () => {
    await signIn(host.a);
    request.project = `b-${tag}`;
    await expect(requireActiveProject()).rejects.toBeInstanceOf(ProjectAccessError);
    await expect(requireActiveProject()).rejects.toMatchObject({ reason: "UNKNOWN_PROJECT" });
  });

  it("the New project form is not refused by another customer's address, and says nothing about it", async () => {
    await signIn(host.a);
    const taken = `b-${tag}`;
    let refusal: { fieldErrors?: { slug?: string } } = {};
    try {
      refusal = await createProject({}, form({ name: "Mine too", slug: taken, status: "SETUP", description: "" }));
    } catch (err) {
      if (!String((err as Error).message).startsWith("NEXT_REDIRECT")) throw err;
    }
    expect(refusal.fieldErrors?.slug).toBeUndefined();
    expect(await rawPrisma.project.count({ where: { slug: taken, customerId: fx.a } })).toBe(1);
    expect(await rawPrisma.project.count({ where: { slug: taken, customerId: fx.b } })).toBe(1);
  });

  it("inside one customer an address still belongs to one project", async () => {
    await expect(createProjectWithDefaults({ name: "Twice", slug: `a-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: fx.a }, rawPrisma)).rejects.toMatchObject({ code: "P2002" });
    await signIn(host.a);
    const refused = await createProject({}, form({ name: "Twice", slug: `a-${tag}`, status: "SETUP", description: "" }));
    expect(refused.fieldErrors?.slug).toContain("already have");
  });
});

describe("employee numbers", () => {
  it("each customer counts from 1, so no number says how many others exist", async () => {
    const inA = () => runWithTenant(fx.a, () => nextEmployeeCode(platformPrisma as never));
    const inB = () => runWithTenant(fx.b, () => nextEmployeeCode(platformPrisma as never));
    expect(await inA()).toBe("EMP-000001");
    expect(await inA()).toBe("EMP-000002");
    expect(await inB()).toBe("EMP-000001");
    await rawPrisma.employee.create({ data: { employeeCode: "EMP-000001", fullName: "A", customerId: fx.a } });
    await rawPrisma.employee.create({ data: { employeeCode: "EMP-000001", fullName: "B", customerId: fx.b } });
    await expect(rawPrisma.employee.create({ data: { employeeCode: "EMP-000001", fullName: "Again", customerId: fx.b } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("two people created at once never get the same number", async () => {
    const codes = await Promise.all(Array.from({ length: 8 }, () => runWithTenant(fx.a, () => nextEmployeeCode(platformPrisma as never))));
    expect(new Set(codes).size).toBe(8);
  });
});

describe("a linked Google account", () => {
  const subject = `google-${tag}`;
  const link = (userId: string, on: string) => {
    request.host = on;
    return completeIdentityLink({ config: googleConfig as never, code: "c", verifier: "v", userId, fetchImpl: googleSays(subject) as never });
  };

  it("one customer's link does not block the same account in another", async () => {
    await signIn(host.a);
    await link(fx.userA, host.a);
    await signIn(host.b);
    await link(fx.userB, host.b);
    const rows = await rawPrisma.userGoogleIdentity.findMany({ where: { googleSubject: subject }, orderBy: { customerKey: "asc" } });
    expect(rows.map((r) => r.customerKey).sort()).toEqual([fx.a, fx.b].sort());
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([fx.userA, fx.userB]));
  });

  it("inside one customer it still belongs to one person", async () => {
    const colleague = await rawPrisma.user.create({ data: { username: `colleague${tag}`, name: "C", passwordHash: "x", customerId: fx.a } });
    await signIn(host.a);
    await expect(link(colleague.id, host.a)).rejects.toBeInstanceOf(GoogleIdentityError);
  });
});

describe("what belongs to the software owner", () => {
  it("Forge is off for a customer even with its switch on, and stays available in the original installation", async () => {
    await rawPrisma.projectFeature.upsert({
      where: { projectId_key: { projectId: fx.projectA, key: "PRODUCT_KNOWLEDGE_FORGE" } },
      update: { enabled: true },
      create: { projectId: fx.projectA, key: "PRODUCT_KNOWLEDGE_FORGE", enabled: true },
    });
    forgetProjectFeatureStates();
    await signIn(host.a);
    expect((await disabledFeaturesFor(fx.projectA)).has("PRODUCT_KNOWLEDGE_FORGE")).toBe(true);
    expect((await disabledFeaturesFor(ORIGINAL_PROJECT_ID)).has("PRODUCT_KNOWLEDGE_FORGE")).toBe(false);
  });

  it("the Module Builder does not offer it to a customer", async () => {
    await signIn(host.a);
    expect((await getProjectModuleState(fx.projectA))?.hidden).toContain("PRODUCT_KNOWLEDGE_FORGE");
  });
});
