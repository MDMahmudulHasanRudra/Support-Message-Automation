import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * White labeling (BRANDING.md), called as the browser calls it, with only the request plumbing
 * stubbed. What must hold:
 *   - only a Main Admin (projects.manage) can change the brand or rename a project — the actions
 *     check it themselves, whatever page shows the button;
 *   - nothing saved means the built-in brand, and saving the default text is the same as Reset;
 *   - an image's type comes from its bytes, an oversize or scripted file is refused, and the image
 *     route serves what was stored, with a new URL after every change;
 *   - a project is renamed by name only — its address never moves.
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

const branding = await import("@/server/actions/branding");
const projects = await import("@/server/actions/projects");
const { getBranding } = await import("@/server/branding");
const route = await import("@/app/api/brand/[asset]/route");

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
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}

const sessions = {} as Record<"mainAdmin" | "portalViewer", Session>;
const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const pngFile = (name = "logo.png") => new File([PNG], name, { type: "image/png" });
const get = (asset: string, v?: string | number, headers?: Record<string, string>) =>
  route.GET(new Request(`http://test/api/brand/${asset}${v === undefined ? "" : `?v=${v}`}`, { headers }), { params: Promise.resolve({ asset }) });

beforeAll(async () => {
  sessions.mainAdmin = await user("MainAdmin", await role("BR main admin", ["projects.view", "projects.manage"]));
  sessions.portalViewer = await user("PortalViewer", await role("BR viewer", ["projects.view"]));
  await rawPrisma.platformBranding.deleteMany({});
});

beforeEach(() => {
  current = sessions.mainAdmin;
});

