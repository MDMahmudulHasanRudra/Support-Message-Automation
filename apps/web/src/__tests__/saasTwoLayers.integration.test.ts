import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, ensureDefaultRoles, PLATFORM_LOG_CUSTOMER, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";

/**
 * The two administration layers (SAAS_PLATFORM_PLAN.md §12), through the REAL sign-ins, sessions,
 * access checks, scoped database clients and actions — only the request plumbing is stubbed.
 *
 *   Layer 1 — the Nexora platform: its own operators, sign-in, session, pages; the admin address.
 *   Layer 2 — each customer's software: its own Main Admin, projects, users, roles and settings, on
 *             its own address, seeing nothing of any other customer.
 *
 * Fixture: the original installation (rows with no customer) adopted as the founding customer F on
 * address f; a second customer B on address b with its own roles, project and people; one operator.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const host = { f: `f-${tag}.nexora.test`, b: `b-${tag}.nexora.test`, admin: `admin-${tag}.nexora.test`, unknown: `x-${tag}.nexora.test` };
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
    delete: (name: string | { name: string }) => void jar.delete(typeof name === "string" ? name : name.name),
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
const { forgetFoundingCustomer } = await import("@/server/tenant");
const { hasPermission } = await import("@/server/permissions");
const { platformPrisma } = await import("@/server/db");
const { logSystemEvent } = await import("@/server/logSystemEvent");
const { requireMainAdminPage } = await import("@/server/mainAdmin");
const { platformLogin } = await import("@/app/platform/login/actions");
const { setupAllowed } = await import("@/app/platform/setup/actions");
const platform = await import("@/server/platform/actions/customers");
const supportActions = await import("@/server/platform/actions/support");
const { consumeSupportTicket } = await import("@/app/support-access/[ticket]/actions");
const { acceptInvitation } = await import("@/app/(auth)/invite/[token]/actions");
const billing = await import("@/server/platform/actions/billing");
const { setDomainNetworkForTests, domainCheckAnswer } = await import("@/server/domainVerification");
const tlsRoute = await import("@/app/api/platform/tls-allowed/route");

const created = { users: [] as string[], roles: [] as string[], projects: [] as string[], customers: [] as string[], operators: [] as string[] };
const people = {} as Record<"fAdmin" | "fStaff" | "bAdmin" | "bStaff", { id: string; username: string }>;
const project = {} as Record<"f" | "b", { id: string; slug: string }>;
const customer = {} as Record<"f" | "b", string>;
let foundingWasCreatedHere = false;
let operatorUsername = "";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function role(name: string, keys: string[], customerId: string | null) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, customerId, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  created.roles.push(r.id);
  return r.id;
}

async function person(name: string, roleId: string, customerId: string | null, projectIds: string[]) {
  const username = `${name}_${tag}`.toLowerCase();
  const u = await rawPrisma.user.create({ data: { username, email: `${username}@example.test`, name, passwordHash: auth.hashPassword(PASSWORD), permissionModuleId: roleId, customerId } });
  created.users.push(u.id);
  for (const projectId of projectIds) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  return { id: u.id, username };
}

async function signIn(who: { username: string }, on: string): Promise<boolean> {
  jar.delete("support_automation_session");
  request.host = on;
  request.project = null;
  try {
    return !(await login({}, form({ username: who.username, password: PASSWORD }))).error;
  } catch (err) {
    if ((err as { redirectTo?: string }).redirectTo === "/open") return true;
    throw err;
  }
}

async function operatorSignIn(on: string): Promise<boolean> {
  jar.delete("nexora_platform_session");
  request.host = on;
  request.project = null;
  try {
    return !(await platformLogin({}, form({ username: operatorUsername, password: PASSWORD }))).error;
  } catch (err) {
    if ((err as { redirectTo?: string }).redirectTo === "/platform") return true;
    throw err;
  }
}

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

/** Run as whoever is signed in on `on`, outside any project (a customer's Main Admin portal). */
async function inPortal<T>(on: string, fn: () => Promise<T>): Promise<T> {
  request.host = on;
  request.project = null;
  return fn();
}

