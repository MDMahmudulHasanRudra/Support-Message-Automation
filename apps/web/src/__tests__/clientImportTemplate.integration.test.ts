import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { addDuration, autoMapColumns, dhakaToday, PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * The client import template and the Clients V3 import columns (CLIENTS_V3.md §Import).
 *
 * What must hold:
 *   - the blank template needs `clients.import` only; "with my clients" also needs `clients.export`,
 *     holds only this project's non-archived clients, and is logged;
 *   - the template's first sheet is Clients, its headers map themselves on upload, its drop-downs read
 *     the project's own teams and staff, and its Example rows import without a single error;
 *   - a date typed into the template's date column (an Excel date) arrives as that date;
 *   - team, staff, seller, country, currency and a subscription import from the file; a name the
 *     roster does not know, shares or places in another team refuses the row with the reason;
 *   - re-importing the same file adds no second subscription; someone who may not sell subscriptions
 *     imports the clients without them, and is told so.
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
const templateRoute = await import("@/app/p/[project]/api/clients/import/template/route");
const { IMPORT_TEMPLATE_COLUMNS } = await import("@/server/clientImportTemplate");
const { buildWorkbook } = await import("@/server/xlsxWriter");
const { computeImportPreview } = await import("@/server/clientImport");
const { importOptionsFor } = await import("@/server/clientImportExtras");

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
const people = {} as Record<"admin" | "importer" | "viewer", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const download = (person: Session, project: Project, q = "") => as(person, project, () => templateRoute.GET(new NextRequest(`https://assist.example.test/p/x/api/clients/import/template${q}`)));
const upload = (person: Session, project: Project, bytes: Buffer, name = "clients.xlsx") => {
  const f = new FormData();
  f.set("file", new File([new Uint8Array(bytes)], name));
  return as(person, project, () => importActions.previewClientImport({}, f));
};
const job = (id: string) => rawPrisma.clientImportJob.findUniqueOrThrow({ where: { id } });
/** The preview exactly as the job page computes it, for the person looking at it. */
const previewOf = async (person: Session, project: Project, id: string) => {
  const j = await job(id);
  return as(person, project, async () => computeImportPreview(j.rows as never, j.mapping as never, await importOptionsFor(person)));
};
const HEADERS = IMPORT_TEMPLATE_COLUMNS.map((c) => c.header);
/** A Clients sheet in the template's own format (its date and text columns), as a person would save it. */
const sheetOf = (rows: Array<Record<string, string | number>>) =>
  buildWorkbook([{ name: "Clients", rows: [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h] ?? ""))], columnStyles: IMPORT_TEMPLATE_COLUMNS.map((c) => (c.format === "text" ? "text" : c.format === "date" ? "date" : undefined)) }], "t");

/** The files inside an .xlsx (a zip), to read what SheetJS does not expose: validations and styles. */
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
const today = dhakaToday(new Date());
const excelSerial = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86400000 + 25569;

beforeAll(async () => {
  const base = ["clients.view", "clients.create", "clients.update", "clients.import", "messages.view"];
  people.admin = await user("TplAdmin", await role("Tpl admin", [...base, "clients.export", "clients.manage_subscriptions"]));
  people.importer = await user("TplImporter", await role("Tpl importer", base));
  people.viewer = await user("TplViewer", await role("Tpl viewer", ["clients.view", "messages.view"]));
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.admin.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key: "CLIENT_CENTER" } }, create: { projectId: p.id, key: "CLIENT_CENTER", enabled: true }, update: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("TplA");
  B = await make("TplB");
  await rawPrisma.clientBillingCurrency.create({ data: { projectId: A.id, code: "BDT" } });
  const sales = await rawPrisma.team.create({ data: { projectId: A.id, name: `Sales ${tag}` } });
  const support = await rawPrisma.team.create({ data: { projectId: A.id, name: `Support ${tag}` } });
  await rawPrisma.team.create({ data: { projectId: A.id, name: `Old ${tag}`, status: "DISABLED" } });
  await rawPrisma.team.create({ data: { projectId: B.id, name: `Bteam ${tag}` } });
  let n = 0;
  const member = (project: Project, name: string, teamId: string | null) =>
    rawPrisma.internalTeamMember.create({ data: { projectId: project.id, name, phoneNumber: `8801${String(70000000 + Number.parseInt(tag.slice(0, 5), 16) % 1000000 + ++n).padStart(9, "0")}`, role: "Executive", teamId } });
  await member(A, `Nadia ${tag}`, sales.id);
  await member(A, `Fahim ${tag}`, support.id);
  await member(A, `Twin ${tag}`, sales.id);
  await member(A, `Twin ${tag}`, support.id);
  await member(B, `Bperson ${tag}`, null);
  forgetProjectFeatureStates();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.client.updateMany({ where, data: { currentSubscriptionId: null } });
  await rawPrisma.clientSubscription.deleteMany({ where });
  await rawPrisma.clientActivity.deleteMany({ where });
  await rawPrisma.clientChannel.deleteMany({ where });
  await rawPrisma.client.deleteMany({ where });
  await rawPrisma.clientImportJob.deleteMany({ where });
  await rawPrisma.clientBillingCurrency.deleteMany({ where });
  await rawPrisma.internalTeamMember.deleteMany({ where });
  await rawPrisma.team.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
});

