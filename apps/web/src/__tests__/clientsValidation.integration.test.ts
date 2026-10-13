import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Client Management: the validation pass over Phases 2–3. Things the first tests did not pin:
 *   - an ARCHIVED client refuses notes, channels, consent and removals at the server;
 *   - another project's channel cannot be reached by id, and the DATABASE (not only the scoped
 *     client) refuses every cross-project reference and any move of a client to another project;
 *   - permanent deletion removes only that client's own rows, and never a client restored first;
 *   - a spreadsheet is read only up to the row limit, a small file holding a huge amount of text or
 *     a very wide sheet is refused, and a malformed file is a message, not an error page;
 *   - the export and the import refuse in a project whose Client Management feature is off.
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
const actions = await import("@/server/actions/clients");
const importActions = await import("@/server/actions/clientImport");
const exportRoute = await import("@/app/p/[project]/api/clients/export/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;
let Off: Project;
let admin: Session;

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
const as = <T,>(project: Project, fn: () => Promise<T>) => {
  current = admin;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const create = (project: Project, fields: Record<string, string>) => as(project, () => actions.createClient({}, form(fields)));
const uploadFile = (project: Project, file: File) => {
  const f = new FormData();
  f.set("file", file);
  return as(project, () => importActions.previewClientImport({}, f));
};
const xlsx = (rows: unknown[][]) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return new File([new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer)], "big.xlsx");
};

beforeAll(async () => {
  const everything = ["clients.view", "clients.create", "clients.update", "clients.archive", "clients.delete", "clients.import", "clients.export", "messages.view"];
  const u = await rawPrisma.user.create({ data: { username: `val_${tag}`, email: `val.${tag}@example.test`, name: "Validator", passwordHash: "x", permissionModuleId: await role("CV admin", everything) } });
  ids.users.push(u.id);
  admin = { userId: u.id, username: u.username, email: u.email!, name: "Validator" } as Session;
  const make = async (name: string, enabled: boolean) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: u.id }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: [{ projectId: p.id, userId: u.id }], skipDuplicates: true });
    if (enabled) await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("ValA", true);
  B = await make("ValB", true);
  Off = await make("ValOff", false);
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientNote.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.clientImportJob.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("archived clients and cross-project references", () => {
  it("refuses notes, channels, consent and removals on an ARCHIVED client", async () => {
    const id = (await create(A, { name: "Frozen Client", phone: "+8801766000001" })).clientId!;
    const channel = await rawPrisma.clientChannel.findFirstOrThrow({ where: { clientId: id } });
    await as(A, () => actions.archiveClients([id]));
    expect((await as(A, () => actions.addClientNote(id, {}, form({ body: "x" })))).error).toMatch(/archived/);
    expect((await as(A, () => actions.addClientChannel(id, {}, form({ kind: "EMAIL", value: "frozen@example.com" })))).error).toMatch(/archived/);
    expect((await as(A, () => actions.setClientChannelConsent(channel.id, "OPTED_OUT"))).message).toMatch(/archived/);
    expect((await as(A, () => actions.removeClientChannel(channel.id))).message).toMatch(/archived/);
    expect(await rawPrisma.clientChannel.count({ where: { clientId: id } })).toBe(1);
    expect(await rawPrisma.clientNote.count({ where: { clientId: id } })).toBe(0);
  });

  it("another project's channel cannot be changed or removed by id", async () => {
    const inB = (await create(B, { name: "B Owner", phone: "+8801766000002" })).clientId!;
    const channel = await rawPrisma.clientChannel.findFirstOrThrow({ where: { clientId: inB } });
    expect((await as(A, () => actions.setClientChannelConsent(channel.id, "OPTED_OUT"))).message).toMatch(/no longer exists/);
    expect((await as(A, () => actions.removeClientChannel(channel.id))).message).toMatch(/no longer exists/);
    expect(await rawPrisma.clientChannel.findUniqueOrThrow({ where: { id: channel.id } })).toMatchObject({ consentStatus: "UNKNOWN" });
  });

  it("the database refuses every cross-project reference and any move of a client to another project", async () => {
    const memberB = await rawPrisma.internalTeamMember.create({ data: { projectId: B.id, name: "Trigger B", phoneNumber: `+88017${Math.floor(Math.random() * 1e8)}`, role: "Support" } });
    const teamB = await rawPrisma.team.create({ data: { projectId: B.id, name: `Trigger Team ${tag}` } });
    const inA = (await create(A, { name: "Trigger Owner A" })).clientId!;
    await expect(rawPrisma.client.create({ data: { projectId: A.id, code: `TRG-M-${tag}`, name: "x", assignedMemberId: memberB.id } })).rejects.toThrow();
    await expect(rawPrisma.client.create({ data: { projectId: A.id, code: `TRG-T-${tag}`, name: "x", assignedTeamId: teamB.id } })).rejects.toThrow();
    await expect(rawPrisma.client.update({ where: { id: inA }, data: { assignedMemberId: memberB.id } })).rejects.toThrow();
    await expect(rawPrisma.clientNote.create({ data: { projectId: B.id, clientId: inA, body: "x" } })).rejects.toThrow();
    await expect(rawPrisma.clientActivity.create({ data: { projectId: B.id, clientId: inA, type: "X", summary: "x" } })).rejects.toThrow();
    await expect(rawPrisma.client.update({ where: { id: inA }, data: { projectId: B.id } })).rejects.toThrow();
    await rawPrisma.internalTeamMember.delete({ where: { id: memberB.id } });
    await rawPrisma.team.delete({ where: { id: teamB.id } });
  });
});

