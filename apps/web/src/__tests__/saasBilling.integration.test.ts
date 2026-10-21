import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma, recomputeCustomerBilling } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";

/**
 * SaaS billing (SAAS_PLATFORM_PLAN.md §10), through the REAL sign-in, actions, access checks and
 * database — only the request plumbing is stubbed. What must hold:
 *   - a customer with no subscription is never held or limited (Customer #1), and neither is one
 *     whose subscription has automatic suspension off, however late;
 *   - an enforced subscription past its grace period holds the workspace: it opens read-only and
 *     every change is refused with the renewal wording; a payment releases it, reversing it holds again;
 *   - a manual suspension holds at once and Unlock releases it;
 *   - limits hold under concurrency; payments cannot be edited or deleted; invoice numbers are unique;
 *   - an invitation works once, not after expiry, and gives the owner no platform permission;
 *   - a plan's modules become the workspace's features only when asked.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const PASSWORD = "Test-password-123";
const DAY = 24 * 60 * 60_000;

const request = { host: "localhost", project: null as string | null };
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
const { checkPermission } = await import("@/server/authorize");
const billing = await import("@/server/actions/saasBilling");
const { acceptInvitation } = await import("@/app/(auth)/invite/[token]/actions");
const { createUserWithAccess } = await import("@/server/adminUsers");
const { lockAndCheckCustomerLimit } = await import("@/server/customerLimits");

const ids = { users: [] as string[], roles: [] as string[], projects: [] as string[], customers: [] as string[], plans: [] as string[] };
const people = {} as Record<"admin" | "staff", { id: string; username: string }>;
const ws = {} as Record<"legacy" | "late" | "billed" | "limited", { id: string; slug: string; customerId: string }>;
let planId = "";

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

async function workspace(key: string, admin: string) {
  const p = await createProjectWithDefaults({ name: `Billing ${key} ${tag}`, slug: `billing-${key}-${tag}`, status: "ACTIVE", creatorUserId: admin }, rawPrisma);
  ids.projects.push(p.id);
  const c = await rawPrisma.customer.create({ data: { name: `Billing customer ${key} ${tag}`, contactEmail: `${key}-${tag}@example.test` } });
  ids.customers.push(c.id);
  await rawPrisma.project.update({ where: { id: p.id }, data: { customerId: c.id } });
  return { id: p.id, slug: p.slug, customerId: c.id };
}

async function signIn(who: { username: string }) {
  jar.clear();
  request.project = null;
  const form = new FormData();
  form.set("username", who.username);
  form.set("password", PASSWORD);
  try {
    expect((await login({}, form)).error).toBeUndefined();
  } catch (err) {
    if ((err as { redirectTo?: string }).redirectTo !== "/open") throw err;
  }
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** The workspace as the access check sees it right now. */
async function opened(slug: string) {
  request.project = slug;
  context.forgetProjectAccessDecisions();
  return context.requireActiveProject();
}

const held = async (projectId: string) => (await rawPrisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { billingHoldAt: true } })).billingHoldAt !== null;

async function assign(customerId: string, extra: Record<string, string> = {}) {
  await signIn(people.admin);
  const r = await billing.assignPlan(customerId, {}, form({ planId, ...extra }));
  expect(r.error ?? r.fieldErrors).toBeUndefined();
  return rawPrisma.subscription.findFirstOrThrow({ where: { customerId, endedAt: null } });
}

beforeAll(async () => {
  await rawPrisma.platformDomainSettings.deleteMany({});
  forgetHostScopes();
  const adminRole = await role("Billing main admin", ["projects.view", "projects.manage", "users.view", "users.create"]);
  const staffRole = await role("Billing staff", ["messages.view", "messages.reply", "automation_rules.view", "automation_rules.create"]);
  people.admin = await person("BillAdmin", adminRole, []);
  for (const key of ["legacy", "late", "billed", "limited"] as const) ws[key] = await workspace(key, people.admin.id);
  people.staff = await person("BillStaff", staffRole, [ws.billed.id, ws.legacy.id]);
  const plan = await rawPrisma.plan.create({
    data: { name: `Standard ${tag}`, priceMinor: BigInt(150000), currency: "BDT", interval: "MONTH", trialDays: 0, maxWhatsAppAccounts: 1, maxUsers: 1, features: ["WHATSAPP_CHAT"] },
  });
  ids.plans.push(plan.id);
  planId = plan.id;
});

beforeEach(() => {
  request.host = "localhost";
  request.project = null;
});

