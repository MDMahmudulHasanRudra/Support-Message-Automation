import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { GoogleSheetMemberRole } from "@prisma/client";
import { createProjectWithDefaults, encryptSecret, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { NOT_ALLOWED_TO_STAFF, ONLY_MANAGER_FOR_LEADS, PERMISSIONS, SHEET_MEMBER_ROLES } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Google Sheets Phase 5 — sheet members (GOOGLE_SHEETS.md §5), against the isolated database. The
 * shared-team-sheet story, end to end:
 *
 *   Daily Client Follow-up — Lead: Rudra · Editors: Borhan, Istiyak, Khairul · Monitor: CTO
 *
 * What must hold: a Lead staffs the sheet and stays a working member; several people work on it at
 * once; the CTO monitors without ever counting as working; Google Drive's sharing is shown but never
 * becomes membership; membership is history; attribution is the person who acted, through the
 * explicit login ↔ team member link, never the owner, the creator or the connected Google account.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

let current: Session;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[], bizId: "" };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/isp-digital${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const members = await import("@/server/google/members");
const store = await import("@/server/google/spreadsheets");
const oauth = await import("@/server/google/oauth");
const actions = await import("@/server/actions/googleSheetMembers");
const teamActions = await import("@/server/actions/teamMembers");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" | "SUSPENDED" | "ARCHIVED" };
const isp: Project = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" };
let biz: Project = { id: "", slug: "bizify", name: "Bizify", status: "ACTIVE" };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);

// ── A fake Google: the sharing list (Drive permissions.list) and the file listing ────────────────────
const google = {
  sharing: new Map<string, { status: number; body: unknown }>(),
  files: new Map<string, unknown[]>(),
  calls: [] as string[],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  google.calls.push(url.pathname);
  const permissions = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(url.pathname);
  if (permissions) {
    const answer = google.sharing.get(decodeURIComponent(permissions[1]!));
    return answer ? json(answer.body, answer.status) : json({ error: { code: 404, message: "File not found" } }, 404);
  }
  if (url.pathname === "/drive/v3/files") {
    const token = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? "";
    return json({ files: google.files.get(token) ?? [] });
  }
  return json({ error: "unexpected" }, 404);
};

