import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, encryptSecret, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { columnIndex, PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Google Sheets Phases 3, 6, 7, 9 and 10 — the editor, the activity log, work sessions and the
 * reports (GOOGLE_SHEETS.md §6–§10), against the isolated database and a fake Google that keeps a
 * real grid in memory. The shared-sheet story:
 *
 *   Daily Client Follow-up — Lead: Rudra · Editors: Borhan, NoEdit (role lacks the edit key) ·
 *   Monitor: CTO. The Google account carrying every call is RUDRA's own connected account.
 *
 * What must hold: only members open the contents; only Leads/Editors with the edit permission change
 * them; Save never overwrites a cell somebody changed in Google meanwhile; a delete never removes a
 * row that moved; every change is credited to the signed-in person — never to the Google account
 * that carried it — and no cell value or search text is stored; signals cannot turn viewing into
 * work; the reports read exactly what was recorded, project by project.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], bizId: "" };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const editor = await import("@/server/actions/googleSheetEditor");
const sessionsStore = await import("@/server/google/sessions");
const reports = await import("@/server/google/reports");
const reportTables = await import("@/server/google/reportTables");
const signalRoute = await import("@/app/p/[project]/api/google-sheets/signal/route");
const exportRoute = await import("@/app/p/[project]/api/google-sheets/report-export/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" | "SUSPENDED" | "ARCHIVED" };
const isp: Project = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" };
let biz: Project = { id: "", slug: "bizify", name: "Bizify", status: "ACTIVE" };

// ── A fake Google that keeps a real grid ─────────────────────────────────────────────────────────────
interface FakeTab {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
  /** Raw content (what is typed): a value or a formula. */
  cells: string[][];
}
const files = new Map<string, FakeTab[]>();
const writes: Array<{ path: string; body: unknown }> = [];
let validToken = "";

function parseA1(range: string) {
  const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  if (!m) throw new Error(`fake Google cannot read range ${range}`);
  return { title: m[1]!.replace(/''/g, "'"), c1: columnIndex(m[2]!), r1: Number(m[3]), c2: columnIndex(m[4] ?? m[2]!), r2: Number(m[5] ?? m[3]) };
}
const raw = (tab: FakeTab, r: number, c: number) => tab.cells[r - 1]?.[c] ?? "";
const shown = (value: string) => (value.startsWith("=") ? "42" : value);
/** Like Google: numbers come back as numbers, trailing empties are dropped. */
const asGoogle = (value: string) => (/^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
function setCell(tab: FakeTab, r: number, c: number, value: string) {
  while (tab.cells.length < r) tab.cells.push([]);
  const row = tab.cells[r - 1]!;
  while (row.length <= c) row.push("");
  row[c] = value;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? "";
  if (url.hostname !== "sheets.googleapis.com") return json({ error: "unexpected" }, 404);
  if (bearer !== validToken) return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
  const m = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(url.pathname)!;
  const tabs = files.get(decodeURIComponent(m[1]!));
  if (!tabs) return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
  const rest = m[2]!;
  const tabByTitle = (title: string) => tabs.find((t) => t.title === title)!;
  if (rest === "" && (init?.method ?? "GET") === "GET") {
    return json({ properties: { title: "file" }, sheets: tabs.map((t, i) => ({ properties: { sheetId: t.sheetId, title: t.title, index: i, sheetType: "GRID", gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount } } })) });
  }
  if (rest === "/values:batchGet") {
    const render = url.searchParams.get("valueRenderOption");
    return json({
      valueRanges: url.searchParams.getAll("ranges").map((range) => {
        const a = parseA1(range);
        const tab = tabByTitle(a.title);
        const values: unknown[][] = [];
        for (let r = a.r1; r <= Math.min(a.r2, tab.rowCount); r++) {
          const line: unknown[] = [];
          for (let c = a.c1; c <= Math.min(a.c2, tab.columnCount - 1); c++) line.push(render === "FORMULA" ? asGoogle(raw(tab, r, c)) : shown(raw(tab, r, c)));
          while (line.length && (line[line.length - 1] === "" || line[line.length - 1] === undefined)) line.pop();
          values.push(line);
        }
        while (values.length && values[values.length - 1]!.length === 0) values.pop();
        return { range, values };
      }),
    });
  }
  const body = JSON.parse(String(init?.body ?? "{}"));
  writes.push({ path: rest, body });
  if (rest === "/values:batchUpdate") {
    for (const d of body.data as Array<{ range: string; values: string[][] }>) {
      const a = parseA1(d.range);
      setCell(tabByTitle(a.title), a.r1, a.c1, d.values[0]![0]!);
    }
    return json({ totalUpdatedCells: body.data.length });
  }
  if (rest === ":batchUpdate") {
    for (const req of body.requests as Array<Record<string, { range?: { sheetId: number; dimension: string; startIndex: number; endIndex: number }; sheetId?: number; dimension?: string; length?: number }>>) {
      const [kind, spec] = Object.entries(req)[0]!;
      const tab = tabs.find((t) => t.sheetId === (spec.range?.sheetId ?? spec.sheetId))!;
      const rows = (spec.range?.dimension ?? spec.dimension) === "ROWS";
      if (kind === "appendDimension") {
        if (rows) tab.rowCount += spec.length!;
        else tab.columnCount += spec.length!;
      } else {
        const n = spec.range!.endIndex - spec.range!.startIndex;
        if (rows) {
          if (kind === "insertDimension") tab.cells.splice(spec.range!.startIndex, 0, ...Array.from({ length: n }, () => [] as string[]));
          else tab.cells.splice(spec.range!.startIndex, n);
          tab.rowCount += kind === "insertDimension" ? n : -n;
        } else {
          for (const line of tab.cells) {
            if (kind === "insertDimension") line.splice(spec.range!.startIndex, 0, ...Array.from({ length: n }, () => ""));
            else line.splice(spec.range!.startIndex, n);
          }
          tab.columnCount += kind === "insertDimension" ? n : -n;
        }
      }
    }
    return json({});
  }
  return json({ error: "unexpected" }, 404);
};

