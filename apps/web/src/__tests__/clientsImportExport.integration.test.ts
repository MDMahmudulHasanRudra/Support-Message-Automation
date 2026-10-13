import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Client Management, Phase 3: import and export (CLIENT_CENTER.md).
 *
 * What must hold:
 *   - nothing is created until the import is confirmed, and the confirmation is claimed once however
 *     many times it is pressed;
 *   - a bad row is reported and the rest are imported; a row matching an existing client follows the
 *     chosen policy (skip, update, or create anyway) and never merges anything;
 *   - the file's rows are deleted when the import ends, and one project's import cannot see, match or
 *     change another project's clients;
 *   - every step needs `clients.import`; the export needs `clients.export`, follows the list's filters,
 *     is capped, is formula-safe and is recorded without the clients in the log.
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
const importActions = await import("@/server/actions/clientImport");
const clientActions = await import("@/server/actions/clients");
const exportRoute = await import("@/app/p/[project]/api/clients/export/route");

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
const people = {} as Record<"admin" | "importer" | "exporter" | "viewer", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const csvFile = (text: string, name = "clients.csv") => new File([text], name, { type: "text/csv" });
const upload = (person: Session, project: Project, file: File) => {
  const f = new FormData();
  f.set("file", file);
  return as(person, project, () => importActions.previewClientImport({}, f));
};
const job = (id: string) => rawPrisma.clientImportJob.findUniqueOrThrow({ where: { id } });
const url = (q = "") => `https://assist.example.test/p/x/api/clients/export${q}`;