describe("1. the template", () => {
  it("needs clients.import", async () => {
    await expect(download(people.viewer, A)).rejects.toThrow(/redirect/);
  });

  it("is a real workbook: Clients first, headers that map themselves, the project's own drop-downs, tips", async () => {
    const res = await download(people.importer, A);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/client-import-template-tpla-/);
    const bytes = Buffer.from(await res.arrayBuffer());
    const book = XLSX.read(bytes, { type: "buffer" });
    expect(book.SheetNames).toEqual(["Clients", "Example", "How to fill", "Lists"]);

    const header = XLSX.utils.sheet_to_json<string[]>(book.Sheets.Clients!, { header: 1 })[0]!;
    expect(header).toEqual(HEADERS);
    const mapping = autoMapColumns(header);
    expect(Object.keys(mapping).length).toBe(HEADERS.length); // every column maps to a field, none twice
    expect(new Set(Object.values(mapping)).size).toBe(HEADERS.length);

    const lists = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets.Lists!);
    const team = lists.map((r) => r.Team).filter(Boolean);
    expect(team).toEqual([`Sales ${tag}`, `Support ${tag}`]); // active teams only, never another project's
    const staff = lists.map((r) => r["Staff (sold by / assigned)"]).filter(Boolean);
    expect(staff).toContain(`Nadia ${tag}`);
    expect(staff).not.toContain(`Bperson ${tag}`);
    expect(lists[0]!.Currency).toBe("BDT"); // the project's billing currency first

    const xml = unzip(bytes).get("xl/worksheets/sheet1.xml")!;
    expect(xml).toContain(`<formula1>'Lists'!$D$2:$D$3</formula1>`);
    expect(xml).toContain('promptTitle="Name (required)"');
    expect(xml).toContain('state="frozen"');
    expect(unzip(bytes).get("xl/styles.xml")).toContain('formatCode="yyyy-mm-dd"');
  });

  it("its Example rows import without one error", async () => {
    const book = XLSX.read(Buffer.from(await (await download(people.admin, A)).arrayBuffer()), { type: "buffer" });
    const examples = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets.Example!, { raw: false, defval: "" });
    expect(examples).toHaveLength(4);
    const r = await upload(people.admin, A, sheetOf(examples));
    expect(await previewOf(people.admin, A, r.jobId!)).toMatchObject({ invalidCount: 0, validRows: 4, subscriptionRows: 3 });
  });

  it("with my clients: needs clients.export, holds this project's non-archived clients only, and is logged", async () => {
    expect((await download(people.importer, A, "?data=current")).status).toBe(403);
    await rawPrisma.client.create({ data: { projectId: A.id, code: `KEEP-${tag}`, name: `Kept ${tag}`, channels: { create: { projectId: A.id, kind: "PHONE", value: "+8801711000001", normalizedValue: "8801711000001" } } } });
    await rawPrisma.client.create({ data: { projectId: A.id, code: `ARCH-${tag}`, name: `Archived ${tag}`, status: "ARCHIVED" } });
    await rawPrisma.client.create({ data: { projectId: B.id, code: `OTHER-${tag}`, name: `Other ${tag}` } });
    const res = await download(people.admin, A, "?data=current");
    expect(res.status).toBe(200);
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" }).Sheets.Clients!, { raw: false, defval: "" });
    const names = rows.map((r) => r.Name);
    expect(names).toContain(`Kept ${tag}`);
    expect(names).not.toContain(`Archived ${tag}`);
    expect(names).not.toContain(`Other ${tag}`);
    expect(rows.find((r) => r.Name === `Kept ${tag}`)).toMatchObject({ "Client code": `KEEP-${tag}`, Phone: "+8801711000001" });
    expect(await rawPrisma.systemLog.count({ where: { projectId: A.id, message: { contains: "import template with current clients" } } })).toBe(1);
  });
});

