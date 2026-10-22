import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Google Sheets Phase 2 — the spreadsheet list (GOOGLE_SHEETS.md). The real store and actions
 * against the isolated database, with Google Drive replaced by a fake `fetch`. What must hold:
 *   - the list is built from Drive file METADATA; no spreadsheet is ever opened to build it;
 *   - one sheet per Google file per project, however many connected accounts reach it;
 *   - a refresh is idempotent (an unchanged sheet is never rewritten) and never deletes anything;
 *   - a sheet nobody reaches any more is "no longer reachable", and comes back as the same row;
 *   - a capped listing marks nothing unreachable;
 *   - monitoring survives refreshes and only a manager can change it;
 *   - projects never see each other's sheets.
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
const oauth = await import("@/server/google/oauth");
const store = await import("@/server/google/spreadsheets");
const actions = await import("@/server/actions/googleSheets");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let biz = { id: "", slug: "bizify", name: "Bizify", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);
const inBiz = <T,>(fn: () => Promise<T>) => runWithProject(biz, fn);

// ── A fake Google Drive: each access token lists its own files ────────────────────────────────────
interface FakeFile {
  id: string;
  name?: string;
  modifiedTime?: string;
  webViewLink?: string;
  shared?: boolean;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  capabilities?: { canEdit?: boolean; canShare?: boolean };
}
const drive = {
  filesByToken: new Map<string, FakeFile[]>(),
  failingTokens: new Set<string>(),
  /** Tokens whose listing never ends (more than the cap). */
  endlessTokens: new Set<string>(),
  calls: [] as string[],
  revoked: [] as string[],
  /** Refresh tokens Google still accepts, and the new access token each one gets. */
  refreshable: new Map<string, string>(),
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  drive.calls.push(url.origin + url.pathname);
  if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
    const fresh = drive.refreshable.get(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
    return fresh ? json({ access_token: fresh, expires_in: 3600 }) : json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
  }
  if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) {
    drive.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
    return json({});
  }
  const token = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? "";
  if (url.origin + url.pathname === "https://www.googleapis.com/drive/v3/files") {
    if (drive.failingTokens.has(token)) return json({ error: { code: 500, message: "Backend Error", errors: [{ reason: "backendError" }] } }, 500);
    if (drive.endlessTokens.has(token)) {
      const page = Number(url.searchParams.get("pageToken") ?? "0");
      return json({ files: Array.from({ length: 1000 }, (_, i) => ({ id: `${tag}-endless-${page}-${i}`, name: `Endless ${page}-${i}` })), nextPageToken: String(page + 1) });
    }
    const files = drive.filesByToken.get(token);
    if (!files) return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
    return json({ files });
  }
  return json({ error: "unexpected" }, 404);
};

const fileId = (name: string) => `${tag}-${name}`;
function file(name: string, overrides: Partial<FakeFile> = {}): FakeFile {
  return {
    id: fileId(name),
    name: `${name} sheet`,
    modifiedTime: "2026-10-01T09:00:00.000Z",
    webViewLink: `https://docs.google.com/spreadsheets/d/${fileId(name)}/edit`,
    shared: false,
    owners: [{ displayName: "Rudra", emailAddress: `rudra.${tag}@example.test` }],
    capabilities: { canEdit: true, canShare: true },
    ...overrides,
  };
}

/** A connected account with a valid (unexpired) access token, as Phase 1 leaves it. */
async function connectedAccount(name: string, projectId = ORIGINAL_PROJECT_ID) {
  const access = `access-${name}-${tag}`;
  const row = await rawPrisma.googleIntegrationAccount.create({
    data: {
      projectId,
      googleSubject: `sub-${name}-${tag}`,
      email: `${name}.${tag}@example.test`,
      status: "CONNECTED",
      grantedScopes: ["https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/spreadsheets"],
      refreshTokenCiphertext: encryptSecret(`refresh-${name}-${tag}`),
      accessTokenCiphertext: encryptSecret(access),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  drive.filesByToken.set(access, []);
  return { id: row.id, email: row.email, token: access };
}
const lists = (account: { token: string }, files: FakeFile[]) => drive.filesByToken.set(account.token, files);

// ── People and projects ───────────────────────────────────────────────────────────────────────────
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
  const u = await rawPrisma.user.create({ data: { username: `${name}_${tag}`, email: `${name}_${tag}@example.test`, name, passwordHash: "x", permissionModuleId: roleId } });
  for (const projectId of projectIds) await rawPrisma.projectAccess.create({ data: { projectId, userId: u.id } });
  ids.users.push(u.id);
  return { userId: u.id, username: u.username, email: u.email!, name } as Session;
}
async function setFeature(projectId: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId, key: "GOOGLE_SHEETS" } },
    create: { projectId, key: "GOOGLE_SHEETS", enabled },
    update: { enabled },
  });
  forgetProjectFeatureStates();
}

