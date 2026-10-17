import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { autoMapColumns, PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Import history clearing, the template's live checks, the Note column and "Download problem rows"
 * (CLIENTS_V3.md §Import).
 *
 * What must hold:
 *   - clearing Clients import history follows the Clients delete rule (Administrator, or a role given
 *     clients.delete); it never clears a running import or a preview from the last day, and never
 *     touches the clients an import brought in;
 *   - clearing Knowledge import history is an Administrator's; it keeps the entries an import made;
 *   - the template carries filter arrows, live checks and number/date validation, and a Note column
 *     that maps itself; a note is imported once, never twice on a re-import;
 *   - "Download problem rows" holds exactly the refused rows with the reason, in the file's own
 *     columns, and only while the import is a preview.
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
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const importActions = await import("@/server/actions/clientImport");
const knowledgeActions = await import("@/server/actions/knowledgeImport");
const templateRoute = await import("@/app/p/[project]/api/clients/import/template/route");
const problemsRoute = await import("@/app/p/[project]/api/clients/import/[jobId]/problems/route");
const { IMPORT_TEMPLATE_COLUMNS } = await import("@/server/clientImportTemplate");
const { buildWorkbook } = await import("@/server/xlsxWriter");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;

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
const people = {} as Record<"importer" | "deleter" | "mainAdmin" | "knowledgeManager", Session>;
const as = <T,>(person: Session, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(A, fn);
};
const HEADERS = IMPORT_TEMPLATE_COLUMNS.map((c) => c.header);
const sheetOf = (rows: Array<Record<string, string>>) => buildWorkbook([{ name: "Clients", rows: [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h] ?? ""))] }], "t");
const upload = (person: Session, bytes: Buffer) => {
  const f = new FormData();
  f.set("file", new File([new Uint8Array(bytes)], "clients.xlsx"));
  return as(person, () => importActions.previewClientImport({}, f));
};
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const body = buf.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
    files.set(name, (method === 8 ? inflateRawSync(body) : body).toString("utf8"));
    at += 30 + nameLength + extra + size;
  }
  return files;
}

beforeAll(async () => {
  const base = ["clients.view", "clients.create", "clients.update", "clients.import", "messages.view"];
  people.importer = await user("ClrImporter", await role("Clr importer", base));
  people.deleter = await user("ClrDeleter", await role("Clr deleter", [...base, "clients.delete"]));
  people.mainAdmin = await user("ClrMain", await role("Clr main", [...base, "projects.view", "projects.manage", "ai_learning.view", "ai_learning.manage"]));
  people.knowledgeManager = await user("ClrKnow", await role("Clr knowledge", ["ai_learning.view", "ai_learning.manage", "messages.view"]));
  const p = await createProjectWithDefaults({ name: `Clr ${tag}`, slug: `clr-${tag}`, status: "ACTIVE", creatorUserId: people.importer.userId }, rawPrisma);
  ids.projects.push(p.id);
  await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
  for (const key of ["CLIENT_CENTER", "AI_LEARNING"]) {
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key } }, create: { projectId: p.id, key, enabled: true }, update: { enabled: true } });
  }
  A = { id: p.id, slug: p.slug, name: `Clr ${tag}`, status: "ACTIVE" };
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientNote.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.clientImportJob.deleteMany({ where });
  await rawPrisma.aiKnowledgeItem.deleteMany({ where });
  await rawPrisma.knowledgeImport.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. the template", () => {
  it("has filter arrows, live checks, number/date validation, and a Note column that maps itself", async () => {
    const res = await as(people.importer, () => templateRoute.GET(new NextRequest("https://assist.example.test/p/x/api/clients/import/template")));
    const bytes = Buffer.from(await res.arrayBuffer());
    const files = unzip(bytes);
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toMatch(/<autoFilter ref="A1:[A-Z]+2001"\/>/);
    expect(files.get("xl/workbook.xml")).toContain("_xlnm._FilterDatabase");
    expect((sheet.match(/<conditionalFormatting /g) ?? []).length).toBe(6);
    expect(sheet).toContain("COUNTIF(");
    expect(sheet).toMatch(/type="whole" operator="between"/);
    expect(sheet).toMatch(/type="date" operator="between"/);
    expect(files.get("xl/styles.xml")).toContain('<dxfs count="2">');
    // Every header, Note included, still maps to a field — and SheetJS reads the file.
    const header = XLSX.utils.sheet_to_json<string[]>(XLSX.read(bytes, { type: "buffer" }).Sheets.Clients!, { header: 1 })[0]!;
    expect(header).toContain("Note");
    expect(Object.keys(autoMapColumns(header)).length).toBe(HEADERS.length);
  });
});

