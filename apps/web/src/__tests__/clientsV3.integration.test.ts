import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { addCalendarDays, dhakaToday, PERMISSIONS, termState, type SubscriptionState } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Clients V3 (CLIENTS_V3.md): subscriptions, numbered invoices, payments, WhatsApp GROUP links, the
 * guided form, photos, list columns, the register filters and the per-project switches — in separate
 * projects, so none of it crosses.
 *
 * What must hold, beyond "it saves":
 *   - a subscription's expiry is not a debt: no invoice appears unless one is raised;
 *   - a payment is all-or-nothing, never more than what is left, never across currencies or clients,
 *     recorded once however often Record is pressed, and two people paying the same invoice at once
 *     cannot both succeed;
 *   - a reversal gives the amount back and is final; the database refuses rewriting a payment;
 *   - a group link sends nothing and changes no monitoring flag, a group has one owner, and history is kept;
 *   - the server decides what a viewer sees: a billing column or filter is ignored without the key;
 *   - a sub-module switched off in Settings refuses its actions on the server.
 */

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
/** WhatsApp group ids are digits; a unique run number keeps reruns apart. */
const gnum = String(Date.now()).slice(-9);
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
const subs = await import("@/server/actions/clientSubscriptions");
const pay = await import("@/server/actions/clientPayments");
const groups = await import("@/server/actions/clientGroupLinks");
const extras = await import("@/server/actions/clientExtras");
const reads = await import("@/server/clients");
const billingReads = await import("@/server/clientBilling");
const moduleReads = await import("@/server/clientModule");
const { parseClientFilters } = await import("@/lib/clientFilters");
const photoRoute = await import("@/app/p/[project]/api/clients/[id]/photo/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;

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
const people = {} as Record<"admin" | "seller" | "viewer" | "cashier" | "mainAdmin", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const today = dhakaToday(new Date());
const plus = (n: number) => addCalendarDays(today, n);
const roster = {} as Record<string, string>;
const accounts = {} as Record<string, string>;

const newClient = async (project: Project, fields: Record<string, string | Blob>, person = people.admin) => as(person, project, () => clientActions.createClient({}, form(fields)));
const idOf = (r: { clientId?: string; error?: string }) => {
  if (!r.clientId) throw new Error(`not created: ${r.error}`);
  return r.clientId;
};
const sell = (person: Session, project: Project, clientId: string, fields: Record<string, string>) => as(person, project, () => subs.createSubscription(clientId, {}, form(fields)));
const invoice = async (project: Project, clientId: string, fields: Record<string, string>) => {
  const r = await as(people.admin, project, () => billing.createDue(clientId, {}, form(fields)));
  if (!r.success) throw new Error(r.error);
  return rawPrisma.clientDue.findFirstOrThrow({ where: { clientId }, orderBy: { createdAt: "desc" } });
};
const record = (person: Session, project: Project, lines: Array<{ dueId: string; amount: string }>, key = randomUUID().replace(/-/g, "")) =>
  as(person, project, () => pay.recordPayments({ idempotencyKey: key, method: "BANK_TRANSFER", receivedDate: today, reference: "TX-1", note: "", lines }));
const dueRow = (id: string) => rawPrisma.clientDue.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  const base = ["clients.view", "clients.create", "clients.update", "messages.view"];
  people.admin = await user(
    "V3Admin",
    await role("V3 admin", [...base, "clients.view_billing", "clients.edit_billing", "clients.manage_subscriptions", "clients.link_whatsapp_group", "clients.manage_settings", "clients.archive"]),
  );
  people.seller = await user("V3Seller", await role("V3 seller", [...base, "clients.manage_subscriptions"]));
  people.viewer = await user("V3Viewer", await role("V3 viewer", ["clients.view", "messages.view"]));
  people.cashier = await user("V3Cashier", await role("V3 cashier", ["clients.view", "clients.view_billing", "clients.edit_billing"]));
  people.mainAdmin = await user("V3Main", await role("V3 main", ["clients.view", "clients.update", "clients.delete", "projects.view", "projects.manage"]));
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    for (const code of ["BDT", "AED", "JPY"]) await rawPrisma.clientBillingCurrency.create({ data: { projectId: p.id, code } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("V3A");
  B = await make("V3B");
  const sales = await rawPrisma.team.create({ data: { projectId: A.id, name: `Sales ${tag}` } });
  const support = await rawPrisma.team.create({ data: { projectId: A.id, name: `Support ${tag}` } });
  const old = await rawPrisma.team.create({ data: { projectId: A.id, name: `Old ${tag}`, status: "DISABLED" } });
  roster.sales = sales.id;
  roster.support = support.id;
  roster.oldTeam = old.id;
  const member = (name: string, teamId: string | null, status: "ACTIVE" | "INACTIVE" = "ACTIVE", project = A) =>
    rawPrisma.internalTeamMember.create({ data: { projectId: project.id, name, phoneNumber: `88017${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`, role: "Sales Executive", teamId, status } }).then((m) => m.id);
  roster.nadia = await member("Nadia", sales.id);
  roster.fahim = await member("Fahim", support.id);
  roster.gone = await member("Gone", sales.id, "INACTIVE");
  roster.bMember = await member("B Person", null, "ACTIVE", B);
  accounts.a1 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: A.id, label: `A one ${tag}`, status: "CONNECTED" } })).id;
  accounts.a2 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: A.id, label: `A two ${tag}`, status: "CONNECTED" } })).id;
  accounts.b1 = (await rawPrisma.whatsAppAccount.create({ data: { projectId: B.id, label: `B one ${tag}`, status: "CONNECTED" } })).id;
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.client.updateMany({ where, data: { currentSubscriptionId: null } });
  await rawPrisma.clientPaymentAllocation.deleteMany({ where });
  await rawPrisma.clientPayment.deleteMany({ where });
  await rawPrisma.clientDueEvent.deleteMany({ where });
  await rawPrisma.clientDue.deleteMany({ where });
  await rawPrisma.clientWhatsAppGroupLink.deleteMany({ where });
  await rawPrisma.clientSubscription.deleteMany({ where });
  await rawPrisma.clientPhoto.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.listViewPreference.deleteMany({ where });
  await rawPrisma.clientModuleSettings.deleteMany({ where });
  await rawPrisma.clientBillingCurrency.deleteMany({ where });
  await rawPrisma.whatsAppGroup.deleteMany({ where });
  await rawPrisma.whatsAppAccount.deleteMany({ where });
  await rawPrisma.internalTeamMember.deleteMany({ where });
  await rawPrisma.team.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. subscriptions", () => {
  it("sells a term with a real roster seller, snapshots the seller, sets the current term — and raises no invoice by itself", async () => {
    const clientId = idOf(await newClient(A, { name: "Orchid Networks" }));
    const r = await sell(people.seller, A, clientId, { service: "Tiger IPTV", kind: "PAID", startDate: today, durationValue: "3", durationUnit: "MONTH", soldByMemberId: roster.nadia });
    expect(r.success).toBe(true);
    const client = await rawPrisma.client.findUniqueOrThrow({ where: { id: clientId }, include: { currentSubscription: true } });
    expect(client.currentSubscription).toMatchObject({ service: "Tiger IPTV", soldByName: "Nadia", soldByTeamName: `Sales ${tag}`, isRenewal: false });
    expect(await rawPrisma.clientDue.count({ where: { clientId } })).toBe(0);
  });

  it("refuses without the key, an inactive seller, and another project's seller; writes nothing", async () => {
    const clientId = idOf(await newClient(A, { name: "Refused Sale" }));
    const fields = { service: "X", startDate: today, durationValue: "1", durationUnit: "MONTH" };
    expect((await sell(people.viewer, A, clientId, fields)).error).toMatch(/permission/i);
    expect((await sell(people.seller, A, clientId, { ...fields, soldByMemberId: roster.gone })).error).toMatch(/no longer active/);
    expect((await sell(people.seller, A, clientId, { ...fields, soldByMemberId: roster.bMember })).error).toMatch(/roster/);
    expect(await rawPrisma.clientSubscription.count({ where: { clientId } })).toBe(0);
  });

  it("renews from the old expiry, marks the client as returning, keeps the old term, and moves the current term", async () => {
    const clientId = idOf(await newClient(A, { name: "Renewing Client" }));
    await sell(people.seller, A, clientId, { service: "Premium TV", startDate: plus(-20), durationValue: "30", durationUnit: "DAY" });
    const first = await rawPrisma.clientSubscription.findFirstOrThrow({ where: { clientId } });
    const r = await as(people.seller, A, () => subs.renewSubscription(first.id, {}, form({})));
    expect(r.success).toBe(true);
    const terms = await rawPrisma.clientSubscription.findMany({ where: { clientId }, orderBy: { createdAt: "asc" } });
    expect(terms).toHaveLength(2);
    expect(terms[1]!.startDate.toISOString().slice(0, 10)).toBe(plus(10));
    expect(terms[1]!.endDate.toISOString().slice(0, 10)).toBe(plus(40));
    expect(terms[1]).toMatchObject({ isRenewal: true, renewedFromId: first.id });
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentSubscriptionId).toBe(terms[1]!.id);
    // A future-dated renewal of a running term reads ACTIVE, not "starts later".
    const list = await as(people.admin, A, () => reads.listClients({ filters: parseClientFilters({ q: "Renewing Client" }), sort: "name", dir: "asc", page: 1, pageSize: 10 }));
    expect(list.clients[0]).toMatchObject({ subscriptionState: "ACTIVE", returning: true, subscriptionCount: 2 });
  });

  it("pauses, resumes and cancels once each, recomputing the current term", async () => {
    const clientId = idOf(await newClient(A, { name: "Pause Client" }));
    await sell(people.seller, A, clientId, { service: "S1", startDate: plus(-5), durationValue: "1", durationUnit: "MONTH" });
    const t = await rawPrisma.clientSubscription.findFirstOrThrow({ where: { clientId } });
    expect((await as(people.seller, A, () => subs.setSubscriptionPaused(t.id, true))).ok).toBe(true);
    expect((await as(people.seller, A, () => subs.setSubscriptionPaused(t.id, true))).ok).toBe(false);
    expect((await as(people.seller, A, () => subs.setSubscriptionPaused(t.id, false))).ok).toBe(true);
    expect((await as(people.seller, A, () => subs.cancelSubscription(t.id, ""))).ok).toBe(false);
    expect((await as(people.seller, A, () => subs.cancelSubscription(t.id, "Client moved away"))).ok).toBe(true);
    expect((await as(people.seller, A, () => subs.cancelSubscription(t.id, "again"))).ok).toBe(false);
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentSubscriptionId).toBeNull();
    expect(await rawPrisma.clientSubscription.count({ where: { clientId } })).toBe(1);
  });

  it("filters by subscription state in SQL exactly as termState reads each term", async () => {
    const cases: Array<{ name: string; start: number; end: number; kind?: string; renewal?: boolean }> = [
      { name: "St Active", start: -10, end: 60 },
      { name: "St Expiring", start: -20, end: 3 },
      { name: "St Expired", start: -40, end: -1 },
      { name: "St Expires Today", start: -30, end: 0 },
      { name: "St Trial", start: -2, end: 5, kind: "TRIAL" },
      { name: "St Scheduled", start: 5, end: 40 },
    ];
    const made: Array<{ id: string; expected: SubscriptionState }> = [];
    for (const c of cases) {
      const id = idOf(await newClient(A, { name: `${c.name} ${tag}` }));
      const r = await sell(people.seller, A, id, { service: "State Plan", kind: c.kind ?? "PAID", startDate: plus(c.start), durationValue: "", durationUnit: "", endDate: plus(c.end) });
      if (c.end <= c.start) continue;
      expect(r.error).toBeUndefined();
      made.push({ id, expected: termState({ id, kind: c.kind ?? "PAID", startDate: plus(c.start), endDate: plus(c.end), pausedAt: null, cancelledAt: null, isRenewal: false }, today, 7) });
    }
    for (const state of ["ACTIVE", "EXPIRING", "EXPIRED", "TRIAL", "SCHEDULED"] as const) {
      const found = await as(people.admin, A, () => reads.listClients({ filters: parseClientFilters({ state, service: "State Plan" }), sort: "name", dir: "asc", page: 1, pageSize: 50 }));
      expect(found.clients.map((c) => c.id).sort(), state).toEqual(made.filter((m) => m.expected === state).map((m) => m.id).sort());
      for (const c of found.clients) expect(c.subscriptionState).toBe(state);
    }
  });

  it("is refused when Subscriptions is switched off for the project", async () => {
    await as(people.admin, A, () => extras.saveClientModuleSettings({ subscriptions: false, billing: true, payments: true, whatsappGroups: true, requiredFields: [], renewalWindowDays: 7, defaultCountry: "" }));
    const clientId = idOf(await newClient(A, { name: "Off Client" }));
    expect((await sell(people.seller, A, clientId, { service: "X", startDate: today, durationValue: "1", durationUnit: "MONTH" })).error).toMatch(/switched off/);
    await as(people.admin, A, () => extras.saveClientModuleSettings({ subscriptions: true, billing: true, payments: true, whatsappGroups: true, requiredFields: [], renewalWindowDays: 7, defaultCountry: "" }));
  });
});

