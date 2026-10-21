import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, decryptSecret, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Google Sheets §22 — each project's own OAuth client, and its on/off switch, against the isolated
 * database and a fake Google that knows which client IDs and secrets belong together.
 *
 * What must hold: a pair Google rejects is never saved; the secret is stored encrypted and never
 * returned or logged; each project connects, redeems codes and refreshes only with its OWN client;
 * switching the integration off stops every Google call without deleting or disconnecting anything,
 * and switching it on resumes; changing the client sends the accounts it orphaned back to reconnect;
 * a sign-in started with one client cannot finish with another.
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
const clientConfig = await import("@/server/google/clientConfig");
const accounts = await import("@/server/google/accounts");
const settingsActions = await import("@/server/actions/googleSheetsSettings");
const sheetActions = await import("@/server/actions/googleSheets");
const editorActions = await import("@/server/actions/googleSheetEditor");
const connectRoute = await import("@/app/p/[project]/api/google-sheets/connect/route");
const callbackRoute = await import("@/app/api/google/oauth/callback/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
const isp: Project = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" };
let biz: Project = { id: "", slug: "bizify", name: "Bizify", status: "ACTIVE" };

// ── A fake Google that knows which clients exist ─────────────────────────────────────────────────────
const client = (name: string) => ({ id: `${Math.floor(Math.random() * 1e12)}-${name}${tag}.apps.googleusercontent.com`, secret: `GOCSPX-${name}-${tag}-secret` });
const A = client("alpha");
const B = client("bravo");
const C = client("charlie");
const google = {
  clients: new Map([A, B, C].map((c) => [c.id, c.secret])),
  reachable: true,
  tokenRequests: [] as Array<Record<string, string>>,
  revoked: [] as string[],
  calls: [] as string[],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  google.calls.push(url.origin + url.pathname);
  if (!google.reachable) throw new TypeError("fetch failed");
  if (url.href === "https://oauth2.googleapis.com/token") {
    const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
    google.tokenRequests.push(body);
    if (google.clients.get(body.client_id ?? "") !== body.client_secret) return json({ error: "invalid_client" }, 401);
    if (body.grant_type === "refresh_token") return json({ access_token: `access-refreshed-${tag}`, expires_in: 3600 });
    if (body.code === "softify-assist-credential-check") return json({ error: "invalid_grant" }, 400);
    return json({
      access_token: `access-${body.client_id}`,
      refresh_token: `refresh-${body.client_id}`,
      expires_in: 3600,
      scope: "openid email profile https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets",
    });
  }
  if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) {
    google.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
    return json({});
  }
  if (url.pathname === "/v1/userinfo") return json({ sub: `sub-shared-${tag}`, email: `shared.${tag}@example.test`, name: "Shared" });
  if (url.pathname === "/drive/v3/files") return json({ files: [] });
  return json({ error: "unexpected" }, 404);
};

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

const people = {} as Record<"manager" | "viewer", Session>;
const as = <T,>(person: Session, fn: () => Promise<T>, project: Project = isp) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const save = (fields: Record<string, string>, project: Project = isp, person = people.manager) => as(person, () => settingsActions.saveGoogleClientAction({}, form(fields)), project);
const configRow = (projectId: string) => rawPrisma.googleIntegrationConfig.findUnique({ where: { projectId } });
const pressConnect = (project: Project = isp) =>
  as(people.manager, () => connectRoute.GET(new NextRequest(`https://assist.example.test/p/${project.slug}/api/google-sheets/connect`)), project);
async function callback(code: string, sealedState: string, state: string) {
  current = people.manager;
  const url = new URL("https://assist.example.test/api/google/oauth/callback");
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return callbackRoute.GET(new NextRequest(url, { headers: { cookie: `${oauth.STATE_COOKIE}=${sealedState}` } }));
}
/** Press Connect in a project and come back from Google with a code. */
async function connect(project: Project = isp) {
  const start = await pressConnect(project);
  const target = new URL(start.headers.get("location")!);
  return { start, target, finish: () => callback(`code-${tag}`, start.cookies.get(oauth.STATE_COOKIE)!.value, target.searchParams.get("state")!) };
}