// ── People ───────────────────────────────────────────────────────────────────────────────────────────
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
async function user(name: string, roleId: string, projectIds: string[]): Promise<Session> {
  const u = await rawPrisma.user.create({ data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of projectIds) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
async function setFeature(projectId: string) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key: "GOOGLE_SHEETS" } }, create: { projectId, key: "GOOGLE_SHEETS", enabled: true }, update: { enabled: true } });
  forgetProjectFeatureStates();
}

const people = {} as Record<"manager" | "rudra" | "borhan" | "noEdit" | "cto" | "viewer" | "bizUser", Session>;
const team = {} as Record<"rudra" | "borhan", string>;
const sheets = {} as Record<"followup" | "viewOnlyInGoogle" | "biz", string>;
let accountId = "";
let bizAccountId = "";

const as = async <T,>(person: Session, fn: () => Promise<T>, project: Project = isp) => {
  current = person;
  return runWithProject(project, fn);
};
const ok = <T,>(result: T | { error: string }): T => {
  if (result && typeof result === "object" && "error" in result) throw new Error(`unexpected refusal: ${(result as { error: string }).error}`);
  return result as T;
};
const followupTab = () => files.get(`${tag}-followup`)![0]!;

beforeAll(async () => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://assist.example.test");
  vi.stubGlobal("fetch", fakeFetch);
  validToken = `access-${tag}`;

  const managerRole = await role("GSW manager", ["google_sheets.view", "google_sheets.manage", "google_sheets.monitor", "google_sheets.report"]);
  const editorRole = await role("GSW editor", ["google_sheets.view", "google_sheets.edit"]);
  const viewRole = await role("GSW view", ["google_sheets.view"]);
  const ctoRole = await role("GSW cto", ["google_sheets.view", "google_sheets.monitor", "google_sheets.report", "google_sheets.edit"]);
  people.manager = await user("Manager", managerRole, [ORIGINAL_PROJECT_ID]);
  const existing = await rawPrisma.project.findFirst({ where: { slug: "bizify" } });
  const bizProject = existing ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma));
  ids.bizId = bizProject.id;
  biz = { ...biz, id: bizProject.id };
  people.rudra = await user("Rudra", editorRole, [ORIGINAL_PROJECT_ID]);
  people.borhan = await user("Borhan", editorRole, [ORIGINAL_PROJECT_ID]);
  people.noEdit = await user("NoEdit", viewRole, [ORIGINAL_PROJECT_ID]);
  people.cto = await user("CTO", ctoRole, [ORIGINAL_PROJECT_ID]);
  people.viewer = await user("Viewer", viewRole, [ORIGINAL_PROJECT_ID]);
  people.bizUser = await user("BizUser", editorRole, [bizProject.id]);
  await setFeature(ORIGINAL_PROJECT_ID);
  await setFeature(bizProject.id);

  let phone = 0;
  const roster = (name: string, userId: string) =>
    rawPrisma.internalTeamMember.create({ data: { projectId: ORIGINAL_PROJECT_ID, name, phoneNumber: `8801${tag.replace(/\D/g, "").padEnd(6, "3").slice(0, 6)}${String(++phone).padStart(3, "0")}`, role: "Support", userId } });
  team.rudra = (await roster("Rudra (roster)", people.rudra.userId)).id;
  team.borhan = (await roster("Borhan (roster)", people.borhan.userId)).id;

  const account = (projectId: string, subject: string) =>
    rawPrisma.googleIntegrationAccount.create({
      data: {
        projectId,
        googleSubject: subject,
        email: `${subject}@example.test`,
        status: "CONNECTED",
        grantedScopes: ["https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/spreadsheets"],
        refreshTokenCiphertext: encryptSecret(`refresh-${tag}`),
        accessTokenCiphertext: encryptSecret(validToken),
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        connectedById: people.rudra.userId,
      },
    });
  accountId = (await account(ORIGINAL_PROJECT_ID, `sub-rudra-${tag}`)).id;
  bizAccountId = (await account(bizProject.id, `sub-biz-${tag}`)).id;

  const sheet = async (key: string, projectId: string, account: string, canEdit: boolean) => {
    const googleFileId = `${tag}-${key}`;
    files.set(googleFileId, [
      {
        sheetId: 0,
        title: "Follow-up",
        rowCount: 50,
        columnCount: 6,
        cells: [
          ["Client", "Due", "Note"],
          ["Rahim", "500", ""],
          ["Karim", "300", "call back"],
          ["Total", "=SUM(B2:B3)", ""],
        ],
      },
      { sheetId: 77, title: "Rudra's list", rowCount: 10, columnCount: 3, cells: [["x"]] },
    ]);
    const row = await rawPrisma.googleSpreadsheet.create({ data: { projectId, googleFileId, name: `Sheet ${key}` } });
    await rawPrisma.googleSpreadsheetAccess.create({ data: { projectId, spreadsheetId: row.id, googleAccountId: account, canEdit, canShare: true } });
    return row.id;
  };
  sheets.followup = await sheet("followup", ORIGINAL_PROJECT_ID, accountId, true);
  sheets.viewOnlyInGoogle = await sheet("viewonly", ORIGINAL_PROJECT_ID, accountId, false);
  sheets.biz = await sheet("biz", bizProject.id, bizAccountId, true);

  const member = (spreadsheetId: string, userId: string, role: "LEAD" | "EDITOR" | "MONITOR", projectId = ORIGINAL_PROJECT_ID) =>
    rawPrisma.googleSpreadsheetMember.create({ data: { projectId, spreadsheetId, userId, role, startedAt: new Date("2026-01-01T00:00:00Z"), addedById: people.manager.userId } });
  for (const id of [sheets.followup, sheets.viewOnlyInGoogle]) {
    await member(id, people.rudra.userId, "LEAD");
    await member(id, people.borhan.userId, "EDITOR");
    await member(id, people.noEdit.userId, "EDITOR");
    await member(id, people.cto.userId, "MONITOR");
  }
  await member(sheets.biz, people.bizUser.userId, "EDITOR", bizProject.id);
});