describe("2. invoices and payments", () => {
  it("numbers every new invoice and can raise one with a sale", async () => {
    const clientId = idOf(await newClient(A, { name: "Invoice Client" }));
    const due = await invoice(A, clientId, { dueDate: plus(5), amount: "1500", currency: "BDT", kind: "SERVICE", service: "Setup", soldByMemberId: roster.fahim });
    expect(due.invoiceNumber).toMatch(/^INV-\d{6}$/);
    expect(due).toMatchObject({ kind: "SERVICE", service: "Setup", soldByMemberId: roster.fahim });
    const r = await as(people.admin, A, () => subs.createSubscription(clientId, {}, form({ service: "Tiger IPTV", startDate: today, durationValue: "1", durationUnit: "YEAR", invoiceAmount: "900", invoiceCurrency: "AED", invoiceDueDate: plus(7) })));
    expect(r.message).toMatch(/INV-\d{6}/);
    const sale = await rawPrisma.clientDue.findFirstOrThrow({ where: { clientId, kind: "SUBSCRIPTION" } });
    expect(sale.subscriptionId).not.toBeNull();
    // Selling with an amount needs the billing key too.
    expect((await sell(people.seller, A, clientId, { service: "Y", startDate: today, durationValue: "1", durationUnit: "MONTH", invoiceAmount: "10", invoiceCurrency: "BDT", invoiceDueDate: today })).error).toMatch(/Edit Client Billing/);
  });

  it("records a partial then a full payment, each audited, with the timeline naming no amount", async () => {
    const clientId = idOf(await newClient(A, { name: "Payer One" }));
    const due = await invoice(A, clientId, { dueDate: plus(3), amount: "300", currency: "AED" });
    const first = await record(people.cashier, A, [{ dueId: due.id, amount: "100" }]);
    expect(first.ok).toBe(true);
    expect(await dueRow(due.id)).toMatchObject({ status: "PARTIALLY_PAID" });
    expect((await dueRow(due.id)).paidAmount?.toFixed(2)).toBe("100.00");
    const second = await record(people.cashier, A, [{ dueId: due.id, amount: "200.00" }]);
    expect(second.ok).toBe(true);
    expect(await dueRow(due.id)).toMatchObject({ status: "PAID" });
    expect(await rawPrisma.clientDueEvent.count({ where: { dueId: due.id, type: "PAYMENT_RECORDED" } })).toBe(2);
    const timeline = await rawPrisma.clientActivity.findMany({ where: { clientId, type: "PAYMENT_RECORDED" } });
    expect(timeline).toHaveLength(2);
    for (const entry of timeline) {
      expect(entry.summary).toMatch(/^Payment RCPT-\d{6} recorded against INV-\d{6}$/);
      expect(Object.keys((entry.details ?? {}) as object)).toEqual(["paymentId"]);
    }
  });

  it("splits a batch into one receipt per client and currency, and refuses the whole batch on any bad line", async () => {
    const c1 = idOf(await newClient(A, { name: "Batch One" }));
    const c2 = idOf(await newClient(A, { name: "Batch Two" }));
    const d1 = await invoice(A, c1, { dueDate: plus(1), amount: "100", currency: "AED" });
    const d2 = await invoice(A, c1, { dueDate: plus(2), amount: "50", currency: "AED" });
    const d3 = await invoice(A, c1, { dueDate: plus(2), amount: "1000", currency: "BDT" });
    const d4 = await invoice(A, c2, { dueDate: plus(2), amount: "70", currency: "AED" });

    const refused = await record(people.cashier, A, [{ dueId: d1.id, amount: "100" }, { dueId: d2.id, amount: "50.01" }]);
    expect(refused.ok).toBe(false);
    expect(refused.lineErrors?.[d2.id]).toMatch(/More than what is left/);
    expect((await dueRow(d1.id)).status).toBe("UNPAID");

    const ok = await record(people.cashier, A, [{ dueId: d1.id, amount: "100" }, { dueId: d2.id, amount: "25" }, { dueId: d3.id, amount: "1000" }, { dueId: d4.id, amount: "70" }]);
    expect(ok.ok).toBe(true);
    expect(ok.receipts?.map((r) => `${r.clientId === c1 ? "c1" : "c2"}:${r.currency}:${r.amount}`).sort()).toEqual(["c1:AED:125.00", "c1:BDT:1000.00", "c2:AED:70.00"]);
    expect((await dueRow(d2.id)).status).toBe("PARTIALLY_PAID");
    const payments = await rawPrisma.clientPayment.findMany({ where: { clientId: { in: [c1, c2] } }, include: { allocations: true } });
    expect(payments.every((p) => p.allocations.every((a) => a.amount.lte(p.amount)))).toBe(true);
  });

  it("records once however often Record is pressed, including at the same moment", async () => {
    const clientId = idOf(await newClient(A, { name: "Twice Pressed" }));
    const due = await invoice(A, clientId, { dueDate: plus(1), amount: "40", currency: "AED" });
    const key = randomUUID().replace(/-/g, "");
    const [a, b] = await Promise.all([record(people.cashier, A, [{ dueId: due.id, amount: "10" }], key), record(people.cashier, A, [{ dueId: due.id, amount: "10" }], key)]);
    expect(a.ok && b.ok).toBe(true);
    const again = await record(people.cashier, A, [{ dueId: due.id, amount: "10" }], key);
    expect(again.alreadyRecorded).toBe(true);
    expect(await rawPrisma.clientPayment.count({ where: { clientId } })).toBe(1);
    expect((await dueRow(due.id)).paidAmount?.toFixed(2)).toBe("10.00");
  });

  it("lets only one of two people settle the same remaining amount at once", async () => {
    const clientId = idOf(await newClient(A, { name: "Race Client" }));
    const due = await invoice(A, clientId, { dueDate: plus(1), amount: "60", currency: "AED" });
    const results = await Promise.all([record(people.cashier, A, [{ dueId: due.id, amount: "60" }]), record(people.admin, A, [{ dueId: due.id, amount: "60" }])]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await dueRow(due.id)).paidAmount?.toFixed(2)).toBe("60.00");
  });

  it("refuses decimals a currency does not have, a paid invoice, a future date, and someone without the key", async () => {
    const clientId = idOf(await newClient(A, { name: "Yen Client" }));
    const yen = await invoice(A, clientId, { dueDate: plus(1), amount: "5000", currency: "JPY" });
    expect((await record(people.cashier, A, [{ dueId: yen.id, amount: "10.50" }])).lineErrors?.[yen.id]).toMatch(/no decimals/);
    expect((await record(people.viewer, A, [{ dueId: yen.id, amount: "10" }])).message).toMatch(/permission/i);
    const future = await as(people.cashier, A, () => pay.recordPayments({ idempotencyKey: randomUUID().replace(/-/g, ""), method: "CASH", receivedDate: plus(3), reference: "", note: "", lines: [{ dueId: yen.id, amount: "10" }] }));
    expect(future.message).toMatch(/future/);
    expect(await rawPrisma.clientPayment.count({ where: { clientId } })).toBe(0);
  });

  it("reverses a payment back to owed, once, and keeps the receipt marked reversed", async () => {
    const clientId = idOf(await newClient(A, { name: "Reverse Client" }));
    const due = await invoice(A, clientId, { dueDate: plus(1), amount: "80", currency: "AED" });
    await record(people.cashier, A, [{ dueId: due.id, amount: "80" }]);
    const payment = await rawPrisma.clientPayment.findFirstOrThrow({ where: { clientId } });
    expect((await as(people.cashier, A, () => pay.reversePayment(payment.id, ""))).ok).toBe(false);
    expect((await as(people.cashier, A, () => pay.reversePayment(payment.id, "Wrong client"))).ok).toBe(true);
    expect(await dueRow(due.id)).toMatchObject({ status: "UNPAID", paidAmount: null });
    expect((await as(people.cashier, A, () => pay.reversePayment(payment.id, "again"))).ok).toBe(false);
    expect((await rawPrisma.clientPayment.findUniqueOrThrow({ where: { id: payment.id } })).reversalReason).toBe("Wrong client");
  });

  it("makes the database refuse rewriting a payment, un-reversing it, or allocating across clients", async () => {
    const c1 = idOf(await newClient(A, { name: "Guard One" }));
    const c2 = idOf(await newClient(A, { name: "Guard Two" }));
    const d1 = await invoice(A, c1, { dueDate: plus(1), amount: "10", currency: "AED" });
    const d2 = await invoice(A, c2, { dueDate: plus(1), amount: "10", currency: "AED" });
    await record(people.cashier, A, [{ dueId: d1.id, amount: "5" }]);
    const p = await rawPrisma.clientPayment.findFirstOrThrow({ where: { clientId: c1 } });
    await expect(rawPrisma.clientPayment.update({ where: { id: p.id }, data: { amount: "9.00" } })).rejects.toThrow(/cannot be changed/);
    await expect(rawPrisma.clientPaymentAllocation.create({ data: { projectId: A.id, paymentId: p.id, dueId: d2.id, amount: "1.00" } })).rejects.toThrow(/same client and currency/);
    await rawPrisma.clientPayment.update({ where: { id: p.id }, data: { reversedAt: new Date(), reversalReason: "x" } });
    await expect(rawPrisma.clientPayment.update({ where: { id: p.id }, data: { reversedAt: null } })).rejects.toThrow(/stays reversed/);
  });

  it("keeps a hand edit of the invoice from dropping below what receipts settled", async () => {
    const clientId = idOf(await newClient(A, { name: "Hand Edit" }));
    const due = await invoice(A, clientId, { dueDate: plus(1), amount: "100", currency: "AED" });
    await record(people.cashier, A, [{ dueId: due.id, amount: "40" }]);
    const edit = (fields: Record<string, string>) => as(people.admin, A, () => billing.updateDue(due.id, {}, form({ dueDate: plus(1), currency: "AED", ...fields })));
    expect((await edit({ amount: "100", status: "UNPAID", paidAmount: "" })).error).toMatch(/already settled/);
    expect((await edit({ amount: "100", status: "PARTIALLY_PAID", paidAmount: "10" })).error).toMatch(/already settled/);
    expect((await edit({ amount: "", status: "PARTIALLY_PAID", paidAmount: "" })).error).toBeTruthy();
    expect((await edit({ amount: "120", status: "PARTIALLY_PAID", paidAmount: "40" })).success).toBe(true);
  });

  it("never pays another project's invoice", async () => {
    const clientId = idOf(await newClient(A, { name: "Foreign Due" }));
    const due = await invoice(A, clientId, { dueDate: plus(1), amount: "10", currency: "AED" });
    const r = await record(people.cashier, B, [{ dueId: due.id, amount: "5" }]);
    expect(r.ok).toBe(false);
    expect(r.lineErrors?.[due.id]).toMatch(/no longer exists/);
  });
});

