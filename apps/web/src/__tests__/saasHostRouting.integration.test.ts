import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";

/**
 * SaaS hostname routing (SAAS_PLATFORM_PLAN.md §3.3–§3.5), through the REAL sign-in, sessions,
 * project access and permission checks — only the request plumbing (headers, cookies) is stubbed.
 * Two customers, A and B, each with a project; Shared has access to both; Admin is a Main Admin.
 * What must hold:
 *   - with routing OFF nothing changes for anyone (the state every install deploys in);
 *   - a customer's address opens only that customer's project — for Shared and for a Main Admin too;
 *   - the admin address opens every project for a Main Admin and none for a customer's staff;
 *   - an unknown address opens nothing and nobody can sign in on it;
 *   - platform permissions do not exist on a customer's address;
 *   - a session works only on the address it was made on;
 *   - Caddy may get a certificate only for a verified or admin address;
 *   - domain checks move the status step by step, and routing cannot be switched on from an
 *     address that would lose the portal.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const host = { a: `a-${tag}.nexora.test`, b: `b-${tag}.nexora.test`, admin: `admin-${tag}.nexora.test`, unknown: `x-${tag}.nexora.test` };
const PASSWORD = "Test-password-123";

// --- request plumbing -------------------------------------------------------------------------
const request = { host: "", project: "" as string | null };
const jar = new Map<string, string>();
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => {
    const h = new Headers({ "x-nexora-host": request.host, "user-agent": "vitest" });
    if (request.project) h.set("x-softify-project", request.project);
    return h;
  },
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw Object.assign(new Error(`REDIRECT ${to}`), { redirectTo: to });
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const auth = await import("@/server/auth");
const { login } = await import("@/app/(auth)/login/actions");
const context = await import("@/server/projectContext");
const { forgetHostScopes } = await import("@/server/hostScope");
const { hasPermission } = await import("@/server/permissions");
const saas = await import("@/server/actions/saas");
const { setDomainNetworkForTests, domainCheckAnswer } = await import("@/server/domainVerification");
const tlsRoute = await import("@/app/api/platform/tls-allowed/route");

const ids = { users: [] as string[], roles: [] as string[], projects: [] as string[], customers: [] as string[] };
const people = {} as Record<"alice" | "bob" | "shared" | "admin", { id: string; username: string }>;
const project = {} as Record<"a" | "b", { id: string; slug: string }>;
const customer = {} as Record<"a" | "b", string>;

async function role(name: string, keys: string[]) {
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
async function person(name: string, roleId: string, projectIds: string[]) {
  const username = `${name}_${tag}`.toLowerCase();
  const u = await rawPrisma.user.create({ data: { username, email: `${username}@example.test`, name, passwordHash: auth.hashPassword(PASSWORD), permissionModuleId: roleId } });
  ids.users.push(u.id);
  for (const projectId of projectIds) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  return { id: u.id, username };
}

/** Sign in as `who` on `on`, through the real login action. Returns whether it succeeded. */
async function signIn(who: { username: string }, on: string): Promise<boolean> {
  jar.clear();
  request.host = on;
  request.project = null;
  const form = new FormData();
  form.set("username", who.username);
  form.set("password", PASSWORD);
  try {
    const result = await login({}, form);
    return !result.error;
  } catch (err) {
    if ((err as { redirectTo?: string }).redirectTo === "/open") return true;
    throw err;
  }
}

/** May the signed-in person open `slug` on `on`? Uses the real access check. */
async function opens(on: string, slug: string): Promise<boolean> {
  request.host = on;
  request.project = slug;
  context.forgetProjectAccessDecisions();
  try {
    await context.requireActiveProject();
    return true;
  } catch (err) {
    if ((err as Error).name === "ProjectAccessError") return false;
    throw err;
  }
}

async function setRouting(enabled: boolean) {
  await rawPrisma.platformDomainSettings.upsert({
    where: { id: "default" },
    create: { id: "default", hostRoutingEnabled: enabled, rootDomain: "nexora.test", adminHostnames: [host.admin], publicIps: ["203.0.113.10"] },
    update: { hostRoutingEnabled: enabled, rootDomain: "nexora.test", adminHostnames: [host.admin], publicIps: ["203.0.113.10"] },
  });
  forgetHostScopes();
  context.forgetProjectAccessDecisions();
}