const sessions = {} as Record<"manager" | "viewer", Session>;
const accounts = {} as Record<"rudra" | "borhan", Awaited<ReturnType<typeof connectedAccount>>>;
let config: ReturnType<typeof oauth.googleOAuthConfig> & object;
const sync = (account: { id: string }, project = isp) => runWithProject(project, () => store.syncAccountSpreadsheets(account.id, { config, fetchImpl: fakeFetch }));
const sheetRow = (name: string, projectId = ORIGINAL_PROJECT_ID) =>
  rawPrisma.googleSpreadsheet.findUniqueOrThrow({ where: { projectId_googleFileId: { projectId, googleFileId: fileId(name) } }, include: { access: true } });
const listAll = (filters: Partial<Parameters<typeof store.listSpreadsheets>[0]> = {}) =>
  inIsp(() => store.listSpreadsheets({ view: "all", page: 1, pageSize: 500, search: tag, ...filters }));

beforeAll(async () => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://assist.example.test");
  vi.stubGlobal("fetch", fakeFetch);
  config = oauth.googleOAuthConfig()!;

  sessions.manager = await user("GsListManager", await role("GS list manage", ["google_sheets.view", "google_sheets.manage"]), [ORIGINAL_PROJECT_ID]);
  sessions.viewer = await user("GsListViewer", await role("GS list view", ["google_sheets.view"]), [ORIGINAL_PROJECT_ID]);
  const existing = await rawPrisma.project.findFirst({ where: { slug: "bizify" } });
  const bizProject = existing ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: sessions.manager.userId }, rawPrisma));
  ids.bizId = bizProject.id;
  biz = { ...biz, id: bizProject.id };
  await setFeature(ORIGINAL_PROJECT_ID, true);
  await setFeature(bizProject.id, true);

  accounts.rudra = await connectedAccount("rudra");
  accounts.borhan = await connectedAccount("borhan");
});

beforeEach(() => {
  current = sessions.manager;
});