// ── People ──────────────────────────────────────────────────────────────────────────────────────────
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
async function user(name: string, roleId: string, projectIds: string[], isActive = true): Promise<Session> {
  const u = await rawPrisma.user.create({
    data: { username: `${name.toLowerCase()}_${tag}`, email: `${name.toLowerCase()}.${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId, isActive },
  });
  for (const projectId of projectIds) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
let phone = 0;
const rosterMember = (name: string, userId: string | null, projectId = ORIGINAL_PROJECT_ID) =>
  rawPrisma.internalTeamMember.create({ data: { projectId, name, phoneNumber: `8801${tag.replace(/\D/g, "").padEnd(6, "7").slice(0, 6)}${String(++phone).padStart(3, "0")}`, role: "Support", userId } });

async function setFeature(projectId: string) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId, key: "GOOGLE_SHEETS" } },
    create: { projectId, key: "GOOGLE_SHEETS", enabled: true },
    update: { enabled: true },
  });
  forgetProjectFeatureStates();
}

const people = {} as Record<"manager" | "rudra" | "borhan" | "istiyak" | "khairul" | "cto" | "viewer" | "outsider" | "inactive" | "bizOnly", Session>;
const team = {} as Record<"rudra" | "borhan" | "istiyak" | "khairulDecoy", { id: string }>;
const sheets = {} as Record<"followup" | "biz" | "unstaffed", { id: string; googleFileId: string }>;
let connectedAccountId = "";

async function sheet(name: string, projectId: string, owner: Session, canShare = true) {
  const googleFileId = `${tag}-${name}`;
  const row = await rawPrisma.googleSpreadsheet.create({
    data: { projectId, googleFileId, name, ownerEmail: owner.email, ownerName: owner.name, sharedInGoogle: true },
  });
  const accountId = projectId === ORIGINAL_PROJECT_ID ? connectedAccountId : undefined;
  if (accountId) await rawPrisma.googleSpreadsheetAccess.create({ data: { projectId, spreadsheetId: row.id, googleAccountId: accountId, canEdit: true, canShare } });
  return { id: row.id, googleFileId };
}

const as = async <T,>(person: Session, fn: () => Promise<T>, project: Project = isp) => {
  current = person;
  return runWithProject(project, fn);
};
const add = (person: Session, sheetId: string, target: Session, memberRole: string, project: Project = isp) => {
  const form = new FormData();
  form.set("userId", target.userId);
  form.set("role", memberRole);
  return as(person, () => actions.addSheetMemberAction(sheetId, {}, form), project);
};
const openRows = (sheetId: string) => rawPrisma.googleSpreadsheetMember.findMany({ where: { spreadsheetId: sheetId, endedAt: null }, orderBy: { startedAt: "asc" } });

beforeAll(async () => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://assist.example.test");
  vi.stubGlobal("fetch", fakeFetch);

  const managerRole = await role("GS members manager", ["google_sheets.view", "google_sheets.manage", "whatsapp.manage"]);
  const editorRole = await role("GS members editor", ["google_sheets.view", "google_sheets.edit"]);
  const monitorRole = await role("GS members monitor", ["google_sheets.view", "google_sheets.monitor", "google_sheets.report"]);
  const viewerRole = await role("GS members viewer", ["google_sheets.view"]);

  const existing = await rawPrisma.project.findFirst({ where: { slug: "bizify" } });
  people.manager = await user("Manager", managerRole, [ORIGINAL_PROJECT_ID]);
  const bizProject = existing ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma));
  ids.bizId = bizProject.id;
  biz = { ...biz, id: bizProject.id };
  await rawPrisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: bizProject.id, userId: people.manager.userId } },
    create: { projectId: bizProject.id, userId: people.manager.userId },
    update: {},
  });

  people.rudra = await user("Rudra", editorRole, [ORIGINAL_PROJECT_ID]); // the Lead: edit, NOT manage
  people.borhan = await user("Borhan", editorRole, [ORIGINAL_PROJECT_ID]);
  people.istiyak = await user("Istiyak", editorRole, [ORIGINAL_PROJECT_ID]);
  people.khairul = await user("Khairul", editorRole, [ORIGINAL_PROJECT_ID]);
  people.cto = await user("CTO", monitorRole, [ORIGINAL_PROJECT_ID]);
  people.viewer = await user("Viewer", viewerRole, [ORIGINAL_PROJECT_ID]);
  people.outsider = await user("Outsider", editorRole, []);
  people.inactive = await user("Inactive", editorRole, [ORIGINAL_PROJECT_ID], false);
  people.bizOnly = await user("BizOnly", editorRole, [bizProject.id]);
  await setFeature(ORIGINAL_PROJECT_ID);
  await setFeature(bizProject.id);

  team.rudra = await rosterMember("Rudra (roster)", people.rudra.userId);
  team.borhan = await rosterMember("Borhan (roster)", people.borhan.userId);
  team.istiyak = await rosterMember("Istiyak (roster)", people.istiyak.userId);
  // Same name as the Khairul login, NOT linked: the app must never pair them by name.
  team.khairulDecoy = await rosterMember("Khairul", null);

  const account = await rawPrisma.googleIntegrationAccount.create({
    data: {
      projectId: ORIGINAL_PROJECT_ID,
      googleSubject: `sub-rudra-${tag}`,
      email: people.rudra.email,
      status: "CONNECTED",
      refreshTokenCiphertext: encryptSecret(`refresh-${tag}`),
      accessTokenCiphertext: encryptSecret(`access-${tag}`),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      connectedById: people.rudra.userId, // Rudra connected his own Google account…
    },
  });
  connectedAccountId = account.id;
  // …and owns the file in Google. Neither makes him anything in the app.
  sheets.followup = await sheet("Daily Client Follow-up", ORIGINAL_PROJECT_ID, people.rudra);
  sheets.unstaffed = await sheet("Unstaffed", ORIGINAL_PROJECT_ID, people.rudra, false);
  sheets.biz = await sheet("Bizify sheet", bizProject.id, people.manager);
});

beforeEach(() => {
  current = people.manager;
});

afterAll(async () => {
  const sheetIds = (await rawPrisma.googleSpreadsheet.findMany({ where: { googleFileId: { startsWith: tag } }, select: { id: true } })).map((s) => s.id);
  await rawPrisma.googleSpreadsheetMember.deleteMany({ where: { spreadsheetId: { in: sheetIds } } });
  await rawPrisma.googleSpreadsheet.deleteMany({ where: { id: { in: sheetIds } } });
  await rawPrisma.googleIntegrationAccount.deleteMany({ where: { googleSubject: { endsWith: tag } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: Object.values(team).map((t) => t.id) } } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "GOOGLE_SHEETS", projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId, ...ids.projects] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("0. the roles", () => {
  it("the database's roles are exactly the shared rules' roles", () => {
    expect(Object.values(GoogleSheetMemberRole)).toEqual([...SHEET_MEMBER_ROLES]);
  });
});

describe("1. staffing a shared sheet", () => {
  it("nobody is a member by default — not the owner in Google, and not whoever connected the account", async () => {
    expect((await inIsp(() => members.getSheetMembers(sheets.followup.id)))!.current).toEqual([]);
    const rudra = await inIsp(() => members.resolveSheetActor(sheets.followup.id, people.rudra.userId));
    expect(rudra).toMatchObject({ userId: people.rudra.userId, role: null, canWork: false });
  });

  it("a manager makes Rudra the Lead; the Lead adds three editors and a monitor", async () => {
    expect((await add(people.manager, sheets.followup.id, people.rudra, "LEAD")).success).toMatch(/now lead/);
    for (const editor of [people.borhan, people.istiyak, people.khairul]) {
      expect((await add(people.rudra, sheets.followup.id, editor, "EDITOR")).success).toMatch(/now editor/);
    }
    expect((await add(people.rudra, sheets.followup.id, people.cto, "MONITOR")).success).toMatch(/now monitor/);

    const view = (await inIsp(() => members.getSheetMembers(sheets.followup.id)))!;
    expect(view.current.map((m) => [m.name, m.role])).toEqual([
      ["Rudra", "LEAD"],
      ["Borhan", "EDITOR"],
      ["Istiyak", "EDITOR"],
      ["Khairul", "EDITOR"],
      ["CTO", "MONITOR"],
    ]);
    // Every change is recorded with who made it.
    const logs = await rawPrisma.systemLog.findMany({ where: { targetId: sheets.followup.id, scope: "google-sheets" }, select: { actorUserId: true, message: true } });
    expect(logs.filter((l) => l.actorUserId === people.manager.userId).map((l) => l.message)).toEqual([`Rudra added to spreadsheet "Daily Client Follow-up" as lead`]);
    expect(logs.filter((l) => l.actorUserId === people.rudra.userId)).toHaveLength(4);
  });

  it("the Lead stays a working member, alongside the editors working on the same sheet", async () => {
    const view = (await inIsp(() => members.getSheetMembers(sheets.followup.id)))!;
    const byName = Object.fromEntries(view.current.map((m) => [m.name, m]));
    for (const name of ["Rudra", "Borhan", "Istiyak", "Khairul"]) expect(byName[name]!.canWorkThroughApp).toBe(true);
    expect(byName.CTO!.canWorkThroughApp).toBe(false);
    for (const person of [people.rudra, people.borhan, people.istiyak]) {
      expect(await inIsp(() => members.resolveSheetActor(sheets.followup.id, person.userId))).toMatchObject({ userId: person.userId, canWork: true });
    }
  });

  it("an Editor whose role lacks the edit permission is shown as not able to work through the app yet", async () => {
    await add(people.manager, sheets.followup.id, people.viewer, "EDITOR");
    const view = (await inIsp(() => members.getSheetMembers(sheets.followup.id)))!;
    expect(view.current.find((m) => m.userId === people.viewer.userId)).toMatchObject({ role: "EDITOR", canWorkThroughApp: false });
    await as(people.manager, () => actions.removeSheetMemberAction(sheets.followup.id, people.viewer.userId));
  });
});

describe("2. who may change the members", () => {
  it("a Lead cannot appoint, re-role or remove a Lead — themselves included", async () => {
    expect((await add(people.rudra, sheets.followup.id, people.viewer, "LEAD")).error).toBe(ONLY_MANAGER_FOR_LEADS);
    expect((await as(people.rudra, () => actions.changeSheetMemberRoleAction(sheets.followup.id, people.borhan.userId, "LEAD"))).error).toBe(ONLY_MANAGER_FOR_LEADS);
    expect((await as(people.rudra, () => actions.changeSheetMemberRoleAction(sheets.followup.id, people.rudra.userId, "EDITOR"))).error).toBe(ONLY_MANAGER_FOR_LEADS);
    expect((await as(people.rudra, () => actions.removeSheetMemberAction(sheets.followup.id, people.rudra.userId))).error).toBe(ONLY_MANAGER_FOR_LEADS);
    expect((await openRows(sheets.followup.id)).find((r) => r.userId === people.rudra.userId)?.role).toBe("LEAD");
  });

  it("an editor, the monitor and a viewer change nothing", async () => {
    const before = await openRows(sheets.followup.id);
    for (const person of [people.borhan, people.cto, people.viewer]) {
      const result = await add(person, sheets.followup.id, people.viewer, "EDITOR");
      expect(result.error).toBeTruthy();
      expect([NOT_ALLOWED_TO_STAFF, "You do not have permission to perform this action."]).toContain(result.error);
      expect((await as(person, () => actions.removeSheetMemberAction(sheets.followup.id, people.istiyak.userId))).error).toBeTruthy();
    }
    expect(await openRows(sheets.followup.id)).toEqual(before);
  });

  it("only logins that may enter this project, and are active, can be added", async () => {
    expect((await add(people.manager, sheets.followup.id, people.outsider, "EDITOR")).error).toMatch(/cannot enter this project/);
    expect((await add(people.manager, sheets.followup.id, people.inactive, "EDITOR")).error).toMatch(/cannot enter this project/);
    expect((await add(people.manager, sheets.followup.id, people.bizOnly, "EDITOR")).error).toMatch(/cannot enter this project/);
  });

  it("one membership per person: a second add is refused, and two at once still make one", async () => {
    expect((await add(people.rudra, sheets.followup.id, people.borhan, "MONITOR")).error).toMatch(/already editor/);
    const results = await Promise.all([
      inIsp(() => members.addSheetMember({ spreadsheetId: sheets.followup.id, userId: people.viewer.userId, role: "MONITOR", actor: { userId: people.manager.userId, hasManage: true, hasEdit: false } })),
      inIsp(() => members.addSheetMember({ spreadsheetId: sheets.followup.id, userId: people.viewer.userId, role: "MONITOR", actor: { userId: people.manager.userId, hasManage: true, hasEdit: false } })),
    ].map((p) => p.then(() => "ok", (err: Error) => err.message)));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect((await openRows(sheets.followup.id)).filter((r) => r.userId === people.viewer.userId)).toHaveLength(1);
    await as(people.manager, () => actions.removeSheetMemberAction(sheets.followup.id, people.viewer.userId));
  });
});

describe("3. membership is history", () => {
  it("moving Borhan from editor to monitor ends one period and starts the next at the same instant", async () => {
    expect((await as(people.rudra, () => actions.changeSheetMemberRoleAction(sheets.followup.id, people.borhan.userId, "MONITOR"))).success).toMatch(/now monitor/);
    const rows = await rawPrisma.googleSpreadsheetMember.findMany({ where: { spreadsheetId: sheets.followup.id, userId: people.borhan.userId }, orderBy: { startedAt: "asc" } });
    expect(rows.map((r) => [r.role, r.endReason])).toEqual([
      ["EDITOR", "ROLE_CHANGED"],
      ["MONITOR", null],
    ]);
    expect(rows[0]!.endedAt!.getTime()).toBe(rows[1]!.startedAt.getTime());
    expect(rows[0]!.endedById).toBe(people.rudra.userId);

    const justBefore = new Date(rows[1]!.startedAt.getTime() - 1);
    expect(await inIsp(() => members.resolveSheetActor(sheets.followup.id, people.borhan.userId, justBefore))).toMatchObject({ role: "EDITOR", canWork: true });
    expect(await inIsp(() => members.resolveSheetActor(sheets.followup.id, people.borhan.userId, rows[1]!.startedAt))).toMatchObject({ role: "MONITOR", canWork: false });

    await as(people.rudra, () => actions.changeSheetMemberRoleAction(sheets.followup.id, people.borhan.userId, "EDITOR"));
    expect(await rawPrisma.googleSpreadsheetMember.count({ where: { spreadsheetId: sheets.followup.id, userId: people.borhan.userId } })).toBe(3);
  });

  it("removing ends the period and keeps it; adding back opens a new one", async () => {
    expect((await as(people.rudra, () => actions.removeSheetMemberAction(sheets.followup.id, people.istiyak.userId))).success).toMatch(/history is kept/);
    const ended = await rawPrisma.googleSpreadsheetMember.findFirstOrThrow({ where: { spreadsheetId: sheets.followup.id, userId: people.istiyak.userId } });
    expect(ended).toMatchObject({ endReason: "REMOVED", endedById: people.rudra.userId });
    expect((await openRows(sheets.followup.id)).map((r) => r.userId)).not.toContain(people.istiyak.userId);

    await add(people.rudra, sheets.followup.id, people.istiyak, "EDITOR");
    const rows = await rawPrisma.googleSpreadsheetMember.findMany({ where: { spreadsheetId: sheets.followup.id, userId: people.istiyak.userId }, orderBy: { startedAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(ended.id);
    expect(rows[1]!.endedAt).toBeNull();
    expect((await inIsp(() => members.getSheetMembers(sheets.followup.id)))!.history.length).toBeGreaterThanOrEqual(2);
  });
});

describe("4. attribution: the person who acted, through the explicit link", () => {
  it("is the acting login and its linked team member — never the owner or the connected account", async () => {
    const borhan = await inIsp(() => members.resolveSheetActor(sheets.followup.id, people.borhan.userId));
    expect(borhan).toMatchObject({ userId: people.borhan.userId, teamMemberId: team.borhan.id, role: "EDITOR", canWork: true });
    expect(borhan!.userId).not.toBe(people.rudra.userId);
  });

  it("a login with no link stays unlinked — a roster member with the same name is not guessed", async () => {
    const khairul = await inIsp(() => members.resolveSheetActor(sheets.followup.id, people.khairul.userId));
    expect(khairul).toMatchObject({ userId: people.khairul.userId, teamMemberId: null, teamMemberName: null });
    const view = (await inIsp(() => members.getSheetMembers(sheets.followup.id)))!;
    expect(view.current.find((m) => m.userId === people.khairul.userId)!.teamMember).toBeNull();
  });

  it("linking a login to a team member is explicit, audited, and followed from then on", async () => {
    const decoy = team.khairulDecoy.id;
    const form = new FormData();
    form.set("userId", people.khairul.userId);
    expect(await as(people.manager, () => teamActions.linkTeamMemberLogin(decoy, {}, form))).toEqual({ saved: true });
    expect(await inIsp(() => members.resolveSheetActor(sheets.followup.id, people.khairul.userId))).toMatchObject({ teamMemberId: decoy });
    const log = await rawPrisma.systemLog.findFirst({ where: { targetId: decoy, scope: "team-members" }, select: { actorUserId: true, message: true } });
    expect(log).toMatchObject({ actorUserId: people.manager.userId, message: `Team member Khairul linked to login ${people.khairul.username}` });

    const unlink = new FormData();
    unlink.set("userId", "");
    await as(people.manager, () => teamActions.linkTeamMemberLogin(decoy, {}, unlink));
    expect(await inIsp(() => members.resolveSheetActor(sheets.followup.id, people.khairul.userId))).toMatchObject({ teamMemberId: null });
    expect(await rawPrisma.systemLog.count({ where: { targetId: decoy, scope: "team-members" } })).toBe(2);
  });

  it("reading Google's list of spreadsheets creates no member for the owner or the connecting account", async () => {
    // Google lists everything the account reaches: the sheets above, and one it has not seen before.
    const owner = [{ displayName: "Rudra", emailAddress: people.rudra.email }];
    google.files.set(`access-${tag}`, [
      { id: sheets.followup.googleFileId, name: "Daily Client Follow-up", owners: owner, capabilities: { canEdit: true, canShare: true } },
      { id: sheets.unstaffed.googleFileId, name: "Unstaffed", owners: owner, capabilities: { canEdit: true, canShare: false } },
      { id: `${tag}-from-google`, name: "From Google", owners: owner, capabilities: { canEdit: true, canShare: true } },
    ]);
    await inIsp(() => store.syncAccountSpreadsheets(connectedAccountId, { config: oauth.googleOAuthConfig()!, fetchImpl: fakeFetch }));
    const fresh = await rawPrisma.googleSpreadsheet.findFirstOrThrow({ where: { googleFileId: `${tag}-from-google` } });
    expect(await rawPrisma.googleSpreadsheetMember.count({ where: { spreadsheetId: fresh.id } })).toBe(0);
    expect(await inIsp(() => members.resolveSheetActor(fresh.id, people.rudra.userId))).toMatchObject({ role: null, canWork: false });
  });
});

describe("5. Google Drive's sharing is shown, never copied into members", () => {
  it("the Lead sees Google's list; the app's roles do not move", async () => {
    google.sharing.set(sheets.followup.googleFileId, {
      status: 200,
      body: {
        permissions: [
          { type: "user", role: "owner", emailAddress: people.rudra.email, displayName: "Rudra" },
          { type: "user", role: "writer", emailAddress: people.borhan.email, displayName: "Borhan" },
          // Google says the CTO may edit the file; in the app the CTO stays a monitor.
          { type: "user", role: "writer", emailAddress: people.cto.email, displayName: "CTO" },
          { type: "user", role: "writer", emailAddress: `stranger.${tag}@example.test`, displayName: "Stranger" },
          { type: "anyone", role: "reader" },
        ],
      },
    });
    const before = await openRows(sheets.followup.id);
    const result = await as(people.rudra, () => actions.readGoogleSharingAction(sheets.followup.id));
    expect("sharing" in result && result.sharing.visible).toBe(true);
    if ("sharing" in result && result.sharing.visible) {
      expect(result.sharing.entries.map((e) => [e.emailAddress, e.role])).toContainEqual([people.cto.email, "writer"]);
      expect(result.sharing.via).toBe(people.rudra.email);
    }
    expect(await openRows(sheets.followup.id)).toEqual(before);
    expect((await openRows(sheets.followup.id)).find((r) => r.userId === people.cto.userId)?.role).toBe("MONITOR");
    expect(JSON.stringify(result)).not.toMatch(/access-|refresh-|Ciphertext/);
  });

  it("is shown only to the people who staff the sheet", async () => {
    expect((await as(people.borhan, () => actions.readGoogleSharingAction(sheets.followup.id)))).toHaveProperty("error");
    expect((await as(people.cto, () => actions.readGoogleSharingAction(sheets.followup.id)))).toHaveProperty("error");
  });

  it("says so when no connected account may see it, or Google refuses", async () => {
    google.calls.length = 0;
    const none = await as(people.manager, () => actions.readGoogleSharingAction(sheets.unstaffed.id));
    expect(none).toMatchObject({ sharing: { visible: false, reason: expect.stringMatching(/can share/) } });
    expect(google.calls).toEqual([]); // nothing was even asked of Google
    google.sharing.set(sheets.followup.googleFileId, { status: 403, body: { error: { code: 403, message: "The user does not have sufficient permissions", errors: [{ reason: "insufficientFilePermissions" }] } } });
    const refused = await as(people.manager, () => actions.readGoogleSharingAction(sheets.followup.id));
    expect(refused).toMatchObject({ sharing: { visible: false } });
  });
});

describe("6. projects and read-only projects", () => {
  it("another project's spreadsheet is unreachable from here", async () => {
    expect((await add(people.manager, sheets.biz.id, people.rudra, "EDITOR")).error).toMatch(/not in this project/);
    expect(await inIsp(() => members.getSheetMembers(sheets.biz.id))).toBeNull();
    expect(await rawPrisma.googleSpreadsheetMember.count({ where: { spreadsheetId: sheets.biz.id } })).toBe(0);
  });

  it("a suspended project changes no member", async () => {
    const suspended: Project = { ...isp, status: "SUSPENDED" };
    const result = await add(people.manager, sheets.followup.id, people.viewer, "EDITOR", suspended);
    expect(result.error).toMatch(/suspended/i);
    expect((await openRows(sheets.followup.id)).map((r) => r.userId)).not.toContain(people.viewer.userId);
  });
});