describe("permanent deletion", () => {
  it("removes only that client's own rows, never a client restored first, and leaves import history alone", async () => {
    const keep = (await create(A, { name: "Keep Me", phone: "+8801766000003" })).clientId!;
    const gone = (await create(A, { name: "Delete Me", phone: "+8801766000004" })).clientId!;
    await as(A, () => actions.archiveClients([keep, gone]));
    await as(A, () => actions.restoreClients([keep])); // restored: no longer eligible
    const result = await as(A, () => actions.deleteClients([keep, gone]));
    expect(result.message).toMatch(/1 permanently deleted, 1 skipped/);
    expect(await rawPrisma.client.count({ where: { id: keep } })).toBe(1);
    expect(await rawPrisma.clientChannel.count({ where: { clientId: keep } })).toBe(1);
    expect(await rawPrisma.clientActivity.count({ where: { clientId: keep } })).toBeGreaterThan(0);
    expect(await rawPrisma.client.count({ where: { id: gone } })).toBe(0);
    expect(await rawPrisma.clientChannel.count({ where: { clientId: gone } })).toBe(0);

    const job = await rawPrisma.clientImportJob.create({ data: { projectId: A.id, fileName: "history.csv", fileType: "csv", status: "COMPLETED", importedCount: 2 } });
    await as(A, () => actions.archiveClients([keep]));
    await as(A, () => actions.deleteClients([keep]));
    expect(await rawPrisma.clientImportJob.findUnique({ where: { id: job.id } })).toMatchObject({ fileName: "history.csv", importedCount: 2 });
  });
});

describe("import parsing limits", () => {
  it("stops reading a sheet at the row limit instead of expanding all of it", async () => {
    const rows: unknown[][] = [["Name", "Phone"]];
    for (let i = 0; i < 3000; i++) rows.push([`Row ${i}`, `0171${String(i).padStart(7, "0")}`]);
    expect((await uploadFile(A, xlsx(rows))).error).toMatch(/more than 2,000 rows/);
  });

  it("refuses a small file that holds far more text than its size suggests, and a very wide sheet", async () => {
    const long = "a".repeat(900); // identical cells compress to almost nothing on disk
    const rows: unknown[][] = [["Name", "Notes", "Extra", "More"]];
    for (let i = 0; i < 1800; i++) rows.push([`N${i}`, long, long, long]);
    const file = xlsx(rows);
    expect(file.size).toBeLessThan(2 * 1024 * 1024);
    expect((await uploadFile(A, file)).error).toMatch(/too much text/);
    const wide: unknown[][] = [Array.from({ length: 300 }, (_, i) => `C${i}`), Array.from({ length: 300 }, (_, i) => `v${i}`)];
    expect((await uploadFile(A, xlsx(wide))).error).toMatch(/too many columns/);
  });

  it("a malformed .xlsx is a message, never an error page, and creates no job", async () => {
    const before = await rawPrisma.clientImportJob.count({ where: { projectId: A.id } });
    const r = await uploadFile(A, new File(["this is not a zip"], "broken.xlsx"));
    expect(r.error).toBeTruthy();
    expect(r.jobId).toBeUndefined();
    expect(await rawPrisma.clientImportJob.count({ where: { projectId: A.id } })).toBe(before);
  });
});