afterAll(async () => {
  await rawPrisma.googleSpreadsheet.deleteMany({ where: { googleFileId: { startsWith: tag } } });
  await rawPrisma.googleIntegrationAccount.deleteMany({ where: { googleSubject: { endsWith: tag } } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "GOOGLE_SHEETS", projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1. reading the list from Google", () => {
  it("stores each spreadsheet's details and what the account may do — and opens none of them", async () => {
    lists(accounts.rudra, [
      file("followup", {
        name: "Daily Client Follow-up",
        modifiedTime: "2026-10-08T10:15:00.000Z",
        shared: true,
        lastModifyingUser: { displayName: "Borhan" },
      }),
      file("billing", { name: "Billing tracker", modifiedTime: "2026-10-05T08:00:00.000Z", capabilities: { canEdit: false, canShare: false } }),
    ]);
    drive.calls.length = 0;
    const result = await sync(accounts.rudra);
    expect(result).toEqual({ listed: 2, added: 2, updated: 0, removed: 0, capped: false });

    const followup = await sheetRow("followup");
    expect(followup).toMatchObject({
      name: "Daily Client Follow-up",
      sharedInGoogle: true,
      ownerName: "Rudra",
      lastModifiedByName: "Borhan",
      lastModifiedByEmail: null,
      isMonitored: false,
      removedAt: null,
      webViewLink: `https://docs.google.com/spreadsheets/d/${fileId("followup")}/edit`,
    });
    expect(followup.modifiedTime?.toISOString()).toBe("2026-10-08T10:15:00.000Z");
    expect(followup.access).toEqual([expect.objectContaining({ googleAccountId: accounts.rudra.id, canEdit: true, canShare: true, removedAt: null })]);
    expect((await sheetRow("billing")).access[0]).toMatchObject({ canEdit: false, canShare: false });
    expect(await rawPrisma.googleIntegrationAccount.findUniqueOrThrow({ where: { id: accounts.rudra.id } })).toMatchObject({ spreadsheetCount: 2, lastError: null });

    // Drive file metadata only: not one request to the Sheets API, nothing from inside a sheet.
    expect(new Set(drive.calls)).toEqual(new Set(["https://www.googleapis.com/drive/v3/files"]));
  });

  it("a spreadsheet two connected accounts reach is ONE sheet with two paths", async () => {
    lists(accounts.borhan, [file("followup", { name: "Daily Client Follow-up", modifiedTime: "2026-10-08T10:15:00.000Z", shared: true, capabilities: { canEdit: true, canShare: false } }), file("shared-only", { name: "Borhan's leads", modifiedTime: "2026-10-07T12:00:00.000Z" })]);
    const result = await sync(accounts.borhan);
    expect(result).toMatchObject({ listed: 2, added: 1 });
    expect(await rawPrisma.googleSpreadsheet.count({ where: { googleFileId: fileId("followup") } })).toBe(1);
    const followup = await sheetRow("followup");
    // Borhan's account was not told who last edited it; that does not erase what Rudra's was told.
    expect(followup.lastModifiedByName).toBe("Borhan");
    expect(followup.access.map((a) => [a.googleAccountId, a.canEdit, a.canShare]).sort()).toEqual(
      [
        [accounts.rudra.id, true, true],
        [accounts.borhan.id, true, false],
      ].sort(),
    );
  });

  it("refreshing again with nothing changed rewrites no spreadsheet", async () => {
    const before = await rawPrisma.googleSpreadsheet.findMany({ where: { googleFileId: { startsWith: tag } }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    const result = await sync(accounts.rudra);
    expect(result).toEqual({ listed: 2, added: 0, updated: 0, removed: 0, capped: false });
    const after = await rawPrisma.googleSpreadsheet.findMany({ where: { googleFileId: { startsWith: tag } }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    expect(after).toEqual(before);
    expect(await rawPrisma.googleSpreadsheetAccess.count({ where: { googleAccountId: accounts.rudra.id } })).toBe(2);
  });

  it("a renamed spreadsheet is updated in place", async () => {
    const before = await sheetRow("billing");
    lists(accounts.rudra, [
      file("followup", { name: "Daily Client Follow-up", modifiedTime: "2026-10-08T10:15:00.000Z", shared: true, lastModifyingUser: { displayName: "Borhan" } }),
      file("billing", { name: "Billing tracker 2026", modifiedTime: "2026-10-09T08:00:00.000Z", capabilities: { canEdit: false, canShare: false } }),
    ]);
    const result = await sync(accounts.rudra);
    expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 });
    const after = await sheetRow("billing");
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Billing tracker 2026");
  });
});

describe("2. spreadsheets that go away", () => {
  it("losing one path keeps a sheet another account reaches; losing the last makes it 'no longer reachable' — never deleted", async () => {
    lists(accounts.borhan, []);
    const result = await sync(accounts.borhan);
    expect(result).toMatchObject({ listed: 0, removed: 2 });

    const followup = await sheetRow("followup");
    expect(followup.removedAt).toBeNull();
    expect(followup.access.find((a) => a.googleAccountId === accounts.borhan.id)?.removedAt).not.toBeNull();
    const leads = await sheetRow("shared-only");
    expect(leads.removedAt).not.toBeNull();

    const unreachable = await listAll({ view: "unreachable" });
    expect(unreachable.rows.map((r) => r.googleFileId)).toEqual([fileId("shared-only")]);
    expect((await listAll()).rows.map((r) => r.googleFileId)).not.toContain(fileId("shared-only"));
  });

  it("a spreadsheet seen again comes back as the same row", async () => {
    const before = await sheetRow("shared-only");
    lists(accounts.borhan, [file("shared-only", { name: "Borhan's leads", modifiedTime: "2026-10-07T12:00:00.000Z" })]);
    await sync(accounts.borhan);
    const after = await sheetRow("shared-only");
    expect(after.id).toBe(before.id);
    expect(after.removedAt).toBeNull();
    expect(after.access.find((a) => a.googleAccountId === accounts.borhan.id)?.removedAt).toBeNull();
  });

  it("a list cut off at the cap marks nothing unreachable, since the rest is unknown", async () => {
    const big = await connectedAccount("big");
    lists(big, [file("big-only", { name: "Only on the big account" })]);
    await sync(big);
    drive.endlessTokens.add(big.token);
    const result = await sync(big);
    drive.endlessTokens.delete(big.token);
    expect(result).toMatchObject({ capped: true, listed: 10_000, removed: 0 });
    const kept = await sheetRow("big-only");
    expect(kept.removedAt).toBeNull();
    expect(kept.access[0]!.removedAt).toBeNull();
  }, 60_000);

  it("disconnecting an account closes its paths: a sheet only it reached is no longer reachable", async () => {
    const result = await inIsp(() => actions.disconnectGoogleAccountAction(accounts.borhan.id));
    expect(result.success).toBeTruthy();
    expect((await sheetRow("shared-only")).removedAt).not.toBeNull();
    const followup = await sheetRow("followup");
    expect(followup.removedAt).toBeNull();
    expect(followup.access.filter((a) => a.removedAt === null).map((a) => a.googleAccountId)).toEqual([accounts.rudra.id]);
  });
});

describe("3. monitoring", () => {
  it("only a manager marks a spreadsheet; the mark survives refreshes and is logged", async () => {
    const followup = await sheetRow("followup");
    current = sessions.viewer;
    expect((await inIsp(() => actions.setSpreadsheetMonitoringAction(followup.id, true))).error).toBeTruthy();
    expect((await sheetRow("followup")).isMonitored).toBe(false);

    current = sessions.manager;
    expect((await inIsp(() => actions.setSpreadsheetMonitoringAction(followup.id, true))).success).toMatch(/is monitored/);
    expect(await sheetRow("followup")).toMatchObject({ isMonitored: true, monitoredByUsername: sessions.manager.username });
    expect(await rawPrisma.systemLog.count({ where: { targetId: followup.id, message: { contains: "is monitored" } } })).toBe(1);

    await sync(accounts.rudra);
    expect((await sheetRow("followup")).isMonitored).toBe(true);
    expect((await listAll({ view: "monitored" })).rows.map((r) => r.googleFileId)).toEqual([fileId("followup")]);
  });
});

describe("4. the list", () => {
  it("searches by name or spreadsheet id, filters by account and view, newest first", async () => {
    const all = await listAll();
    expect(all.rows[0]!.googleFileId).toBe(fileId("billing")); // modified 9 Oct, the newest
    expect(all.rows.map((r) => r.modifiedTime?.getTime() ?? 0)).toEqual([...all.rows.map((r) => r.modifiedTime?.getTime() ?? 0)].sort((a, b) => b - a));

    // By name, any case (this test's own rows only: the shared test database may hold others).
    const byName = (await listAll({ search: "follow-up" })).rows.filter((r) => r.googleFileId.startsWith(tag));
    expect(byName.map((r) => r.name)).toEqual(["Daily Client Follow-up"]);
    expect((await listAll({ search: fileId("billing") })).rows.map((r) => r.googleFileId)).toEqual([fileId("billing")]);
    const viaRudra = await listAll({ accountId: accounts.rudra.id });
    expect(viaRudra.rows.every((r) => r.paths.some((p) => p.accountId === accounts.rudra.id))).toBe(true);
    expect(viaRudra.rows.map((r) => r.googleFileId)).not.toContain(fileId("shared-only"));
    // The account filter means "reaches it NOW": Borhan's account is disconnected.
    expect((await listAll({ accountId: accounts.borhan.id })).rows).toEqual([]);

    expect(all.counts.monitored + all.counts.unmonitored).toBe(all.counts.all);
    expect(all.counts.unreachable).toBe(1);
    // Paths name the account, never a token.
    expect(JSON.stringify(all)).not.toMatch(/access-|refresh-|Ciphertext/);
  });
});

describe("5. projects stay apart", () => {
  it("the same Google file in another project is that project's own row, invisible and untouchable from here", async () => {
    const bizAccount = await connectedAccount("bizowner", ids.bizId);
    lists(bizAccount, [file("followup", { name: "Bizify copy of the follow-up" })]);
    await sync(bizAccount, biz);

    const bizSheet = await sheetRow("followup", ids.bizId);
    expect(bizSheet.id).not.toBe((await sheetRow("followup")).id);
    expect((await listAll()).rows.map((r) => r.id)).not.toContain(bizSheet.id);
    expect((await inBiz(() => store.listSpreadsheets({ view: "all", page: 1, pageSize: 500, search: tag }))).rows.map((r) => r.id)).toEqual([bizSheet.id]);

    expect((await inIsp(() => actions.setSpreadsheetMonitoringAction(bizSheet.id, true))).error).toMatch(/not in this project/);
    expect((await sheetRow("followup", ids.bizId)).isMonitored).toBe(false);
    await expect(inIsp(() => store.syncAccountSpreadsheets(bizAccount.id, { config, fetchImpl: fakeFetch }))).rejects.toThrow(/not connected to this project/);
  });
});

describe("6. refreshing from the page", () => {
  it("needs the manage permission — and asks Google nothing for someone without it", async () => {
    current = sessions.viewer;
    drive.calls.length = 0;
    expect((await inIsp(() => actions.refreshAllGoogleSpreadsheetsAction())).error).toBeTruthy();
    expect((await inIsp(() => actions.refreshGoogleSpreadsheetsAction(accounts.rudra.id))).error).toBeTruthy();
    expect(drive.calls).toEqual([]);
  });

  it("reads every connected account, and names the one Google would not answer for", async () => {
    const other = await connectedAccount("other");
    lists(other, [file("other-sheet", { name: "Other sheet" })]);
    drive.failingTokens.add(accounts.rudra.token);
    const result = await inIsp(() => actions.refreshAllGoogleSpreadsheetsAction());
    drive.failingTokens.delete(accounts.rudra.token);
    expect(result.error).toContain(accounts.rudra.email);
    expect((await sheetRow("other-sheet")).removedAt).toBeNull();
    // A failed read never marks anything unreachable.
    expect((await sheetRow("followup")).removedAt).toBeNull();
    expect((await rawPrisma.googleIntegrationAccount.findUniqueOrThrow({ where: { id: accounts.rudra.id } })).lastError).toMatch(/Could not read the spreadsheet list/);

    const ok = await inIsp(() => actions.refreshGoogleSpreadsheetsAction(accounts.rudra.id));
    expect(ok.success).toMatch(/2 spreadsheets accessible/);
  });
});

describe("7. a cached token Google no longer accepts", () => {
  it("is refreshed once and the listing retried", async () => {
    const stale = await connectedAccount("stale");
    drive.filesByToken.delete(stale.token); // Google now answers 401 to the cached token
    drive.refreshable.set(`refresh-stale-${tag}`, `access-stale-new-${tag}`);
    drive.filesByToken.set(`access-stale-new-${tag}`, [file("stale-sheet", { name: "Stale sheet" })]);
    const result = await sync(stale);
    expect(result.listed).toBe(1);
    const row = await rawPrisma.googleIntegrationAccount.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row).toMatchObject({ status: "CONNECTED", lastError: null, spreadsheetCount: 1 });
  });

  it("and when Google refuses the refresh too, the account needs reconnecting — not an hour of 401s", async () => {
    const revoked = await connectedAccount("revoked");
    drive.filesByToken.delete(revoked.token);
    await expect(sync(revoked)).rejects.toThrow(/needs to be connected again/);
    expect(await rawPrisma.googleIntegrationAccount.findUniqueOrThrow({ where: { id: revoked.id } })).toMatchObject({
      status: "NEEDS_RECONNECT",
      refreshTokenCiphertext: null,
      accessTokenCiphertext: null,
    });
  });
});