beforeAll(async () => {
  await rawPrisma.platformDomainSettings.deleteMany({});
  const staffRole = await role("SaaS staff", ["messages.view"]);
  const adminRole = await role("SaaS main admin", ["projects.view", "projects.manage", "users.view", "messages.view"]);
  people.admin = await person("Admin", adminRole, []);
  for (const key of ["a", "b"] as const) {
    const p = await createProjectWithDefaults({ name: `SaaS ${key.toUpperCase()} ${tag}`, slug: `saas-${key}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.id }, rawPrisma);
    ids.projects.push(p.id);
    project[key] = p;
    const c = await rawPrisma.customer.create({ data: { name: `Customer ${key.toUpperCase()} ${tag}` } });
    ids.customers.push(c.id);
    customer[key] = c.id;
    await rawPrisma.project.update({ where: { id: p.id }, data: { customerId: c.id } });
    await rawPrisma.customerDomain.create({ data: { customerId: c.id, hostname: host[key], status: "ACTIVE", verificationToken: `token-${key}-${tag}` } });
  }
  people.alice = await person("Alice", staffRole, [project.a.id]);
  people.bob = await person("Bob", staffRole, [project.b.id]);
  people.shared = await person("Shared", staffRole, [project.a.id, project.b.id]);
});

beforeEach(async () => {
  setDomainNetworkForTests(null);
  await setRouting(true);
});

afterAll(async () => {
  setDomainNetworkForTests(null);
  await rawPrisma.platformDomainSettings.deleteMany({});
  await rawPrisma.userSession.deleteMany({ where: { userId: { in: ids.users } } });
  // Projects created with every default own many rows; on this throwaway database they are
  // detached and archived rather than deleted.
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: { in: ids.projects } } });
  await rawPrisma.project.updateMany({ where: { id: { in: ids.projects } }, data: { customerId: null, status: "ARCHIVED" } });
  await rawPrisma.customer.deleteMany({ where: { id: { in: ids.customers } } });
  await rawPrisma.customer.deleteMany({ where: { name: { contains: tag } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetHostScopes();
});

describe("with routing OFF nothing changes", () => {
  it("anyone signs in anywhere and opens exactly the projects they could before", async () => {
    await setRouting(false);
    expect(await signIn(people.shared, host.unknown)).toBe(true);
    expect(await opens(host.unknown, project.a.slug)).toBe(true);
    expect(await opens(host.unknown, project.b.slug)).toBe(true);
    expect(await signIn(people.alice, host.b)).toBe(true);
    expect(await opens(host.b, project.a.slug)).toBe(true);
    expect(await opens(host.b, project.b.slug)).toBe(false); // no access, exactly as before
  });
});

describe("a customer's address opens only that customer", () => {
  it("someone with access to both customers sees only the one whose address they are on", async () => {
    expect(await signIn(people.shared, host.a)).toBe(true);
    expect(await opens(host.a, project.a.slug)).toBe(true);
    expect(await opens(host.a, project.b.slug)).toBe(false);
    request.host = host.a;
    expect((await context.accessibleProjects(people.shared.id)).map((p) => p.slug)).toEqual([project.a.slug]);

    expect(await signIn(people.shared, host.b)).toBe(true);
    expect(await opens(host.b, project.b.slug)).toBe(true);
    expect(await opens(host.b, project.a.slug)).toBe(false);
  });

  it("a Main Admin on a customer's address is confined to that customer, and holds no platform permission there", async () => {
    expect(await signIn(people.admin, host.a)).toBe(true);
    expect(await opens(host.a, project.a.slug)).toBe(true);
    expect(await opens(host.a, project.b.slug)).toBe(false);
    request.host = host.a;
    request.project = null;
    const session = (await auth.getSession())!;
    expect(await hasPermission(session, "projects.manage")).toBe(false);
    expect(await hasPermission(session, "users.view")).toBe(false);
    // A Server Action posted from here is refused even though the person is a Main Admin.
    expect((await saas.disableCustomerDomain("whatever")).error).toMatch(/Main Admin/);
  });

  it("a customer's people cannot sign in on another customer's address — with the wrong-password message", async () => {
    expect(await signIn(people.alice, host.b)).toBe(false);
    expect(await signIn(people.bob, host.a)).toBe(false);
    expect(await signIn(people.alice, host.a)).toBe(true);
  });
});

describe("the admin address", () => {
  it("opens every project for a Main Admin, with the platform permissions", async () => {
    expect(await signIn(people.admin, host.admin)).toBe(true);
    expect(await opens(host.admin, project.a.slug)).toBe(true);
    expect(await opens(host.admin, project.b.slug)).toBe(true);
    request.host = host.admin;
    request.project = null;
    expect(await hasPermission((await auth.getSession())!, "projects.manage")).toBe(true);
  });

  it("refuses a customer's staff at sign-in", async () => {
    expect(await signIn(people.alice, host.admin)).toBe(false);
    expect(await signIn(people.shared, host.admin)).toBe(false);
  });
});

describe("an unknown address", () => {
  it("opens nothing and nobody signs in on it, a Main Admin included", async () => {
    expect(await signIn(people.admin, host.unknown)).toBe(false);
    expect(await signIn(people.shared, host.unknown)).toBe(false);
    // Even a session made elsewhere (and an unbound older one) opens nothing here.
    expect(await signIn(people.admin, host.admin)).toBe(true);
    await rawPrisma.userSession.updateMany({ where: { userId: people.admin.id }, data: { hostname: null } });
    expect(await opens(host.unknown, project.a.slug)).toBe(false);
  });

  it("a disabled address is unknown at once", async () => {
    await rawPrisma.customerDomain.update({ where: { hostname: host.b }, data: { status: "DISABLED" } });
    forgetHostScopes();
    try {
      expect(await signIn(people.bob, host.b)).toBe(false);
    } finally {
      await rawPrisma.customerDomain.update({ where: { hostname: host.b }, data: { status: "ACTIVE" } });
      forgetHostScopes();
    }
  });
});

describe("a session belongs to its address", () => {
  it("is refused on another address, even by someone with access there", async () => {
    expect(await signIn(people.shared, host.a)).toBe(true);
    request.host = host.a;
    expect((await auth.getSession())?.userId).toBe(people.shared.id);
    request.host = host.b; // the same cookie, carried to B by hand
    expect(await auth.getSession()).toBeNull();
    expect(await opens(host.b, project.b.slug)).toBe(false);
  });
});

describe("Caddy's certificate question", () => {
  const ask = async (domain: string) => (await tlsRoute.GET(new Request(`http://127.0.0.1:8668/api/platform/tls-allowed?domain=${domain}`))).status;
  it("yes only for a verified or live customer address and the admin address", async () => {
    expect(await ask(host.a)).toBe(200);
    expect(await ask(host.admin)).toBe(200);
    expect(await ask(host.unknown)).toBe(404);
    expect(await ask("not a host")).toBe(404);
    const pending = await rawPrisma.customerDomain.create({ data: { customerId: customer.a, hostname: `p-${tag}.nexora.test`, verificationToken: "t" } });
    expect(await ask(pending.hostname)).toBe(404);
    await rawPrisma.customerDomain.update({ where: { id: pending.id }, data: { status: "DISABLED" } });
    expect(await ask(pending.hostname)).toBe(404);
    await rawPrisma.customerDomain.delete({ where: { id: pending.id } });
  });
});

describe("managing addresses (admin address, Main Admin)", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("refuses reserved names, deep subdomains and an address another customer has", async () => {
    expect(await signIn(people.admin, host.admin)).toBe(true);
    expect((await saas.addCustomerDomain(customer.a, {}, form({ hostname: "www.nexora.test" }))).error).toMatch(/reserved/);
    expect((await saas.addCustomerDomain(customer.a, {}, form({ hostname: "x.y.nexora.test" }))).error).toMatch(/one level/);
    expect((await saas.addCustomerDomain(customer.a, {}, form({ hostname: host.b }))).error).toMatch(/already assigned/);
  });

  it("a check moves PENDING → VERIFIED → ACTIVE step by step, and explains each failure", async () => {
    expect(await signIn(people.admin, host.admin)).toBe(true);
    const hostname = `new-${tag}.nexora.test`;
    expect((await saas.addCustomerDomain(customer.a, {}, form({ hostname }))).success).toBeTruthy();
    const domain = await rawPrisma.customerDomain.findUniqueOrThrow({ where: { hostname } });
    const answer = domainCheckAnswer(domain.verificationToken);
    const net = { ips: ["198.51.100.7"], http: { status: 200, body: answer } as { status: number; body: string } | { error: string }, https: { error: "CERT_HAS_EXPIRED" } as { status: number; body: string } | { error: string } };
    setDomainNetworkForTests({
      resolveAddresses: async () => net.ips,
      get: async (url) => (url.startsWith("https://") ? net.https : net.http),
    });

    // DNS points elsewhere: stays PENDING, and the message says where it points.
    let result = await saas.checkCustomerDomain(domain.id);
    expect(result.error).toMatch(/198\.51\.100\.7/);
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe("PENDING");

    // Right IP, but something else answers: still PENDING.
    net.ips = ["203.0.113.10"];
    net.http = { status: 404, body: "nope" };
    result = await saas.checkCustomerDomain(domain.id);
    expect(result.error).toMatch(/another application/);
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe("PENDING");

    // Reaches this app, HTTPS not ready: VERIFIED — Caddy may now get the certificate.
    net.http = { status: 200, body: answer };
    result = await saas.checkCustomerDomain(domain.id);
    expect(result.error).toMatch(/certificate/);
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe("VERIFIED");
    expect((await tlsRoute.GET(new Request(`http://127.0.0.1/api/platform/tls-allowed?domain=${hostname}`))).status).toBe(200);

    // HTTPS works: ACTIVE.
    net.https = { status: 200, body: answer };
    result = await saas.checkCustomerDomain(domain.id);
    expect(result.success).toMatch(/live/);
    const live = await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: domain.id } });
    expect(live.status).toBe("ACTIVE");
    expect(live.activatedAt).not.toBeNull();

    // A later failed check does not take a live address down.
    net.ips = [];
    await saas.checkCustomerDomain(domain.id);
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe("ACTIVE");

    // Disable: off at once; it must be disabled before it can be removed.
    expect((await saas.removeCustomerDomain(domain.id)).error).toMatch(/Disable/);
    expect((await saas.disableCustomerDomain(domain.id)).success).toBeTruthy();
    expect((await tlsRoute.GET(new Request(`http://127.0.0.1/api/platform/tls-allowed?domain=${hostname}`))).status).toBe(404);
    expect((await saas.removeCustomerDomain(domain.id)).success).toBeTruthy();
  });

  it("routing cannot be switched on from an address that is not an admin address", async () => {
    await setRouting(false);
    expect(await signIn(people.admin, host.a)).toBe(true);
    request.host = host.a;
    const state = await saas.saveDomainSettings(
      {},
      form({ rootDomain: "nexora.test", adminHostnames: host.admin, publicIps: "203.0.113.10", reservedLabels: "", hostRoutingEnabled: "on" }),
    );
    expect(state.fieldErrors?.hostRoutingEnabled).toMatch(/lose access/);
    expect((await rawPrisma.platformDomainSettings.findUniqueOrThrow({ where: { id: "default" } })).hostRoutingEnabled).toBe(false);
  });

  it("adopting an existing project attaches it without changing it; a project already taken is refused", async () => {
    expect(await signIn(people.admin, host.admin)).toBe(true);
    const free = await createProjectWithDefaults({ name: `Adopt ${tag}`, slug: `adopt-${tag}`, status: "ACTIVE", creatorUserId: people.admin.id }, rawPrisma);
    ids.projects.push(free.id);
    let created: string | null = null;
    try {
      await saas.createCustomer({}, form({ name: `Adopted ${tag}`, projectMode: "existing", projectId: free.id }));
    } catch (err) {
      created = (err as { redirectTo?: string }).redirectTo ?? null;
    }
    expect(created).toMatch(/^\/admin\/customers\//);
    const after = await rawPrisma.project.findUniqueOrThrow({ where: { id: free.id } });
    expect(after).toMatchObject({ name: `Adopt ${tag}`, slug: `adopt-${tag}`, status: "ACTIVE" });
    expect(after.customerId).not.toBeNull();
    ids.customers.push(after.customerId!);

    const again = await saas.createCustomer({}, form({ name: `Twice ${tag}`, projectMode: "existing", projectId: project.a.id }));
    expect(again.fieldErrors?.projectId).toMatch(/already belongs/);
  });
});

