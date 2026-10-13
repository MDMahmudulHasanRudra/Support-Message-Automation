import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Client billing (CLIENT_CENTER_PLAN.md §2, stage 4A): manual dues, the currency list and the audit,
 * in separate projects so neither can see the other's money.
 *
 * What must hold:
 *   - changing billing needs `clients.edit_billing`, and the feature switch (it ships off) refuses it;
 *   - a currency is required only when an amount is present, and only from the project's list — which
 *     ships empty, so nothing is assumed;
 *   - a settled due is kept (there is no delete), every change is an append-only event, and the
 *     client's timeline says THAT billing changed without an amount or a date;
 *   - a due is found and changed only inside its own project, and the database refuses a due whose
 *     client is in another project.
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

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const clientActions = await import("@/server/actions/clients");
const billing = await import("@/server/actions/clientBilling");
const reads = await import("@/server/clientBilling");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;
let C: Project; // CLIENT_CENTER never switched on

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
const people = {} as Record<"manager" | "billing" | "viewer" | "plain", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const newClient = async (project: Project, name: string) => (await as(people.manager, project, () => clientActions.createClient({}, form({ name })))).clientId!;
const addDue = (person: Session, project: Project, clientId: string, fields: Record<string, string>) => as(person, project, () => billing.createDue(clientId, {}, form(fields)));
const editDue = (person: Session, project: Project, dueId: string, fields: Record<string, string>) => as(person, project, () => billing.updateDue(dueId, {}, form(fields)));
const addCurrency = (project: Project, code: string) => as(people.billing, project, () => billing.addBillingCurrency({}, form({ code })));