describe("the feature switch on direct access", () => {
  it("the export route, the import and every client action refuse in a project with Client Management off", async () => {
    current = admin;
    await expect(runWithProject(Off, () => exportRoute.GET(new NextRequest("https://assist.example.test/p/x/api/clients/export?format=csv")))).rejects.toThrow();
    await expect(runWithProject(Off, () => exportRoute.POST(new NextRequest("https://assist.example.test/p/x/api/clients/export", { method: "POST", body: JSON.stringify({ ids: ["x"] }) })))).rejects.toThrow();
    expect((await uploadFile(Off, new File(["Name\nA"], "a.csv"))).error).toBeTruthy();
    expect((await create(Off, { name: "Nope" })).error).toBeTruthy();
    expect((await as(Off, () => actions.archiveClients(["x"]))).ok).toBe(false);
    expect((await as(Off, () => actions.deleteClients(["x"]))).ok).toBe(false);
    expect(await rawPrisma.client.count({ where: { projectId: Off.id } })).toBe(0);
    expect(await rawPrisma.clientImportJob.count({ where: { projectId: Off.id } })).toBe(0);
  });
});

describe("the spreadsheet library and hostile files", () => {
  it("runs a SheetJS release that carries the fixes for GHSA-4r6h-8v6p-xvw6 (<0.19.3) and GHSA-5pgg-2g8v-p4x9 (<0.20.2)", () => {
    const [major, minor, patch] = (XLSX.version as string).split(".").map(Number) as [number, number, number];
    expect(major > 0 || minor > 20 || (minor === 20 && patch >= 2)).toBe(true);
  });

  it("refuses an upload over the size limit before it is parsed, and creates no job", async () => {
    const before = await rawPrisma.clientImportJob.count({ where: { projectId: A.id } });
    const big = new File(["Name\n" + "x".repeat(2 * 1024 * 1024 + 10)], "huge.csv");
    expect((await uploadFile(A, big)).error).toMatch(/limit is 2 MB/);
    expect(await rawPrisma.clientImportJob.count({ where: { projectId: A.id } })).toBe(before);
  });

  it("a truncated zip and a zip that is not a workbook are messages, never an error page", async () => {
    const good = xlsx([["Name"], ["A"]]);
    const bytes = new Uint8Array(await good.arrayBuffer());
    expect((await uploadFile(A, new File([bytes.slice(0, Math.floor(bytes.length / 2))], "cut.xlsx"))).jobId).toBeUndefined();
    const rubbish = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
    rubbish.set([0x50, 0x4b, 0x03, 0x04]); // starts like a zip, is not one
    const r = await uploadFile(A, new File([rubbish], "rubbish.xlsx"));
    expect(r.error).toBeTruthy();
    expect(r.jobId).toBeUndefined();
  });

  it("a header named __proto__ / constructor cannot reach Object.prototype and does not break the import", async () => {
    const csv = "Name,__proto__,constructor,Phone\nProto Client,polluted,polluted,01911000001";
    const r = await uploadFile(A, new File([csv], "proto.csv"));
    expect(r.jobId).toBeTruthy();
    const done = await as(A, () => importActions.confirmClientImport(r.jobId!, "SKIP"));
    expect(done.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: "Proto Client" } })).toBe(1);
  });

  it("a normal .xlsx and .csv with equivalent rows import to equivalent clients", async () => {
    const xlsxRows: unknown[][] = [["Name", "Phone", "Email"], ["Twin One", "01922000001", "t1@example.com"], ["Twin Two", "01922000002", "t2@example.com"]];
    const csvText = ["Name,Phone,Email", "Csv One,01933000001,c1@example.com", "Csv Two,01933000002,c2@example.com"].join("\n");
    const fromXlsx = await uploadFile(A, xlsx(xlsxRows));
    const fromCsv = await uploadFile(A, new File([csvText], "twin.csv"));
    expect((await as(A, () => importActions.confirmClientImport(fromXlsx.jobId!, "SKIP"))).message).toMatch(/Imported 2/);
    expect((await as(A, () => importActions.confirmClientImport(fromCsv.jobId!, "SKIP"))).message).toMatch(/Imported 2/);
    const shape = async (name: string) => (await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name }, include: { channels: true } })).channels.map((c) => c.kind).sort();
    expect(await shape("Twin One")).toEqual(["EMAIL", "PHONE"]);
    expect(await shape("Csv One")).toEqual(["EMAIL", "PHONE"]);
    expect((await rawPrisma.clientChannel.findFirstOrThrow({ where: { projectId: A.id, kind: "PHONE", normalizedValue: "8801922000001" } })).value).toBe("01922000001");
  });
});