beforeAll(async () => {
  people.admin = await user("Admin", await role("CI admin", ["clients.view", "clients.create", "clients.update", "clients.archive", "clients.delete", "clients.import", "clients.export", "messages.view"]));
  people.importer = await user("Importer", await role("CI importer", ["clients.view", "clients.import", "messages.view"]));
  people.exporter = await user("Exporter", await role("CI exporter", ["clients.view", "clients.export", "messages.view"]));
  people.viewer = await user("Viewer", await role("CI viewer", ["clients.view", "messages.view"]));
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("ImpA");
  B = await make("ImpB");
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

const HEADER = "Client Name,Mobile,Email,Tags,Package,Status";

describe("1. upload and preview", () => {
  it("refuses without clients.import, and refuses files that are not .csv / .xlsx, empty, or too long", async () => {
    expect((await upload(people.viewer, A, csvFile(`${HEADER}\nA,01711111111,,,,`))).error).toMatch(/permission/i);
    expect((await upload(people.admin, A, new File(["x"], "x.pdf"))).error).toMatch(/Only \.csv and \.xlsx/);
    expect((await upload(people.admin, A, csvFile(""))).error).toMatch(/Choose a/);
    expect((await upload(people.admin, A, csvFile(HEADER))).error).toMatch(/at least one client row/);
    const tooMany = `${HEADER}\n${Array.from({ length: 2001 }, (_, i) => `C${i},0171${String(i).padStart(7, "0")},,,,`).join("\n")}`;
    expect((await upload(people.admin, A, csvFile(tooMany))).error).toMatch(/at most 2,000/);
    expect(await rawPrisma.clientImportJob.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("creates only a preview job: nothing is imported, the columns are mapped from the headers", async () => {
    const r = await upload(people.importer, A, csvFile(`${HEADER}\nRahim,01711111111; +8801822222222,r@x.com,"VIP, Dhaka",Gold,Active\n,01733333333,,,,\nKarim,not-a-phone,,,,`));
    expect(r.jobId).toBeTruthy();
    const j = await job(r.jobId!);
    expect(j).toMatchObject({ status: "PREVIEW", totalRows: 3, importedCount: 0 });
    expect(j.mapping).toMatchObject({ name: "Client Name", phone: "Mobile", email: "Email", tags: "Tags", category: "Package", status: "Status" });
    expect(await rawPrisma.client.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("recomputes the preview for a changed mapping, and refuses a column the file does not have", async () => {
    const r = await upload(people.admin, A, csvFile("Who,Number\nZed,01944444444"));
    const id = r.jobId!;
    expect((await as(people.admin, A, () => importActions.remapClientImport(id, { name: "Who", phone: "Number" }))).ok).toBe(true);
    expect((await job(id)).mapping).toMatchObject({ name: "Who", phone: "Number" });
    expect((await as(people.admin, A, () => importActions.remapClientImport(id, { name: "Nope" }))).message).toMatch(/no column called/);
    expect((await as(people.admin, A, () => importActions.remapClientImport(id, { name: "Who", phone: "Who" }))).message).toMatch(/two fields/);
    expect((await as(people.viewer, A, () => importActions.remapClientImport(id, { name: "Who" }))).ok).toBe(false);
  });

  it("reads an .xlsx file", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([["Name", "Phone"], ["Excel Client", "01955555555"]]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const r = await upload(people.admin, A, new File([new Uint8Array(buffer)], "c.xlsx"));
    expect(await job(r.jobId!)).toMatchObject({ fileType: "xlsx", totalRows: 1 });
  });
});

describe("2. confirm: policies, partial failure, once only, privacy", () => {
  it("imports the good rows, reports the bad ones, deletes the file's rows, and writes a log without the clients", async () => {
    const r = await upload(people.importer, A, csvFile(`${HEADER}\nRahim Import,01711111111; +8801822222222,r@x.com,"VIP, Dhaka",Gold,Pending\n,01733333333,,,,\nKarim Bad,not-a-phone,,,,\nSultana,01866666666,,,,`, "march.csv"));
    const done = await as(people.importer, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"));
    expect(done).toMatchObject({ ok: true });
    const j = await job(r.jobId!);
    expect(j).toMatchObject({ status: "PARTIAL", importedCount: 2, failedCount: 2, skippedCount: 0 });
    expect(j.rows).toEqual([]);
    expect((j.errors as Array<{ rowNumber: number }>).map((e) => e.rowNumber).sort()).toEqual([3, 4]);

    const rahim = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: "Rahim Import" }, include: { channels: true, activities: true } });
    expect(rahim).toMatchObject({ status: "PENDING", source: "IMPORT", sourceDetail: "march.csv", tags: ["vip", "dhaka"], category: "Gold" });
    expect(rahim.channels.map((c) => `${c.kind}:${c.normalizedValue}:${c.consentStatus}`).sort()).toEqual(["EMAIL:r@x.com:UNKNOWN", "PHONE:8801711111111:UNKNOWN", "PHONE:8801822222222:UNKNOWN"]);
    expect(rahim.activities.map((a) => a.type)).toEqual(["IMPORTED"]);

    const log = await rawPrisma.systemLog.findFirst({ where: { projectId: A.id, scope: "clients", message: { startsWith: "Client import finished" } }, orderBy: { createdAt: "desc" } });
    expect(log?.message).toMatch(/2 created, 0 updated, 0 skipped, 2 failed/);
    expect(JSON.stringify(log?.metadata)).not.toMatch(/Rahim|8801711111111|r@x\.com/);
  });

  it("claims the confirmation once: a second press, or a second tab, imports nothing more", async () => {
    const r = await upload(people.admin, A, csvFile(`${HEADER}\nOnce Only,01777000001,,,,`));
    const [first, second] = await Promise.all([
      as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP")),
      as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP")),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: "Once Only" } })).toBe(1);
    expect((await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"))).message).toMatch(/already been started/);
  });

  it("SKIP leaves a matching client alone and says why; the in-file repeat is skipped too", async () => {
    const original = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: "Rahim Import" } });
    const r = await upload(people.admin, A, csvFile(`${HEADER}\nRahim Changed,01711111111,,,Platinum,\nBrand New,01888000002,,,,\nBrand New Again,+8801888000002,,,,`));
    await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"));
    const j = await job(r.jobId!);
    expect(j).toMatchObject({ status: "COMPLETED", importedCount: 1, skippedCount: 2, failedCount: 0 });
    expect(await rawPrisma.client.findUniqueOrThrow({ where: { id: original.id } })).toMatchObject({ name: "Rahim Import", category: "Gold" });
    expect(JSON.stringify(j.errors)).toMatch(/matches a client you already have/);
    expect(JSON.stringify(j.errors)).toMatch(/repeats row 3/);
  });

  it("UPDATE fills in the match without resetting its status, adding only new channels and tags", async () => {
    const r = await upload(people.admin, A, csvFile("Client Name,Mobile,Email,Tags,Package\nRahim Updated,01711111111,extra@x.com,corporate,Platinum"));
    await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "UPDATE"));
    const c = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, channels: { some: { normalizedValue: "8801711111111" } } }, include: { channels: true, activities: true } });
    expect(c).toMatchObject({ name: "Rahim Updated", category: "Platinum", status: "PENDING" }); // the file gave no status: it stays PENDING
    expect(c.tags.sort()).toEqual(["corporate", "dhaka", "vip"]);
    expect(c.channels.map((ch) => ch.normalizedValue).sort()).toEqual(["8801711111111", "8801822222222", "extra@x.com", "r@x.com"].sort());
    expect(c.activities.map((a) => a.type)).toContain("IMPORT_UPDATED");
    expect((await job(r.jobId!))).toMatchObject({ updatedCount: 1, importedCount: 0 });
  });

  it("does not update an archived match, and CREATE makes a second client only when asked", async () => {
    const c = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: "Sultana" } });
    await as(people.admin, A, () => clientActions.archiveClients([c.id]));
    const r1 = await upload(people.admin, A, csvFile("Name,Phone\nSultana New,01866666666"));
    await as(people.admin, A, () => importActions.confirmClientImport(r1.jobId!, "UPDATE"));
    expect(await job(r1.jobId!)).toMatchObject({ skippedCount: 1, updatedCount: 0 });
    expect(JSON.stringify((await job(r1.jobId!)).errors)).toMatch(/archived/);
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: c.id } })).name).toBe("Sultana");

    const r2 = await upload(people.admin, A, csvFile("Name,Phone\nSultana Twin,01866666666"));
    await as(people.admin, A, () => importActions.confirmClientImport(r2.jobId!, "CREATE"));
    expect(await rawPrisma.client.count({ where: { projectId: A.id, channels: { some: { normalizedValue: "8801866666666" } } } })).toBe(2);
  });

  it("refuses an unknown policy, a missing Name mapping, and cancels a preview without importing", async () => {
    const r = await upload(people.admin, A, csvFile("Mystery,Phone\nX,01999000001"));
    expect((await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "MERGE"))).message).toMatch(/Choose what to do/);
    expect((await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"))).message).toMatch(/Map a column to Name/);
    expect((await job(r.jobId!)).status).toBe("PREVIEW"); // released again, not stuck
    expect((await as(people.admin, A, () => importActions.cancelClientImport(r.jobId!))).ok).toBe(true);
    expect(await job(r.jobId!)).toMatchObject({ status: "CANCELLED", rows: [] });
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: "X" } })).toBe(0);
  });

  it("only closes an import that has really been running a long time", async () => {
    const r = await upload(people.admin, A, csvFile("Name\nStuck"));
    await rawPrisma.clientImportJob.update({ where: { id: r.jobId! }, data: { status: "PROCESSING", startedAt: new Date() } });
    expect((await as(people.admin, A, () => importActions.abandonClientImport(r.jobId!))).ok).toBe(false);
    await rawPrisma.clientImportJob.update({ where: { id: r.jobId! }, data: { startedAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await as(people.admin, A, () => importActions.abandonClientImport(r.jobId!))).ok).toBe(true);
    expect(await job(r.jobId!)).toMatchObject({ status: "FAILED", rows: [] });
  });
});