function forgetCaches() {
  forgetHostScopes();
  forgetFoundingCustomer();
  context.forgetProjectAccessDecisions();
}

beforeAll(async () => {
  await rawPrisma.platformDomainSettings.deleteMany({});
  // The operator (Layer 1).
  operatorUsername = `op_${tag}`;
  const op = await rawPrisma.platformOperator.create({ data: { username: operatorUsername, name: "Operator", passwordHash: auth.hashPassword(PASSWORD) } });
  created.operators.push(op.id);

  // The original installation (no customer) and its people.
  const fRole = await role("F Administrator", ["projects.view", "projects.manage", "users.view", "users.create", "users.edit", "messages.view", "release_notes.manage", "permissions.view", "permissions.edit"], null);
  const fStaffRole = await role("F staff", ["messages.view"], null);
  const fProject = await createProjectWithDefaults({ name: `F ${tag}`, slug: `f-${tag}`, status: "ACTIVE", creatorUserId: null }, rawPrisma);
  created.projects.push(fProject.id);
  project.f = fProject;
  people.fAdmin = await person("fAdmin", fRole, null, []);
  people.fStaff = await person("fStaff", fStaffRole, null, [fProject.id]);

  // Customer B with its own copy of the software.
  const b = await rawPrisma.customer.create({ data: { name: `B ${tag}` } });
  created.customers.push(b.id);
  customer.b = b.id;
  const bRoles = await ensureDefaultRoles(rawPrisma, b.id);
  const bStaffRole = await role("B staff", ["messages.view"], b.id);
  const bProject = await createProjectWithDefaults({ name: `B ${tag}`, slug: `b-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: b.id }, rawPrisma);
  created.projects.push(bProject.id);
  project.b = bProject;
  people.bAdmin = await person("bAdmin", bRoles.administratorId, b.id, [bProject.id]);
  people.bStaff = await person("bStaff", bStaffRole, b.id, [bProject.id]);
  await rawPrisma.customerDomain.create({ data: { customerId: b.id, hostname: host.b, status: "ACTIVE", verificationToken: `t-b-${tag}` } });

  // The founding customer: adopted through the platform's own action unless a previous suite did.
  const existing = await rawPrisma.customer.findFirst({ where: { isFounding: true } });
  if (existing) customer.f = existing.id;
  else {
    expect(await operatorSignIn("localhost")).toBe(true);
    const before = { users: await rawPrisma.user.count({ where: { customerId: null } }), projects: await rawPrisma.project.count({ where: { customerId: null } }) };
    const result = await platform.createCustomer({}, form({ mode: "original", name: `F ${tag}` }));
    expect(result.created?.customerId).toBeTruthy();
    customer.f = result.created!.customerId;
    foundingWasCreatedHere = true;
    // Adopting changes nothing in the original installation.
    expect(await rawPrisma.user.count({ where: { customerId: null } })).toBe(before.users);
    expect(await rawPrisma.project.count({ where: { customerId: null } })).toBe(before.projects);
  }
  await rawPrisma.customerDomain.create({ data: { customerId: customer.f, hostname: host.f, status: "ACTIVE", verificationToken: `t-f-${tag}` } });

  await rawPrisma.platformDomainSettings.create({
    data: { id: "default", hostRoutingEnabled: true, rootDomain: "nexora.test", adminHostnames: [host.admin], publicIps: ["203.0.113.10"] },
  });
  forgetCaches();
});

beforeEach(() => {
  setDomainNetworkForTests(null);
  forgetCaches();
});

afterAll(async () => {
  setDomainNetworkForTests(null);
  await rawPrisma.platformDomainSettings.deleteMany({});
  const supportUsers = (await rawPrisma.user.findMany({ where: { supportOperatorId: { in: created.operators } }, select: { id: true } })).map((u) => u.id);
  const invited = (await rawPrisma.user.findMany({ where: { customerId: { in: created.customers } }, select: { id: true } })).map((u) => u.id);
  const users = [...new Set([...created.users, ...supportUsers, ...invited])];
  await rawPrisma.userSession.deleteMany({ where: { userId: { in: users } } });
  await rawPrisma.supportAccessSession.deleteMany({ where: { customerId: { in: [...created.customers, customer.f] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { OR: [{ projectId: { in: created.projects } }, { userId: { in: users } }] } });
  await rawPrisma.project.updateMany({ where: { id: { in: created.projects } }, data: { status: "ARCHIVED" } });
  await rawPrisma.customerDomain.deleteMany({ where: { hostname: { contains: tag } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: users } } });
  await rawPrisma.department.deleteMany({ where: { name: { contains: tag } } });
  await rawPrisma.permissionModule.deleteMany({ where: { OR: [{ id: { in: created.roles } }, { customerId: { in: created.customers } }] } });
  await rawPrisma.platformOperatorSession.deleteMany({ where: { operatorId: { in: created.operators } } });
  await rawPrisma.platformOperator.deleteMany({ where: { id: { in: created.operators } } });
  if (foundingWasCreatedHere) created.customers.push(customer.f);
  // Customers keep their (archived) projects on this throwaway database; detach them first.
  await rawPrisma.project.updateMany({ where: { customerId: { in: created.customers } }, data: { customerId: null } });
  await rawPrisma.securitySettings.deleteMany({ where: { customerId: { in: created.customers } } });
  // Payments are append-only by trigger; the customer's cascade is the only way they go, so lift it for cleanup only.
  await rawPrisma.$executeRawUnsafe('ALTER TABLE "SubscriptionPayment" DISABLE TRIGGER "SubscriptionPayment_immutable"');
  try {
    await rawPrisma.customer.deleteMany({ where: { id: { in: created.customers } } });
  } finally {
    await rawPrisma.$executeRawUnsafe('ALTER TABLE "SubscriptionPayment" ENABLE TRIGGER "SubscriptionPayment_immutable"');
  }
  forgetCaches();
});

describe("Layer 2 — each customer has its own Main Admin, and sees only its own software", () => {
  it("B's Main Admin manages B's portal on B's address — B's projects and people only", async () => {
    expect(await signIn(people.bAdmin, host.b)).toBe(true);
    await inPortal(host.b, async () => {
      await expect(requireMainAdminPage()).resolves.toMatchObject({ canManage: true });
      const users = (await platformPrisma.user.findMany({ select: { id: true } })).map((u) => u.id);
      expect(users).toEqual(expect.arrayContaining([people.bAdmin.id, people.bStaff.id]));
      expect(users).not.toContain(people.fAdmin.id);
      expect(users).not.toContain(people.fStaff.id);
      expect((await context.accessibleProjects(people.bAdmin.id)).map((p) => p.slug)).toEqual([project.b.slug]);
    });
    expect(await opens(host.b, project.b.slug)).toBe(true);
    expect(await opens(host.b, project.f.slug)).toBe(false);
    // An open address (the server's own) serves every customer, so only the customer check stands
    // between B's Main Admin and the original installation's project there.
    expect(await signIn(people.bAdmin, "localhost:8668")).toBe(true);
    expect(await opens("localhost:8668", project.b.slug)).toBe(true);
    expect(await opens("localhost:8668", project.f.slug)).toBe(false);
  });

  it("the original installation's Main Admin keeps today's portal and sees none of B", async () => {
    expect(await signIn(people.fAdmin, host.f)).toBe(true);
    await inPortal(host.f, async () => {
      await expect(requireMainAdminPage()).resolves.toMatchObject({ canManage: true });
      const users = (await platformPrisma.user.findMany({ select: { id: true } })).map((u) => u.id);
      expect(users).toContain(people.fStaff.id);
      expect(users).not.toContain(people.bAdmin.id);
      const slugs = (await context.accessibleProjects(people.fAdmin.id)).map((p) => p.slug);
      expect(slugs).toContain(project.f.slug);
      expect(slugs).not.toContain(project.b.slug);
    });
  });

  it("roles, departments and log entries are per customer; another customer's row cannot be reached by id", async () => {
    const fAdministrator = await rawPrisma.permissionModule.findFirstOrThrow({ where: { name: `F Administrator ${tag}` } });
    expect(await signIn(people.bAdmin, host.b)).toBe(true);
    await inPortal(host.b, async () => {
      await expect(platformPrisma.permissionModule.update({ where: { id: fAdministrator.id }, data: { description: "taken over" } })).rejects.toThrow();
      const dept = await platformPrisma.department.create({ data: { name: `Support ${tag}` } });
      expect(dept.customerId).toBe(customer.b);
      await logSystemEvent("INFO", "users", `B portal entry ${tag}`);
    });
    expect(await signIn(people.fAdmin, host.f)).toBe(true);
    await inPortal(host.f, async () => {
      // The same department name is free in another customer.
      const dept = await platformPrisma.department.create({ data: { name: `Support ${tag}` } });
      expect(dept.customerId).toBeNull();
      expect(await platformPrisma.systemLog.count({ where: { message: `B portal entry ${tag}` } })).toBe(0);
      expect(await platformPrisma.systemLog.count({ where: { customerId: PLATFORM_LOG_CUSTOMER } })).toBe(0);
    });
    expect(await rawPrisma.systemLog.count({ where: { message: `B portal entry ${tag}`, customerId: customer.b } })).toBe(1);
  });

  it("the product's own keys (release notes) work only in the original installation", async () => {
    await rawPrisma.permissionModulePermission.create({
      data: { permissionModuleId: (await rawPrisma.user.findUniqueOrThrow({ where: { id: people.bAdmin.id } })).permissionModuleId!, permissionId: (await rawPrisma.permission.findUniqueOrThrow({ where: { key: "release_notes.manage" } })).id },
    }).catch(() => undefined);
    expect(await signIn(people.bAdmin, host.b)).toBe(true);
    request.project = project.b.slug;
    expect(await hasPermission((await auth.getSession())!, "release_notes.manage")).toBe(false);
    expect(await signIn(people.fAdmin, host.f)).toBe(true);
    request.project = project.f.slug;
    expect(await hasPermission((await auth.getSession())!, "release_notes.manage")).toBe(true);
  });

  it("people sign in only on their own customer's address (or an open one)", async () => {
    expect(await signIn(people.bStaff, host.b)).toBe(true);
    expect(await signIn(people.bStaff, host.f)).toBe(false);
    expect(await signIn(people.bStaff, host.admin)).toBe(false);
    expect(await signIn(people.bStaff, host.unknown)).toBe(false);
    expect(await signIn(people.fStaff, host.b)).toBe(false);
    expect(await signIn(people.fStaff, host.f)).toBe(true);
    expect(await signIn(people.bStaff, "localhost")).toBe(true);
  });

  it("a session belongs to its address", async () => {
    expect(await signIn(people.bStaff, host.b)).toBe(true);
    request.host = host.b;
    expect((await auth.getSession())?.userId).toBe(people.bStaff.id);
    request.host = host.f;
    expect(await auth.getSession()).toBeNull();
  });
});

describe("Layer 1 — the platform is a separate place with its own sign-in", () => {
  it("no customer login — not even the original installation's Main Admin — passes a platform action", async () => {
    jar.clear();
    expect(await signIn(people.fAdmin, "localhost")).toBe(true);
    expect((await platform.updateCustomer(customer.b, {}, form({ name: "renamed" }))).error).toMatch(/platform session/i);
    expect((await billing.recordPayment(customer.b, {}, form({ amount: "1", method: "CASH" }))).error).toMatch(/platform session/i);
  });

  it("operators sign in on the platform address (or an open one), never on a customer's", async () => {
    expect(await operatorSignIn(host.b)).toBe(false);
    expect(await operatorSignIn(host.admin)).toBe(true);
    request.host = host.b; // the platform cookie carried to a customer address does nothing there
    expect((await platform.updateCustomer(customer.b, {}, form({ name: `B ${tag}` }))).error).toBeTruthy();
    expect(await operatorSignIn(host.admin)).toBe(true);
    expect((await platform.updateCustomer(customer.b, {}, form({ name: `B ${tag}` }))).savedAt).toBeTruthy();
  });

  it("the platform address serves no customer's software", async () => {
    expect(await opens(host.admin, project.b.slug)).toBe(false);
    expect(await opens(host.admin, project.f.slug)).toBe(false);
  });

  it("first-operator setup is closed once an operator exists", async () => {
    expect(await signIn(people.fAdmin, "localhost")).toBe(true);
    expect(await setupAllowed()).toMatchObject({ ok: false });
  });

  it("platform log entries are the platform's own", async () => {
    expect(await rawPrisma.systemLog.count({ where: { customerId: PLATFORM_LOG_CUSTOMER, scope: "platform" } })).toBeGreaterThan(0);
  });
});

describe("onboarding a new customer from the platform", () => {
  it("provisions its own complete software: roles, workspace, All Access plan with its price, payment, owner as its Main Admin", async () => {
    expect(await operatorSignIn(host.admin)).toBe(true);
    const allAccess = await rawPrisma.plan.findFirstOrThrow({ where: { name: "All Access" } });
    const host3 = `c-${tag}.nexora.test`;
    const result = await platform.createCustomer(
      {},
      form({
        mode: "new",
        name: `C ${tag}`,
        contactEmail: `c-${tag}@example.test`,
        projectName: `C workspace ${tag}`,
        projectSlug: `c-${tag}`,
        hostname: host3,
        planId: allAccess.id,
        price: "2500",
        paymentAmount: "2500",
        paymentMethod: "BKASH",
        ownerMode: "login",
        ownerName: "C Owner",
        ownerUsername: `cowner_${tag}`,
        ownerPassword: PASSWORD,
      }),
    );
    expect(result.created?.customerId).toBeTruthy();
    const c = result.created!.customerId;
    created.customers.push(c);
    const cProject = await rawPrisma.project.findFirstOrThrow({ where: { customerId: c } });
    created.projects.push(cProject.id);
    expect(await rawPrisma.permissionModule.count({ where: { customerId: c, isSystem: true } })).toBe(4);
    const sub = await rawPrisma.subscription.findFirstOrThrow({ where: { customerId: c, endedAt: null } });
    expect(sub).toMatchObject({ planName: "All Access", allModules: true, priceMinor: BigInt(250000), status: "ACTIVE" });
    const features = await rawPrisma.projectFeature.findMany({ where: { projectId: cProject.id } });
    expect(features.every((f) => f.enabled)).toBe(true);
    const owner = await rawPrisma.user.findUniqueOrThrow({ where: { username: `cowner_${tag}` }, include: { permissionModule: true } });
    expect(owner.customerId).toBe(c);
    expect(owner.permissionModule?.customerId).toBe(c);
    expect(owner.permissionModule?.name).toBe("Administrator");

    // Their address, then the owner signs in there and runs only their own software.
    await rawPrisma.customerDomain.updateMany({ where: { hostname: host3 }, data: { status: "ACTIVE" } });
    forgetCaches();
    expect(await signIn({ username: `cowner_${tag}` }, host3)).toBe(true);
    expect((await context.accessibleProjects(owner.id)).map((p) => p.slug)).toEqual([cProject.slug]);
    expect(await opens(host3, project.b.slug)).toBe(false);
    // A new project they create follows their All Access plan.
    const extra = await createProjectWithDefaults({ name: `C two ${tag}`, slug: `c2-${tag}`, status: "ACTIVE", creatorUserId: owner.id, customerId: c }, rawPrisma);
    created.projects.push(extra.id);
  });

  it("an invited owner accepts on their own address and becomes that customer's Main Admin", async () => {
    expect(await operatorSignIn(host.admin)).toBe(true);
    const invite = await billing.inviteOwner(customer.b, {}, form({ name: "B second owner" }));
    expect(invite.link).toContain(`://${host.b}/invite/`);
    const token = invite.link!.split("/invite/")[1]!;
    jar.delete("support_automation_session");
    request.host = host.f; // another customer's address: refused
    expect((await acceptInvitation(token, {}, form({ username: `binv_${tag}`, password: PASSWORD, confirmPassword: PASSWORD }))).error).toMatch(/not valid/);
    request.host = host.b;
    await expect(acceptInvitation(token, {}, form({ username: `binv_${tag}`, password: PASSWORD, confirmPassword: PASSWORD }))).rejects.toMatchObject({ redirectTo: "/open" });
    const owner = await rawPrisma.user.findUniqueOrThrow({ where: { username: `binv_${tag}` }, include: { permissionModule: true } });
    expect(owner.customerId).toBe(customer.b);
    expect(owner.permissionModule).toMatchObject({ customerId: customer.b, name: "Administrator" });
  });
});