// These tests are written around the original installation as it exists in production ("ISP
// Digital", /p/isp-digital). A database created after 21 Oct 2026 names that project "Nexora Project
// 1" instead (20261021090000_nexora_white_label_defaults), so give it the existing install's name and
// address first. Test database only.
beforeAll(async () => {
  await rawPrisma.project.update({ where: { id: ORIGINAL_PROJECT_ID }, data: { name: "ISP Digital", slug: "isp-digital" } });
});

beforeAll(async () => {
  // No environment client: everything here is the projects' own.
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
  vi.stubEnv("NEXTAUTH_URL", "https://assist.example.test");
  vi.stubGlobal("fetch", fakeFetch);
  const manageRole = await role("GSC manage", ["google_sheets.view", "google_sheets.manage", "google_sheets.edit"]);
  people.manager = await user("Manager", manageRole, [ORIGINAL_PROJECT_ID]);
  people.viewer = await user("Viewer", await role("GSC view", ["google_sheets.view"]), [ORIGINAL_PROJECT_ID]);
  const existing = await rawPrisma.project.findFirst({ where: { slug: "bizify" } });
  const bizProject = existing ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma));
  ids.bizId = bizProject.id;
  biz = { ...biz, id: bizProject.id };
  await rawPrisma.projectAccess.upsert({ where: { projectId_userId: { projectId: biz.id, userId: people.manager.userId } }, create: { projectId: biz.id, userId: people.manager.userId }, update: {} });
  for (const projectId of [ORIGINAL_PROJECT_ID, biz.id]) {
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key: "GOOGLE_SHEETS" } }, create: { projectId, key: "GOOGLE_SHEETS", enabled: true }, update: { enabled: true } });
    await rawPrisma.googleIntegrationConfig.deleteMany({ where: { projectId } });
  }
  forgetProjectFeatureStates();
});

beforeEach(() => {
  google.reachable = true;
  google.tokenRequests.length = 0;
  google.revoked.length = 0;
  google.calls.length = 0;
});