describe("3. WhatsApp group links", () => {
  const group = async (accountId: string, project: Project, jid: string, extra: Record<string, unknown> = {}) =>
    rawPrisma.whatsAppGroup.create({ data: { projectId: project.id, accountId, whatsappGroupId: jid, name: `Group ${jid.slice(0, 6)}`, isMonitored: false, aiAutomationEnabled: false, ...extra } });

  it("links a synced group without touching monitoring, AI or anything sent", async () => {
    const clientId = idOf(await newClient(A, { name: "Group Client" }));
    const g = await group(accounts.a1, A, `120363${gnum}01@g.us`);
    const outboundBefore = await rawPrisma.outboundMessage.count();
    const commandsBefore = await rawPrisma.workerCommand.count();
    const r = await as(people.admin, A, () => groups.linkClientGroup(clientId, accounts.a1, g.id));
    expect(r.ok).toBe(true);
    expect(await rawPrisma.whatsAppGroup.findUniqueOrThrow({ where: { id: g.id } })).toMatchObject({ isMonitored: false, aiAutomationEnabled: false });
    expect(await rawPrisma.outboundMessage.count()).toBe(outboundBefore);
    expect(await rawPrisma.workerCommand.count()).toBe(commandsBefore);
    const list = await as(people.admin, A, () => reads.listClients({ filters: parseClientFilters({ group: "linked", q: "Group Client" }), sort: "name", dir: "asc", page: 1, pageSize: 10 }));
    expect(list.clients[0]!.groups.map((x) => x.name)).toEqual([g.name]);
  });

  it("gives a group one owner — through any of our numbers — and frees it on unlink, keeping history", async () => {
    const owner = idOf(await newClient(A, { name: "Owner" }));
    const other = idOf(await newClient(A, { name: "Other" }));
    const jid = `120363${gnum}02@g.us`;
    const g1 = await group(accounts.a1, A, jid);
    const g2 = await group(accounts.a2, A, jid);
    expect((await as(people.admin, A, () => groups.linkClientGroup(owner, accounts.a1, g1.id))).ok).toBe(true);
    const clash = await as(people.admin, A, () => groups.linkClientGroup(other, accounts.a2, g2.id));
    expect(clash.message).toMatch(/already linked to Owner/);
    const candidates = await as(people.admin, A, () => groups.searchLinkableGroups(accounts.a2, jid.slice(0, 10)));
    expect(candidates.find((c) => c.groupId === g2.id)?.linkedTo?.name).toBe("Owner");
    const link = await rawPrisma.clientWhatsAppGroupLink.findFirstOrThrow({ where: { clientId: owner } });
    expect((await as(people.admin, A, () => groups.unlinkClientGroup(link.id, "moved"))).ok).toBe(true);
    expect((await as(people.admin, A, () => groups.linkClientGroup(other, accounts.a2, g2.id))).ok).toBe(true);
    expect(await rawPrisma.clientWhatsAppGroupLink.count({ where: { whatsappGroupId: jid } })).toBe(2);
  });

  it("refuses an inactive group, a mismatched account, another project's group, and anyone without the key", async () => {
    const clientId = idOf(await newClient(A, { name: "Refused Links" }));
    const inactive = await group(accounts.a1, A, `120363${gnum}03@g.us`, { isActive: false });
    const active = await group(accounts.a1, A, `120363${gnum}04@g.us`);
    const foreign = await group(accounts.b1, B, `120363${gnum}05@g.us`);
    expect((await as(people.admin, A, () => groups.linkClientGroup(clientId, accounts.a1, inactive.id))).message).toMatch(/inactive/);
    expect((await as(people.admin, A, () => groups.linkClientGroup(clientId, accounts.a2, active.id))).message).toMatch(/another WhatsApp account/);
    expect((await as(people.admin, A, () => groups.linkClientGroup(clientId, accounts.b1, foreign.id))).ok).toBe(false);
    expect((await as(people.seller, A, () => groups.linkClientGroup(clientId, accounts.a1, active.id))).message).toMatch(/permission/i);
    expect(await as(people.seller, A, () => groups.searchLinkableGroups(accounts.a1, ""))).toEqual([]);
    expect(await rawPrisma.clientWhatsAppGroupLink.count({ where: { clientId } })).toBe(0);
    // The table itself holds groups only.
    await expect(rawPrisma.clientWhatsAppGroupLink.create({ data: { projectId: A.id, clientId, whatsappGroupId: "8801700000000@c.us", groupName: "x" } })).rejects.toThrow(/is_group/);
  });
});

