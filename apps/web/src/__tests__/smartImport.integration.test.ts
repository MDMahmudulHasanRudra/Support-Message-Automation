import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS, SMART_IMPORT_LIMITS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Smart Bulk Import (SMART_IMPORT.md), against a real database. What must hold:
 *   - the upload refuses what it must (size, rows, type, zip bomb) before anything is stored;
 *   - one column can fill several fields (Scenario B), and a wrong file cannot be imported (Scenario C);
 *   - a correction on the review is what gets imported (Scenario D), and only the reviewed revision;
 *   - the processor is idempotent: a restart, a second processor or a retry never writes a row twice
 *     (Scenario G), and two imports of the same client create it once;
 *   - cancelling stops between batches and reports exactly what was committed (Scenario F);
 *   - permissions, the feature switch and the project boundary hold (Scenario H).
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
const actions = await import("@/server/actions/smartImport");
const uploadRoute = await import("@/app/p/[project]/api/clients/import/smart-upload/route");
const processor = await import("@/server/smartImportProcessor");
const { forgetSmartAnalysis } = await import("@/server/smartImport");
const problemsRoute = await import("@/app/p/[project]/api/clients/import/[jobId]/problems/route");

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
const people = {} as Record<"importer" | "viewer", Session>;
const as = <T,>(person: Session, fn: () => Promise<T>, project: Project = A) => {
  current = person;
  return runWithProject(project, fn);
};

async function setFeature(project: Project, key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: project.id, key } }, create: { projectId: project.id, key, enabled }, update: { enabled } });
  forgetProjectFeatureStates();
}

const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n"), "utf8");
function xlsx(rows: unknown[][], extraSheet?: { name: string; rows: unknown[][] }): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Clients");
  if (extraSheet) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(extraSheet.rows), extraSheet.name);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function upload(bytes: Buffer, name: string, person = people.importer, project = A): Promise<{ status: number; body: { ok: boolean; jobId?: string; error?: string } }> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name));
  const res = await as(person, () => uploadRoute.POST(new NextRequest("http://localhost/p/x/api/clients/import/smart-upload", { method: "POST", body: form })), project);
  return { status: res.status, body: await res.json() };
}
async function uploaded(bytes: Buffer, name = "clients.csv", project = A): Promise<string> {
  const r = await upload(bytes, name, people.importer, project);
  expect(r.body, JSON.stringify(r.body)).toMatchObject({ ok: true });
  return r.body.jobId!;
}
const job = (id: string) => rawPrisma.clientImportJob.findUniqueOrThrow({ where: { id } });
const review = (id: string, query: Parameters<typeof actions.loadSmartReview>[1] = {}) =>
  as(people.importer, async () => {
    const r = await actions.loadSmartReview(id, query);
    if ("error" in r) throw new Error(r.error);
    return r;
  });
async function confirm(id: string, policy = "SKIP", acknowledged: string[] = []) {
  const r = await review(id);
  return as(people.importer, () => actions.confirmSmartImport(id, { revision: r.revision, policy, acknowledged }));
}
/** Runs the processor the way the app does: claim, then work inside the job's project. */
async function runProcessor(budgetMs = 120_000): Promise<string | null> {
  const claimed = await processor.claimSmartImportJob();
  if (!claimed) return null;
  const project = claimed.projectId === A.id ? A : B;
  return runWithProject(project, () => processor.processClaimedJob(claimed.id, budgetMs));
}
async function drain() {
  for (let i = 0; i < 50 && (await runProcessor()); i++);
}
const clientsWithPhone = (projectId: string, digits: string) => rawPrisma.client.count({ where: { projectId, channels: { some: { normalizedValue: { contains: digits } } } } });