afterAll(async () => {
  await rawPrisma.googleIntegrationConfig.deleteMany({ where: { projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.googleIntegrationAccount.deleteMany({ where: { googleSubject: { endsWith: tag } } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "GOOGLE_SHEETS", projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1. saving a project's client", () => {
  it("with nothing saved and no server default, connecting is refused as not set up", async () => {
    expect((await pressConnect()).headers.get("location")).toContain("google_error=not_configured");
  });

  it("is refused to someone who may only view, and a malformed ID never reaches Google", async () => {
    expect((await save({ clientId: A.id, clientSecret: A.secret }, isp, people.viewer)).error).toBeTruthy();
    expect((await save({ clientId: "not-a-client-id", clientSecret: A.secret })).error).toMatch(/apps\.googleusercontent\.com/);
    expect(google.calls).toEqual([]);
    expect(await configRow(ORIGINAL_PROJECT_ID)).toBeNull();
  });

  it("a pair Google rejects is NOT saved", async () => {
    const result = await save({ clientId: A.id, clientSecret: "GOCSPX-wrong-secret-value" });
    expect(result.error).toMatch(/did not accept/);
    expect(google.tokenRequests[0]).toMatchObject({ client_id: A.id, redirect_uri: "https://assist.example.test/api/google/oauth/callback" });
    expect(await configRow(ORIGINAL_PROJECT_ID)).toBeNull();
  });

  it("a pair Google accepts is saved, its secret encrypted, never returned, never logged", async () => {
    const result = await save({ clientId: A.id, clientSecret: A.secret });
    expect(result.success).toMatch(/accepted/);
    const row = (await configRow(ORIGINAL_PROJECT_ID))!;
    expect(row).toMatchObject({ clientId: A.id, validationStatus: "VALID", credentialsUpdatedByUsername: people.manager.username, enabled: true });
    expect(row.clientSecretCiphertext).not.toContain(A.secret);
    expect(decryptSecret(row.clientSecretCiphertext!)).toBe(A.secret);
    const view = await as(people.manager, () => clientConfig.getGoogleIntegrationView());
    expect(view).toMatchObject({ source: "PROJECT", clientId: A.id, hasSecret: true, validationStatus: "VALID" });
    expect(JSON.stringify(view)).not.toContain(A.secret);
    expect(JSON.stringify(view)).not.toContain(row.clientSecretCiphertext!);
    const logs = await rawPrisma.systemLog.findMany({ where: { createdAt: { gte: new Date(Date.now() - 60_000) } }, select: { message: true, metadata: true } });
    expect(JSON.stringify(logs)).not.toContain(A.secret);
  });

  it("a blank secret keeps the saved one for the same client — and is required for a new client", async () => {
    expect((await save({ clientId: A.id, clientSecret: "" })).success).toMatch(/accepted/);
    expect(google.tokenRequests.at(-1)).toMatchObject({ client_id: A.id, client_secret: A.secret });
    expect((await save({ clientId: B.id, clientSecret: "" })).error).toMatch(/Enter the client secret/);
    expect((await configRow(ORIGINAL_PROJECT_ID))!.clientId).toBe(A.id);
  });

  it("when Google cannot be reached the pair is saved as not yet confirmed, with the warning", async () => {
    google.reachable = false;
    expect((await save({ clientId: A.id, clientSecret: A.secret })).success).toMatch(/not yet confirmed/);
    expect((await configRow(ORIGINAL_PROJECT_ID))!.validationStatus).toBe("UNVALIDATED");
    google.reachable = true;
    expect((await as(people.manager, () => settingsActions.revalidateGoogleClientAction())).success).toMatch(/accepted/);
    expect((await configRow(ORIGINAL_PROJECT_ID))!.validationStatus).toBe("VALID");
  });
});

describe("2. each project connects with its own client, and only its own", () => {
  it("ISP Digital's consent URL carries its client; Bizify, with none, is not set up and sees nothing of ISP's", async () => {
    const { target } = await connect(isp);
    expect(target.searchParams.get("client_id")).toBe(A.id);
    expect((await pressConnect(biz)).headers.get("location")).toContain("google_error=not_configured");
    const bizView = await as(people.manager, () => clientConfig.getGoogleIntegrationView(), biz);
    expect(bizView).toMatchObject({ source: null, clientId: null, hasSecret: false });
  });

  it("the callback redeems the code with the project's client, and the account remembers which client issued its tokens", async () => {
    const { finish } = await connect(isp);
    const res = await finish();
    expect(res.headers.get("location")).toContain("connected=");
    const exchange = google.tokenRequests.find((r) => r.grant_type === "authorization_code" && r.code === `code-${tag}`)!;
    expect(exchange).toMatchObject({ client_id: A.id, client_secret: A.secret });
    const account = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID, googleSubject: `sub-shared-${tag}` } });
    expect(account).toMatchObject({ status: "CONNECTED", oauthClientId: A.id });
  });

  it("Bizify saves its own client and connects through it, while ISP Digital keeps its own", async () => {
    expect((await save({ clientId: B.id, clientSecret: B.secret }, biz)).success).toMatch(/accepted/);
    const { target } = await connect(biz);
    expect(target.searchParams.get("client_id")).toBe(B.id);
    expect((await configRow(ORIGINAL_PROJECT_ID))!.clientId).toBe(A.id);
    expect((await connect(isp)).target.searchParams.get("client_id")).toBe(A.id);
  });
});

describe("3. switching the integration off and on", () => {
  it("off: nothing talks to Google — no connect, no refresh, no spreadsheet — and nothing is deleted or disconnected", async () => {
    expect((await as(people.manager, () => settingsActions.setGoogleIntegrationEnabledAction(false))).success).toMatch(/off/);
    expect((await pressConnect()).headers.get("location")).toContain("google_error=disabled");
    const account = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID, googleSubject: `sub-shared-${tag}` } });
    google.calls.length = 0;
    expect((await as(people.manager, () => sheetActions.refreshGoogleSpreadsheetsAction(account.id))).error).toMatch(/switched off/);
    expect("error" in (await as(people.manager, () => editorActions.loadSheetWindowAction("any-sheet", { purpose: "OPEN" })))).toBe(true);
    expect(google.calls).toEqual([]);
    expect(await rawPrisma.googleIntegrationAccount.findUnique({ where: { id: account.id } })).toMatchObject({ status: "CONNECTED" });
    expect((await configRow(ORIGINAL_PROJECT_ID))!.clientSecretCiphertext).not.toBeNull();
    // Bizify is unaffected.
    expect((await connect(biz)).target.searchParams.get("client_id")).toBe(B.id);
  });

  it("on again: the saved client and the connected account work as before, without reconnecting", async () => {
    expect((await as(people.manager, () => settingsActions.setGoogleIntegrationEnabledAction(true))).success).toMatch(/on/);
    const account = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID, googleSubject: `sub-shared-${tag}` } });
    expect((await as(people.manager, () => sheetActions.refreshGoogleSpreadsheetsAction(account.id))).success).toBeTruthy();
  });
});