describe("2. the Clients V3 columns", () => {
  const good = (name: string, phone: string, extra: Record<string, string | number> = {}) => ({
    Name: name,
    Phone: phone,
    Country: "uae",
    "Preferred currency": "aed",
    Team: `sales ${tag}`,
    "Assigned staff": `Nadia ${tag}`,
    "Sold by": `Fahim ${tag}`,
    "Service / plan": "Tiger IPTV",
    "Subscription type": "Trial",
    "Start date": excelSerial(today), // typed into the date column: Excel stores a date
    Duration: 1,
    "Duration unit": "Months",
    ...extra,
  });

  it("imports team, staff, seller, country, currency and the subscription; re-importing adds no second term", async () => {
    const file = sheetOf([good(`V3 One ${tag}`, "01712000001")]);
    const r = await upload(people.admin, A, file);
    const dbg = await previewOf(people.admin, A, r.jobId!);
    expect(dbg).toMatchObject({ invalidCount: 0, subscriptionRows: 1, subscriptionsImported: true });
    expect(await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"))).toMatchObject({ ok: true });

    const c = await rawPrisma.client.findFirstOrThrow({
      where: { projectId: A.id, name: `V3 One ${tag}` },
      include: { assignedTeam: true, assignedMember: true, soldByMember: true, currentSubscription: true, activities: true },
    });
    expect(c).toMatchObject({ country: "AE", preferredCurrency: "AED" });
    expect(c.assignedTeam?.name).toBe(`Sales ${tag}`);
    expect(c.assignedMember?.name).toBe(`Nadia ${tag}`);
    expect(c.soldByMember?.name).toBe(`Fahim ${tag}`);
    expect(c.currentSubscription).toMatchObject({ service: "Tiger IPTV", kind: "TRIAL", soldByName: `Fahim ${tag}`, durationValue: 1, durationUnit: "MONTH", isRenewal: false });
    expect(c.currentSubscription!.startDate.toISOString().slice(0, 10)).toBe(today);
    expect(c.currentSubscription!.endDate.toISOString().slice(0, 10)).toBe(addDuration(today, 1, "MONTH"));
    expect(c.activities.map((a) => a.type).sort()).toEqual(["IMPORTED", "SUBSCRIPTION_ADDED"]);

    const again = await upload(people.admin, A, file);
    await as(people.admin, A, () => importActions.confirmClientImport(again.jobId!, "UPDATE"));
    expect(await rawPrisma.clientSubscription.count({ where: { clientId: c.id } })).toBe(1);
  });

  it("an expiry date instead of a duration, written the way people type it", async () => {
    const r = await upload(people.admin, A, sheetOf([{ Name: `V3 Expiry ${tag}`, Phone: "01712000002", "Service / plan": "Basic", "Start date": "17/10/2026", "Expiry date": "17 Nov 2026" }]));
    await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"));
    const c = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: `V3 Expiry ${tag}` }, include: { currentSubscription: true } });
    expect(c.currentSubscription).toMatchObject({ service: "Basic", kind: "PAID" });
    expect(c.currentSubscription!.endDate.toISOString().slice(0, 10)).toBe("2026-11-17");
  });

  it("refuses a row the roster cannot place, with the reason, and imports the rest", async () => {
    const r = await upload(
      people.admin,
      A,
      sheetOf([
        good(`V3 Fine ${tag}`, "01712000010"),
        good(`V3 Ghost ${tag}`, "01712000011", { "Sold by": "Nobody Here" }),
        good(`V3 Twin ${tag}`, "01712000012", { "Assigned staff": `Twin ${tag}` }),
        good(`V3 Wrongteam ${tag}`, "01712000013", { "Assigned staff": `Fahim ${tag}` }),
        good(`V3 Oldteam ${tag}`, "01712000014", { Team: `Old ${tag}`, "Assigned staff": "" }),
        good(`V3 Otherproject ${tag}`, "01712000015", { Team: `Bteam ${tag}`, "Assigned staff": "" }),
        good(`V3 Badcountry ${tag}`, "01712000016", { Country: "Atlantis" }),
        good(`V3 Baddate ${tag}`, "01712000017", { "Start date": "10/31/2026" }),
        good(`V3 Badunit ${tag}`, "01712000018", { "Duration unit": "Fortnights" }),
      ]),
    );
    const preview = await previewOf(people.admin, A, r.jobId!);
    expect(preview).toMatchObject({ validRows: 1, invalidCount: 8 });
    const text = JSON.stringify(preview.invalid);
    expect(text).toMatch(/Nobody Here.*not on this project's team roster/);
    expect(text).toMatch(/2 team members have that name/);
    expect(text).toMatch(/is not in the team/);
    expect(text).toMatch(/is disabled/);
    expect(text).toMatch(new RegExp(`Bteam ${tag}.*does not exist in this project`));
    expect(text).toMatch(/Atlantis.*not recognised/);
    await as(people.admin, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"));
    expect(await rawPrisma.client.count({ where: { projectId: A.id, name: { startsWith: "V3 " }, AND: { name: { endsWith: tag } } } })).toBe(3); // One, Expiry, Fine
  });

  it("someone who may not sell subscriptions imports the clients without them, and is told so beforehand", async () => {
    const r = await upload(people.importer, A, sheetOf([good(`V3 NoSubs ${tag}`, "01712000020")]));
    expect(await previewOf(people.importer, A, r.jobId!)).toMatchObject({ subscriptionRows: 1, subscriptionsImported: false });
    await as(people.importer, A, () => importActions.confirmClientImport(r.jobId!, "SKIP"));
    const c = await rawPrisma.client.findFirstOrThrow({ where: { projectId: A.id, name: `V3 NoSubs ${tag}` } });
    expect(c.currentSubscriptionId).toBeNull();
    expect(await rawPrisma.clientSubscription.count({ where: { clientId: c.id } })).toBe(0);
  });
});