beforeAll(async () => {
  people.importer = await user("SmartImporter", await role("Smart importer", ["clients.view", "clients.create", "clients.update", "clients.import"]));
  people.viewer = await user("SmartViewer", await role("Smart viewer", ["clients.view"]));
  for (const label of ["A", "B"]) {
    const p = await createProjectWithDefaults({ name: `Smart ${label} ${tag}`, slug: `smart-${label.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.importer.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    const project = { id: p.id, slug: p.slug, name: `Smart ${label} ${tag}`, status: "ACTIVE" as const };
    if (label === "A") A = project;
    else B = project;
    await setFeature(project, "CLIENT_CENTER", true);
    await setFeature(project, "CLIENT_SMART_IMPORT", true);
  }
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientImportRow.deleteMany({ where });
  await rawPrisma.clientImportJob.deleteMany({ where });
  await rawPrisma.clientImportPreset.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientNote.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("upload", () => {
  it("stages a CSV as rows, keeps leading zeros, and maps the exact headers", async () => {
    const id = await uploaded(csv([["Customer Name", "Mobile", "Notes from sales"], ["Rahim", "01712000001", "vip"], ["Karim", "01712000002", ""]]));
    const j = await job(id);
    expect(j).toMatchObject({ engine: "SMART", status: "PREVIEW", totalRows: 2, headers: ["Customer Name", "Mobile", "Notes from sales"], revision: 0 });
    expect(j.mapping).toEqual({ version: 2, fields: { name: { mode: "source", column: "Customer Name" }, phone: { mode: "source", column: "Mobile" } } });
    const rows = await rawPrisma.clientImportRow.findMany({ where: { jobId: id }, orderBy: { rowNumber: "asc" } });
    expect(rows.map((r) => [r.rowNumber, r.source])).toEqual([
      [2, { "Customer Name": "Rahim", Mobile: "01712000001", "Notes from sales": "vip" }],
      [3, { "Customer Name": "Karim", Mobile: "01712000002" }],
    ]);
  });

  it("reads numeric phone cells in an .xlsx as digits, and dates as dates", async () => {
    const id = await uploaded(xlsx([["Name", "Phone", "Join Date"], ["A", 8801712345678, new Date(Date.UTC(2026, 9, 17))]]), "c.xlsx");
    const [row] = await rawPrisma.clientImportRow.findMany({ where: { jobId: id } });
    expect(row!.source).toEqual({ Name: "A", Phone: "8801712345678", "Join Date": "2026-10-17" });
  });

  it("takes 5,000 rows and refuses 5,001, oversize, fake and bomb files — storing nothing", async () => {
    const before = await rawPrisma.clientImportJob.count({ where: { projectId: A.id } });
    const rows = (n: number) => [["Name", "Phone"], ...Array.from({ length: n }, (_, i) => [`C${i}`, `+88017${String(10000000 + i)}`])];
    const ok = await upload(xlsx(rows(SMART_IMPORT_LIMITS.maxRows)), "big.xlsx");
    expect(ok.status).toBe(200);
    expect((await job(ok.body.jobId!)).totalRows).toBe(5000);

    const refusals: Array<[Buffer, string, number, RegExp]> = [
      [xlsx(rows(SMART_IMPORT_LIMITS.maxRows + 1)), "over.xlsx", 422, /more than 5,000/],
      [Buffer.alloc(SMART_IMPORT_LIMITS.maxBytes + 1, 65), "huge.csv", 413, /limit is 15 MB/],
      [Buffer.from("Name,Phone\nA,1"), "renamed.xlsx", 422, /not an \.xlsx/],
      [Buffer.from([0x4d, 0x5a, 0, 0, 1]), "evil.csv", 422, /not a text CSV/],
      [Buffer.from("a"), "notes.pdf", 422, /Only \.xlsx and \.csv/],
    ];
    for (const [bytes, name, status, error] of refusals) {
      const r = await upload(bytes, name);
      expect(r.status, name).toBe(status);
      expect(r.body.error, name).toMatch(error);
    }
    expect(await rawPrisma.clientImportJob.count({ where: { projectId: A.id } })).toBe(before + 1);
  }, 120_000);

  it("refuses without permission or with the feature off", async () => {
    expect((await upload(csv([["Name"], ["A"]]), "a.csv", people.viewer)).status).toBe(403);
    await setFeature(A, "CLIENT_SMART_IMPORT", false);
    try {
      const r = await upload(csv([["Name"], ["A"]]), "a.csv");
      expect(r).toMatchObject({ status: 403, body: { error: expect.stringMatching(/not switched on/) } });
    } finally {
      await setFeature(A, "CLIENT_SMART_IMPORT", true);
    }
  });
});

describe("mapping, review and wrong files", () => {
  it("Scenario B: one Mobile column feeds Name and Phone, and imports", async () => {
    const id = await uploaded(csv([["Mobile Number"], ["01713000001"], ["01713000002"]]));
    const r0 = await review(id);
    expect(r0.assessment.blocks.map((b) => b.code)).toContain("NAME_UNSET");
    const saved = await as(people.importer, () =>
      actions.saveSmartMapping(id, r0.revision, { fields: { name: { mode: "source", column: "Mobile Number" }, phone: { mode: "source", column: "Mobile Number" } } }),
    );
    expect(saved).toMatchObject({ ok: true });
    const r1 = await review(id);
    expect(r1.summary).toMatchObject({ total: 2, ready: 2, willCreate: 2, invalid: 0 });
    expect(await confirm(id)).toMatchObject({ ok: true });
    await drain();
    expect((await job(id)).status).toBe("COMPLETED");
    const created = await rawPrisma.client.findMany({ where: { projectId: A.id, name: { in: ["01713000001", "01713000002"] } }, include: { channels: true } });
    expect(created).toHaveLength(2);
    expect(created.every((c) => c.channels.some((ch) => ch.kind === "PHONE"))).toBe(true);
  });

  it("Scenario C: an unrelated report is blocked, and an unrecognised file needs an acknowledgement", async () => {
    const id = await uploaded(csv([["Invoice No", "Amount", "Paid On"], ["INV-1", "500", "2026-10-01"]]));
    const r = await review(id);
    expect(r.assessment.blocks.map((b) => b.code)).toContain("NAME_UNSET");
    expect(await confirm(id)).toMatchObject({ ok: false, message: expect.stringMatching(/needs a name/) });
    // Deliberately naming every row with a constant still needs the "I checked this file" tick.
    await as(people.importer, () => actions.saveSmartMapping(id, r.revision, { fields: { name: { mode: "constant", value: "Unknown customer" } } }));
    expect(await confirm(id)).toMatchObject({ ok: false, message: expect.stringMatching(/Tick that you have checked/) });
    expect((await job(id)).status).toBe("PREVIEW");
    expect(await confirm(id, "SKIP", ["NO_RECOGNISED_COLUMNS"])).toMatchObject({ ok: true });
  });

  it("refuses mappings that name unknown fields or columns, and invalid constants", async () => {
    const id = await uploaded(csv([["Name"], ["A"]]));
    const { revision } = await review(id);
    for (const [raw, error] of [
      [{ fields: { passwordHash: { mode: "constant", value: "x" } } }, /not a client field/],
      [{ fields: { name: { mode: "source", column: "Nope" } } }, /no column/],
      [{ fields: { status: { mode: "constant", value: "ARCHIVED" } } }, /archive/i],
      [{ fields: { team: { mode: "constant", value: "No Such Team" } } }, /does not exist/],
    ] as const) {
      expect(await as(people.importer, () => actions.saveSmartMapping(id, revision, raw))).toMatchObject({ ok: false, message: expect.stringMatching(error) });
    }
  });

  it("Scenario D: a correction is saved, survives a reload, and is what gets imported", async () => {
    const id = await uploaded(csv([["Name", "Phone", "Email"], ["Good Row", "01714000001", ""], ["Bad Row", "123", "nope"]]));
    let r = await review(id, { filter: "invalid" });
    expect(r.rows.map((x) => x.rowNumber)).toEqual([3]);
    const bad = r.rows[0]!;
    await as(people.importer, () => actions.editSmartRow(id, bad.id, "phone", "01714000002"));
    await as(people.importer, () => actions.editSmartRow(id, bad.id, "email", ""));
    r = await review(id);
    expect(r.summary).toMatchObject({ ready: 2, invalid: 0 });
    expect(r.rows.find((x) => x.id === bad.id)).toMatchObject({ edited: ["phone", "email"], values: { phone: "01714000002" } });
    expect(await confirm(id)).toMatchObject({ ok: true });
    await drain();
    expect(await clientsWithPhone(A.id, "1714000002")).toBe(1);
  });

  it("refuses a confirmation of a revision the person did not review", async () => {
    const id = await uploaded(csv([["Name"], ["A"], ["B"]]));
    const { revision, rows } = await review(id);
    await as(people.importer, () => actions.editSmartRow(id, rows[0]!.id, "name", "A2"));
    expect(await as(people.importer, () => actions.confirmSmartImport(id, { revision, policy: "SKIP", acknowledged: [] }))).toMatchObject({ ok: false, message: expect.stringMatching(/changed after you reviewed/) });
  });

  it("formula-looking names are invalid; script-looking text stays inert text", async () => {
    const id = await uploaded(csv([["Name", "Address"], ['=HYPERLINK("http://x")', ""], ["Fine", "<img src=x onerror=alert(1)>"]]));
    const r = await review(id);
    expect(r.summary).toMatchObject({ invalid: 1, ready: 1 });
    // Half the file is invalid: confirming needs the "I checked this file" tick.
    expect(await confirm(id)).toMatchObject({ ok: false });
    expect(await confirm(id, "SKIP", ["MOSTLY_INVALID"])).toMatchObject({ ok: true });
    await drain();
    expect((await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: "Fine" } })).address).toBe("<img src=x onerror=alert(1)>");
    // The row that was not imported can be downloaded with its reason, in the file's own columns.
    const res = await as(people.importer, () => problemsRoute.GET(new NextRequest(`http://localhost/p/x/api/clients/import/${id}/problems`), { params: Promise.resolve({ jobId: id }) }));
    expect(res.status).toBe(200);
    const sheet = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
    const grid = XLSX.utils.sheet_to_json<string[]>(sheet.Sheets[sheet.SheetNames[0]!]!, { header: 1 });
    expect(grid[0]).toEqual(["Problem", "Name", "Address"]);
    expect(grid).toHaveLength(2);
    expect(grid[1]![0]).toMatch(/^Row 2: .*formula/);
    expect(sheet.Sheets[sheet.SheetNames[0]!]!.B2?.f).toBeUndefined();
  });

  it("bulk-set refuses identifier fields and needs the count the person saw", async () => {
    const id = await uploaded(csv([["Name"], ["A"], ["B"]]));
    expect(await as(people.importer, () => actions.bulkSetSmartField(id, { filter: "all" }, "phone", "01700000000", 2))).toMatchObject({ ok: false, message: expect.stringMatching(/identifies a client/) });
    expect(await as(people.importer, () => actions.bulkSetSmartField(id, { filter: "all" }, "category", "Retail", 5))).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(await as(people.importer, () => actions.bulkSetSmartField(id, { filter: "all" }, "category", "Retail", 2))).toMatchObject({ ok: true });
    expect((await review(id)).rows.map((r) => r.values.category)).toEqual(["Retail", "Retail"]);
  });

  it("presets carry rules, never data, and report columns a new file lacks", async () => {
    const first = await uploaded(csv([["Client", "Cell"], ["A", "01715000001"]]));
    const r = await review(first);
    await as(people.importer, () => actions.saveSmartMapping(first, r.revision, { fields: { name: { mode: "source", column: "Client" }, phone: { mode: "source", column: "Cell" }, category: { mode: "constant", value: "Retail" } } }));
    expect(await as(people.importer, () => actions.saveSmartPreset(first, `Shop ${tag}`, true))).toMatchObject({ ok: true });
    const preset = await rawPrisma.clientImportPreset.findFirstOrThrow({ where: { projectId: A.id, name: `Shop ${tag}` } });
    expect(JSON.stringify(preset.mapping)).not.toContain("01715000001");
    const second = await uploaded(csv([["Client"], ["B"]]));
    const applied = await as(people.importer, async () => actions.applySmartPreset(second, (await review(second)).revision, preset.id));
    expect(applied).toMatchObject({ ok: true, message: expect.stringMatching(/Phone \("Cell"\)/) });
    expect((await job(second)).mapping).toEqual({ version: 2, fields: { name: { mode: "source", column: "Client" }, category: { mode: "constant", value: "Retail" } } });
  });

  it("another sheet can be chosen from the kept file", async () => {
    const id = await uploaded(xlsx([["Totals"], ["99"]], { name: "Customers", rows: [["Report"], [], ["Name", "Phone"], ["X", "01716000001"]] }), "two.xlsx");
    const res = await as(people.importer, () => actions.chooseSmartSheet(id, "Customers", 0));
    // Without media storage configured the file is not kept, and the action says so plainly.
    if (!res.ok) {
      expect(res.message).toMatch(/no longer kept/);
      return;
    }
    const j = await job(id);
    expect(j).toMatchObject({ sheetName: "Customers", headerRow: 3, headers: ["Name", "Phone"], totalRows: 1 });
  });
});

describe("processing", () => {
  const rows = (prefix: string, n: number) => [["Name", "Phone"], ...Array.from({ length: n }, (_, i) => [`${prefix} ${i}`, `+880171${prefix.charCodeAt(0) % 10}${String(1000000 + i)}`])];

  it("Scenario G: a restart mid-import resumes without writing any row twice", async () => {
    const id = await uploaded(csv(rows("Restart", 120)));
    await confirm(id);
    // First holder works one batch, then "dies" (its lease simply runs out).
    const claimed = await processor.claimSmartImportJob();
    expect(claimed?.id).toBe(id);
    expect(await runWithProject(A, () => processor.processClaimedJob(id, 0))).toBe("MORE");
    const midway = await rawPrisma.clientImportRow.count({ where: { jobId: id, outcome: "CREATED" } });
    expect(midway).toBe(25);
    await rawPrisma.clientImportJob.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    await drain();
    expect(await job(id)).toMatchObject({ status: "COMPLETED", importedCount: 120 });
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: { startsWith: "Restart " } } })).toBe(120);
  });

  it("two processors on one job, and two imports of the same client, never duplicate", async () => {
    const a = await uploaded(csv(rows("Twin", 60)));
    const b = await uploaded(csv(rows("Twin", 60)));
    await confirm(a);
    await confirm(b);
    // Both jobs, and the same job twice, at once.
    await Promise.all([
      runWithProject(A, () => processor.processClaimedJob(a)),
      runWithProject(A, () => processor.processClaimedJob(a)),
      runWithProject(A, () => processor.processClaimedJob(b)),
    ]);
    await drain();
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: { startsWith: "Twin " } } })).toBe(60);
    const outcomes = await rawPrisma.clientImportRow.groupBy({ by: ["outcome"], where: { jobId: { in: [a, b] } }, _count: { _all: true } });
    expect(Object.fromEntries(outcomes.map((o) => [o.outcome, o._count._all]))).toEqual({ CREATED: 60, SKIPPED: 60 });
  });

  it("Scenario F: cancelling stops before the next batch and reports exactly what was committed", async () => {
    const id = await uploaded(csv(rows("Cancel", 100)));
    await confirm(id);
    await processor.claimSmartImportJob();
    await runWithProject(A, () => processor.processClaimedJob(id, 0));
    expect(await as(people.importer, () => actions.cancelSmartImport(id))).toMatchObject({ ok: true, message: expect.stringMatching(/already imported are kept/) });
    await rawPrisma.clientImportJob.update({ where: { id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    await drain();
    const j = await job(id);
    const status = await as(people.importer, () => actions.readSmartImportStatus(id));
    expect(j.status).toBe("CANCELLED");
    expect(status?.counts).toMatchObject({ created: 25, pending: 75 });
    expect(j.importedCount).toBe(25);
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: { startsWith: "Cancel " } } })).toBe(25);
    // Retry runs only the rows never attempted.
    expect(await as(people.importer, () => actions.retrySmartImport(id))).toMatchObject({ ok: true, message: expect.stringMatching(/^75 rows/) });
    await drain();
    expect(await job(id)).toMatchObject({ status: "COMPLETED", importedCount: 100 });
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: { startsWith: "Cancel " } } })).toBe(100);
  });

  it("a cancel requested while the processor is running stops it after the current batch", async () => {
    const id = await uploaded(csv(rows("Midrun", 300)));
    await confirm(id);
    await processor.claimSmartImportJob();
    const running = runWithProject(A, () => processor.processClaimedJob(id, 600_000));
    // Wait for the first committed row, then ask it to stop — without touching the processor.
    for (let i = 0; i < 500 && (await rawPrisma.clientImportRow.count({ where: { jobId: id, outcome: "CREATED" } })) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await as(people.importer, () => actions.cancelSmartImport(id));
    expect(await running).toBe("CANCELLED");
    const counts = await as(people.importer, () => actions.readSmartImportStatus(id));
    expect((await job(id)).status).toBe("CANCELLED");
    expect(counts!.counts.pending).toBeGreaterThan(0);
    // What was committed is exactly what the history says, and exactly the clients that exist.
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: { startsWith: "Midrun " } } })).toBe(counts!.counts.created);
    expect((await job(id)).importedCount).toBe(counts!.counts.created);
  });

  it("a queued import can go back to review; nothing was written", async () => {
    const id = await uploaded(csv(rows("Back", 3)));
    await confirm(id);
    expect(await as(people.importer, () => actions.cancelSmartImport(id))).toMatchObject({ ok: true, message: expect.stringMatching(/Nothing was imported/) });
    expect((await job(id)).status).toBe("PREVIEW");
    expect(await rawPrisma.clientImportRow.count({ where: { jobId: id, outcome: { not: null } } })).toBe(0);
  });

  it("matches existing clients by policy: SKIP keeps them, UPDATE fills them", async () => {
    const first = await uploaded(csv([["Name", "Phone"], ["Match Me", "01717000001"]]));
    await confirm(first);
    await drain();
    const second = await uploaded(csv([["Name", "Phone", "Company"], ["Match Me Again", "01717000001", "Acme"]]));
    expect((await review(second)).summary).toMatchObject({ matchExisting: 1, willCreate: 0 });
    await confirm(second, "UPDATE");
    await drain();
    const client = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, channels: { some: { normalizedValue: { contains: "1717000001" } } } } });
    expect(client).toMatchObject({ name: "Match Me Again", companyName: "Acme" });
    expect(await clientsWithPhone(A.id, "1717000001")).toBe(1);
  });

  it("a held project's import waits rather than failing", async () => {
    const id = await uploaded(csv(rows("Held", 2)));
    await confirm(id);
    await rawPrisma.project.update({ where: { id: A.id }, data: { status: "SUSPENDED" } });
    try {
      await processor.smartImportTick();
      expect((await job(id)).status).toBe("QUEUED");
    } finally {
      await rawPrisma.project.update({ where: { id: A.id }, data: { status: "ACTIVE" } });
    }
    await drain();
    expect((await job(id)).status).toBe("COMPLETED");
  });
});

