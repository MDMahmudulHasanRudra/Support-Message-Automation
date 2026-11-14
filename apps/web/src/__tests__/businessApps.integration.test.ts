import "./helpers/requireTestDatabase";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma, resolveBusinessAppCapability } from "@support-automation/db";
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

afterEach(() => host.registerBusinessAppAdapter(null, "commerce"));

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
  it("stays waiting, with the reason, while no adapter exists — never ACTIVE", async () => {
    current = s.adminA;
    const row = (await installation(A.project))!;
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

    host.registerBusinessAppAdapter(fakeAdapter(async () => ({ ok: true, data: { externalWorkspaceId: "ws-a", appContractVersion: "1", verifiedAt: new Date().toISOString() }, asOf: new Date().toISOString() })));
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
    // No adapter: honest refusal, nothing sent.
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/has not published its sign-in hand-off/);
    host.registerBusinessAppAdapter(fakeAdapter(async () => ({ ok: false, error: { code: "NOT_AVAILABLE", message: "x", retryable: true } })));
    expect(await inProject(A, () => actions.launchBusinessApp("commerce"))).toEqual({ redirectUrl: "https://commerce.example.test/launch?code=one-time" });
    host.registerBusinessAppAdapter(fakeAdapter(async () => ({ ok: false, error: { code: "NOT_AVAILABLE", message: "x", retryable: true } }), "http://commerce.example.test/launch"));
    expect((await inProject(A, () => actions.launchBusinessApp("commerce"))).error).toMatch(/not secure/);
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
