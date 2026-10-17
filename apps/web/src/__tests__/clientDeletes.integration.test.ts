import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { addCalendarDays, dhakaToday, PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Deleting in Clients (owner's rule, 17 Oct 2026; CLIENTS_V3.md §Delete).
 *
 * What must hold:
 *   - an Administrator (Main Admin) may delete clients, subscriptions, invoices, payments and notes;
 *     a role an Administrator gave `clients.delete` may too; nobody else, whatever else they hold;
 *   - only an Administrator can ADD `clients.delete` to a role; keeping it on a role is not refused;
 *   - deleting a subscription recomputes the client's current term and keeps its invoices;
 *   - an invoice a recorded payment still settles is kept; after the payment is reversed it can go;
 *   - deleting an unreversed payment takes it off the invoices it settled first;
 *   - a note goes, and the timeline says a note was deleted.
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
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const clientActions = await import("@/server/actions/clients");
const billing = await import("@/server/actions/clientBilling");
const subs = await import("@/server/actions/clientSubscriptions");
const pay = await import("@/server/actions/clientPayments");
const del = await import("@/server/actions/clientDeletes");
const roles = await import("@/server/actions/permissionModules");
const moduleReads = await import("@/server/clientModule");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;

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
async function user(name: string, roleId: string): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
const people = {} as Record<"manager" | "deleter" | "mainAdmin" | "roleEditor", Session>;
const as = <T,>(person: Session, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(A, fn);
};
const form = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) f.append(k, one);
  return f;
};
const today = dhakaToday(new Date());
const newClient = async (name: string) => {
  const r = await as(people.manager, () => clientActions.createClient({}, form({ name, phone: `+88017${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}` })));
  if (!r.clientId) throw new Error(r.error);
  return r.clientId;
};
const invoice = async (clientId: string, amount: string) => {
  const r = await as(people.manager, () => billing.createDue(clientId, {}, form({ dueDate: addCalendarDays(today, 5), amount, currency: "BDT" })));
  if (!r.success) throw new Error(r.error);
  return rawPrisma.clientDue.findFirstOrThrow({ where: { clientId }, orderBy: { createdAt: "desc" } });
};
const record = (dueId: string, amount: string) =>
  as(people.manager, () => pay.recordPayments({ idempotencyKey: randomUUID().replace(/-/g, ""), method: "CASH", receivedDate: today, reference: "", note: "", lines: [{ dueId, amount }] }));
const call = async <T,>(fn: () => Promise<T>): Promise<T | { redirected: string }> => {
  try {
    return await fn();
  } catch (err) {
    if ((err as Error).message === "NEXT_REDIRECT") return { redirected: (err as unknown as { to: string }).to };
    throw err;
  }
};

beforeAll(async () => {
  const work = ["clients.view", "clients.create", "clients.update", "clients.archive", "clients.view_billing", "clients.edit_billing", "clients.manage_subscriptions", "messages.view"];
  people.manager = await user("DelManager", await role("Del manager", work));
  people.deleter = await user("DelDeleter", await role("Del deleter", [...work, "clients.delete"]));
  people.mainAdmin = await user("DelMain", await role("Del main", ["clients.view", "projects.view", "projects.manage", "permissions.view", "permissions.create", "permissions.edit"]));
  people.roleEditor = await user("DelRoles", await role("Del roles", ["permissions.view", "permissions.create", "permissions.edit"]));
  const p = await createProjectWithDefaults({ name: `Del ${tag}`, slug: `del-${tag}`, status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma);
  ids.projects.push(p.id);
  await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
  await rawPrisma.clientBillingCurrency.create({ data: { projectId: p.id, code: "BDT" } });
  A = { id: p.id, slug: p.slug, name: `Del ${tag}`, status: "ACTIVE" };
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.client.updateMany({ where, data: { currentSubscriptionId: null } });
  await rawPrisma.clientPaymentAllocation.deleteMany({ where });
  await rawPrisma.clientPayment.deleteMany({ where });
  await rawPrisma.clientDueEvent.deleteMany({ where });
  await rawPrisma.clientDue.deleteMany({ where });
  await rawPrisma.clientSubscription.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientNote.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.clientBillingCurrency.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { name: { contains: tag }, users: { none: {} } } });
  forgetProjectFeatureStates();
});

describe("1. who may delete", () => {
  it("an Administrator, or a role given clients.delete — never anybody else, whatever else they hold", async () => {
    expect(await as(people.manager, () => moduleReads.canDeleteClientRecords(people.manager))).toBe(false);
    expect(await as(people.deleter, () => moduleReads.canDeleteClientRecords(people.deleter))).toBe(true);
    expect(await as(people.mainAdmin, () => moduleReads.canDeleteClientRecords(people.mainAdmin))).toBe(true);

    const clientId = await newClient(`Refused ${tag}`);
    await as(people.manager, () => clientActions.addClientNote(clientId, {}, form({ body: "keep me" })));
    const note = await rawPrisma.clientNote.findFirstOrThrow({ where: { clientId } });
    const due = await invoice(clientId, "100");
    for (const attempt of [
      () => del.deleteClientNote(note.id),
      () => del.deleteDues([due.id]),
      () => del.deleteSubscriptions(["x"]),
      () => del.deletePayments(["x"]),
      () => clientActions.deleteClients([clientId]),
    ]) {
      const r = await as(people.manager, attempt);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Only an Administrator/);
    }
    expect(await rawPrisma.clientNote.count({ where: { id: note.id } })).toBe(1);
    expect(await rawPrisma.clientDue.count({ where: { id: due.id } })).toBe(1);
    expect(await rawPrisma.client.count({ where: { id: clientId } })).toBe(1);
  });

  it("only an Administrator can ADD clients.delete to a role; editing a role that already has it is not refused", async () => {
    const added = await as(people.roleEditor, () => call(() => roles.createPermissionModule({}, form({ name: `Gets delete ${tag}`, permissionKeys: ["clients.view", "clients.delete"] }))));
    expect(added).toEqual({ error: expect.stringMatching(/Only an Administrator can give this permission/) });
    const holder = await role("Already has delete", ["clients.view", "clients.delete"]);
    const kept = await as(people.roleEditor, () => call(() => roles.updatePermissionModule(holder, {}, form({ name: `Already has delete ${tag}`, permissionKeys: ["clients.view", "clients.delete", "messages.view"] }))));
    expect(kept).toEqual({ redirected: expect.any(String) });
    const byAdmin = await as(people.mainAdmin, () => call(() => roles.createPermissionModule({}, form({ name: `Admin gives delete ${tag}`, permissionKeys: ["clients.view", "clients.delete"] }))));
    expect(byAdmin).toEqual({ redirected: expect.any(String) });
  });
});

