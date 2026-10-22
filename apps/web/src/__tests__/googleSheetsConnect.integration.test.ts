import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, decryptSecret, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Google Sheets Phase 1 — connecting Google accounts (GOOGLE_SHEETS.md). The real routes, actions and
 * account store against the isolated database, with Google replaced by a fake `fetch` that speaks its
 * token, identity, Drive and revoke endpoints. What must hold:
 *   - only a person with google_sheets.manage, in a project with the feature on, can connect;
 *   - Google's answer is accepted only with our sealed state, for the same person, once;
 *   - tokens are stored encrypted and never returned; the client secret never leaves the server;
 *   - reconnecting the same Google account reuses its row; projects and accounts stay apart;
 *   - a revoked grant becomes NEEDS_RECONNECT; disconnecting wipes tokens and keeps the row.
 */

// Tokens are sealed with the app's credential key; the isolated script does not set one for the web.
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
const accounts = await import("@/server/google/accounts");
const actions = await import("@/server/actions/googleSheets");
const connectRoute = await import("@/app/p/[project]/api/google-sheets/connect/route");
const callbackRoute = await import("@/app/api/google/oauth/callback/route");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let biz = { id: "", slug: "bizify", name: "Bizify", status: "ACTIVE" as const };
const inIsp = <T,>(fn: () => Promise<T>) => runWithProject(isp, fn);
const inBiz = <T,>(fn: () => Promise<T>) => runWithProject(biz, fn);

// ── A fake Google ───────────────────────────────────────────────────────────────────────────────
interface FakeAccount {
  code: string;
  sub: string;
  email: string;
  refresh: string;
  access: string;
  scopes: string[];
  sheets: number;
  noRefreshToken?: boolean;
}
const FULL_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/spreadsheets"];
const google = {
  byCode: new Map<string, FakeAccount>(),
  byAccess: new Map<string, FakeAccount>(),
  byRefresh: new Map<string, FakeAccount>(),
  revoked: [] as string[],
  refreshCalls: 0,
  refreshFailure: null as string | null,
  calls: [] as string[],
};
function fakeAccount(name: string, overrides: Partial<FakeAccount> = {}): FakeAccount {
  const account: FakeAccount = {
    code: `code-${name}-${tag}`,
    sub: `sub-${name}-${tag}`,
    email: `${name}.${tag}@example.test`,
    refresh: `refresh-${name}-${tag}`,
    access: `access-${name}-${tag}`,
    scopes: FULL_SCOPES,
    sheets: 24,
    ...overrides,
  };
  google.byCode.set(account.code, account);
  google.byRefresh.set(account.refresh, account);
  google.byAccess.set(account.access, account);
  return account;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  google.calls.push(url.origin + url.pathname);
  const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? "";
  if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
    const body = new URLSearchParams(String(init?.body));
    if (body.get("client_secret") !== "test-secret") return json({ error: "invalid_client" }, 401);
    if (body.get("grant_type") === "authorization_code") {
      const account = google.byCode.get(body.get("code") ?? "");
      if (!account || !body.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: account.access, ...(account.noRefreshToken ? {} : { refresh_token: account.refresh }), expires_in: 3600, scope: account.scopes.join(" ") });
    }
    google.refreshCalls += 1;
    if (google.refreshFailure) return json({ error: google.refreshFailure }, 400);
    const account = google.byRefresh.get(body.get("refresh_token") ?? "");
    if (!account) return json({ error: "invalid_grant" }, 400);
    account.access = `${account.access}-r`;
    google.byAccess.set(account.access, account);
    return json({ access_token: account.access, expires_in: 3600, scope: account.scopes.join(" ") });
  }
  if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) {
    google.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
    return json({});
  }
  const account = google.byAccess.get(bearer);
  if (!account) return json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401);
  if (url.pathname === "/v1/userinfo") return json({ sub: account.sub, email: account.email, name: `Name ${account.email}` });
  if (url.pathname === "/drive/v3/files") return json({ files: Array.from({ length: account.sheets }, (_, i) => ({ id: `${account.sub}-${i}` })) });
  return json({ error: "unexpected" }, 404);
};

// ── People and projects ─────────────────────────────────────────────────────────────────────────
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

const sessions = {} as Record<"manager" | "viewer" | "other", Session>;

// These tests are written around the original installation as it exists in production ("ISP
// Digital", /p/isp-digital). A database created after 21 Oct 2026 names that project "RELQIVO Project
// 1" instead (20261021090000_relqivo_white_label_defaults), so give it the existing install's name and
// address first. Test database only.
beforeAll(async () => {
  await rawPrisma.project.update({ where: { id: ORIGINAL_PROJECT_ID }, data: { name: "ISP Digital", slug: "isp-digital" } });
});