beforeEach(() => {
  current = people.manager;
  writes.length = 0;
});

afterAll(async () => {
  const sheetIds = (await rawPrisma.googleSpreadsheet.findMany({ where: { googleFileId: { startsWith: tag } }, select: { id: true } })).map((s) => s.id);
  await rawPrisma.googleSheetActivity.deleteMany({ where: { spreadsheetId: { in: sheetIds } } });
  await rawPrisma.googleSheetWorkSession.deleteMany({ where: { spreadsheetId: { in: sheetIds } } });
  await rawPrisma.googleSpreadsheetMember.deleteMany({ where: { spreadsheetId: { in: sheetIds } } });
  await rawPrisma.googleSpreadsheet.deleteMany({ where: { id: { in: sheetIds } } });
  await rawPrisma.googleIntegrationAccount.deleteMany({ where: { googleSubject: { endsWith: tag } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: Object.values(team) } } });
  await rawPrisma.googleSheetsSettings.deleteMany({ where: { projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "GOOGLE_SHEETS", projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const open = (person: Session, spreadsheetId = sheets.followup, project: Project = isp, clientKey?: string) =>
  as(person, () => editor.loadSheetWindowAction(spreadsheetId, { purpose: "OPEN", clientKey }), project);
const save = (person: Session, edits: Array<{ row: number; col: number; value: string; base: string }>, spreadsheetId = sheets.followup, project: Project = isp, clientKey?: string) =>
  as(person, () => editor.saveSheetCellsAction(spreadsheetId, { tabId: 0, edits, clientKey }), project);
const activities = (where: Record<string, unknown> = {}) => rawPrisma.googleSheetActivity.findMany({ where: { spreadsheetId: sheets.followup, ...where }, orderBy: { createdAt: "asc" } });

describe("1. who opens a spreadsheet's contents (Phase 3)", () => {
  it("somebody who is not a member does not — and Google is never asked", async () => {
    const result = await open(people.viewer);
    expect(result).toEqual({ error: expect.stringMatching(/Only this spreadsheet's members/) });
  });

  it("a member opens the bounded window; only someone who may edit gets what is TYPED in the cells", async () => {
    const lead = ok(await open(people.rudra)).data;
    expect(lead.tab).toMatchObject({ sheetId: 0, title: "Follow-up" });
    expect(lead.window).toEqual({ startRow: 1, startCol: 0, rows: 50, cols: 6 });
    expect(lead.display[3]!.slice(0, 2)).toEqual(["Total", "42"]);
    expect(lead.raw![3]!.slice(0, 2)).toEqual(["Total", "=SUM(B2:B3)"]);
    expect(lead.raw![1]![1]).toBe("500"); // Google's number comes back as the same text
    expect(lead.googleCanEdit).toBe(true);
    const monitor = ok(await open(people.cto)).data;
    expect(monitor.raw).toBeNull();
    expect(monitor.display[3]![1]).toBe("42");
  });

  it("another project's spreadsheet is not found, and a token never reaches the browser", async () => {
    expect(await open(people.manager, sheets.biz)).toEqual({ error: "That spreadsheet is not in this project." });
    const payload = JSON.stringify(ok(await open(people.rudra)));
    expect(payload).not.toContain(validToken);
    expect(payload).not.toContain("refresh-");
  });

  it("opening is VIEWING, credited to the person — tab, but no range and no values", async () => {
    const before = await rawPrisma.googleSheetActivity.count({ where: { spreadsheetId: sheets.followup, actionType: "SPREADSHEET_OPENED", userId: people.borhan.userId } });
    ok(await open(people.borhan));
    const rows = await activities({ actionType: "SPREADSHEET_OPENED", userId: people.borhan.userId });
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ kind: "VIEW", source: "APPLICATION", attribution: "APPLICATION", tabTitle: "Follow-up", range: null, teamMemberId: team.borhan, memberRole: "EDITOR", googleAccountId: accountId });
  });
});

describe("2. who changes it, and how a save behaves (Phase 3 + 6)", () => {
  it("a monitor, an Editor whose role lacks the edit key, a non-member manager and a suspended project are all refused — nothing is written", async () => {
    const edit = [{ row: 2, col: 1, value: "999", base: "500" }];
    expect((await save(people.cto, edit)) as { error: string }).toEqual({ error: expect.stringMatching(/monitor/) });
    expect((await save(people.noEdit, edit)) as { error: string }).toEqual({ error: expect.stringMatching(/Edit Google Sheets/) });
    expect((await save(people.manager, edit)) as { error: string }).toEqual({ error: expect.stringMatching(/add yourself as an Editor/) });
    expect((await save(people.rudra, edit, sheets.followup, { ...isp, status: "SUSPENDED" })) as { error: string }).toEqual({ error: expect.stringMatching(/read-only/) });
    expect(writes).toEqual([]);
    expect(raw(followupTab(), 2, 1)).toBe("500");
  });

  it("an Editor's save writes ONLY the changed cells, as typed (USER_ENTERED), credited to them — not to the Google account that carried it", async () => {
    const result = ok(
      await save(people.borhan, [
        { row: 2, col: 1, value: "650", base: "500" },
        { row: 3, col: 2, value: "=B2*2", base: "call back" },
      ]),
    ).result;
    expect(result).toMatchObject({ written: 2, conflicts: [], unchanged: 0, tabTitle: "Follow-up" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      path: "/values:batchUpdate",
      body: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: "'Follow-up'!B2", majorDimension: "ROWS", values: [["650"]] },
          { range: "'Follow-up'!C3", majorDimension: "ROWS", values: [["=B2*2"]] },
        ],
      },
    });
    expect(raw(followupTab(), 2, 1)).toBe("650");
    const row = (await activities({ actionType: "CELLS_EDITED" })).at(-1)!;
    expect(row).toMatchObject({ kind: "WORK", userId: people.borhan.userId, teamMemberId: team.borhan, memberRole: "EDITOR", googleAccountId: accountId, range: "'Follow-up'!B2:C3", itemCount: 2 });
    // The account belongs to Rudra; Rudra did nothing.
    expect(row.userId).not.toBe(people.rudra.userId);
    // No cell value is stored anywhere on the row.
    expect(JSON.stringify(row)).not.toMatch(/650|B2\*2/);
  });

  it("a cell changed in Google since it was loaded is reported with what it holds now, and NOT overwritten", async () => {
    setCell(followupTab(), 2, 1, "700"); // somebody, in Google
    const result = ok(await save(people.borhan, [{ row: 2, col: 1, value: "800", base: "650" }])).result;
    expect(result).toMatchObject({ written: 0, conflicts: [{ row: 2, col: 1, value: "800", now: "700" }] });
    expect(writes).toEqual([]);
    expect(raw(followupTab(), 2, 1)).toBe("700");
    // Saving again against what Google holds now is an informed overwrite.
    const again = ok(await save(people.borhan, [{ row: 2, col: 1, value: "800", base: "700" }])).result;
    expect(again).toMatchObject({ written: 1, conflicts: [] });
    expect(raw(followupTab(), 2, 1)).toBe("800");
  });

  it("a sheet the connected account may only VIEW in Google cannot be saved through it", async () => {
    const result = await save(people.borhan, [{ row: 2, col: 1, value: "1", base: "500" }], sheets.viewOnlyInGoogle);
    expect(result).toEqual({ error: expect.stringMatching(/None of the connected Google accounts can edit/) });
    expect(writes).toEqual([]);
  });

  it("deleting a row that moved since it was loaded deletes nothing; the right row is deleted when it still matches", async () => {
    const tab = followupTab();
    const seenRow3 = { start: 0, lines: [[...tab.cells[2]!]] };
    tab.cells.splice(1, 0, ["Inserted in Google", "", ""]); // everything below shifts down
    tab.rowCount += 1;
    const refused = await as(people.borhan, () => editor.changeSheetDimensionAction(sheets.followup, { tabId: 0, change: { kind: "DELETE_ROWS", from: 3, count: 1 }, seen: seenRow3 }));
    expect(refused).toEqual({ error: expect.stringMatching(/Row 3 changed in Google/) });
    expect(writes).toEqual([]);

    const seenRow4 = { start: 0, lines: [[...tab.cells[3]!]] };
    const done = ok(await as(people.borhan, () => editor.changeSheetDimensionAction(sheets.followup, { tabId: 0, change: { kind: "DELETE_ROWS", from: 4, count: 1 }, seen: seenRow4 })));
    expect(done.description).toBe("Deleted row 4");
    expect(writes[0]!.body).toEqual({ requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 3, endIndex: 4 } } }] });
    expect((await activities({ actionType: "ROWS_DELETED" })).at(-1)).toMatchObject({ userId: people.borhan.userId, detail: "Deleted row 4", range: "'Follow-up'!4:4", itemCount: 1 });
  });

  it("rows and columns are inserted and appended where asked", async () => {
    ok(await as(people.rudra, () => editor.changeSheetDimensionAction(sheets.followup, { tabId: 0, change: { kind: "INSERT_ROWS", at: 2, count: 1 } })));
    ok(await as(people.rudra, () => editor.changeSheetDimensionAction(sheets.followup, { tabId: 0, change: { kind: "INSERT_COLUMNS", at: 1, count: 2 } })));
    ok(await as(people.rudra, () => editor.changeSheetDimensionAction(sheets.followup, { tabId: 0, change: { kind: "APPEND_ROWS", count: 10 } })));
    expect(writes.map((w) => (w.body as { requests: Array<Record<string, unknown>> }).requests[0])).toEqual([
      { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 }, inheritFromBefore: true } },
      { insertDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 3 }, inheritFromBefore: true } },
      { appendDimension: { sheetId: 0, dimension: "ROWS", length: 10 } },
    ]);
    const types = (await activities({ userId: people.rudra.userId, kind: "WORK" })).map((a) => a.actionType);
    expect(types).toEqual(["ROWS_ADDED", "COLUMNS_ADDED", "ROWS_ADDED"]);
    // A monitor can do none of it.
    expect(await as(people.cto, () => editor.changeSheetDimensionAction(sheets.followup, { tabId: 0, change: { kind: "APPEND_ROWS", count: 1 } }))).toEqual({ error: expect.stringMatching(/monitor/) });
  });

  it("search finds text across the whole tab; the log records THAT a search happened, never what was searched", async () => {
    const found = ok(await as(people.cto, () => editor.searchSheetAction(sheets.followup, { tabId: 0, query: "rahim" })));
    expect(found.matches.map((m) => m.text)).toEqual(["Rahim"]);
    const row = (await activities({ actionType: "SEARCHED" })).at(-1)!;
    expect(row).toMatchObject({ kind: "VIEW", userId: people.cto.userId, memberRole: "MONITOR", range: null, detail: null });
    expect(JSON.stringify(row).toLowerCase()).not.toContain("rahim");
  });
});