afterAll(async () => {
  await rawPrisma.userSession.deleteMany({ where: { userId: { in: ids.users } } });
  const invited = await rawPrisma.userInvitation.findMany({ where: { customerId: { in: ids.customers } }, select: { acceptedUserId: true } });
  const extraUsers = await rawPrisma.projectAccess.findMany({ where: { projectId: { in: ids.projects } }, select: { userId: true } });
  const allUsers = [...new Set([...ids.users, ...invited.map((i) => i.acceptedUserId).filter((x): x is string => !!x), ...extraUsers.map((a) => a.userId)])];
  await rawPrisma.userSession.deleteMany({ where: { userId: { in: allUsers } } });
  await rawPrisma.projectMemberRole.deleteMany({ where: { projectId: { in: ids.projects } } });
  await rawPrisma.projectAccess.deleteMany({ where: { projectId: { in: ids.projects } } });
  await rawPrisma.project.updateMany({ where: { id: { in: ids.projects } }, data: { customerId: null, status: "ARCHIVED", billingHoldAt: null } });
  // Payments are append-only by trigger; the customer's cascade is the only way they go, so lift it for cleanup only.
  await rawPrisma.$executeRawUnsafe('ALTER TABLE "SubscriptionPayment" DISABLE TRIGGER "SubscriptionPayment_immutable"');
  try {
    await rawPrisma.customer.deleteMany({ where: { id: { in: ids.customers } } });
  } finally {
    await rawPrisma.$executeRawUnsafe('ALTER TABLE "SubscriptionPayment" ENABLE TRIGGER "SubscriptionPayment_immutable"');
  }
  await rawPrisma.plan.deleteMany({ where: { id: { in: ids.plans } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: allUsers } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

describe("Customer #1's protection", () => {
  it("a customer with no subscription is never held or limited, whatever the date", async () => {
    await recomputeCustomerBilling(rawPrisma, ws.legacy.customerId, new Date(Date.now() + 3650 * DAY));
    expect(await held(ws.legacy.id)).toBe(false);
    expect(await rawPrisma.$transaction((tx) => lockAndCheckCustomerLimit(tx, ws.legacy.id, "USERS"))).toBeNull();
    expect(await rawPrisma.$transaction((tx) => lockAndCheckCustomerLimit(tx, ws.legacy.id, "WHATSAPP_ACCOUNTS"))).toBeNull();
    await signIn(people.staff);
    const project = await opened(ws.legacy.slug);
    expect(project.status).toBe("ACTIVE");
    expect(project.billingHold).toBeFalsy();
  });

  it("a subscription with automatic suspension off is never held, however late — it only reads as payment due", async () => {
    const sub = await assign(ws.late.customerId, { paidThrough: new Date(Date.now() - 200 * DAY).toISOString().slice(0, 10) });
    expect(sub.autoEnforce).toBe(false); // the default
    await recomputeCustomerBilling(rawPrisma, ws.late.customerId, new Date(Date.now() + 365 * DAY));
    expect(await held(ws.late.id)).toBe(false);
    expect((await rawPrisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("PAST_DUE");
  });
});

describe("an enforced subscription", () => {
  it("past its grace period holds the workspace read-only with the renewal wording; a payment releases it and reversing it holds again", async () => {
    const lapsed = new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10);
    const sub = await assign(ws.billed.customerId, { paidThrough: lapsed, graceDays: "7", autoEnforce: "on" });
    expect(await held(ws.billed.id)).toBe(true);

    await signIn(people.staff);
    const project = await opened(ws.billed.slug);
    expect(project.status).toBe("SUSPENDED");
    expect(project.billingHold).toBe(true);
    const refused = await checkPermission("automation_rules.create");
    expect("denied" in refused && refused.denied).toMatch(/subscription is suspended/);
    const reading = await checkPermission("messages.view");
    expect("denied" in reading).toBe(false); // read-only, not locked out

    // Two months behind: the payment covers a period starting today, so it really releases.
    await signIn(people.admin);
    const paid = await billing.recordPayment(ws.billed.customerId, {}, form({ amount: "1500", method: "BKASH", reference: `TRX${tag}` }));
    expect(paid.error ?? paid.fieldErrors).toBeUndefined();
    expect(await held(ws.billed.id)).toBe(false);
    const after = await rawPrisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.paidThrough!.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);

    const payment = await rawPrisma.subscriptionPayment.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(payment.amountMinor).toBe(BigInt(150000));
    expect((await rawPrisma.subscriptionInvoice.findUniqueOrThrow({ where: { id: payment.invoiceId! } })).status).toBe("PAID");

    const reversed = await billing.reversePayment(payment.id, {}, form({ reason: "Recorded twice" }));
    expect(reversed.error).toBeUndefined();
    expect((await rawPrisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).paidThrough?.toISOString().slice(0, 10)).toBe(lapsed);
    expect(await held(ws.billed.id)).toBe(true);
  });

  it("a recorded payment cannot be edited or deleted, and a reversal cannot be undone", async () => {
    const payment = await rawPrisma.subscriptionPayment.findFirstOrThrow({ where: { customerId: ws.billed.customerId } });
    await expect(rawPrisma.subscriptionPayment.update({ where: { id: payment.id }, data: { amountMinor: BigInt(1) } })).rejects.toThrow(/cannot be changed/);
    await expect(rawPrisma.subscriptionPayment.delete({ where: { id: payment.id } })).rejects.toThrow();
    await expect(rawPrisma.subscriptionPayment.update({ where: { id: payment.id }, data: { reversedAt: null } })).rejects.toThrow(/cannot be changed again/);
  });

  it("a manual suspension holds at once even with enforcement off, and Unlock releases it", async () => {
    await signIn(people.admin);
    await billing.updateSubscriptionTerms(ws.billed.customerId, {}, form({ graceDays: "7" })); // enforcement off
    await billing.extendSubscription(ws.billed.customerId, {}, form({ days: "30" }));
    expect(await held(ws.billed.id)).toBe(false);
    expect((await billing.suspendSubscription(ws.billed.customerId, {}, form({ reason: "Asked to pause" }))).error).toBeUndefined();
    expect(await held(ws.billed.id)).toBe(true);
    expect((await billing.unlockSubscription(ws.billed.customerId)).error).toBeUndefined();
    expect(await held(ws.billed.id)).toBe(false);
  });

  it("invoice numbers come from one sequence and never repeat", async () => {
    await signIn(people.admin);
    expect((await billing.issueInvoice(ws.billed.customerId)).error).toBeUndefined();
    const numbers = (await rawPrisma.subscriptionInvoice.findMany({ where: { customerId: ws.billed.customerId }, select: { number: true } })).map((i) => i.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) expect(n).toMatch(/^INV-\d{6,}$/);
    expect((await billing.issueInvoice(ws.billed.customerId)).error).toMatch(/already open/);
  });
});

describe("limits and the plan's modules", () => {
  it("modules are applied only when asked, and the user limit holds under concurrent creation", async () => {
    await assign(ws.limited.customerId, { applyFeatures: "on" });
    const features = await rawPrisma.projectFeature.findMany({ where: { projectId: ws.limited.id }, select: { key: true, enabled: true } });
    expect(features.filter((f) => f.enabled).map((f) => f.key)).toEqual(["WHATSAPP_CHAT"]);

    const attempts = await Promise.all(
      [1, 2, 3].map((n) =>
        createUserWithAccess(rawPrisma, {
          username: `lim${n}_${tag}`,
          name: `Limited ${n}`,
          password: PASSWORD,
          confirmPassword: PASSWORD,
          permissionModuleId: null,
          employee: null,
          access: [{ projectId: ws.limited.id, level: "FULL", isLead: false }],
        }),
      ),
    );
    const ok = attempts.filter((a) => a.ok);
    expect(ok).toHaveLength(1);
    for (const a of attempts.filter((x) => !x.ok)) expect(!a.ok && a.error).toMatch(/plan includes/);
    expect(await rawPrisma.$transaction((tx) => lockAndCheckCustomerLimit(tx, ws.limited.id, "WHATSAPP_ACCOUNTS"))).toBeNull(); // 0 of 1 used
  });
});

describe("the owner invitation", () => {
  it("works once, makes a Lead with no platform permission, and is refused when used again or expired", async () => {
    await signIn(people.admin);
    const r = await billing.inviteOwner(ws.limited.customerId, {}, form({ name: "Owner", email: `owner-${tag}@example.test` }));
    expect(r.link).toMatch(/\/invite\//);
    const token = r.link!.split("/invite/")[1]!;
    const stored = await rawPrisma.userInvitation.findFirstOrThrow({ where: { customerId: ws.limited.customerId } });
    expect(stored.tokenHash).not.toContain(token);
    expect(stored.linkCiphertext).not.toBeNull(); // kept encrypted for the worker to email
    expect(stored.linkCiphertext).not.toContain(token);

    // The plan allows one user, already used above: the owner is refused by the limit, and the claim is released.
    const refused = await acceptInvitation(token, {}, form({ username: `owner_${tag}`, password: PASSWORD, confirmPassword: PASSWORD }));
    expect(refused.error).toMatch(/plan includes/);
    await rawPrisma.subscription.updateMany({ where: { customerId: ws.limited.customerId, endedAt: null }, data: { maxUsers: 5 } });

    jar.clear();
    await expect(acceptInvitation(token, {}, form({ username: `owner_${tag}`, password: PASSWORD, confirmPassword: PASSWORD }))).rejects.toMatchObject({ redirectTo: "/open" });
    const owner = await rawPrisma.user.findUniqueOrThrow({ where: { username: `owner_${tag}` } });
    expect(owner.permissionModuleId).toBeNull();
    expect((await rawPrisma.projectMemberRole.findFirstOrThrow({ where: { projectId: ws.limited.id, userId: owner.id } })).isLead).toBe(true);
    const session = (await auth.getSession())!;
    expect(session.userId).toBe(owner.id);
    expect(await hasPermission(session, "projects.manage")).toBe(false);
    request.project = ws.limited.slug;
    context.forgetProjectAccessDecisions();
    expect(await hasPermission(session, "project_members.manage")).toBe(true);

    const again = await acceptInvitation(token, {}, form({ username: `owner2_${tag}`, password: PASSWORD, confirmPassword: PASSWORD }));
    expect(again.error).toMatch(/not valid/);

    await signIn(people.admin);
    const second = await billing.inviteOwner(ws.limited.customerId, {}, form({ name: "Late owner" }));
    await rawPrisma.userInvitation.updateMany({ where: { customerId: ws.limited.customerId, acceptedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await acceptInvitation(second.link!.split("/invite/")[1]!, {}, form({ username: `owner3_${tag}`, password: PASSWORD, confirmPassword: PASSWORD }));
    expect(expired.error).toMatch(/not valid/);
  });
});
