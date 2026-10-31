import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { ISO_CURRENCY_CODES, PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * The Client Configuration Center (CLIENT_CONFIGURATION.md) against a real database: who may change a list,
 * that lists stay in their project, that a rename / merge carries the value on the clients that have it (and an
 * archive never takes it away), plan price suggestions keep each currency's decimals, any number of currencies
 * can be offered, and every change is logged.
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
const actions = await import("@/server/actions/clientConfiguration");
const clientActions = await import("@/server/actions/clients");
const { loadClientConfiguration } = await import("@/server/clientConfiguration");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;
const people = {} as Record<"admin" | "staff" | "seller", Session>;
const as = <T,>(person: Session, fn: () => Promise<T>, project: Project = A) => {
  current = person;
  return runWithProject(project, fn);
};

async function person(name: string, keys: string[]): Promise<Session> {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const role = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  ids.roles.push(role.id);
  const u = await rawPrisma.user.create({ data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: role.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
const client = (project: Project, name: string, data: { tags?: string[]; category?: string; businessType?: string } = {}) =>
  rawPrisma.client.create({ data: { projectId: project.id, code: `${name}-${tag}`.slice(0, 40), name, ...data } });

beforeAll(async () => {
  people.admin = await person("CfgAdmin", ["clients.view", "clients.manage_settings"]);
  people.staff = await person("CfgStaff", ["clients.view", "clients.create", "clients.update"]);
  people.seller = await person("CfgSeller", ["clients.view", "clients.create", "clients.update", "clients.manage_subscriptions"]);
  for (const label of ["A", "B"]) {
    const p = await createProjectWithDefaults({ name: `Cfg ${label} ${tag}`, slug: `cfg-${label.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    const project = { id: p.id, slug: p.slug, name: `Cfg ${label} ${tag}`, status: "ACTIVE" as const };
    if (label === "A") A = project;
    else B = project;
  }
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientSubscription.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.clientCatalogEntry.deleteMany({ where });
  await rawPrisma.clientServicePlan.deleteMany({ where });
  await rawPrisma.clientCountrySetting.deleteMany({ where });
  await rawPrisma.clientBillingCurrency.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("who may change a list, and where", () => {
  it("refuses someone without the client settings permission", async () => {
    const r = await as(people.staff, () => actions.saveCatalogEntry({ kind: "TAG", name: "vip" }));
    expect(r.ok).toBe(false);
    expect(await rawPrisma.clientCatalogEntry.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("keeps each project's lists to itself", async () => {
    const r = await as(people.admin, () => actions.saveCatalogEntry({ kind: "CATEGORY", name: "Corporate" }));
    expect(r).toMatchObject({ ok: true });
    const fromB = await as(people.admin, () => actions.setCatalogEntryArchived(r.id!, true), B);
    expect(fromB).toMatchObject({ ok: false, message: expect.stringMatching(/no longer exists/) });
    expect(await rawPrisma.clientCatalogEntry.findUniqueOrThrow({ where: { id: r.id! } })).toMatchObject({ archivedAt: null });
    const bView = await as(people.admin, () => loadClientConfiguration(), B);
    expect(bView.entries.CATEGORY).toHaveLength(0);
    // The same name in another project is a separate entry.
    expect(await as(people.admin, () => actions.saveCatalogEntry({ kind: "CATEGORY", name: "corporate" }), B)).toMatchObject({ ok: true });
  });
});

describe("a list never takes a value away from a client", () => {
  it("renames a tag on the clients that carry it, keeping their order and never duplicating it", async () => {
    const c1 = await client(A, "T1", { tags: ["new", "gold", "vip"] });
    const c2 = await client(A, "T2", { tags: ["gold", "premium"] });
    const created = await as(people.admin, () => actions.saveCatalogEntry({ kind: "TAG", name: "gold" }));
    const r = await as(people.admin, () => actions.saveCatalogEntry({ kind: "TAG", id: created.id, name: "Premium" }));
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/2 client/) });
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: c1.id } })).tags).toEqual(["new", "premium", "vip"]);
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: c2.id } })).tags).toEqual(["premium"]);
  });

  it("merges one entry into another: clients move, and the old name stays as a spelling", async () => {
    const c = await client(A, "M1", { category: "corp" });
    const from = await as(people.admin, () => actions.saveCatalogEntry({ kind: "CATEGORY", name: "Corp" }));
    const into = (await rawPrisma.clientCatalogEntry.findFirstOrThrow({ where: { projectId: A.id, kind: "CATEGORY", name: "Corporate" } })).id;
    const r = await as(people.admin, () => actions.mergeCatalogEntries(from.id!, into));
    expect(r).toMatchObject({ ok: true });
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: c.id } })).category).toBe("Corporate");
    expect(await rawPrisma.clientCatalogEntry.findUnique({ where: { id: from.id! } })).toBeNull();
    expect((await rawPrisma.clientCatalogEntry.findUniqueOrThrow({ where: { id: into } })).aliases).toContain("Corp");
  });

  it("archives without touching clients, and refuses a second entry with the same name in another case", async () => {
    const c = await client(A, "R1", { businessType: "Retail" });
    const e = await as(people.admin, () => actions.saveCatalogEntry({ kind: "BUSINESS_TYPE", name: "Retail" }));
    await as(people.admin, () => actions.setCatalogEntryArchived(e.id!, true));
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: c.id } })).businessType).toBe("Retail");
    expect(await as(people.admin, () => actions.saveCatalogEntry({ kind: "BUSINESS_TYPE", name: "RETAIL" }))).toMatchObject({ ok: false, message: expect.stringMatching(/already/) });
  });

  it("lists values clients already carry and adds them in one click", async () => {
    await client(A, "U1", { tags: ["legacy-tag"] });
    const before = await as(people.admin, () => loadClientConfiguration());
    expect(before.unlisted.TAG.map((u) => u.name)).toContain("legacy-tag");
    const r = await as(people.admin, () => actions.addUsedValuesToCatalog("TAG", before.unlisted.TAG.map((u) => u.name)));
    expect(r.ok).toBe(true);
    const after = await as(people.admin, () => loadClientConfiguration());
    expect(after.unlisted.TAG).toHaveLength(0);
    expect(after.entries.TAG.find((e) => e.name === "legacy-tag")?.clients).toBe(1);
  });
});

describe("plans, currencies and countries", () => {
  it("keeps a plan's prices in each currency's own decimals, and refuses a dropped digit", async () => {
    const ok = await as(people.admin, () => actions.saveServicePlan({ name: "Home 20", defaultKind: "PAID", defaultDuration: "1", defaultUnit: "MONTH", prices: [{ currency: "KWD", amount: "2.550" }, { currency: "SAR", amount: "30.00" }] }));
    expect(ok).toMatchObject({ ok: true });
    expect((await rawPrisma.clientServicePlan.findUniqueOrThrow({ where: { id: ok.id! } })).prices).toEqual([{ currency: "KWD", amount: "2.550" }, { currency: "SAR", amount: "30.00" }]);
    expect(await as(people.admin, () => actions.saveServicePlan({ name: "Bad", prices: [{ currency: "USD", amount: "7.355" }] }))).toMatchObject({ ok: false });
    expect(await as(people.admin, () => actions.saveServicePlan({ name: "home 20" }))).toMatchObject({ ok: false, message: expect.stringMatching(/already/) });
  });

  it("offers far more than 30 currencies, and refuses a code that is not a currency", async () => {
    for (const code of ISO_CURRENCY_CODES.slice(0, 40)) expect(await as(people.admin, () => actions.setProjectCurrency(code, true))).toMatchObject({ ok: true });
    expect(await rawPrisma.clientBillingCurrency.count({ where: { projectId: A.id, enabled: true } })).toBe(40);
    expect(await as(people.admin, () => actions.setProjectCurrency("XYZ", true))).toMatchObject({ ok: false });
    expect(await as(people.admin, () => actions.setCurrencyFavorite("SAR", true))).toMatchObject({ ok: true });
    expect(await rawPrisma.clientBillingCurrency.findFirstOrThrow({ where: { projectId: A.id, code: "SAR" } })).toMatchObject({ favorite: true, enabled: true });
  });

  it("saves a country's own currency and language, and refuses a country that does not exist", async () => {
    expect(await as(people.admin, () => actions.saveCountrySetting({ country: "SA", favorite: true, currency: "USD", language: "English" }))).toMatchObject({ ok: true });
    expect(await rawPrisma.clientCountrySetting.findFirstOrThrow({ where: { projectId: A.id, country: "SA" } })).toMatchObject({ favorite: true, currency: "USD", language: "English" });
    expect(await as(people.admin, () => actions.saveCountrySetting({ country: "ZZ" }))).toMatchObject({ ok: false });
  });

  it("records every change in the project's System Log", async () => {
    const logs = await rawPrisma.systemLog.findMany({ where: { projectId: A.id, scope: "clients" }, select: { message: true } });
    const text = logs.map((l) => l.message).join("\n");
    for (const needle of ["Tag changed: gold → premium", "Category merged: Corp → Corporate", "Business type archived: Retail", "Service plan added: Home 20", "Currency offered", "Country setting changed: SA"]) expect(text).toContain(needle);
  });
});

describe("Add / Edit Client with the V5 fields", () => {
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  it("stores the business type and other languages, and a paid plan with an exact expiry creates no invoice", async () => {
    const dues = await rawPrisma.clientDue.count({ where: { projectId: A.id } });
    const r = await as(people.seller, () =>
      clientActions.createClient(
        {},
        form({
          name: `Form ${tag}`,
          phone: "+966551234567",
          whatsappSame: "1",
          country: "SA",
          preferredCurrency: "SAR",
          preferredLanguage: "Arabic",
          additionalLanguages: "English, arabic, Urdu",
          businessType: "Retail",
          tags: "vip, premium",
          subService: "Home 20",
          subKind: "PAID",
          subStartDate: "2026-01-31",
          subEndDate: "2026-03-15",
        }),
      ),
    );
    expect(r.error, r.error).toBeUndefined();
    const c = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: `Form ${tag}` }, include: { subscriptions: true } });
    expect(c).toMatchObject({ businessType: "Retail", additionalLanguages: ["English", "Urdu"], preferredLanguage: "Arabic", tags: ["vip", "premium"] });
    expect(c.subscriptions).toHaveLength(1);
    expect(c.subscriptions[0]).toMatchObject({ service: "Home 20", kind: "PAID" });
    expect(c.subscriptions[0]!.endDate.toISOString().slice(0, 10)).toBe("2026-03-15");
    // Choosing a paid plan records the term only: no invoice, no due.
    expect(await rawPrisma.clientDue.count({ where: { projectId: A.id } })).toBe(dues);

    // An edit from a form without the V5 fields leaves them as they are.
    const u = await as(people.seller, () => clientActions.updateClient(c.id, {}, form({ name: `Form ${tag}`, status: "ACTIVE" })));
    expect(u.error, u.error).toBeUndefined();
    expect(await rawPrisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ businessType: "Retail", additionalLanguages: ["English", "Urdu"] });
  });

  it("refuses a business type that is a spreadsheet formula, keeping what was typed", async () => {
    const r = await as(people.seller, () => clientActions.createClient({}, form({ name: `Bad ${tag}`, businessType: "=cmd" })));
    expect(r.error).toMatch(/business type/);
    expect(r.values?.name).toBe(`Bad ${tag}`);
  });
});