describe("recovery: the platform admin cannot lock themselves out", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("with routing on, saving admin addresses that leave out the address in use is refused", async () => {
    expect(await signIn(people.admin, host.admin)).toBe(true);
    request.host = host.admin;
    const state = await saas.saveDomainSettings(
      {},
      form({ rootDomain: "nexora.test", adminHostnames: `other-${tag}.nexora.test`, publicIps: "203.0.113.10", reservedLabels: "", hostRoutingEnabled: "on" }),
    );
    expect(state.fieldErrors?.hostRoutingEnabled).toMatch(/lose access/);
    expect((await rawPrisma.platformDomainSettings.findUniqueOrThrow({ where: { id: "default" } })).adminHostnames).toEqual([host.admin]);
  });

  it("the server's emergency switch forces routing off without touching the database", async () => {
    // Routing is ON in the database here; an unknown address normally lets nobody in.
    expect(await signIn(people.admin, host.unknown)).toBe(false);
    process.env.SAAS_HOST_ROUTING_DISABLED = "true";
    try {
      expect(await signIn(people.admin, host.unknown)).toBe(true);
      expect(await opens(host.unknown, project.b.slug)).toBe(true);
      expect((await rawPrisma.platformDomainSettings.findUniqueOrThrow({ where: { id: "default" } })).hostRoutingEnabled).toBe(true);
    } finally {
      delete process.env.SAAS_HOST_ROUTING_DISABLED;
    }
  });

  it("the server itself (localhost, its IP) is always open, for a tunnel when every name is lost", async () => {
    expect(await signIn(people.admin, "127.0.0.1:8668")).toBe(true);
    expect(await opens("127.0.0.1:8668", project.a.slug)).toBe(true);
    expect(await signIn(people.admin, "localhost:8668")).toBe(true);
  });
});