describe("2. notes and problem rows", () => {
  it("imports a note once; a re-import with Update does not add it again", async () => {
    const file = sheetOf([{ Name: `Noted ${tag}`, Phone: "01712555001", Note: "Call after 6 pm" }]);
    const first = await upload(people.importer, file);
    await as(people.importer, () => importActions.confirmClientImport(first.jobId!, "SKIP"));
    const client = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: `Noted ${tag}` }, include: { notes: true } });
    expect(client.notes.map((n) => n.body)).toEqual(["Call after 6 pm"]);
    const again = await upload(people.importer, file);
    await as(people.importer, () => importActions.confirmClientImport(again.jobId!, "UPDATE"));
    expect(await rawPrisma.clientNote.count({ where: { clientId: client.id } })).toBe(1);
  });

  it("problem rows: exactly the refused rows, the reason first, the file's own columns, only while a preview", async () => {
    const r = await upload(
      people.importer,
      sheetOf([
        { Name: `Good ${tag}`, Phone: "01712555010" },
        { Name: "", Phone: "01712555011", Email: "nobody@example.test" },
        { Name: `Bad date ${tag}`, "Service / plan": "Tiger", "Start date": "31/31/2026", Duration: "1" },
      ]),
    );
    const res = await as(people.importer, () => problemsRoute.GET(new NextRequest("https://assist.example.test/x"), { params: Promise.resolve({ jobId: r.jobId! }) }));
    expect(res.status).toBe(200);
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" }).Sheets["Problem rows"]!, { defval: "" });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.Problem).toMatch(/^Row 3: .*name/i);
    expect(rows[0]!.Email).toBe("nobody@example.test");
    expect(rows[1]!.Problem).toMatch(/^Row 4: .*Start date/);
    expect(Object.keys(rows[0]!)).toEqual(["Problem", ...HEADERS]);

    await as(people.importer, () => importActions.cancelClientImport(r.jobId!));
    const after = await as(people.importer, () => problemsRoute.GET(new NextRequest("https://assist.example.test/x"), { params: Promise.resolve({ jobId: r.jobId! }) }));
    expect(after.status).toBe(409);
  });
});

describe("3. clearing import history", () => {
  it("follows the delete rule, keeps running and fresh imports, and never touches the clients", async () => {
    const done = await upload(people.importer, sheetOf([{ Name: `Kept client ${tag}`, Phone: "01712555020" }]));
    await as(people.importer, () => importActions.confirmClientImport(done.jobId!, "SKIP"));
    const freshPreview = await upload(people.importer, sheetOf([{ Name: `Fresh ${tag}` }]));
    const oldPreview = await upload(people.importer, sheetOf([{ Name: `Old ${tag}` }]));
    await rawPrisma.clientImportJob.update({ where: { id: oldPreview.jobId! }, data: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    const running = await rawPrisma.clientImportJob.create({ data: { projectId: A.id, fileName: "running.xlsx", fileType: "xlsx", status: "PROCESSING", startedAt: new Date() } });

    const refused = await as(people.importer, () => importActions.clearClientImports("finished"));
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/Only an Administrator/) });

    const one = await as(people.deleter, () => importActions.clearClientImports([running.id]));
    expect(one.ok).toBe(false);
    expect(await rawPrisma.clientImportJob.count({ where: { id: running.id } })).toBe(1);

    const all = await as(people.mainAdmin, () => importActions.clearClientImports("finished"));
    expect(all.ok).toBe(true);
    expect(await rawPrisma.clientImportJob.count({ where: { id: done.jobId! } })).toBe(0);
    expect(await rawPrisma.clientImportJob.count({ where: { id: oldPreview.jobId! } })).toBe(0);
    expect(await rawPrisma.clientImportJob.count({ where: { id: freshPreview.jobId! } })).toBe(1);
    expect(await rawPrisma.clientImportJob.count({ where: { id: running.id } })).toBe(1);
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: `Kept client ${tag}` } })).toBe(1);
  });

  it("knowledge import history: an Administrator's; entries an import made are kept", async () => {
    const finished = await rawPrisma.knowledgeImport.create({ data: { projectId: A.id, label: `Manual ${tag}`, rawText: "x", status: "COMPLETED", entriesCreated: 1 } });
    const waiting = await rawPrisma.knowledgeImport.create({ data: { projectId: A.id, label: `Queued ${tag}`, rawText: "y", status: "PENDING" } });
    const entry = await rawPrisma.aiKnowledgeItem.create({ data: { projectId: A.id, category: "FAQ", title: "How to pay", answer: "Use the app.", importId: finished.id } });

    const refused = await as(people.knowledgeManager, () => knowledgeActions.clearKnowledgeImports("finished"));
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/Only an Administrator/) });

    const r = await as(people.mainAdmin, () => knowledgeActions.clearKnowledgeImports("finished"));
    expect(r.ok).toBe(true);
    expect(await rawPrisma.knowledgeImport.count({ where: { id: finished.id } })).toBe(0);
    expect(await rawPrisma.knowledgeImport.count({ where: { id: waiting.id } })).toBe(1);
    expect(await rawPrisma.aiKnowledgeItem.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ importId: null });
  });
});