beforeAll(async () => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://assist.example.test");
  vi.stubGlobal("fetch", fakeFetch);

  const existing = await rawPrisma.project.findFirst({ where: { slug: "bizify" } });
  const manageRole = await role("GS manage", ["google_sheets.view", "google_sheets.manage"]);
  sessions.manager = await user("GsManager", manageRole, [ORIGINAL_PROJECT_ID]);
  const bizProject = existing ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: sessions.manager.userId }, rawPrisma));
  ids.bizId = bizProject.id;
  biz = { ...biz, id: bizProject.id };
  await rawPrisma.projectAccess.upsert({
    where: { projectId_userId: { projectId: bizProject.id, userId: sessions.manager.userId } },
    create: { projectId: bizProject.id, userId: sessions.manager.userId },
    update: {},
  });
  sessions.viewer = await user("GsViewer", await role("GS view", ["google_sheets.view"]), [ORIGINAL_PROJECT_ID]);
  sessions.other = await user("GsOther", manageRole, [ORIGINAL_PROJECT_ID]);
  await setFeature(ORIGINAL_PROJECT_ID, true);
  await setFeature(bizProject.id, true);
});

beforeEach(() => {
  current = sessions.manager;
});

afterAll(async () => {
  // Connecting reads each account's spreadsheet list (Phase 2); the fake files' ids carry the tag.
  await rawPrisma.googleSpreadsheet.deleteMany({ where: { googleFileId: { contains: tag } } });
  await rawPrisma.googleIntegrationAccount.deleteMany({ where: { googleSubject: { endsWith: tag } } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "GOOGLE_SHEETS", projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Helpers that drive the two routes like a browser ────────────────────────────────────────────
async function pressConnect(project = isp) {
  return runWithProject(project, () => connectRoute.GET(new NextRequest(`https://assist.example.test/p/${project.slug}/api/google-sheets/connect`)));
}
function sealedFor(projectSlug: string, userId: string, now = Date.now()) {
  const state = oauth.newOAuthState(projectSlug, userId, now);
  return { state, cookie: oauth.sealOAuthState(state) };
}
async function googleCallsBack(query: Record<string, string>, cookie: string | null) {
  const url = new URL("https://assist.example.test/api/google/oauth/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return callbackRoute.GET(new NextRequest(url, { headers: cookie ? { cookie: `${oauth.STATE_COOKIE}=${cookie}` } : {} }));
}
async function connect(account: FakeAccount, project = isp, as = sessions.manager) {
  current = as;
  const { state, cookie } = sealedFor(project.slug, as.userId);
  return googleCallsBack({ code: account.code, state: state.state }, cookie);
}
const location = (res: Response) => res.headers.get("location") ?? "";

describe("1. pressing Connect", () => {
  it("sends a manager to Google's consent screen with a sealed, HTTP-only state cookie", async () => {
    const res = await pressConnect();
    expect(res.status).toBe(303);
    const target = new URL(location(res));
    expect(target.origin).toBe("https://accounts.google.com");
    expect(target.searchParams.get("redirect_uri")).toBe("https://assist.example.test/api/google/oauth/callback");
    const cookie = res.cookies.get(oauth.STATE_COOKIE);
    expect(cookie).toMatchObject({ httpOnly: true, path: "/api/google/oauth/callback" });
    const opened = oauth.openOAuthState(cookie!.value);
    expect(opened).toMatchObject({ projectSlug: "isp-digital", userId: sessions.manager.userId, state: target.searchParams.get("state") });
    expect(location(res)).not.toContain("test-secret");
  });

  it("refuses someone who may only view, and a project without the feature", async () => {
    current = sessions.viewer;
    expect(location(await pressConnect())).toContain("/p/isp-digital/settings/google-sheets?google_error=permission");
    current = sessions.manager;
    await setFeature(ids.bizId, false);
    expect(location(await pressConnect(biz))).toContain("google_error=permission");
    await setFeature(ids.bizId, true);
  });

  it("says so when the server has no OAuth client yet", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    expect(location(await pressConnect())).toContain("google_error=not_configured");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
  });
});

describe("2. Google calls back", () => {
  it("stores the account — encrypted tokens, its identity, scopes and spreadsheet count — and lands on the settings page", async () => {
    const alice = fakeAccount("alice", { sheets: 24 });
    const res = await connect(alice);
    expect(location(res)).toBe(`https://assist.example.test/p/isp-digital/settings/google-sheets?connected=${encodeURIComponent(alice.email)}`);
    expect(res.cookies.get(oauth.STATE_COOKIE)?.value).toBe("");

    const row = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { googleSubject: alice.sub, projectId: ORIGINAL_PROJECT_ID } });
    expect(row).toMatchObject({ email: alice.email, status: "CONNECTED", spreadsheetCount: 24, connectedById: sessions.manager.userId });
    expect(row.grantedScopes).toContain("https://www.googleapis.com/auth/spreadsheets");
    // Encrypted at rest, and decryptable only on the server.
    expect(row.refreshTokenCiphertext).not.toContain(alice.refresh);
    expect(row.accessTokenCiphertext).not.toContain(alice.access);
    expect(decryptSecret(row.refreshTokenCiphertext!)).toBe(alice.refresh);
    const log = await rawPrisma.systemLog.findFirst({ where: { targetId: row.id, message: { contains: "connected" } } });
    expect(log).not.toBeNull();
  });

  it("refuses a missing or foreign state, a different person, an expired consent and a refusal at Google — storing nothing", async () => {
    const bob = fakeAccount("bob");
    const { state, cookie } = sealedFor("isp-digital", sessions.manager.userId);
    expect(location(await googleCallsBack({ code: bob.code, state: "not-ours" }, cookie))).toContain("google_error=state");
    expect(location(await googleCallsBack({ code: bob.code, state: state.state }, null))).toContain("/open?next=");
    current = sessions.other;
    expect(location(await googleCallsBack({ code: bob.code, state: state.state }, cookie))).toContain("google_error=session");
    current = sessions.manager;
    const old = sealedFor("isp-digital", sessions.manager.userId, Date.now() - oauth.STATE_TTL_MS - 1000);
    expect(location(await googleCallsBack({ code: bob.code, state: old.state.state }, old.cookie))).toContain("google_error%3Dexpired");
    expect(location(await googleCallsBack({ error: "access_denied", state: state.state }, cookie))).toContain("google_error=denied");
    expect(await rawPrisma.googleIntegrationAccount.count({ where: { googleSubject: bob.sub } })).toBe(0);
  });

  it("re-checks the permission inside the project: a viewer holding a valid state is still refused", async () => {
    const carol = fakeAccount("carol");
    expect(location(await connect(carol, isp, sessions.viewer))).toContain("google_error=permission");
    expect(await rawPrisma.googleIntegrationAccount.count({ where: { googleSubject: carol.sub } })).toBe(0);
  });

  it("refuses a grant without spreadsheet access (and revokes it), and one without offline access", async () => {
    const partial = fakeAccount("partial", { scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"] });
    expect(location(await connect(partial))).toContain("google_error=missing_scopes");
    expect(google.revoked).toContain(partial.refresh);
    const online = fakeAccount("online", { noRefreshToken: true });
    expect(location(await connect(online))).toContain("google_error=no_refresh_token");
    expect(await rawPrisma.googleIntegrationAccount.count({ where: { googleSubject: { in: [partial.sub, online.sub] } } })).toBe(0);
  });
});

describe("3. several accounts, several projects", () => {
  it("connecting the same Google account again reuses its row — never a duplicate", async () => {
    const alice = google.byCode.get(`code-alice-${tag}`)!;
    const before = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { googleSubject: alice.sub, projectId: ORIGINAL_PROJECT_ID } });
    alice.sheets = 30;
    await connect(alice);
    const rows = await rawPrisma.googleIntegrationAccount.findMany({ where: { googleSubject: alice.sub, projectId: ORIGINAL_PROJECT_ID } });
    expect(rows.map((r) => r.id)).toEqual([before.id]);
    expect(rows[0]!.spreadsheetCount).toBe(30);
  });

  it("each project has its own accounts; another project's account is unreachable", async () => {
    const dave = fakeAccount("dave", { sheets: 3 });
    await connect(dave);
    const alice = google.byCode.get(`code-alice-${tag}`)!;
    await connect(alice, biz);

    const inIspList = (await inIsp(() => accounts.listGoogleAccounts())).filter((a) => a.email.endsWith(`${tag}@example.test`));
    const inBizList = (await inBiz(() => accounts.listGoogleAccounts())).filter((a) => a.email.endsWith(`${tag}@example.test`));
    expect(inIspList.map((a) => a.email).sort()).toEqual([alice.email, dave.email].sort());
    expect(inBizList.map((a) => a.email)).toEqual([alice.email]);
    // The same Google account in two projects is two rows, never shared.
    expect(inBizList[0]!.id).not.toBe(inIspList.find((a) => a.email === alice.email)!.id);

    const daveId = inIspList.find((a) => a.email === dave.email)!.id;
    const config = oauth.googleOAuthConfig()!;
    await expect(inBiz(() => accounts.getAccessToken(daveId, { config }))).rejects.toThrow(/not connected to this project/);
    expect((await inBiz(() => actions.disconnectGoogleAccountAction(daveId))).error).toMatch(/not connected to this project/);
  });

  it("nothing a page receives carries a token, a ciphertext or the client secret", async () => {
    const list = await inIsp(() => accounts.listGoogleAccounts());
    const text = JSON.stringify(list);
    for (const forbidden of ["refresh-", "access-", "Ciphertext", "test-secret"]) expect(text).not.toContain(forbidden);
    expect(Object.keys(list[0]!)).not.toEqual(expect.arrayContaining(["refreshTokenCiphertext"]));
  });
});

describe("4. using and losing access", () => {
  it("refreshes an expired access token and keeps the new one", async () => {
    const dave = google.byCode.get(`code-dave-${tag}`)!;
    const row = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { googleSubject: dave.sub, projectId: ORIGINAL_PROJECT_ID } });
    await rawPrisma.googleIntegrationAccount.update({ where: { id: row.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    const before = google.refreshCalls;
    const token = await inIsp(() => accounts.getAccessToken(row.id, { config: oauth.googleOAuthConfig()! }));
    expect(google.refreshCalls).toBe(before + 1);
    expect(token).toBe(dave.access);
    // Still valid: no second refresh.
    await inIsp(() => accounts.getAccessToken(row.id, { config: oauth.googleOAuthConfig()! }));
    expect(google.refreshCalls).toBe(before + 1);
  });

  it("a grant revoked at Google becomes NEEDS_RECONNECT, with the dead tokens wiped and the reason kept", async () => {
    const dave = google.byCode.get(`code-dave-${tag}`)!;
    const row = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { googleSubject: dave.sub, projectId: ORIGINAL_PROJECT_ID } });
    await rawPrisma.googleIntegrationAccount.update({ where: { id: row.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });
    google.refreshFailure = "invalid_grant";
    const result = await inIsp(() => actions.refreshGoogleSpreadsheetsAction(row.id));
    google.refreshFailure = null;
    expect(result.error).toMatch(/needs to be connected again/);
    const after = await rawPrisma.googleIntegrationAccount.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "NEEDS_RECONNECT", refreshTokenCiphertext: null, accessTokenCiphertext: null });
    expect(after.lastError).toMatch(/Connect the account again/);
  });

  it("recount and disconnect are refused to someone who may only view", async () => {
    const alice = google.byCode.get(`code-alice-${tag}`)!;
    const row = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { googleSubject: alice.sub, projectId: ORIGINAL_PROJECT_ID } });
    current = sessions.viewer;
    expect((await inIsp(() => actions.refreshGoogleSpreadsheetsAction(row.id))).error).toBeTruthy();
    expect((await inIsp(() => actions.disconnectGoogleAccountAction(row.id))).error).toBeTruthy();
    expect((await rawPrisma.googleIntegrationAccount.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("CONNECTED");
  });

  it("disconnecting wipes the tokens and KEEPS the row — and leaves Google's grant alone while Bizify still uses the same Google account; connecting again revives the same row", async () => {
    const alice = google.byCode.get(`code-alice-${tag}`)!;
    const row = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { googleSubject: alice.sub, projectId: ORIGINAL_PROJECT_ID } });
    google.revoked.length = 0;
    const result = await inIsp(() => actions.disconnectGoogleAccountAction(row.id));
    expect(result.success).toMatch(/disconnected/);
    expect(JSON.stringify(result)).not.toContain("refresh-");
    // Google revokes a whole grant (app × Google account): revoking here would disconnect Bizify too.
    expect(google.revoked).toEqual([]);
    expect(await rawPrisma.googleIntegrationAccount.count({ where: { googleSubject: alice.sub, projectId: biz.id, status: "CONNECTED" } })).toBe(1);
    const after = await rawPrisma.googleIntegrationAccount.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "DISCONNECTED", refreshTokenCiphertext: null, accessTokenCiphertext: null, disconnectedByUsername: sessions.manager.username });
    expect((await inIsp(() => actions.refreshGoogleSpreadsheetsAction(row.id))).error).toMatch(/needs to be connected again/);

    await connect(alice);
    const revived = await rawPrisma.googleIntegrationAccount.findMany({ where: { googleSubject: alice.sub, projectId: ORIGINAL_PROJECT_ID } });
    expect(revived).toHaveLength(1);
    expect(revived[0]).toMatchObject({ id: row.id, status: "CONNECTED", disconnectedAt: null });
  });
});
