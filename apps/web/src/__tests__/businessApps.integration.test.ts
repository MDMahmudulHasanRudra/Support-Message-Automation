import "./helpers/requireTestDatabase";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { callBusinessApp, commerceAppAdapter, createProjectWithDefaults, decryptSecret, prisma as rawPrisma, resolveBusinessAppCapability } from "@support-automation/db";
import { FakeCommerce } from "./helpers/fakeCommerce";
import { PERMISSIONS, type BusinessAppAdapter } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Business Apps on the host side (docs/BUSINESS_APP_INTEGRATION_CONTRACT.md). Proves, against a real database:
 *   - creating a project with no add-on is what it always was, and an add-on is added PENDING, never ACTIVE;
 *   - an app is added once per project (the unique index, not a read-then-write);
 *   - one customer can neither add to, connect, disable nor list another customer's project's apps, and one
 *     project never sees another project's installation;
 *   - adding needs projects.manage; opening needs business_apps.open;
 *   - only an ACTIVE installation opens, never in a suspended (or billing-held) or archived project;
 *   - ACTIVE needs a verified connection (the adapter's answer, and a database CHECK);
 *   - disabling stops the AI capability gate at once.
 */

let current: Session;
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${to}`), { digest: `NEXT_REDIRECT;${to}` });
  },
}));

const { runWithProject } = await import("@/server/projectContext");
const actions = await import("@/server/actions/businessApps");
const host = await import("@/server/businessApps");
const { createProject } = await import("@/server/actions/projects");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
type Fx = { customer: string; project: string; other: string; slug: string; otherSlug: string };
const A = {} as Fx;
const B = {} as Fx;
const s = {} as Record<"adminA" | "adminB" | "opener" | "noKey" | "viewerOnly", Session>;
const created: string[] = [];

async function role(customerId: string, name: string, keys: string[]) {
  const permissions = await Promise.all(
    keys.map((key) => {
      const def = PERMISSIONS.find((p) => p.key === key)!;
      return rawPrisma.permission.upsert({ where: { key }, create: { key, label: def.label, category: def.category }, update: {}, select: { id: true } });
    }),
  );
  const r = await rawPrisma.permissionModule.create({ data: { name: `${name} ${tag}`, customerId, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
  return r.id;
}
async function user(customerId: string, name: string, roleId: string, projects: string[]): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId, customerId } });
  for (const projectId of projects) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  return { userId: u.id, username: u.username, email: u.email!, name, tenant: customerId };
}
const inProject = <T,>(fx: Fx, fn: () => Promise<T>, status: "ACTIVE" | "SUSPENDED" | "ARCHIVED" = "ACTIVE", which: "project" | "other" = "project") =>
  runWithProject({ id: fx[which], slug: which === "project" ? fx.slug : fx.otherSlug, name: `P ${tag}`, status, tenant: fx.customer }, fn);
const installation = (projectId: string, appKey = "commerce") => rawPrisma.projectAppInstallation.findFirst({ where: { projectId, appKey } });
async function makeActive(projectId: string) {
  await rawPrisma.projectAppInstallation.updateMany({ where: { projectId, appKey: "commerce" }, data: { status: "ACTIVE", externalWorkspaceId: `ws-${projectId}`, lastConnectedAt: new Date() } });
}
function form(values: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) for (const one of Array.isArray(v) ? v : [v]) data.append(k, one);
  return data;
}
const fakeAdapter = (verify: BusinessAppAdapter["verifyConnection"], redirectUrl = "https://commerce.example.test/launch?code=one-time"): BusinessAppAdapter => ({
  appKey: "commerce",
  verifyConnection: verify,
  createLaunch: async () => ({ ok: true, data: { redirectUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() }, asOf: new Date().toISOString() }),
  call: async () => ({ ok: false, error: { code: "NOT_AVAILABLE", message: "test", retryable: false } }),
});

beforeAll(async () => {
  for (const [fx, k] of [
    [A, "a"],
    [B, "b"],
  ] as const) {
    fx.customer = (await rawPrisma.customer.create({ data: { name: `apps ${k} ${tag}` } })).id;
    fx.slug = `apps-${k}-${tag}`;
    fx.otherSlug = `apps-${k}2-${tag}`;
    fx.project = (await createProjectWithDefaults({ name: `Apps ${k} ${tag}`, slug: fx.slug, status: "ACTIVE", creatorUserId: null, customerId: fx.customer }, rawPrisma)).id;
    fx.other = (await createProjectWithDefaults({ name: `Apps ${k}2 ${tag}`, slug: fx.otherSlug, status: "ACTIVE", creatorUserId: null, customerId: fx.customer }, rawPrisma)).id;
  }
  const adminA = await role(A.customer, "AppsAdminA", ["projects.view", "projects.manage", "business_apps.open"]);
  const adminB = await role(B.customer, "AppsAdminB", ["projects.view", "projects.manage", "business_apps.open"]);
  const opener = await role(A.customer, "AppsOpener", ["business_apps.open", "messages.view"]);
  const noKey = await role(A.customer, "AppsNoKey", ["messages.view", "messages.reply"]);
  const viewerOnly = await role(A.customer, "AppsPortalViewer", ["projects.view", "business_apps.open"]);
  s.adminA = await user(A.customer, "appsadmina", adminA, [A.project, A.other]);
  s.adminB = await user(B.customer, "appsadminb", adminB, [B.project, B.other]);
  s.opener = await user(A.customer, "appsopener", opener, [A.project, A.other]);
  s.noKey = await user(A.customer, "appsnokey", noKey, [A.project]);
  s.viewerOnly = await user(A.customer, "appsviewer", viewerOnly, [A.project]);
});

afterEach(() => host.registerBusinessAppAdapter(commerceAppAdapter));

afterAll(async () => {
  await rawPrisma.projectAppInstallation.deleteMany({ where: { projectId: { in: [A.project, A.other, B.project, B.other, ...created] } } });
});

describe("creating a project", () => {
  it("with no add-on adds no Business App and lands where it always did", async () => {
    current = s.adminA;
    const slug = `apps-plain-${tag}`;
    await expect(createProject({}, form({ name: `Plain ${tag}`, slug, status: "ACTIVE", moduleSetup: "PLAN" }))).rejects.toThrow(/NEXT_REDIRECT:\/admin\/projects\/.+\?created=1/);
    const project = await rawPrisma.project.findFirstOrThrow({ where: { slug, customerId: A.customer } });
    created.push(project.id);
    expect(await rawPrisma.projectAppInstallation.count({ where: { projectId: project.id } })).toBe(0);
    const log = await rawPrisma.systemLog.findFirst({ where: { message: `Project "Plain ${tag}" created` }, orderBy: { createdAt: "desc" } });
    expect(log?.metadata).not.toHaveProperty("businessApps");
  });

  it("with Commerce adds it PENDING — never connected — and ignores an app that is not available", async () => {
    current = s.adminA;
    const slug = `apps-addon-${tag}`;
    await expect(
      createProject({}, form({ name: `Addon ${tag}`, slug, status: "ACTIVE", moduleSetup: "PLAN", businessApps: ["commerce", "travel", "commerce"] })),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    const project = await rawPrisma.project.findFirstOrThrow({ where: { slug, customerId: A.customer } });
    created.push(project.id);
    const rows = await rawPrisma.projectAppInstallation.findMany({ where: { projectId: project.id } });
    expect(rows.map((r) => [r.appKey, r.status, r.lastConnectedAt, r.installedById])).toEqual([["commerce", "PENDING", null, s.adminA.userId]]);
  });
});

describe("adding an app", () => {
  it("needs projects.manage", async () => {
    current = s.viewerOnly;
    expect((await actions.addBusinessApp(A.project, "commerce")).error).toMatch(/Manage Projects/);
    current = s.opener;
    expect((await actions.addBusinessApp(A.project, "commerce")).error).toMatch(/Manage Projects/);
    expect(await installation(A.project)).toBeNull();
  });

  it("happens once per project: a second add is refused, and so is a duplicate written past the action", async () => {
    current = s.adminA;
    expect((await actions.addBusinessApp(A.project, "commerce")).success).toMatch(/waiting to connect/);
    expect((await actions.addBusinessApp(A.project, "commerce")).error).toMatch(/already added/);
    await expect(rawPrisma.projectAppInstallation.create({ data: { projectId: A.project, appKey: "commerce", contractVersion: "x" } })).rejects.toThrow(/Unique constraint/);
    expect(await rawPrisma.projectAppInstallation.count({ where: { projectId: A.project } })).toBe(1);
    expect((await actions.addBusinessApp(A.project, "travel")).error).toMatch(/not available/);
  });

  it("never reaches another customer's project, its installations or its list", async () => {
    current = s.adminB;
    expect((await actions.addBusinessApp(B.project, "commerce")).success).toBeTruthy();
    const bRow = (await installation(B.project))!;

    current = s.adminA;
    expect((await actions.addBusinessApp(B.other, "commerce")).error).toMatch(/no longer exists/);
    expect(await installation(B.other)).toBeNull();
    expect((await actions.connectBusinessAppAction(bRow.id, B.project)).error).toMatch(/no longer exists/);
    expect((await actions.setBusinessAppEnabledAction(bRow.id, B.project, false)).error).toMatch(/no longer exists/);
    expect((await installation(B.project))!.status).toBe("PENDING");
    const listed = await host.listCustomerInstallations();
    expect(listed.map((i) => i.projectId)).toContain(A.project);
    expect(listed.map((i) => i.projectId)).not.toContain(B.project);
  });
});

describe("connecting", () => {
  it("stays waiting, with the reason, while Commerce is not configured or no adapter exists — never ACTIVE", async () => {
    current = s.adminA;
    const row = (await installation(A.project))!;
    delete process.env.COMMERCE_API_URL;
    expect((await actions.connectBusinessAppAction(row.id, A.project)).error).toMatch(/not configured on this server/);
    expect((await installation(A.project))!.status).toBe("PENDING");
    host.registerBusinessAppAdapter(null, "commerce");
    const result = await actions.connectBusinessAppAction(row.id, A.project);
    expect(result.error).toMatch(/has not published its connection endpoint/);
    const after = (await installation(A.project))!;
    expect(after.status).toBe("PENDING");
    expect(after.lastConnectedAt).toBeNull();
    expect(after.lastError).toMatch(/not published/);
  });

  it("becomes ACTIVE only on a verified answer, and a failed answer is ERROR", async () => {
    current = s.adminA;
    const row = (await installation(A.project))!;
    host.registerBusinessAppAdapter(fakeAdapter(async () => ({ ok: false, error: { code: "UNAUTHORIZED", message: "Commerce refused the credentials.", retryable: false } })));
    expect((await actions.connectBusinessAppAction(row.id, A.project)).error).toMatch(/refused/);
    expect((await installation(A.project))!.status).toBe("ERROR");

    // Whatever an adapter claims, the host activates only a contract version it supports.
    host.registerBusinessAppAdapter(fakeAdapter(async () => ({ ok: true, data: { externalWorkspaceId: "ws-a", appContractVersion: "v2", verifiedAt: new Date().toISOString() }, asOf: new Date().toISOString() })));
    expect((await actions.connectBusinessAppAction(row.id, A.project)).error).toMatch(/contract version this server does not support/);
    expect((await installation(A.project))!.status).toBe("ERROR");

    host.registerBusinessAppAdapter(fakeAdapter(async () => ({ ok: true, data: { externalWorkspaceId: "ws-a", appContractVersion: "v1", verifiedAt: new Date().toISOString() }, asOf: new Date().toISOString() })));
    expect((await actions.connectBusinessAppAction(row.id, A.project)).success).toMatch(/connected/);
    const after = (await installation(A.project))!;
    expect([after.status, after.externalWorkspaceId, after.lastError]).toEqual(["ACTIVE", "ws-a", null]);
    expect(after.lastConnectedAt).not.toBeNull();
  });

  it("the database refuses ACTIVE without a verified connection", async () => {
    await expect(
      rawPrisma.projectAppInstallation.updateMany({ where: { projectId: B.project }, data: { status: "ACTIVE" } }),
    ).rejects.toThrow(/active_verified_check/);
  });
});

describe("opening an app", () => {
  it("opens an ACTIVE installation for a role with business_apps.open, and asks the adapter for a single-use launch", async () => {
    current = s.opener;
    const decision = await inProject(A, () => host.authorizeBusinessAppLaunch("commerce"));
    expect(decision.ok).toBe(true);
    // The real Commerce adapter, with Commerce not configured here: said honestly, nothing sent.
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/not configured on this server/);
    host.registerBusinessAppAdapter(null, "commerce");
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/has not published its sign-in hand-off/);
    const nf = async () => ({ ok: false as const, error: { code: "NOT_AVAILABLE" as const, message: "x", retryable: true } });
    // An app whose address is not configured is never followed, whatever it answers.
    delete process.env.COMMERCE_APP_URL;
    host.registerBusinessAppAdapter(fakeAdapter(nf));
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/not configured/);
    process.env.COMMERCE_API_URL = "https://commerce-api.example.test";
    process.env.COMMERCE_APP_URL = "https://commerce.example.test";
    expect(await inProject(A, () => actions.launchBusinessApp("commerce"))).toEqual({ redirectUrl: "https://commerce.example.test/launch?code=one-time" });
    host.registerBusinessAppAdapter(fakeAdapter(nf, "http://commerce.example.test/launch"));
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/not secure/);
    host.registerBusinessAppAdapter(fakeAdapter(nf, "https://commerce.example.test.evil.test/launch"));
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/outside its approved origin/);
    const withExpiry = (expiresAt: string) => ({ ...fakeAdapter(nf), createLaunch: async () => ({ ok: true as const, data: { redirectUrl: "https://commerce.example.test/launch?code=x", expiresAt }, asOf: "" }) });
    host.registerBusinessAppAdapter(withExpiry(new Date(Date.now() - 1000).toISOString()));
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/already expired/);
    host.registerBusinessAppAdapter(withExpiry(new Date(Date.now() + 3_600_000).toISOString()));
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/valid for too long/);
    delete process.env.COMMERCE_API_URL;
    delete process.env.COMMERCE_APP_URL;
  });

  it("is refused without business_apps.open, and the sidebar offers nothing", async () => {
    current = s.noKey;
    const decision = await inProject(A, () => host.authorizeBusinessAppLaunch("commerce"));
    expect(decision).toMatchObject({ ok: false, refusal: "NO_PERMISSION" });
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/does not include opening Business Apps/);
    expect(await inProject(A, () => host.launchableBusinessApps(s.noKey, { id: A.project, slug: A.slug, name: "x", status: "ACTIVE", tenant: A.customer }))).toEqual([]);
    current = s.opener;
    expect(await inProject(A, () => host.launchableBusinessApps(s.opener, { id: A.project, slug: A.slug, name: "x", status: "ACTIVE", tenant: A.customer }))).toEqual([
      { key: "commerce", name: "Commerce", icon: "ShoppingBag" },
    ]);
  });

  it("never sees another project's installation, even with the same customer and the same person", async () => {
    current = s.opener;
    expect(await inProject(A, () => host.authorizeBusinessAppLaunch("commerce"), "ACTIVE", "other")).toMatchObject({ ok: false, refusal: "NOT_INSTALLED" });
    expect(await inProject(A, () => host.projectInstallationsInWorkspace(), "ACTIVE", "other")).toEqual([]);
  });

  it("is refused for every state but ACTIVE", async () => {
    current = s.opener;
    for (const status of ["PENDING", "CONNECTING", "ERROR", "DISABLED"]) {
      await rawPrisma.projectAppInstallation.updateMany({ where: { projectId: A.project }, data: { status } });
      const decision = await inProject(A, () => host.authorizeBusinessAppLaunch("commerce"));
      expect(decision.ok, status).toBe(false);
      expect(decision).toMatchObject({ refusal: status === "DISABLED" ? "DISABLED" : "NOT_ACTIVE" });
    }
    await rawPrisma.projectAppInstallation.updateMany({ where: { projectId: A.project }, data: { status: "ACTIVE" } });
  });

  it("is refused in a suspended, billing-held or archived project, and the sidebar hides it", async () => {
    current = s.opener;
    expect(await inProject(A, () => host.authorizeBusinessAppLaunch("commerce"), "SUSPENDED")).toMatchObject({ ok: false, refusal: "PROJECT_SUSPENDED" });
    expect(await inProject(A, () => host.authorizeBusinessAppLaunch("commerce"), "ARCHIVED")).toMatchObject({ ok: false, refusal: "PROJECT_ARCHIVED" });
    expect(await inProject(A, () => host.launchableBusinessApps(s.opener, { id: A.project, slug: A.slug, name: "x", status: "SUSPENDED", tenant: A.customer }), "SUSPENDED")).toEqual([]);

    // The same rules for host-side callers, read from the project row itself (a billing hold reads as suspended).
    await rawPrisma.project.update({ where: { id: A.project }, data: { billingHoldAt: new Date() } });
    expect(await resolveBusinessAppCapability(rawPrisma, A.project, "commerce", "commerce.getCurrentPrice")).toEqual({ allowed: false, reason: "PROJECT_SUSPENDED" });
    await rawPrisma.project.update({ where: { id: A.project }, data: { billingHoldAt: null } });

    current = s.adminA;
    await rawPrisma.project.update({ where: { id: A.project }, data: { status: "SUSPENDED" } });
    expect((await actions.connectBusinessAppAction((await installation(A.project))!.id, A.project)).error).toMatch(/suspended/);
    await rawPrisma.project.update({ where: { id: A.project }, data: { status: "ARCHIVED" } });
    expect((await actions.addBusinessApp(A.project, "commerce")).error).toMatch(/archived/);
    await rawPrisma.project.update({ where: { id: A.project }, data: { status: "ACTIVE" } });
  });
});

describe("the capability gate the AI and the worker must pass", () => {
  it("allows a declared capability of an ACTIVE installation, and disabling stops it at once", async () => {
    await makeActive(A.project);
    expect(await resolveBusinessAppCapability(rawPrisma, A.project, "commerce", "commerce.getCurrentPrice")).toMatchObject({ allowed: true, externalWorkspaceId: `ws-${A.project}` });
    expect(await resolveBusinessAppCapability(rawPrisma, A.project, "commerce", "commerce.refund")).toEqual({ allowed: false, reason: "UNKNOWN_CAPABILITY" });
    expect(await resolveBusinessAppCapability(rawPrisma, A.other, "commerce", "commerce.getCurrentPrice")).toEqual({ allowed: false, reason: "NOT_INSTALLED" });

    current = s.adminA;
    const row = (await installation(A.project))!;
    expect((await actions.setBusinessAppEnabledAction(row.id, A.project, false)).success).toMatch(/disabled/);
    expect(await resolveBusinessAppCapability(rawPrisma, A.project, "commerce", "commerce.getCurrentPrice")).toEqual({ allowed: false, reason: "INSTALLATION_DISABLED" });
    // A disabled app cannot be connected until it is enabled, and enabling never jumps straight to ACTIVE.
    expect((await actions.connectBusinessAppAction(row.id, A.project)).error).toMatch(/disabled/);
    expect((await actions.setBusinessAppEnabledAction(row.id, A.project, true)).success).toMatch(/enabled/);
    expect((await installation(A.project))!.status).toBe("PENDING");
    expect(await resolveBusinessAppCapability(rawPrisma, A.project, "commerce", "commerce.getCurrentPrice")).toEqual({ allowed: false, reason: "INSTALLATION_PENDING" });
  });

  it("disabling needs projects.manage", async () => {
    current = s.opener;
    const row = (await installation(A.project))!;
    expect((await actions.setBusinessAppEnabledAction(row.id, A.project, false)).error).toMatch(/Manage Projects/);
    expect((await installation(A.project))!.status).not.toBe("DISABLED");
  });
});

describe("the real Commerce adapter, against Commerce's own rules (contract v1)", () => {
  const commerce = new FakeCommerce();
  const P = {} as Record<"link" | "fresh" | "v2" | "mapped", string>;

  beforeAll(async () => {
    await commerce.start();
    for (const k of ["link", "fresh", "v2", "mapped"] as const) {
      P[k] = (await createProjectWithDefaults({ name: `Commerce ${k} ${tag}`, slug: `commerce-${k}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: A.customer }, rawPrisma)).id;
      created.push(P[k]);
      await rawPrisma.projectAppInstallation.create({ data: { projectId: P[k], appKey: "commerce", contractVersion: "v1" } });
    }
  });
  afterAll(async () => {
    await commerce.stop();
    delete process.env.COMMERCE_API_URL;
    delete process.env.COMMERCE_PROVISIONING_SECRET;
    delete process.env.COMMERCE_APP_URL;
  });
  const configure = () => {
    process.env.COMMERCE_API_URL = commerce.url;
    process.env.COMMERCE_PROVISIONING_SECRET = commerce.secret;
  };
  const connect = async (k: keyof typeof P, input?: Parameters<typeof actions.connectBusinessAppAction>[2]) => {
    current = s.adminA;
    return actions.connectBusinessAppAction((await installation(P[k]))!.id, P[k], input);
  };

  it("links an existing workspace: signed provisioning, the key stored encrypted the moment it is issued, ACTIVE only after an authenticated read", async () => {
    configure();
    const ws = commerce.workspace(0);
    expect((await connect("link", { mode: "LINK_EXISTING", workspaceId: ws })).success).toMatch(/connected/);
    const row = (await installation(P.link))!;
    const conn = commerce.connection(P.link)!;
    expect([row.status, row.externalWorkspaceId, row.externalTenantId, row.externalConnectionId, row.contractVersion]).toEqual(["ACTIVE", ws, conn.tenantId, conn.connectionId, "v1"]);
    expect(conn.hostCustomerId).toBe(A.customer);
    expect(row.credentialCiphertext).not.toContain(conn.apiKey);
    expect(decryptSecret(row.credentialCiphertext!)).toBe(conn.apiKey);
    expect(conn.apiKey.startsWith(row.credentialHint!)).toBe(true);
    expect(commerce.requests).toEqual(["POST /api/v1/integrations/provision", "GET /api/v1/integrations/products/search"]);
    // The view a page reads never carries the credential.
    const listed = JSON.stringify(await host.listProjectInstallations(P.link));
    expect(listed).not.toContain("credentialCiphertext");
    expect(listed).not.toContain(conn.apiKey);
  });

  it("a plaintext key can never be stored (database CHECK)", async () => {
    await expect(rawPrisma.projectAppInstallation.updateMany({ where: { projectId: P.link }, data: { credentialCiphertext: "cmk_abc_def" } })).rejects.toThrow(/credential_encrypted_check/);
  });

  it("reads live products through the one gate: Commerce's prices as exact minor units, offers as Commerce applies them", async () => {
    const found = await callBusinessApp(rawPrisma, P.link, "commerce", "commerce.searchProducts", { query: "anker", limit: 5 });
    expect(found.ok && found.data.products.map((p) => [p.name, p.price, p.compareAtPrice, p.inStock, p.quantityAvailable])).toEqual([
      ["Anker 737 Power Bank 24K", { amountMinor: "10355", currency: "USD" }, null, true, 70],
      ["Anker Soundcore Space One", { amountMinor: "8400", currency: "USD" }, { amountMinor: "12900", currency: "USD" }, false, 0],
    ]);
    const detail = await callBusinessApp(rawPrisma, P.link, "commerce", "commerce.getProductDetails", { productId: "6bc7a01f-63de-4b3e-95b8-489dfa0fa06f" });
    expect(detail.ok && [detail.data.variants[0]!.listPrice, detail.data.offers.map((o) => [o.title, o.description])]).toEqual([
      { amountMinor: "10900", currency: "USD" },
      [["Accessory Bundle", "5% off"]],
    ]);
  });

  it("order status only for the ONE Commerce customer whose number is the verified one", async () => {
    const mine = await callBusinessApp(rawPrisma, P.link, "commerce", "commerce.getOrderStatus", { orderReference: null, verifiedCustomer: { kind: "PHONE_E164", value: "33612345678" } });
    expect(mine.ok && mine.data.orders.map((o) => [o.orderReference, o.status, o.paymentStatus, o.total])).toEqual([["ORD-1006", "Processing", "Partial", { amountMinor: "149900", currency: "USD" }]]);
    const shared = await callBusinessApp(rawPrisma, P.link, "commerce", "commerce.getOrderStatus", { orderReference: null, verifiedCustomer: { kind: "PHONE_E164", value: "8801711000222" } });
    expect(shared.ok && shared.data.orders).toEqual([]);
  });

  it("check again re-proves the same mapping with the stored key (Commerce gives no second key)", async () => {
    expect((await connect("link")).success).toMatch(/connected/);
    expect((await installation(P.link))!.status).toBe("ACTIVE");
  });

  it("Commerce saying the connection is disabled is ERROR, and from then on the gate makes no call at all", async () => {
    commerce.connection(P.link)!.status = "Disabled";
    expect((await connect("link")).error).toMatch(/reports this connection as Disabled/);
    expect((await installation(P.link))!.status).toBe("ERROR");
    const before = commerce.requests.length;
    expect(await callBusinessApp(rawPrisma, P.link, "commerce", "commerce.searchProducts", { query: "anker", limit: 5 })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(commerce.requests.length).toBe(before);
    commerce.connection(P.link)!.status = "Active";
    expect((await connect("link")).success).toMatch(/connected/);
  });

  it("a Main Admin's disable stops every new call, though Commerce itself is still active", async () => {
    current = s.adminA;
    expect((await actions.setBusinessAppEnabledAction((await installation(P.link))!.id, P.link, false)).success).toMatch(/disabled/);
    const before = commerce.requests.length;
    expect(await callBusinessApp(rawPrisma, P.link, "commerce", "commerce.getActiveOffers", {})).toMatchObject({ ok: false, error: { code: "FORBIDDEN", message: expect.stringMatching(/INSTALLATION_DISABLED/) } });
    expect(commerce.requests.length).toBe(before);
    // The key is kept (encrypted), so enabling needs only a fresh check, never a lost one-time key.
    expect((await installation(P.link))!.credentialCiphertext).not.toBeNull();
    expect((await actions.setBusinessAppEnabledAction((await installation(P.link))!.id, P.link, true)).success).toMatch(/enabled/);
    expect((await connect("link")).success).toMatch(/connected/);
  });

  it("refuses to re-point a mapped project at another workspace, and a workspace linked elsewhere is Commerce's 409", async () => {
    expect((await connect("link", { mode: "LINK_EXISTING", workspaceId: commerce.workspace(1) })).error).toMatch(/already mapped/);
    expect((await connect("mapped", { mode: "LINK_EXISTING", workspaceId: commerce.workspace(0) })).error).toMatch(/already linked to another host project/);
    expect((await installation(P.mapped))!.status).toBe("ERROR");
  });

  it("a workspace Commerce now reports differently for the project is not accepted", async () => {
    expect((await connect("mapped", { mode: "LINK_EXISTING", workspaceId: commerce.workspace(1) })).success).toMatch(/connected/);
    commerce.connection(P.mapped)!.workspaceId = commerce.workspace(2);
    expect((await connect("mapped")).error).toMatch(/different workspace/);
    const row = (await installation(P.mapped))!;
    expect([row.status, row.externalWorkspaceId]).toEqual(["ERROR", commerce.workspace(1)]);
  });

  it("a contract version this server has no adapter for is never activated, and the one-time key is still kept", async () => {
    commerce.contractVersion = "v2";
    try {
      expect((await connect("v2", { mode: "PROVISION_NEW", currency: "BDT" })).error).toMatch(/speaks contract “v2”/);
    } finally {
      commerce.contractVersion = "v1";
    }
    const row = (await installation(P.v2))!;
    expect([row.status, row.externalWorkspaceId]).toEqual(["ERROR", null]);
    expect(decryptSecret(row.credentialCiphertext!)).toBe(commerce.connection(P.v2)!.apiKey);
  });

  it("creates a new workspace, and a project whose key this server never held cannot be activated", async () => {
    expect((await connect("fresh", { mode: "PROVISION_NEW", currency: "bdt" })).success).toMatch(/connected/);
    expect(commerce.workspaces.has((await installation(P.fresh))!.externalWorkspaceId!)).toBe(true);
    // Lose the key: Commerce will not give it again, so the host refuses rather than guessing.
    await rawPrisma.projectAppInstallation.updateMany({ where: { projectId: P.fresh }, data: { credentialCiphertext: null } });
    expect((await connect("fresh")).error).toMatch(/gives its key only once/);
  });

  it("a wrong shared secret is Commerce's 401, shown as Commerce said it", async () => {
    process.env.COMMERCE_PROVISIONING_SECRET = "not-the-secret";
    expect((await connect("v2", { mode: "PROVISION_NEW", currency: "BDT" })).error).toMatch(/signature is invalid/);
    configure();
  });

  it("only an approved address is ever called or framed", async () => {
    process.env.COMMERCE_API_URL = "http://commerce.internal.test";
    expect((await connect("link")).error).toMatch(/not an approved address/);
    configure();
    process.env.COMMERCE_APP_URL = "https://shop.example.test/";
    expect(host.businessAppEmbedUrl("commerce", "/orders?status=open")).toEqual({ url: "https://shop.example.test/orders?status=open", origin: "https://shop.example.test" });
    expect(host.businessAppEmbedUrl("commerce", "//evil.test/x")!.url).toBe("https://shop.example.test/dashboard");
    expect(host.businessAppEmbedUrl("commerce", "https://evil.test/")!.url).toBe("https://shop.example.test/dashboard");
    process.env.COMMERCE_APP_URL = "http://shop.example.test";
    expect(host.businessAppEmbedUrl("commerce")).toBeNull();
  });

  describe("signing a person in from the workspace", () => {
    const fx = () => ({ customer: A.customer, project: P.link, other: P.link, slug: `commerce-link-${tag}`, otherSlug: `commerce-link-${tag}` });
    const launch = (path?: string) => inProject(fx(), () => actions.launchBusinessApp("commerce", path));
    beforeAll(() => {
      configure();
      process.env.COMMERCE_APP_URL = "http://127.0.0.1:3999";
    });

    it("asks Commerce with a signed request and a pseudonymous subject, and opens only Commerce's single-use address", async () => {
      configure();
      // The address test above left the check failed on purpose; a fresh check makes it ACTIVE again.
      expect((await connect("link")).success).toMatch(/connected/);
      current = s.adminA;
      expect((await installation(P.link))!.status).toBe("ACTIVE");
      const first = await launch("//evil.test/x");
      expect(first.mode).toBe("LINK");
      expect(first.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:3999\/sso\/launch#code=[0-9a-f]{32}$/);
      const sent = commerce.launches.at(-1)!;
      expect([sent.hostCustomerId, sent.hostProjectId, sent.returnPath, sent.displayName]).toEqual([A.customer, P.link, "/dashboard", s.adminA.name]);
      // Stable for this person in this installation, and never the host's own user id.
      expect(sent.subject).toBe(createHash("sha256").update(`${(await installation(P.link))!.id}:${s.adminA.userId}`).digest("hex"));
      expect(JSON.stringify(commerce.launches)).not.toContain(s.adminA.userId);

      // Once the person linked their Commerce account (in Commerce), the next open signs straight in.
      commerce.linkedSubjects.add(sent.subject);
      const second = await launch("/orders?status=open");
      expect(second.mode).toBe("SIGN_IN");
      expect(commerce.launches.at(-1)).toMatchObject({ subject: sent.subject, returnPath: "/orders?status=open" });
    });

    it("an address Commerce was not expected to answer with is never opened", async () => {
      current = s.adminA;
      for (const bad of ["https://evil.test/sso/launch#code=0123456789abcdef", "/login#code=0123456789abcdef", "/sso/launch?code=0123456789abcdef"]) {
        commerce.launchPathOverride = bad;
        try {
          expect((await launch()).error).toMatch(/sign-in address did not have the shape/);
        } finally {
          commerce.launchPathOverride = null;
        }
      }
    });

    it("Commerce refusing, or not offering sign-in yet, is said plainly; the frame then opens Commerce's own sign-in", async () => {
      current = s.adminA;
      commerce.connection(P.link)!.status = "Disabled";
      try {
        expect((await launch()).error).toMatch(/refused to sign you in from this project. Commerce said: “The connection to the host platform is not active.”/);
      } finally {
        commerce.connection(P.link)!.status = "Active";
      }
      commerce.hostSignIn = false;
      try {
        expect((await launch()).error).toMatch(/does not offer sign-in from Get Assist yet/);
      } finally {
        commerce.hostSignIn = true;
      }
      process.env.COMMERCE_PROVISIONING_SECRET = "not-the-secret";
      expect((await launch()).error).toMatch(/signature is invalid/);
      configure();
    });

    it("a disabled installation, or a person without business_apps.open, asks Commerce nothing", async () => {
      current = s.adminA;
      const id = (await installation(P.link))!.id;
      expect((await actions.setBusinessAppEnabledAction(id, P.link, false)).success).toMatch(/disabled/);
      const before = commerce.requests.length;
      expect((await launch()).error).toBeTruthy();
      const noKey = await user(A.customer, "appsnokeylink", await role(A.customer, "AppsNoKeyLink", ["messages.view"]), [P.link]);
      current = noKey;
      expect((await launch()).error).toBeTruthy();
      expect(commerce.requests.length).toBe(before);
      current = s.adminA;
      expect((await actions.setBusinessAppEnabledAction(id, P.link, true)).success).toMatch(/enabled/);
      expect((await connect("link")).success).toMatch(/connected/);
    });
  });
});