describe("3. sessions — signals measure presence, and cannot turn viewing into work (Phase 7)", () => {
  const key = (name: string) => `${name}-${tag}-key-000000`;
  const post = (person: Session, body: Record<string, unknown>, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
    as(person, () =>
      signalRoute.POST(new NextRequest("https://assist.example.test/p/isp-digital/api/google-sheets/signal", { method: "POST", body: JSON.stringify(body), headers })),
    );
  const events = async (clientKey: string) => {
    const session = await rawPrisma.googleSheetWorkSession.findFirst({ where: { clientKey }, select: { id: true } });
    return session ? (await rawPrisma.googleSheetWorkSessionEvent.findMany({ where: { sessionId: session.id }, orderBy: { at: "asc" } })).map((e) => e.kind) : [];
  };

  it("the route accepts a member's signal from the same site only", async () => {
    expect((await post(people.borhan, { clientKey: key("b1"), spreadsheetId: sheets.followup, kind: "START" })).status).toBe(204);
    expect(await events(key("b1"))).toEqual(["START"]);
    expect((await post(people.borhan, { clientKey: key("x1"), spreadsheetId: sheets.followup, kind: "START" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(people.viewer, { clientKey: key("v1"), spreadsheetId: sheets.followup, kind: "START" })).status).toBe(403);
    expect((await post(people.borhan, { clientKey: "short", spreadsheetId: sheets.followup, kind: "START" })).status).toBe(400);
    expect(await rawPrisma.googleSheetWorkSession.count({ where: { clientKey: { in: [key("x1"), key("v1")] } } })).toBe(0);
  });

  it("a monitor's work signal is recorded as viewing; someone else's key is ignored; signals faster than the interval are dropped", async () => {
    const t0 = new Date("2026-10-09T04:00:00Z");
    const cto = { clientKey: key("c1"), spreadsheetId: sheets.followup, userId: people.cto.userId, mayWork: false };
    await as(people.cto, () => sessionsStore.recordSignal({ ...cto, kind: "START", now: t0 }));
    await as(people.cto, () => sessionsStore.recordSignal({ ...cto, kind: "WORK_SIGNAL", now: new Date(t0.getTime() + 30_000) }));
    expect(await events(key("c1"))).toEqual(["START", "VIEW_SIGNAL"]);
    expect(await as(people.borhan, () => sessionsStore.recordSignal({ ...cto, userId: people.borhan.userId, mayWork: true, kind: "WORK_SIGNAL", now: new Date(t0.getTime() + 60_000) }))).toMatchObject({ outcome: "IGNORED" });
    const quick = await as(people.cto, () => sessionsStore.recordSignal({ ...cto, kind: "VIEW_SIGNAL", now: new Date(t0.getTime() + 35_000) }));
    expect(quick.outcome).toBe("THROTTLED");
    expect(await events(key("c1"))).toEqual(["START", "VIEW_SIGNAL"]);
  });

  it("a save is a work signal on the session it was made in; CLOSE ends the session", async () => {
    const clientKey = key("b2");
    expect((await post(people.borhan, { clientKey, spreadsheetId: sheets.followup, kind: "START" })).status).toBe(204);
    const tab = followupTab();
    ok(await save(people.borhan, [{ row: 1, col: 0, value: "Customer", base: raw(tab, 1, 0) }], sheets.followup, isp, clientKey));
    expect(await events(clientKey)).toEqual(["START", "WORK_SIGNAL"]);
    const session = (await rawPrisma.googleSheetWorkSession.findFirst({ where: { clientKey } }))!;
    expect(session).toMatchObject({ canWork: true, memberRole: "EDITOR", teamMemberId: team.borhan });
    expect((await activities({ actionType: "CELLS_EDITED" })).at(-1)!.sessionId).toBe(session.id);
    expect((await post(people.borhan, { clientKey, spreadsheetId: sheets.followup, kind: "CLOSE" })).status).toBe(204);
    expect((await rawPrisma.googleSheetWorkSession.findUnique({ where: { id: session.id } }))!.closedAt).not.toBeNull();
    expect(await as(people.borhan, () => sessionsStore.recordSignal({ clientKey, spreadsheetId: sheets.followup, userId: people.borhan.userId, mayWork: true, kind: "VIEW_SIGNAL" }))).toMatchObject({ outcome: "CLOSED" });
  });

  it("'open right now' lists who has a signal within the threshold, working or viewing", async () => {
    const now = new Date();
    const live = (person: Session, name: string, mayWork: boolean, kind: "VIEW_SIGNAL" | "WORK_SIGNAL") =>
      as(person, () => sessionsStore.recordSignal({ clientKey: key(name), spreadsheetId: sheets.followup, userId: person.userId, mayWork, kind, now }));
    await live(people.rudra, "r-live", true, "WORK_SIGNAL");
    await live(people.cto, "c-live", false, "VIEW_SIGNAL");
    const list = await as(people.manager, () => sessionsStore.listLiveSessions({ spreadsheetId: sheets.followup, now }));
    const byName = Object.fromEntries(list.map((s) => [s.name, s.working]));
    expect(byName).toMatchObject({ Rudra: true, CTO: false });
    const later = await as(people.manager, () => sessionsStore.listLiveSessions({ spreadsheetId: sheets.followup, now: new Date(now.getTime() + 6 * 60_000) }));
    expect(later.map((s) => s.name)).not.toContain("Rudra");
  });
});

describe("4. the reports read exactly what was recorded (Phases 9–10)", () => {
  const day = "2026-09-20";
  const t = (minute: number) => new Date(Date.UTC(2026, 8, 20, 4, minute, 0)); // 10:00 Dhaka + minutes
  const session = async (person: Session, spreadsheetId: string, minutes: Array<[number, "START" | "VIEW_SIGNAL" | "WORK_SIGNAL"]>, project: Project = isp) => {
    const clientKey = `rep-${person.name}-${spreadsheetId.slice(-6)}-${tag}-${minutes[0]![0]}`.replace(/[^A-Za-z0-9_-]/g, "");
    for (const [minute, kind] of minutes) {
      await as(person, () => sessionsStore.recordSignal({ clientKey, spreadsheetId, userId: person.userId, mayWork: person !== people.cto, kind, now: t(minute) }), project);
    }
  };

  beforeAll(async () => {
    await session(people.rudra, sheets.followup, [
      [0, "START"],
      [1, "WORK_SIGNAL"],
      [3, "WORK_SIGNAL"],
      [5, "WORK_SIGNAL"],
      [7, "WORK_SIGNAL"],
      [9, "VIEW_SIGNAL"],
    ]);
    await session(people.borhan, sheets.followup, [
      [0, "WORK_SIGNAL"],
      [4, "WORK_SIGNAL"],
      [8, "WORK_SIGNAL"],
    ]);
    await session(people.cto, sheets.followup, [
      [0, "START"],
      [3, "VIEW_SIGNAL"],
      [6, "VIEW_SIGNAL"],
    ]);
    // Bizify's work must never appear in ISP Digital's report.
    await session(people.bizUser, sheets.biz, [
      [0, "WORK_SIGNAL"],
      [4, "WORK_SIGNAL"],
    ], biz);
    const base = { projectId: ORIGINAL_PROJECT_ID, spreadsheetId: sheets.followup, source: "EXTERNAL_GOOGLE" as const, actionType: "EXTERNAL_EDIT" as const, kind: "WORK" as const, occurredAt: t(5), googleAccountId: accountId };
    await rawPrisma.googleSheetActivity.createMany({
      data: [
        { ...base, attribution: "UNATTRIBUTED", unattributedReason: "NO_LINKED_IDENTITY", externalKey: `${tag}-u1` },
        { ...base, attribution: "ATTRIBUTED", userId: people.borhan.userId, externalKey: `${tag}-a1` },
        { ...base, attribution: "APPLICATION_ECHO", externalKey: `${tag}-e1` },
      ],
    });
  });

  const load = (extra: Record<string, string> = {}) => as(people.manager, () => reports.loadSheetReport(reports.parseSheetReportFilters({ period: "custom", from: day, to: day, ...extra })));

  it("per employee: unioned work, viewing, and Google edits credited only through a linked identity", async () => {
    const data = await load();
    const row = (p: Session) => data.employees.rows.find((r) => r.userId === p.userId)!;
    expect(row(people.rudra)).toMatchObject({ workMs: 6 * 60_000, viewingMs: 3 * 60_000, externalEdits: 0 });
    expect(row(people.borhan)).toMatchObject({ workMs: 8 * 60_000, viewingMs: 0, externalEdits: 1 });
    expect(row(people.cto)).toMatchObject({ workMs: 0, viewingMs: 6 * 60_000 });
    expect(data.employees.rows.find((r) => r.userId === people.bizUser.userId)).toBeUndefined();
    expect(data.employees.unattributedExternalEdits).toBe(1);
    const table = reportTables.employeesTable(data);
    expect(table.rows.at(-1)!.cells).toMatchObject({ name: "Total", work: 14 * 60_000, external: 2 });
  });

  it("per sheet: the member breakdown, with roles at the end of the period and the unattributed line", async () => {
    const data = await load({ view: "sheets", sheet: sheets.followup });
    const table = reportTables.sheetMembersTable(data, sheets.followup);
    expect(table.rows.map((r) => [r.cells.name, r.cells.role, (r.cells.work as number) / 60_000, (r.cells.external as number)])).toEqual([
      ["Borhan", "Editor", 8, 1],
      ["Rudra", "Lead", 6, 0],
      ["CTO", "Monitor", 0, 0],
      ["Unattributed", "—", 0, 1],
      ["Total", "", 14, 2],
    ]);
  });

  it("the Excel and CSV exports carry the same table", async () => {
    current = people.manager;
    const csv = await runWithProject(isp, () => exportRoute.GET(new NextRequest(`https://assist.example.test/p/isp-digital/api/google-sheets/report-export?period=custom&from=${day}&to=${day}&format=csv`)));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = (await csv.text()).replace(/^﻿/, "");
    expect(text.split("\n")[0]).toBe("Employee,Team member,Work time (hours),Viewing time (hours),Spreadsheets worked on,Changes (app),Cells changed,Edits in Google");
    expect(text).toContain("Borhan,Borhan (roster),0.13,0,");
    const xlsx = await runWithProject(isp, () => exportRoute.GET(new NextRequest(`https://assist.example.test/p/isp-digital/api/google-sheets/report-export?period=custom&from=${day}&to=${day}&format=xlsx`)));
    expect(xlsx.headers.get("content-type")).toContain("spreadsheetml");
  });
});