describe("2. what each delete keeps true", () => {
  it("a subscription: the current term is recomputed, its invoices stay", async () => {
    const clientId = await newClient(`Subs ${tag}`);
    const sell = (startDate: string) => as(people.manager, () => subs.createSubscription(clientId, {}, form({ service: "Tiger", kind: "PAID", startDate, durationValue: "1", durationUnit: "MONTH" })));
    expect((await sell(addCalendarDays(today, -40))).success).toBe(true);
    expect((await sell(addCalendarDays(today, -5))).success).toBe(true);
    const terms = await rawPrisma.clientSubscription.findMany({ where: { clientId }, orderBy: { startDate: "asc" } });
    const [older, newer] = terms;
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentSubscriptionId).toBe(newer!.id);
    const due = await invoice(clientId, "200");
    await rawPrisma.clientDue.update({ where: { id: due.id }, data: { subscriptionId: newer!.id } });

    const r = await as(people.deleter, () => del.deleteSubscriptions([newer!.id]));
    expect(r).toMatchObject({ ok: true });
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentSubscriptionId).toBe(older!.id);
    expect(await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ subscriptionId: null });
    expect(await rawPrisma.clientActivity.count({ where: { clientId, type: "SUBSCRIPTION_DELETED" } })).toBe(1);
  });

  it("an invoice a recorded payment settles is kept; after the payment is reversed it can go", async () => {
    const clientId = await newClient(`Inv ${tag}`);
    const settled = await invoice(clientId, "300");
    const free = await invoice(clientId, "50");
    const paid = await record(settled.id, "100");
    expect(paid.ok).toBe(true);
    const payment = await rawPrisma.clientPayment.findFirstOrThrow({ where: { clientId } });

    const r = await as(people.deleter, () => del.deleteDues([settled.id, free.id]));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/1 invoice deleted\. 1 invoice kept: a recorded payment/);
    expect(await rawPrisma.clientDue.count({ where: { id: settled.id } })).toBe(1);
    expect(await rawPrisma.clientDue.count({ where: { id: free.id } })).toBe(0);

    expect((await as(people.manager, () => pay.reversePayment(payment.id, "typo"))).ok).toBe(true);
    expect((await as(people.deleter, () => del.deleteDues([settled.id]))).ok).toBe(true);
    expect(await rawPrisma.clientDue.count({ where: { id: settled.id } })).toBe(0);
  });

  it("an unreversed payment is taken off its invoices before it goes", async () => {
    const clientId = await newClient(`Pay ${tag}`);
    const due = await invoice(clientId, "500");
    expect((await record(due.id, "500")).ok).toBe(true);
    expect(await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: "PAID" });
    const payment = await rawPrisma.clientPayment.findFirstOrThrow({ where: { clientId } });

    const r = await as(people.mainAdmin, () => del.deletePayments([payment.id]));
    expect(r).toMatchObject({ ok: true });
    expect(await rawPrisma.clientPayment.count({ where: { id: payment.id } })).toBe(0);
    const after = await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.status).toBe("UNPAID");
    expect(after.paidAmount).toBeNull();
    expect(await rawPrisma.clientDueEvent.count({ where: { dueId: due.id, type: "PAYMENT_DELETED" } })).toBe(1);
    expect(await rawPrisma.clientActivity.count({ where: { clientId, type: "PAYMENT_DELETED" } })).toBe(1);
  });

  it("a note goes, and the timeline records that a note was deleted, not what it said", async () => {
    const clientId = await newClient(`Note ${tag}`);
    await as(people.manager, () => clientActions.addClientNote(clientId, {}, form({ body: "private words" })));
    const note = await rawPrisma.clientNote.findFirstOrThrow({ where: { clientId } });
    expect((await as(people.deleter, () => del.deleteClientNote(note.id))).ok).toBe(true);
    expect(await rawPrisma.clientNote.count({ where: { id: note.id } })).toBe(0);
    const entry = await rawPrisma.clientActivity.findFirstOrThrow({ where: { clientId, type: "NOTE_DELETED" } });
    expect(entry.summary).not.toMatch(/private words/);
  });

  it("a role given clients.delete can delete a client too", async () => {
    const clientId = await newClient(`Whole ${tag}`);
    expect((await as(people.deleter, () => clientActions.deleteClients([clientId]))).ok).toBe(true);
    expect(await rawPrisma.client.count({ where: { id: clientId } })).toBe(0);
  });
});
