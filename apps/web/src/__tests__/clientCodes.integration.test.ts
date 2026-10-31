import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  allocateClientCode,
  changeClientCodeSeries,
  ClientCodeSeriesError,
  createProjectWithDefaults,
  prisma as rawPrisma,
  readClientCodeSeries,
} from "@support-automation/db";

/**
 * Project client codes (CLIENT_CODES.md) against a real database: numbers only for a customer's primary project,
 * a reserved letter prefix for every other, collisions refused, concurrent creates never sharing a code, customers
 * kept apart, the reviewed conversion of old "CL-" codes (aliases keep them findable), typed codes kept out of
 * another project's namespace, and imports that never turn "000007" into 7.
 */

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const codes = await import("@/server/clientCodes");
const { processImportRows } = await import("@/server/clientImport");
const { loadExistingMatches } = await import("@/server/clientRecords");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { customers: [] as string[], projects: [] as string[], users: [] as string[] };
let actor = "";

async function customer(label: string): Promise<string> {
  const c = await rawPrisma.customer.create({ data: { name: `Codes ${label} ${tag}` } });
  ids.customers.push(c.id);
  return c.id;
}
async function project(name: string, slug: string, customerId: string | null, clientCode?: { prefix?: string; minWidth?: number; startSerial?: string }) {
  const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${slug}-${tag}`, status: "ACTIVE", creatorUserId: null, customerId, clientCode }, rawPrisma);
  ids.projects.push(p.id);
  return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
}
const live = async (projectId: string) => (await readClientCodeSeries(rawPrisma, projectId)).find((s) => !s.retiredAt)!;
const next = (projectId: string) => rawPrisma.$transaction((tx) => allocateClientCode(tx, projectId));

let custA: string;
let custB: string;
let primaryA: Awaited<ReturnType<typeof project>>;
let noor: Awaited<ReturnType<typeof project>>;
let nexus: Awaited<ReturnType<typeof project>>;
let primaryB: Awaited<ReturnType<typeof project>>;

beforeAll(async () => {
  const user = await rawPrisma.user.create({ data: { username: `codes_${tag}`, email: `codes.${tag}@example.test`, name: "Codes admin", passwordHash: "x" } });
  ids.users.push(user.id);
  actor = user.id;
  custA = await customer("A");
  custB = await customer("B");
  primaryA = await project("Main", "main-a", custA);
  noor = await project("Noor", "noor", custA);
  nexus = await project("Nexus", "nexus", custA);
  primaryB = await project("Main", "main-b", custB);
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where }); // aliases go with their clients
  await rawPrisma.systemLog.deleteMany({ where });
});

describe("numbering", () => {
  it("gives a customer's first project numbers only, and grows past 9999 without wrapping", async () => {
    expect(await live(primaryA.id)).toMatchObject({ prefix: "", isPrimary: true, minWidth: 4, nextSerial: "1" });
    expect(await next(primaryA.id)).toBe("0001");
    expect(await next(primaryA.id)).toBe("0002");
    await rawPrisma.$transaction((tx) => changeClientCodeSeries(tx, { projectId: primaryA.id, nextSerial: "9999", actorUserId: actor }));
    expect(await next(primaryA.id)).toBe("9999");
    expect(await next(primaryA.id)).toBe("10000");
    expect(await live(primaryA.id)).toMatchObject({ nextSerial: "10001" });
  });

  it("gives later projects their own letter, and a longer one when the letter is taken", async () => {
    expect(await live(noor.id)).toMatchObject({ prefix: "N", isPrimary: false });
    expect(await live(nexus.id)).toMatchObject({ prefix: "NE" });
    expect(await next(noor.id)).toBe("N0001");
    expect(await next(nexus.id)).toBe("NE0001");
  });

  it("refuses a prefix another project of the customer holds, and accepts a free one", async () => {
    await expect(project("Nova", "nova", custA, { prefix: "n" })).rejects.toThrow(ClientCodeSeriesError);
    const vip = await project("Vip lounge", "vip-lounge", custA, { prefix: "VIP", minWidth: 3, startSerial: "7" });
    expect(await next(vip.id)).toBe("VIP007");
  });

  it("serialises two new projects that both start with N into distinct prefixes", async () => {
    const [x, y] = await Promise.all([project("Night", "night", custA), project("North", "north", custA)]);
    const [px, py] = [(await live(x.id)).prefix, (await live(y.id)).prefix];
    expect(px).not.toBe(py);
    expect([px, py].every((p) => /^N[A-Z]+$/.test(p))).toBe(true);
  });

  it("never gives two of 25 parallel creates the same code", async () => {
    const got = await Promise.all(Array.from({ length: 25 }, () => next(noor.id)));
    expect(new Set(got).size).toBe(25);
    expect(got.every((c) => /^N\d{4}$/.test(c))).toBe(true);
  });

  it("keeps customers apart: another customer's primary project starts at 0001 too", async () => {
    expect(await next(primaryB.id)).toBe("0001");
    await expect(rawPrisma.client.create({ data: { projectId: primaryB.id, code: "0001", name: "B one" } })).resolves.toBeTruthy();
  });

  it("skips a code already used (typed by hand) instead of colliding, and never reuses a number", async () => {
    const p = await project("Skip", "skip", custB);
    const prefix = (await live(p.id)).prefix;
    await rawPrisma.client.create({ data: { projectId: p.id, code: `${prefix}0001`, name: "typed" } });
    expect(await next(p.id)).toBe(`${prefix}0002`);
    const archived = await rawPrisma.client.create({ data: { projectId: p.id, code: await next(p.id), name: "gone", status: "ARCHIVED" } });
    await rawPrisma.client.delete({ where: { id: archived.id } });
    expect(await next(p.id)).toBe(`${prefix}0004`);
  });

  it("does not rename a project's codes when the project is renamed; a new prefix starts a new version", async () => {
    await rawPrisma.project.update({ where: { id: noor.id }, data: { name: `Zebra ${tag}` } });
    expect((await live(noor.id)).prefix).toBe("N");
    await expect(rawPrisma.$transaction((tx) => changeClientCodeSeries(tx, { projectId: noor.id, prefix: "NE", actorUserId: actor }))).rejects.toThrow(/reserved/);
    await expect(rawPrisma.$transaction((tx) => changeClientCodeSeries(tx, { projectId: noor.id, minWidth: 3, actorUserId: actor }))).rejects.toThrow(/only grow/);
    await rawPrisma.$transaction((tx) => changeClientCodeSeries(tx, { projectId: noor.id, prefix: "NR", actorUserId: actor }));
    const all = await readClientCodeSeries(rawPrisma, noor.id);
    expect(all.map((s) => [s.version, s.prefix, Boolean(s.retiredAt)])).toEqual([
      [2, "NR", false],
      [1, "N", true],
    ]);
    expect(await next(noor.id)).toBe("NR0001");
    // N stays reserved for this project: nobody else can take it.
    await expect(project("Neon", "neon", custA, { prefix: "N" })).rejects.toThrow(/reserved/);
    await expect(rawPrisma.$transaction((tx) => changeClientCodeSeries(tx, { projectId: primaryA.id, prefix: "P", actorUserId: actor }))).rejects.toThrow(/numbers only/);
  });
});

describe("converting old CL- codes", () => {
  it("previews without writing, applies exactly the reviewed plan, and keeps every old code findable", async () => {
    const p = await project("Convert", "convert", custB);
    const prefix = (await live(p.id)).prefix;
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
    const legacy1 = await rawPrisma.client.create({ data: { projectId: p.id, code: "CL-000041", name: "Old one", createdAt: at(1) } });
    const legacy2 = await rawPrisma.client.create({ data: { projectId: p.id, code: "CL-000099", name: "Old two", createdAt: at(2), status: "ARCHIVED", archivedAt: at(3) } });
    const custom = await rawPrisma.client.create({ data: { projectId: p.id, code: "ACME-77", name: "Custom", createdAt: at(3) } });
    const options = { convertLegacyPattern: true, convertCustom: false };

    const preview = (await codes.previewCodeConversion(p.id, options))!;
    expect(preview.plan.rows.filter((r) => r.to).map((r) => [r.from, r.to])).toEqual([
      ["CL-000041", `${prefix}0001`],
      ["CL-000099", `${prefix}0002`],
    ]);
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: legacy1.id } })).code).toBe("CL-000041"); // the dry run changed nothing

    // A client created after the preview changes the plan: the old hash is refused and nothing is written.
    const later = await rawPrisma.client.create({ data: { projectId: p.id, code: "CL-000120", name: "Later", createdAt: at(4) } });
    const stale = await codes.applyCodeConversion(p.id, { options, expectedHash: preview.plan.hash, actorUserId: actor });
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/Preview again/) });
    expect(await rawPrisma.clientCodeAlias.count({ where: { projectId: p.id } })).toBe(0);

    const fresh = (await codes.previewCodeConversion(p.id, options))!;
    const applied = await codes.applyCodeConversion(p.id, { options, expectedHash: fresh.plan.hash, actorUserId: actor });
    expect(applied).toMatchObject({ ok: true, changed: 3 });
    const after = await rawPrisma.client.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" }, select: { id: true, code: true } });
    expect(after.map((c) => c.code)).toEqual([`${prefix}0001`, `${prefix}0002`, "ACME-77", `${prefix}0003`]);
    // Same ids, old codes resolve to them, archived kept its number, the custom code untouched.
    expect(await codes.clientIdForCode(rawPrisma, p.id, "cl-000041")).toBe(legacy1.id);
    expect(await codes.clientIdForCode(rawPrisma, p.id, "CL-000099")).toBe(legacy2.id);
    expect(await codes.clientIdForCode(rawPrisma, p.id, "ACME-77")).toBe(custom.id);
    expect(await codes.clientIdForCode(rawPrisma, p.id, "CL-000120")).toBe(later.id);
    expect(await rawPrisma.clientActivity.count({ where: { projectId: p.id, type: "CODE_CHANGED" } })).toBe(3);
    // The series continues after the converted numbers, and never gives an old code to anyone.
    expect(await next(p.id)).toBe(`${prefix}0004`);
    expect(await codes.typedClientCodeRefusal(rawPrisma, p.id, "CL-000041")).toMatch(/former code/);
    // Aliases are history.
    await expect(rawPrisma.$executeRaw`UPDATE "ClientCodeAlias" SET "code" = 'X' WHERE "projectId" = ${p.id}`).rejects.toThrow(/never changed/);
  });
});

describe("typed codes", () => {
  it("refuses a code shaped like another project's codes, and one already used in the project", async () => {
    expect(await codes.typedClientCodeRefusal(rawPrisma, primaryA.id, "NE0042")).toMatch(/Nexus/);
    expect(await codes.typedClientCodeRefusal(rawPrisma, nexus.id, "0042")).toMatch(/numbers only/);
    expect(await codes.typedClientCodeRefusal(rawPrisma, primaryA.id, "0001")).toBeNull(); // own form, unused here
    await rawPrisma.client.create({ data: { projectId: primaryA.id, code: "REF-1", name: "has ref" } });
    expect(await codes.typedClientCodeRefusal(rawPrisma, primaryA.id, "ref-1")).toMatch(/already used/);
  });
});

describe("imports", () => {
  const rows = [{ Code: "000007", Name: `Seven ${tag}`, Phone: "+8801700000077" }];
  const mapping = { code: "Code", name: "Name", phone: "Phone" } as const;

  it("gives a new client the project's code and keeps the file's code (leading zeros and all) as its reference", async () => {
    const p = await project("Import ref", "import-ref", custB);
    const prefix = (await live(p.id)).prefix;
    const result = await runWithProject(p, () => processImportRows(rows, mapping, "UPDATE", "file.xlsx", null, async () => undefined, { subscriptions: false }));
    expect(result).toMatchObject({ imported: 1, failed: 0 });
    const client = await rawPrisma.client.findFirstOrThrow({ where: { projectId: p.id } });
    expect(client.code).toBe(`${prefix}0001`);
    expect(await codes.clientIdForCode(rawPrisma, p.id, "000007")).toBe(client.id);
    expect(await codes.clientIdForCode(rawPrisma, p.id, "7")).toBeNull();
    // Re-importing the same file finds the client by the file's code: updated, not created twice.
    const byCode = await runWithProject(p, () => loadExistingMatches([], ["000007"]));
    expect(byCode.byCode.get("000007")).toBe(client.id);
    const again = await runWithProject(p, () => processImportRows([{ ...rows[0]!, Phone: "" }], mapping, "UPDATE", "file.xlsx", null, async () => undefined, { subscriptions: false }));
    expect(again).toMatchObject({ imported: 0, updated: 1 });
    expect(await rawPrisma.client.count({ where: { projectId: p.id } })).toBe(1);
  });

  it("uses the file's code as the client's code only when asked, exactly as written", async () => {
    // Digits only are the primary project's form, so a primary project may take "000007" as it is.
    const p = await project("Import code", "import-code", await customer("C"));
    const result = await runWithProject(p, () => processImportRows(rows, mapping, "UPDATE", "file.xlsx", null, async () => undefined, { subscriptions: false, codeMode: "AS_CODE" }));
    expect(result).toMatchObject({ imported: 1 });
    expect((await rawPrisma.client.findFirstOrThrow({ where: { projectId: p.id } })).code).toBe("000007");
  });

  it("fails just that row, with the reason, when the file's code has another project's form", async () => {
    const p = await project("Import clash", "import-clash", custA);
    const result = await runWithProject(p, () =>
      processImportRows([{ Code: "NE0099", Name: `Clash ${tag}`, Phone: "+8801700000078" }], mapping, "UPDATE", "file.xlsx", null, async () => undefined, { subscriptions: false, codeMode: "AS_CODE" }),
    );
    expect(result).toMatchObject({ imported: 0, failed: 1 });
    expect(result.errors[0]!.errors.join(" ")).toMatch(/Nexus/);
  });
});
