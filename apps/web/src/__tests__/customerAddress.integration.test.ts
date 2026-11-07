import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { pickCustomerOrigin } from "@support-automation/shared";

/**
 * One server, many customers (SAAS_PLATFORM_PLAN.md §12). NEXTAUTH_URL names ONE address, and it happened to be a
 * customer's: every other customer was handed that customer's address in its widget code, chat link and webhook
 * addresses. Each customer gets its own, and another customer's address refuses its keys.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const host = { a: `a-${tag}.example.test`, a2: `a2-${tag}.example.test`, b: `b-${tag}.example.test`, admin: `admin-${tag}.example.test` };
const request = { host: "" };

vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  headers: async () => new Headers({ "x-relqivo-host": request.host, "user-agent": "vitest" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const { runWithProject } = await import("@/server/projectContext");
const { forgetHostScopes } = await import("@/server/hostScope");
const { activeProjectOrigin, publicOriginForProject } = await import("@/server/customerAddress");
const { loadPublicWidget, widgetScriptUrl } = await import("@/server/channels/webchat");
const { webhookUrlFor } = await import("@/server/channels/connections");

const fx = {} as {
  customerA: string;
  customerB: string;
  customerNoAddress: string;
  a: { id: string; slug: string; name: string; status: string };
  b: { id: string; slug: string; name: string; status: string };
  none: { id: string; slug: string; name: string; status: string };
  keyA: string;
  keyB: string;
};
const asProject = <T,>(p: typeof fx.a, fn: () => Promise<T>) => runWithProject(p as never, fn);

async function customerWithProject(name: string) {
  const customer = await rawPrisma.customer.create({ data: { name: `${name} ${tag}` } });
  const project = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId: customer.id }, rawPrisma);
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: project.id, key: "OMNICHANNEL" } },
    update: { enabled: true },
    create: { projectId: project.id, key: "OMNICHANNEL", enabled: true },
  });
  return { customer, project };
}

async function widget(projectId: string): Promise<string> {
  const webhookKey = `key${randomUUID().replace(/-/g, "")}`;
  await rawPrisma.channelConnection.create({ data: { projectId, type: "WEBCHAT", name: "Site", status: "CONNECTED", webhookKey, allowedOrigins: [] } });
  return webhookKey;
}

beforeAll(async () => {
  vi.stubEnv("NEXTAUTH_URL", `https://${host.b}`); // the setting names customer B, as it did on the live server
  await rawPrisma.platformDomainSettings.deleteMany({});
  const a = await customerWithProject("A");
  const b = await customerWithProject("B");
  const none = await customerWithProject("None");
  fx.customerA = a.customer.id;
  fx.customerB = b.customer.id;
  fx.customerNoAddress = none.customer.id;
  fx.a = a.project as typeof fx.a;
  fx.b = b.project as typeof fx.b;
  fx.none = none.project as typeof fx.none;
  fx.keyA = await widget(fx.a.id);
  fx.keyB = await widget(fx.b.id);
  await rawPrisma.customerDomain.createMany({
    data: [
      { customerId: fx.customerA, hostname: host.a, status: "ACTIVE", verificationToken: `t-a-${tag}`, activatedAt: new Date("2026-01-01") },
      { customerId: fx.customerA, hostname: host.a2, status: "ACTIVE", verificationToken: `t-a2-${tag}`, activatedAt: new Date("2026-02-01") },
      { customerId: fx.customerB, hostname: host.b, status: "ACTIVE", verificationToken: `t-b-${tag}`, activatedAt: new Date("2026-01-01") },
    ],
  });
  await rawPrisma.platformDomainSettings.create({ data: { id: "default", hostRoutingEnabled: true, rootDomain: "example.test", adminHostnames: [host.admin], publicIps: ["203.0.113.10"] } });
});

beforeEach(() => {
  request.host = "";
  forgetHostScopes();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rawPrisma.platformDomainSettings.deleteMany({});
  await rawPrisma.customerDomain.deleteMany({ where: { hostname: { contains: tag } } });
  const projects = [fx.a.id, fx.b.id, fx.none.id];
  await rawPrisma.channelConnection.deleteMany({ where: { projectId: { in: projects } } });
  for (const id of projects) await rawPrisma.projectFeature.deleteMany({ where: { projectId: id } });
  forgetHostScopes();
});

describe("every customer is given its own address", () => {
  it("the widget code and chat link name the customer's address, not the one in the server's setting", async () => {
    request.host = host.a;
    expect(await asProject(fx.a, () => widgetScriptUrl())).toBe(`https://${host.a}/api/webchat/widget.js`);
    expect(await asProject(fx.a, () => webhookUrlFor("TELEGRAM", "k"))).toBe(`https://${host.a}/api/channels/telegram/k`);
    request.host = host.b;
    expect(await asProject(fx.b, () => widgetScriptUrl())).toBe(`https://${host.b}/api/webchat/widget.js`);
  });

  it("uses the address they are on when they have several, and their first one otherwise", async () => {
    request.host = host.a2;
    expect(await asProject(fx.a, () => activeProjectOrigin())).toBe(`https://${host.a2}`);
    request.host = "";
    expect(await publicOriginForProject(fx.a.id)).toBe(`https://${host.a}`);
  });

  it("works in background work, which has no address of its own", async () => {
    expect(await publicOriginForProject(fx.a.id)).toBe(`https://${host.a}`);
  });

  it("never hands a customer with no address another customer's", async () => {
    expect(await publicOriginForProject(fx.none.id)).toBeNull();
    expect(await asProject(fx.none, () => widgetScriptUrl())).toBeNull();
  });
});

describe("another customer's address refuses a widget", () => {
  it("opens on its own customer's address only", async () => {
    request.host = host.a;
    expect((await loadPublicWidget(fx.keyA))?.projectId).toBe(fx.a.id);
    expect(await loadPublicWidget(fx.keyB)).toBeNull();
    request.host = host.b;
    expect((await loadPublicWidget(fx.keyB))?.projectId).toBe(fx.b.id);
    expect(await loadPublicWidget(fx.keyA)).toBeNull();
  });

  it("is simply not available on the platform address, not a server error", async () => {
    request.host = host.admin;
    await expect(loadPublicWidget(fx.keyA)).resolves.toBeNull();
  });
});

describe("the rule", () => {
  const base = { routingOn: true, fallback: "https://install.example", scheme: "https" as const, visitedHost: null, isOriginalInstallation: false };

  it("keeps a single installation exactly as it was while routing is off", () => {
    expect(pickCustomerOrigin({ ...base, routingOn: false, domains: [{ hostname: "x.example", status: "ACTIVE" }] })).toBe("https://install.example");
  });

  it("gives the original installation the server's own address when it has none of its own", () => {
    expect(pickCustomerOrigin({ ...base, domains: [], isOriginalInstallation: true })).toBe("https://install.example");
    expect(pickCustomerOrigin({ ...base, domains: [] })).toBeNull();
  });

  it("prefers an active address to one only verified, and ignores a visited address that is not theirs", () => {
    const domains = [{ hostname: "v.example", status: "VERIFIED" }, { hostname: "a.example", status: "ACTIVE" }];
    expect(pickCustomerOrigin({ ...base, domains })).toBe("https://a.example");
    expect(pickCustomerOrigin({ ...base, domains, visitedHost: "someone-else.example" })).toBe("https://a.example");
    expect(pickCustomerOrigin({ ...base, domains: [domains[0]!] })).toBe("https://v.example");
  });
});