describe("support access — audited, time-limited, on the customer's own address", () => {
  it("needs a reason and the operator's password; the ticket works once, on that address only; every change is recorded; ending it ends the session", async () => {
    expect(await operatorSignIn(host.admin)).toBe(true);
    expect((await supportActions.startSupportAccess(customer.b, form({ reason: "short", minutes: "30", operatorPassword: PASSWORD }))).error).toMatch(/reason/);
    expect((await supportActions.startSupportAccess(customer.b, form({ reason: "Investigating missing messages", minutes: "30", operatorPassword: "wrong" }))).error).toMatch(/password/);
    const started = await supportActions.startSupportAccess(customer.b, form({ reason: "Investigating missing messages", minutes: "30", operatorPassword: PASSWORD }));
    expect(started.url).toContain(`://${host.b}/support-access/`);
    const ticket = started.url!.split("/support-access/")[1]!;

    jar.delete("support_automation_session");
    request.host = host.f; // wrong address
    expect((await consumeSupportTicket(ticket)).error).toBeTruthy();
    request.host = host.b;
    await expect(consumeSupportTicket(ticket)).rejects.toMatchObject({ redirectTo: "/open" });
    expect((await consumeSupportTicket(ticket)).error).toBeTruthy(); // once only

    const session = (await auth.getSession())!;
    expect(session.support?.operatorUsername).toBe(operatorUsername);
    expect(session.tenant).toBe(customer.b);
    expect(await opens(host.b, project.b.slug)).toBe(true);
    expect(await opens(host.b, project.f.slug)).toBe(false);

    await inPortal(host.b, () => platformPrisma.department.create({ data: { name: `Support access ${tag}` } }));
    const recorded = await rawPrisma.systemLog.findFirst({ where: { message: "NEXORA_SUPPORT_CHANGE", customerId: customer.b, metadata: { path: ["supportAccessSessionId"], equals: session.support!.id } } });
    expect(recorded?.metadata).toMatchObject({ change: "Department.create", operator: operatorUsername });

    expect(await operatorSignIn(host.admin)).toBe(true);
    expect((await supportActions.endSupportAccess(session.support!.id)).success).toBeTruthy();
    request.host = host.b;
    expect(await auth.getSession()).toBeNull();
    expect(await rawPrisma.systemLog.count({ where: { customerId: customer.b, message: { in: ["NEXORA_SUPPORT_ACCESS_STARTED", "NEXORA_SUPPORT_ACCESS_ENDED"] } } })).toBeGreaterThanOrEqual(2);
  });

  it("the support identity has no password that works, and a customer that deactivates it turns support access off", async () => {
    const identity = await rawPrisma.user.findFirstOrThrow({ where: { supportOperatorId: { not: null }, customerId: customer.b } });
    await rawPrisma.user.update({ where: { id: identity.id }, data: { passwordHash: auth.hashPassword(PASSWORD) } });
    expect(await signIn({ username: identity.username }, host.b)).toBe(false);
    await rawPrisma.user.update({ where: { id: identity.id }, data: { isActive: false } });
    expect(await operatorSignIn(host.admin)).toBe(true);
    expect((await supportActions.startSupportAccess(customer.b, form({ reason: "Investigating missing messages", minutes: "15", operatorPassword: PASSWORD }))).error).toMatch(/turned Nexora support access off/);
  });
});