describe("3. import and project isolation", () => {
  it("never matches, updates or shows another project's clients", async () => {
    const mine = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: "Rahim Updated" } });
    const r = await upload(people.admin, B, csvFile("Name,Phone\nB Copy Of Rahim,01711111111"));
    await as(people.admin, B, () => importActions.confirmClientImport(r.jobId!, "UPDATE"));
    expect(await job(r.jobId!)).toMatchObject({ importedCount: 1, updatedCount: 0, skippedCount: 0 }); // created in B, not matched to A's
    expect((await rawPrisma.client.findUniqueOrThrow({ where: { id: mine.id } })).name).toBe("Rahim Updated");
    // A's job is not reachable from B
    const jobA = await rawPrisma.clientImportJob.findFirstOrThrow({ where: { projectId: A.id } });
    expect((await as(people.admin, B, () => importActions.confirmClientImport(jobA.id, "SKIP"))).ok).toBe(false);
    expect((await as(people.admin, B, () => importActions.cancelClientImport(jobA.id))).ok).toBe(false);
  });
});

describe("4. export", () => {
  it("needs clients.export (a viewer or an importer cannot take the list away)", async () => {
    for (const person of [people.viewer, people.importer]) {
      current = person;
      await expect(runWithProject(A, () => exportRoute.GET(new NextRequest(url("?format=csv"))))).rejects.toThrow();
    }
  });

  it("exports what the list shows: the same filters, formula-safe, with a log entry that holds no client", async () => {
    await as(people.admin, A, () => clientActions.createClient({}, form({ name: "=HYPERLINK(\"http://x\")", tags: "exportme", phone: "+8801700123456" })));
    await as(people.admin, A, () => clientActions.createClient({}, form({ name: "Plain Export", tags: "exportme", email: "Plain@Example.com" })));
    await as(people.admin, A, () => clientActions.createClient({}, form({ name: "Not Exported", tags: "other" })));
    current = people.exporter;
    const res = await runWithProject(A, () => exportRoute.GET(new NextRequest(url("?format=csv&tag=exportme"))));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const body = await res.text();
    expect(body).toContain("Client code,Name,Company,Status");
    expect(body).toContain("Plain Export");
    expect(body).not.toContain("Not Exported");
    expect(body).toContain("'=HYPERLINK"); // a formula in a name is turned into text
    expect(body).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(body).toContain("8801700123456"); // digits, no leading plus
    expect(body).toContain("Plain@Example.com"); // an email is exported as it was typed
    const log = await rawPrisma.systemLog.findFirst({ where: { projectId: A.id, scope: "clients", message: { startsWith: "Exported" } }, orderBy: { createdAt: "desc" } });
    expect(log?.message).toMatch(/Exported 2 client\(s\) as csv/);
    expect(JSON.stringify(log?.metadata)).not.toMatch(/Plain|8801700123456/);
  });

  it("writes a real .xlsx, exports a chosen selection by POST, and refuses another project's ids and an empty selection", async () => {
    const mine = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: "Plain Export" } });
    const theirs = await rawPrisma.client.findFirstOrThrow({ where: { projectId: B.id } });
    current = people.exporter;
    const post = (body: unknown) => runWithProject(A, () => exportRoute.POST(new NextRequest(url(), { method: "POST", body: JSON.stringify(body) })));
    const res = await post({ ids: [mine.id, theirs.id], format: "xlsx" });
    expect(res.status).toBe(200);
    const book = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets.Clients!);
    expect(rows.map((r) => r.Name)).toEqual(["Plain Export"]); // B's client is simply not found in A
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: Array.from({ length: 5001 }, (_, i) => `id${i}`) })).status).toBe(400);
  });

  it("follows the status filter: archived clients are excluded by default and included on request", async () => {
    const sultana = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: "Sultana", status: "ARCHIVED" } });
    current = people.exporter;
    const get = async (q: string) => (await runWithProject(A, () => exportRoute.GET(new NextRequest(url(`?format=csv${q}`))))).text();
    expect(await get("")).not.toContain(sultana.code);
    expect(await get("&status=ARCHIVED")).toContain(sultana.code);
    expect(await get("&status=ALL")).toContain(sultana.code);
  });
});