describe("4. changing the client", () => {
  it("a sign-in started with the old client cannot finish with the new one", async () => {
    const { finish } = await connect(isp); // sealed with client A
    expect((await save({ clientId: C.id, clientSecret: C.secret })).success).toMatch(/connected again/);
    expect((await finish()).headers.get("location")).toContain("google_error=client_changed");
  });

  it("the accounts the old client issued are sent back to reconnect, their tokens wiped and revoked", async () => {
    const account = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID, googleSubject: `sub-shared-${tag}` } });
    expect(account).toMatchObject({ status: "NEEDS_RECONNECT", refreshTokenCiphertext: null, accessTokenCiphertext: null });
    expect(account.lastError).toMatch(/client changed/);
  });

  it("an account whose tokens another client issued is never refreshed with this one", async () => {
    const account = await rawPrisma.googleIntegrationAccount.findFirstOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID, googleSubject: `sub-shared-${tag}` } });
    await rawPrisma.googleIntegrationAccount.update({
      where: { id: account.id },
      data: { status: "CONNECTED", oauthClientId: A.id, refreshTokenCiphertext: (await rawPrisma.googleIntegrationConfig.findUniqueOrThrow({ where: { projectId: ORIGINAL_PROJECT_ID } })).clientSecretCiphertext, accessTokenExpiresAt: new Date(0) },
    });
    google.tokenRequests.length = 0;
    const resolved = await as(people.manager, () => clientConfig.resolveProjectGoogleClient());
    if (!resolved.ok) throw new Error("expected a client");
    await expect(as(people.manager, () => accounts.getAccessToken(account.id, { config: resolved.config }))).rejects.toThrow(/client changed/);
    expect(google.tokenRequests).toEqual([]);
    expect((await rawPrisma.googleIntegrationAccount.findUnique({ where: { id: account.id } }))!.status).toBe("NEEDS_RECONNECT");
  });

  it("a client Google later rejects stops being used", async () => {
    google.clients.delete(C.id);
    expect((await as(people.manager, () => settingsActions.revalidateGoogleClientAction())).error).toMatch(/did not accept/);
    expect((await pressConnect()).headers.get("location")).toContain("google_error=invalid_client");
    google.clients.set(C.id, C.secret);
  });
});