describe("4. the guided Add Client form", () => {
  it("asks before saving a client nothing identifies, then saves it with only a code", async () => {
    const first = await newClient(A, {});
    expect(first.needsBlankConfirm).toBe(true);
    const saved = await newClient(A, { confirmBlank: "1" });
    const row = await rawPrisma.client.findUniqueOrThrow({ where: { id: idOf(saved) } });
    expect(row.name).toBe("");
    expect(row.code).toMatch(/^[A-Z]*\d{4,}$/);
  });

  it("reads an international number to E.164, and a local one with the chosen country", async () => {
    const intl = await rawPrisma.client.findUniqueOrThrow({ where: { id: idOf(await newClient(A, { name: "UAE Client", phone: "+971 50 111 2201", whatsappSame: "1" })) }, include: { channels: true } });
    expect(intl.channels.map((c) => `${c.kind}:${c.value}`).sort()).toEqual(["PHONE:+971501112201", "WHATSAPP:+971501112201"]);
    const local = await rawPrisma.client.findUniqueOrThrow({ where: { id: idOf(await newClient(A, { name: "Saudi Client", country: "SA", phone: "050 111 2202" })) }, include: { channels: true } });
    expect(local.channels[0]).toMatchObject({ value: "+966501112202", normalizedValue: "966501112202" });
    expect(local.country).toBe("SA");
    expect((await newClient(A, { name: "Bad Country", country: "XX" })).error).toMatch(/country/);
  });

  it("applies the project's required fields, without relaxing any technical rule", async () => {
    await as(people.admin, A, () => extras.saveClientModuleSettings({ subscriptions: true, billing: true, payments: true, whatsappGroups: true, requiredFields: ["phone", "country", "soldByMemberId"], renewalWindowDays: 7, defaultCountry: "" }));
    const missing = await newClient(A, { name: "Needs More" });
    expect(missing.error).toMatch(/Phone \/ WhatsApp number is required/);
    expect(missing.error).toMatch(/Country is required/);
    expect(missing.error).toMatch(/Sold by is required/);
    expect((await newClient(A, { name: "Complete", phone: "+8801711000099", country: "BD", soldByMemberId: roster.nadia })).success).toBe(true);
    // Settings changes need their own key.
    expect((await as(people.seller, A, () => extras.saveClientModuleSettings({ subscriptions: true, billing: true, payments: true, whatsappGroups: true, requiredFields: [], renewalWindowDays: 7, defaultCountry: "" }))).ok).toBe(false);
    await as(people.admin, A, () => extras.saveClientModuleSettings({ subscriptions: true, billing: true, payments: true, whatsappGroups: true, requiredFields: [], renewalWindowDays: 7, defaultCountry: "" }));
  });

  it("assigns only from the real roster: an active team, an active member of that team", async () => {
    expect((await newClient(A, { name: "Old Team", assignedTeamId: roster.oldTeam })).error).toMatch(/disabled/);
    expect((await newClient(A, { name: "Wrong Team", assignedTeamId: roster.support, assignedMemberId: roster.nadia })).error).toMatch(/not in the chosen team/);
    expect((await newClient(A, { name: "Gone Member", assignedMemberId: roster.gone })).error).toMatch(/no longer active/);
    expect((await newClient(A, { name: "Foreign Member", assignedMemberId: roster.bMember })).error).toMatch(/does not exist/);
    const ok = await newClient(A, { name: "Right Team", assignedTeamId: roster.sales, assignedMemberId: roster.nadia, soldByMemberId: roster.nadia });
    expect(await rawPrisma.client.findUniqueOrThrow({ where: { id: idOf(ok) } })).toMatchObject({ assignedTeamId: roster.sales, soldByMemberId: roster.nadia });
  });

  it("creates the client, its first subscription and its confirmed group link together — or none of them", async () => {
    const g = await rawPrisma.whatsAppGroup.create({ data: { projectId: A.id, accountId: accounts.a1, whatsappGroupId: `120363${gnum}06@g.us`, name: "Form Group" } });
    const fields = { name: "All At Once", subService: "Tiger IPTV", subStartDate: today, subDurationValue: "1", subDurationUnit: "MONTH", linkAccountId: accounts.a1, linkGroupId: g.id };
    expect((await newClient(A, fields)).error).toMatch(/Confirm/);
    expect((await newClient(A, { ...fields, confirmGroup: "1" }, people.seller)).error).toMatch(/Link WhatsApp Groups/);
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: "All At Once" } })).toBe(0);
    const id = idOf(await newClient(A, { ...fields, confirmGroup: "1", soldByMemberId: roster.nadia }));
    const row = await rawPrisma.client.findUniqueOrThrow({ where: { id }, include: { currentSubscription: true, groupLinks: true } });
    expect(row.currentSubscription).toMatchObject({ service: "Tiger IPTV", soldByName: "Nadia" });
    expect(row.groupLinks.map((l) => l.groupName)).toEqual(["Form Group"]);
  });
});