describe("addresses and recovery (kept from Phase 2)", () => {
  it("Caddy gets a certificate only for a verified customer address and the platform address", async () => {
    const ask = async (domain: string) => (await tlsRoute.GET(new Request(`http://127.0.0.1:8668/api/platform/tls-allowed?domain=${domain}`))).status;
    expect(await ask(host.b)).toBe(200);
    expect(await ask(host.admin)).toBe(200);
    expect(await ask(host.unknown)).toBe(404);
  });

  it("a domain check moves PENDING → VERIFIED → ACTIVE and explains each failure", async () => {
    expect(await operatorSignIn(host.admin)).toBe(true);
    const hostname = `new-${tag}.nexora.test`;
    expect((await platform.addCustomerDomain(customer.b, {}, form({ hostname }))).success).toBeTruthy();
    const domain = await rawPrisma.customerDomain.findUniqueOrThrow({ where: { hostname } });
    const answer = domainCheckAnswer(domain.verificationToken);
    const net = { ips: ["198.51.100.7"], http: { status: 200, body: answer } as { status: number; body: string } | { error: string }, https: { error: "CERT_HAS_EXPIRED" } as { status: number; body: string } | { error: string } };
    setDomainNetworkForTests({ resolveAddresses: async () => net.ips, get: async (url) => (url.startsWith("https://") ? net.https : net.http) });
    expect((await platform.checkCustomerDomain(domain.id)).error).toMatch(/198\.51\.100\.7/);
    net.ips = ["203.0.113.10"];
    expect((await platform.checkCustomerDomain(domain.id)).error).toMatch(/certificate/);
    expect((await rawPrisma.customerDomain.findUniqueOrThrow({ where: { id: domain.id } })).status).toBe("VERIFIED");
    net.https = { status: 200, body: answer };
    expect((await platform.checkCustomerDomain(domain.id)).success).toMatch(/live/);
    expect((await platform.disableCustomerDomain(domain.id)).success).toBeTruthy();
    expect((await platform.removeCustomerDomain(domain.id)).success).toBeTruthy();
  });

  it("routing cannot be switched on from a customer's address; the emergency switch reopens every address", async () => {
    await rawPrisma.platformDomainSettings.update({ where: { id: "default" }, data: { hostRoutingEnabled: false } });
    forgetCaches();
    expect(await operatorSignIn(host.b)).toBe(true); // routing off: every address is open
    request.host = host.b;
    const state = await platform.saveDomainSettings({}, form({ rootDomain: "nexora.test", adminHostnames: host.admin, publicIps: "203.0.113.10", reservedLabels: "", hostRoutingEnabled: "on" }));
    expect(state.fieldErrors?.hostRoutingEnabled).toMatch(/platform/);
    await rawPrisma.platformDomainSettings.update({ where: { id: "default" }, data: { hostRoutingEnabled: true } });
    forgetCaches();
    expect(await signIn(people.bStaff, host.unknown)).toBe(false);
    process.env.SAAS_HOST_ROUTING_DISABLED = "true";
    try {
      expect(await signIn(people.bStaff, host.unknown)).toBe(true);
    } finally {
      delete process.env.SAAS_HOST_ROUTING_DISABLED;
    }
  });

  it("the server itself (localhost, its IP) is always open, for the platform too", async () => {
    expect(await operatorSignIn("127.0.0.1:8668")).toBe(true);
    expect(await signIn(people.fAdmin, "localhost:8668")).toBe(true);
  });
});