afterAll(async () => {
  await rawPrisma.platformBranding.deleteMany({});
  await rawPrisma.project.deleteMany({ where: { id: { in: ids.projects } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
});

describe("nothing saved is the built-in brand", () => {
  it("every page reads the product as it always looked", async () => {
    expect(await getBranding()).toMatchObject({ productName: "Nexora", accentColor: null, logoUrl: null, hasCustomIcon: false });
  });

  it("the icon route serves the built-in icon, and there is no logo yet", async () => {
    const icon = await get("icon", 0);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toContain("<svg");
    expect((await get("logo", 0)).status).toBe(404);
    expect((await get("favicon")).status).toBe(404);
  });
});

describe("only a Main Admin changes the brand", () => {
  it("a portal viewer is refused by every action, and nothing is written", async () => {
    current = sessions.portalViewer;
    expect((await branding.saveBranding({}, form({ productName: `Hacked ${tag}` }))).error).toMatch(/Manage Projects/);
    expect((await branding.uploadBrandAsset("logo", {}, form({ file: pngFile() }))).error).toMatch(/Manage Projects/);
    expect((await branding.removeBrandAsset("icon")).error).toMatch(/Manage Projects/);
    expect(await rawPrisma.platformBranding.count()).toBe(0);
  });
});

describe("saving the name, the sign-in wording and the colour", () => {
  it("is what every page then shows — the name, the wording and the colour", async () => {
    const result = await branding.saveBranding(
      {},
      form({ productName: "  Zoventio   Desk ", loginHeadline: "Support, sorted.", loginSubheading: "Line one\nLine two", accentColor: "#0D9488" }),
    );
    expect(result).toEqual({ savedAt: expect.any(Number) });
    expect(await getBranding()).toMatchObject({
      productName: "Zoventio Desk",
      loginHeadline: "Support, sorted.",
      loginSubheading: "Line one\nLine two",
      accentColor: "#0d9488",
    });
    expect((await rawPrisma.platformBranding.findUniqueOrThrow({ where: { id: "default" } })).updatedByUsername).toBe(sessions.mainAdmin.username);
  });

  it("refuses a bad colour or an over-long name with the field named, and keeps what was saved", async () => {
    const result = await branding.saveBranding({}, form({ productName: "x".repeat(61), accentColor: "#000;}body{display:none" }));
    expect(result.fieldErrors).toMatchObject({ productName: expect.any(String), accentColor: expect.any(String) });
    expect((await getBranding()).productName).toBe("Zoventio Desk");
  });

  it("an emptied field, or the default text itself, goes back to the built-in wording", async () => {
    await branding.saveBranding({}, form({ productName: "Nexora", loginHeadline: "", loginSubheading: "", accentColor: "" }));
    const row = await rawPrisma.platformBranding.findUniqueOrThrow({ where: { id: "default" } });
    expect(row).toMatchObject({ productName: null, loginHeadline: null, loginSubheading: null, accentColor: null });
    expect((await getBranding()).productName).toBe("Nexora");
  });
});

describe("uploading the logo and the icon", () => {
  it("stores a real image, serves it with its sniffed type, and gives it a new URL", async () => {
    const before = (await rawPrisma.platformBranding.findUniqueOrThrow({ where: { id: "default" } })).assetVersion;
    // The browser's claimed type is ignored: the bytes are a PNG whatever the file is called.
    expect(await branding.uploadBrandAsset("logo", {}, form({ file: new File([PNG], "logo.svg", { type: "image/svg+xml" }) }))).toEqual({ savedAt: expect.any(Number) });
    const brand = await getBranding();
    const version = before + 1;
    expect(brand.logoUrl).toBe(`/api/brand/logo?v=${version}`);

    const response = await get("logo", version);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    // An old or missing version is revalidated, never cached for good.
    expect((await get("logo", version - 1)).headers.get("cache-control")).toContain("must-revalidate");
    // A matching ETag answers 304.
    expect((await get("logo", version, { "if-none-match": response.headers.get("etag")! })).status).toBe(304);
  });

  it("the icon becomes the mark everywhere and the tab icon", async () => {
    await branding.uploadBrandAsset("icon", {}, form({ file: pngFile("icon.png") }));
    const brand = await getBranding();
    expect(brand.hasCustomIcon).toBe(true);
    const response = await get("icon", brand.iconUrl.split("v=")[1]);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("refuses a file that is not an image, an SVG with script, an empty file and an oversize one", async () => {
    const version = (await rawPrisma.platformBranding.findUniqueOrThrow({ where: { id: "default" } })).assetVersion;
    const refused = [
      new File(["<html><script>alert(1)</script></html>"], "logo.png", { type: "image/png" }),
      new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'], "logo.svg", { type: "image/svg+xml" }),
      new File([], "empty.png", { type: "image/png" }),
      // A real PNG header, so only the size can refuse it.
      new File([(() => { const big = new Uint8Array(512 * 1024 + 1); big.set(PNG); return big; })()], "huge.png", { type: "image/png" }),
    ];
    for (const file of refused) {
      expect((await branding.uploadBrandAsset("logo", {}, form({ file }))).error, file.name).toBeTruthy();
    }
    expect((await rawPrisma.platformBranding.findUniqueOrThrow({ where: { id: "default" } })).assetVersion).toBe(version);
  });

  it("a plain SVG is accepted", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0d9488"/></svg>';
    expect(await branding.uploadBrandAsset("logo", {}, form({ file: new File([svg], "logo.svg") }))).toEqual({ savedAt: expect.any(Number) });
    expect((await get("logo")).headers.get("content-type")).toBe("image/svg+xml");
  });

  it("removing goes back to the built-in mark and to no logo, with new URLs", async () => {
    const before = await getBranding();
    expect(await branding.removeBrandAsset("icon")).toEqual({ savedAt: expect.any(Number) });
    expect(await branding.removeBrandAsset("logo")).toEqual({ savedAt: expect.any(Number) });
    const after = await getBranding();
    expect(after).toMatchObject({ hasCustomIcon: false, logoUrl: null });
    expect(after.iconUrl).not.toBe(before.iconUrl);
    expect((await get("icon")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await get("logo")).status).toBe(404);
    // Removing what is not there is a no-op, not an error.
    expect(await branding.removeBrandAsset("logo")).toEqual({ savedAt: expect.any(Number) });
  });
});

describe("renaming a project", () => {
  let projectId = "";
  let otherName = "";

  beforeAll(async () => {
    const project = await rawPrisma.project.create({ data: { name: `Rename Me ${tag}`, slug: `rename-${tag}`, status: "ACTIVE" } });
    const other = await rawPrisma.project.create({ data: { name: `Taken Name ${tag}`, slug: `taken-${tag}`, status: "ACTIVE" } });
    ids.projects.push(project.id, other.id);
    projectId = project.id;
    otherName = other.name;
  });

  it("changes the name and description, never the address", async () => {
    const result = await projects.updateProjectDetails(projectId, {}, form({ name: `  Zoventio   Support ${tag} `, description: "Our main desk" }));
    expect(result).toEqual({ savedAt: expect.any(Number) });
    const row = await rawPrisma.project.findUniqueOrThrow({ where: { id: projectId } });
    expect(row).toMatchObject({ name: `Zoventio Support ${tag}`, description: "Our main desk", slug: `rename-${tag}` });
  });

  it("refuses another project's name in any capitalisation, but accepts its own", async () => {
    expect((await projects.updateProjectDetails(projectId, {}, form({ name: otherName.toUpperCase() }))).fieldErrors?.name).toMatch(/already exists/);
    expect(await projects.updateProjectDetails(projectId, {}, form({ name: `zoventio support ${tag}` }))).toEqual({ savedAt: expect.any(Number) });
  });

  it("refuses an empty name, and a non-Main Admin entirely", async () => {
    expect((await projects.updateProjectDetails(projectId, {}, form({ name: "   " }))).fieldErrors?.name).toBeTruthy();
    current = sessions.portalViewer;
    expect((await projects.updateProjectDetails(projectId, {}, form({ name: `Hacked ${tag}` }))).error).toMatch(/Manage Projects/);
    expect((await rawPrisma.project.findUniqueOrThrow({ where: { id: projectId } })).name).toBe(`zoventio support ${tag}`);
  });
});