describe("5. photos", () => {
  const png = () => {
    const crc = (bytes: number[]) => {
      let c = ~0;
      for (const b of bytes) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    };
    const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const chunk = (type: string, data: number[]) => {
      const t = [...type].map((c) => c.charCodeAt(0));
      return [...be(data.length), ...t, ...data, ...be(crc([...t, ...data]))];
    };
    const text = [..."GPS=23.8,90.4"].map((c) => c.charCodeAt(0));
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be(64), ...be(64), 8, 2, 0, 0, 0]), ...chunk("tEXt", text), ...chunk("IDAT", [1]), ...chunk("IEND", [])]);
  };

  it("stores a stripped, bounded thumbnail with the client and serves it only inside its project", async () => {
    const file = new File([png()], "me.png", { type: "image/png" });
    const id = idOf(await newClient(A, { name: "Photo Client", photo: file }));
    const stored = await rawPrisma.clientPhoto.findUniqueOrThrow({ where: { clientId: id } });
    expect(stored.mimeType).toBe("image/png");
    expect(Buffer.from(stored.bytes).includes(Buffer.from("GPS="))).toBe(false);
    const get = (project: Project, person: Session) => as(person, project, () => photoRoute.GET(new Request("http://x/photo") as never, { params: Promise.resolve({ id }) }));
    const ok = await get(A, people.viewer);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await get(B, people.viewer)).status).toBe(404);
    // A file that only claims to be a picture is refused, and the client is not created.
    const fake = new File([new TextEncoder().encode("<svg onload=alert(1)>")], "x.png", { type: "image/png" });
    expect((await newClient(A, { name: "Fake Photo", photo: fake })).error).toMatch(/JPEG, PNG and WebP/);
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: "Fake Photo" } })).toBe(0);
    await expect(rawPrisma.clientPhoto.update({ where: { clientId: id }, data: { bytes: Buffer.alloc(300 * 1024) } })).rejects.toThrow(/bounded/);
  });
});