beforeAll(async () => {
  const all = ["clients.view", "clients.create", "clients.update", "clients.archive", "clients.delete", "clients.view_billing", "clients.edit_billing", "messages.view"];
  people.manager = await user("Manager", await role("BL manager", all));
  people.billing = await user("Billing", await role("BL billing", ["clients.view", "clients.view_billing", "clients.edit_billing", "messages.view"]));
  people.viewer = await user("Viewer", await role("BL viewer", ["clients.view", "clients.view_billing", "messages.view"]));
  people.plain = await user("Plain", await role("BL plain", ["clients.view", "clients.update", "messages.view"]));
  const make = async (name: string, withFeature: boolean) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    if (withFeature) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("BillA", true);
  B = await make("BillB", true);
  C = await make("BillC", false);
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientDueEvent.deleteMany({ where });
  await rawPrisma.clientDue.deleteMany({ where });
  await rawPrisma.clientBillingCurrency.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. permissions and the feature switch", () => {
  it("refuses a due, a currency and an edit without clients.edit_billing, and writes nothing", async () => {
    const clientId = await newClient(A, "Perm Client");
    for (const person of [people.viewer, people.plain]) {
      expect((await addDue(person, A, clientId, { dueDate: "2026-12-01" })).error).toMatch(/permission/i);
      expect((await as(person, A, () => billing.addBillingCurrency({}, form({ code: "BDT" })))).error).toMatch(/permission/i);
    }
    const made = await addDue(people.billing, A, clientId, { dueDate: "2026-12-01" });
    expect(made.success).toBe(true);
    const due = await rawPrisma.clientDue.findFirstOrThrow({ where: { clientId } });
    expect((await editDue(people.viewer, A, due.id, { dueDate: "2026-12-02", status: "PAID" })).error).toMatch(/permission/i);
    expect((await as(people.viewer, A, () => billing.setBillingCurrencyEnabled("BDT", false))).ok).toBe(false);
    expect(await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: "UNPAID" });
    expect(await rawPrisma.clientBillingCurrency.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("refuses everything in a project whose CLIENT_CENTER feature is off", async () => {
    const clientId = await newClient(A, "Feature Client");
    const r = await as(people.billing, C, () => billing.createDue(clientId, {}, form({ dueDate: "2026-12-01" })));
    expect(r.error).toBeTruthy();
    expect((await as(people.billing, C, () => billing.addBillingCurrency({}, form({ code: "BDT" })))).error).toBeTruthy();
    expect(await rawPrisma.clientDue.count({ where: { projectId: C.id } })).toBe(0);
  });
});

describe("2. currency: only with an amount, only from the project's list, empty to begin with", () => {
  it("lets a due be saved with a date only, and refuses an amount while the list is empty", async () => {
    const clientId = await newClient(A, "Currency Client");
    expect(await as(people.billing, A, () => reads.listBillingCurrencies())).toEqual([]);
    expect((await addDue(people.billing, A, clientId, { dueDate: "2026-12-05" })).success).toBe(true);
    const refused = await addDue(people.billing, A, clientId, { dueDate: "2026-12-06", amount: "500" });
    expect(refused.error).toMatch(/Add a currency/);
    expect(refused.values?.amount).toBe("500");
    expect(await rawPrisma.clientDue.count({ where: { clientId } })).toBe(1);
  });

  it("accepts an amount with a listed currency, stores the rest as typed, and drops a currency typed without an amount", async () => {
    const clientId = await newClient(A, "Amount Client");
    expect((await addCurrency(A, "bdt")).success).toBe(true);
    expect((await addDue(people.billing, A, clientId, { dueDate: "2026-12-07", amount: "12,500.5", currency: "usd" })).error).toMatch(/not on this project's currency list/);
    expect((await addDue(people.billing, A, clientId, { dueDate: "2026-12-07", amount: "12,500.5", currency: "BDT" })).success).toBe(true);
    expect((await addDue(people.billing, A, clientId, { dueDate: "2026-12-08", currency: "BDT" })).success).toBe(true);
    const dues = await rawPrisma.clientDue.findMany({ where: { clientId }, orderBy: { dueDate: "asc" } });
    expect(dues[0]).toMatchObject({ currency: "BDT" });
    expect(dues[0]!.amount!.toFixed(2)).toBe("12500.50");
    expect(dues[1]).toMatchObject({ amount: null, currency: null });
    expect(dues[0]!.dueDate.toISOString().slice(0, 10)).toBe("2026-12-07");
  });

  it("turning a currency off stops it being offered but leaves a due that uses it editable", async () => {
    const clientId = await newClient(A, "Off Client");
    await addCurrency(A, "EUR");
    await addDue(people.billing, A, clientId, { dueDate: "2026-12-09", amount: "40", currency: "EUR" });
    expect((await as(people.billing, A, () => billing.setBillingCurrencyEnabled("EUR", false))).ok).toBe(true);
    expect((await addDue(people.billing, A, clientId, { dueDate: "2026-12-10", amount: "40", currency: "EUR" })).error).toMatch(/not on this project's currency list/);
    const due = await rawPrisma.clientDue.findFirstOrThrow({ where: { clientId } });
    expect((await editDue(people.billing, A, due.id, { dueDate: "2026-12-09", amount: "40", currency: "EUR", status: "PAID" })).success).toBe(true);
    expect(await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: "PAID", currency: "EUR" });
  });

  it("keeps each project's currency list to itself", async () => {
    expect((await as(people.billing, B, () => reads.listBillingCurrencies())).map((c) => c.code)).toEqual([]);
    await addCurrency(B, "BDT");
    expect((await as(people.billing, B, () => reads.listBillingCurrencies())).map((c) => c.code)).toEqual(["BDT"]);
    expect((await as(people.billing, A, () => reads.listBillingCurrencies())).map((c) => c.code)).toContain("BDT");
    expect(await rawPrisma.clientBillingCurrency.count({ where: { projectId: B.id, code: "BDT" } })).toBe(1);
  });
});

describe("3. history: every change is an event, and nothing is overwritten", () => {
  it("records creation, a status change and a plain edit, with who and what changed", async () => {
    const clientId = await newClient(A, "History Client");
    await addDue(people.billing, A, clientId, { dueDate: "2026-12-11", amount: "100", currency: "BDT" });
    const due = await rawPrisma.clientDue.findFirstOrThrow({ where: { clientId } });
    expect((await editDue(people.billing, A, due.id, { dueDate: "2026-12-11", amount: "100", currency: "BDT", status: "PARTIALLY_PAID", paidAmount: "40" })).success).toBe(true);
    expect((await editDue(people.billing, A, due.id, { dueDate: "2026-12-11", amount: "100", currency: "BDT", status: "PARTIALLY_PAID", paidAmount: "40", note: "called" })).success).toBe(true);
    const events = await rawPrisma.clientDueEvent.findMany({ where: { dueId: due.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["CREATED", "STATUS_CHANGED", "UPDATED"]);
    expect(events[1]!.changes).toMatchObject({ status: { from: "UNPAID", to: "PARTIALLY_PAID" }, paidAmount: { from: null, to: "40.00" } });
    expect(events[2]!.changes).toEqual({ note: { from: null, to: "called" } });
    expect(events.every((e) => e.actorUserId === people.billing.userId)).toBe(true);
    const after = await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.statusChangedAt).not.toBeNull();
    expect(after.updatedById).toBe(people.billing.userId);
  });

  it("writes nothing when an edit changes nothing", async () => {
    const clientId = await newClient(A, "Same Client");
    await addDue(people.billing, A, clientId, { dueDate: "2026-12-12" });
    const due = await rawPrisma.clientDue.findFirstOrThrow({ where: { clientId } });
    expect((await editDue(people.billing, A, due.id, { dueDate: "2026-12-12", status: "UNPAID" })).success).toBe(true);
    expect(await rawPrisma.clientDueEvent.count({ where: { dueId: due.id } })).toBe(1);
  });

  it("makes the database refuse to change an event", async () => {
    const event = await rawPrisma.clientDueEvent.findFirstOrThrow({ where: { projectId: A.id } });
    await expect(rawPrisma.clientDueEvent.update({ where: { id: event.id }, data: { type: "EDITED" } })).rejects.toThrow(/append-only/);
  });

  it("puts no amount and no date on the client's timeline (readable with clients.view)", async () => {
    const clientId = await newClient(A, "Timeline Client");
    await addDue(people.billing, A, clientId, { dueDate: "2031-03-04", amount: "98765.43", currency: "BDT" });
    const activities = await rawPrisma.clientActivity.findMany({ where: { clientId, type: "BILLING_CHANGED" } });
    expect(activities).toHaveLength(1);
    expect(JSON.stringify(activities)).not.toMatch(/98765|2031-03-04/);
  });

  it("describes an event for the history without showing amounts", () => {
    expect(reads.describeDueEvent("STATUS_CHANGED", { status: { from: "UNPAID", to: "PAID" } }, "2026-12-11")).toBe("Status UNPAID → PAID (due 2026-12-11)");
    expect(reads.describeDueEvent("UPDATED", { amount: { from: "1.00", to: "2.00" } }, null)).toBe("Changed amount");
  });
});

describe("4. reading: the open and overdue views, and the derived summary", () => {
  it("lists open and overdue dues and leaves settled ones out of both", async () => {
    const clientId = await newClient(B, "Overdue Client");
    await addDue(people.billing, B, clientId, { dueDate: "2020-01-15" });
    await addDue(people.billing, B, clientId, { dueDate: "2099-01-15" });
    await addDue(people.billing, B, clientId, { dueDate: "2020-02-15", status: "PAID" });
    const view = (v: string) => as(people.billing, B, () => reads.listDues(reads.parseDueFilters({ view: v })));
    expect((await view("overdue")).dues.map((d) => d.dueDate)).toEqual(["2020-01-15"]);
    expect((await view("open")).dues.map((d) => d.dueDate)).toEqual(["2020-01-15", "2099-01-15"]);
    expect((await view("all")).total).toBe(3);
    expect((await view("PAID")).dues.map((d) => d.dueDate)).toEqual(["2020-02-15"]);
    const detail = await as(people.billing, B, () => reads.getClientBilling(clientId));
    expect(detail.summary).toMatchObject({ openCount: 2, overdueCount: 1, oldestOverdueDate: "2020-01-15", nextDueDate: "2099-01-15" });
  });

  it("filters by client name or code", async () => {
    const found = await as(people.billing, B, () => reads.listDues(reads.parseDueFilters({ view: "all", q: "overdue client" })));
    expect(found.dues.length).toBe(3);
    expect((await as(people.billing, B, () => reads.listDues(reads.parseDueFilters({ view: "all", q: "no such client" })))).dues).toEqual([]);
  });
});

describe("5. archived clients and deletion", () => {
  it("refuses a new due or an edit on an archived client, and a deleted client takes its dues with it", async () => {
    const clientId = await newClient(A, "Archive Client");
    await addDue(people.billing, A, clientId, { dueDate: "2026-12-13" });
    const due = await rawPrisma.clientDue.findFirstOrThrow({ where: { clientId } });
    await as(people.manager, A, () => clientActions.archiveClients([clientId]));
    expect((await addDue(people.billing, A, clientId, { dueDate: "2026-12-14" })).error).toMatch(/archived/);
    expect((await editDue(people.billing, A, due.id, { dueDate: "2026-12-13", status: "PAID" })).error).toMatch(/archived/);
    expect((await as(people.manager, A, () => clientActions.deleteClients([clientId]))).ok).toBe(true);
    expect(await rawPrisma.clientDue.count({ where: { clientId } })).toBe(0);
    expect(await rawPrisma.clientDueEvent.count({ where: { clientId } })).toBe(0);
  });
});

describe("6. project isolation", () => {
  it("does not find, list or change another project's due, whatever id is posted", async () => {
    const clientId = await newClient(A, "Isolated Client");
    await addDue(people.billing, A, clientId, { dueDate: "2026-12-15" });
    const due = await rawPrisma.clientDue.findFirstOrThrow({ where: { clientId } });
    expect((await editDue(people.manager, B, due.id, { dueDate: "2026-12-15", status: "PAID" })).error).toMatch(/no longer exists/);
    expect((await addDue(people.manager, B, clientId, { dueDate: "2026-12-15" })).error).toMatch(/no longer exists/);
    expect((await as(people.manager, B, () => reads.listDues(reads.parseDueFilters({ view: "all", q: "Isolated Client" })))).dues).toEqual([]);
    expect((await as(people.manager, B, () => reads.getClientBilling(clientId))).dues).toEqual([]);
    expect(await rawPrisma.clientDue.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({ status: "UNPAID", projectId: A.id });
  });

  it("makes the database refuse a due that points at a client in another project", async () => {
    const clientId = await newClient(A, "Trigger Client");
    await expect(rawPrisma.clientDue.create({ data: { projectId: B.id, clientId, dueDate: new Date("2026-12-16T00:00:00Z") } })).rejects.toThrow();
    expect(await rawPrisma.clientDue.count({ where: { clientId } })).toBe(0);
  });
});