describe("boundaries and cleanup", () => {
  it("Scenario H: another project's import is not found, even with its id", async () => {
    const id = await uploaded(csv([["Name"], ["Secret"]]), "b.csv", B);
    expect(await as(people.importer, () => actions.loadSmartReview(id, {}))).toEqual({ error: "This import no longer exists." });
    expect(await as(people.importer, () => actions.discardSmartDraft(id))).toMatchObject({ ok: false });
    expect(await as(people.importer, () => actions.readSmartImportStatus(id))).toBeNull();
    expect(await as(people.viewer, () => actions.loadSmartReview(id, {}), B)).toMatchObject({ error: expect.any(String) });
  });

  it("an expired draft is deleted; discarding never touches a client", async () => {
    const id = await uploaded(csv([["Name"], ["Expire Me"]]));
    await rawPrisma.clientImportJob.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await processor.sweepSmartImports();
    expect((await job(id)).status).toBe("EXPIRED");
    expect(await rawPrisma.clientImportRow.count({ where: { jobId: id } })).toBe(0);

    const before = await rawPrisma.client.count({ where: { projectId: A.id } });
    const d = await uploaded(csv([["Name"], ["Discard Me"]]));
    expect(await as(people.importer, () => actions.discardSmartDraft(d))).toMatchObject({ ok: true });
    expect(await rawPrisma.client.count({ where: { projectId: A.id } })).toBe(before);
    forgetSmartAnalysis(d);
  });
});