describe("6. the register: columns, filters and what each viewer sees", () => {
  it("saves columns per person, and never keeps a billing column for someone without billing", async () => {
    const saved = await as(people.viewer, A, () => extras.saveListColumns("clients", ["email", "outstanding", "expiry", "bogus"]));
    expect(saved.columns).toEqual(["client", "email", "expiry"]);
    const caps = await as(people.viewer, A, async () => moduleReads.clientViewerCaps(people.viewer));
    expect((await as(people.viewer, A, () => moduleReads.getColumnPreference(people.viewer.userId, "clients", caps))).columns).toEqual(["client", "email", "expiry"]);
    // Another person, and the same person in another project, start from the defaults.
    const adminCaps = await as(people.admin, A, async () => moduleReads.clientViewerCaps(people.admin));
    expect((await as(people.admin, A, () => moduleReads.getColumnPreference(people.admin.userId, "clients", adminCaps))).customised).toBe(false);
    expect((await as(people.viewer, B, () => moduleReads.getColumnPreference(people.viewer.userId, "clients", caps))).customised).toBe(false);
    expect((await as(people.viewer, A, () => extras.resetListColumns("clients"))).ok).toBe(true);
    expect((await as(people.viewer, A, () => extras.saveListColumns("billing", ["due"]))).ok).toBe(false);
  });

  it("reads outstanding amounts only for a billing viewer, and ignores a billing filter from anyone else", async () => {
    const clientId = idOf(await newClient(A, { name: `Owes Money ${tag}` }));
    await invoice(A, clientId, { dueDate: plus(-2), amount: "240", currency: "AED" });
    const ctxFor = (person: Session) => as(person, A, () => moduleReads.clientFilterContext(person));
    const list = async (person: Session, params: Record<string, string>) =>
      as(person, A, async () => reads.listClients({ filters: parseClientFilters(params), sort: "name", dir: "asc", page: 1, pageSize: 200, ctx: await ctxFor(person) }));
    const forAdmin = await list(people.admin, { q: `Owes Money ${tag}` });
    expect(forAdmin.clients[0]!.billing?.outstanding).toEqual([{ currency: "AED", remaining: "240.00", overdue: true }]);
    const forViewer = await list(people.viewer, { q: `Owes Money ${tag}` });
    expect(forViewer.clients[0]!.billing).toBeNull();
    // The overdue filter narrows for a billing viewer, and is ignored (not answered) for anyone else.
    const all = (await list(people.viewer, {})).total;
    expect((await list(people.viewer, { due: "overdue" })).total).toBe(all);
    expect((await list(people.admin, { due: "overdue" })).clients.map((c) => c.id)).toContain(clientId);
  });

  it("filters by seller, country and returning customers, and sorts by expiry", async () => {
    const c1 = idOf(await newClient(A, { name: `Sort One ${tag}`, country: "BD", soldByMemberId: roster.fahim }));
    const c2 = idOf(await newClient(A, { name: `Sort Two ${tag}`, country: "AE" }));
    await sell(people.seller, A, c1, { service: `Sortable ${tag}`, startDate: today, durationValue: "90", durationUnit: "DAY" });
    await sell(people.seller, A, c2, { service: `Sortable ${tag}`, startDate: today, durationValue: "10", durationUnit: "DAY", soldByMemberId: roster.nadia });
    const read = (params: Record<string, string>, sort: "expiry" | "name" = "name") =>
      as(people.admin, A, () => reads.listClients({ filters: parseClientFilters({ service: `Sortable ${tag}`, ...params }), sort, dir: "asc", page: 1, pageSize: 10 }));
    expect((await read({}, "expiry")).clients.map((c) => c.id)).toEqual([c2, c1]);
    expect((await read({ seller: roster.fahim })).clients.map((c) => c.id)).toEqual([c1]);
    expect((await read({ seller: roster.nadia })).clients.map((c) => c.id)).toEqual([c2]);
    expect((await read({ country: "AE" })).clients.map((c) => c.id)).toEqual([c2]);
    expect((await read({ expiry: "30" })).clients.map((c) => c.id)).toEqual([c2]);
    expect((await read({ repeat: "1" })).clients).toEqual([]);
    expect((await read({})).clients.find((c) => c.id === c1)?.soldBy?.name).toBe("Fahim");
  });

  it("shows nothing of project A in project B", async () => {
    const inB = await as(people.admin, B, () => reads.listClients({ filters: parseClientFilters({}), sort: "name", dir: "asc", page: 1, pageSize: 250 }));
    expect(inB.clients).toEqual([]);
    expect((await as(people.admin, B, () => billingReads.listBillingRegister(billingReads.parseBillingFilters({ view: "all" })))).rows).toEqual([]);
    expect((await as(people.admin, B, () => billingReads.listPayments({ q: "", show: "all", page: 1, pageSize: 50 }))).payments).toEqual([]);
    expect(await as(people.admin, B, () => groups.searchLinkableGroups(accounts.a1, ""))).toEqual([]);
  });
});

describe("7. bulk delete (Main Admin only) and bulk details", () => {
  it("lets only a Main Admin delete, any status, with subscriptions, invoices, payments and links", async () => {
    const a = idOf(await newClient(A, { name: `Bulk Del A ${tag}` }));
    const b = idOf(await newClient(A, { name: `Bulk Del B ${tag}` }));
    await sell(people.seller, A, a, { service: "Tiger IPTV", startDate: today, durationValue: "1", durationUnit: "MONTH" });
    const due = await invoice(A, a, { dueDate: plus(2), amount: "50", currency: "AED" });
    await record(people.cashier, A, [{ dueId: due.id, amount: "20" }]);
    const g = await rawPrisma.whatsAppGroup.create({ data: { projectId: A.id, accountId: accounts.a1, whatsappGroupId: `120363${gnum}09@g.us`, name: "Bulk Group" } });
    await as(people.admin, A, () => groups.linkClientGroup(b, accounts.a1, g.id));

    // Every other role is refused, whatever keys it holds — the admin here holds clients.archive and more.
    for (const person of [people.admin, people.seller, people.cashier, people.viewer]) {
      expect((await as(person, A, () => clientActions.deleteClients([a, b]))).ok).toBe(false);
    }
    expect(await rawPrisma.client.count({ where: { id: { in: [a, b] } } })).toBe(2);

    // Another project's Main Admin action cannot reach these ids either.
    expect((await as(people.mainAdmin, B, () => clientActions.deleteClients([a, b]))).ok).toBe(false);

    const r = await as(people.mainAdmin, A, () => clientActions.deleteClients([a, b]));
    expect(r.message).toMatch(/2 client\(s\) permanently deleted/);
    expect(await rawPrisma.client.count({ where: { id: { in: [a, b] } } })).toBe(0);
    expect(await rawPrisma.clientSubscription.count({ where: { clientId: a } })).toBe(0);
    expect(await rawPrisma.clientPayment.count({ where: { clientId: a } })).toBe(0);
    expect(await rawPrisma.clientWhatsAppGroupLink.count({ where: { clientId: b } })).toBe(0);
    // The group itself is untouched.
    expect(await rawPrisma.whatsAppGroup.findUnique({ where: { id: g.id } })).not.toBeNull();
  });

  it("sets team, seller, country and currency on many at once, checked like the form", async () => {
    const ids = [idOf(await newClient(A, { name: `Bulk Set 1 ${tag}`, assignedTeamId: roster.support, assignedMemberId: roster.fahim })), idOf(await newClient(A, { name: `Bulk Set 2 ${tag}` }))];
    const set = (patch: Record<string, string>, person = people.admin) => as(person, A, () => clientActions.bulkSetClientDetails(ids, patch));
    expect((await set({ teamId: roster.oldTeam })).message).toMatch(/disabled/);
    expect((await set({ soldByMemberId: roster.gone })).message).toMatch(/no longer active/);
    expect((await set({ country: "XX" })).message).toMatch(/country/);
    expect((await set({ country: "AE" }, people.viewer)).ok).toBe(false);
    expect((await set({})).ok).toBe(false);
    const r = await set({ teamId: roster.sales, soldByMemberId: roster.nadia, country: "AE", preferredCurrency: "aed" });
    expect(r.ok).toBe(true);
    const rows = await rawPrisma.client.findMany({ where: { id: { in: ids } }, orderBy: { name: "asc" } });
    for (const row of rows) expect(row).toMatchObject({ assignedTeamId: roster.sales, soldByMemberId: roster.nadia, country: "AE", preferredCurrency: "AED" });
    // Fahim is not in Sales, so his assignment was cleared rather than left contradicting the team.
    expect(rows[0]!.assignedMemberId).toBeNull();
    // "__none" clears; an empty value leaves a field alone.
    await set({ country: "__none" });
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: ids[0]! } })).country).toBeNull();
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: ids[0]! } })).preferredCurrency).toBe("AED");
  });
});
