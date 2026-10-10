import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, encryptSecret, ORIGINAL_PROJECT_ID, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Google Sheets Phase 4 — a person's own Google identity (GOOGLE_SHEETS.md §5), against the isolated
 * database and a fake Google.
 *
 * What must hold: an identity is linked only by the person signing in with it themselves (never from
 * a matching email), asks Google for nothing but who they are, keeps no token and revokes nothing (the
 * same Google account is often also connected to a project); one Google account belongs to one login;
 * only its owner unlinks it; the sealed purpose keeps "link me" and "connect an account" apart. And a
 * Phase 1 fix: disconnecting an account in one project never revokes a grant another project uses.
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
const identity = await import("@/server/google/identity");
const accounts = await import("@/server/google/accounts");
const settingsActions = await import("@/server/actions/googleSheetsSettings");
const identityRoute = await import("@/app/p/[project]/api/google-sheets/identity/route");
const callbackRoute = await import("@/app/api/google/oauth/callback/route");

const isp = { id: ORIGINAL_PROJECT_ID, slug: "isp-digital", name: "ISP Digital", status: "ACTIVE" as const };
let biz = { id: "", slug: "bizify", name: "Bizify", status: "ACTIVE" as const };

// ── A fake Google ────────────────────────────────────────────────────────────────────────────────────
const google = {
  byCode: new Map<string, { sub: string; email: string; access: string }>(),
  revoked: [] as string[],
  calls: [] as string[],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  google.calls.push(url.origin + url.pathname);
  if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
    const body = new URLSearchParams(String(init?.body));
    const who = google.byCode.get(body.get("code") ?? "");
    if (!who || !body.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
    // A sign-in for identity asks for openid + email only, so Google grants exactly that.
    return json({ access_token: who.access, expires_in: 3600, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
  }
  if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) {
    google.revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
    return json({});
  }
  const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? "";
  const who = [...google.byCode.values()].find((w) => w.access === bearer);
  if (url.pathname === "/v1/userinfo" && who) return json({ sub: who.sub, email: who.email.toUpperCase(), name: `Name ${who.email}` });
  return json({ error: "unexpected" }, 404);
};
function googleAccount(name: string) {
  const who = { sub: `idsub-${name}-${tag}`, email: `${name}.${tag}@gmail.test`, access: `idaccess-${name}-${tag}` };
  google.byCode.set(`code-${name}-${tag}`, who);
  return { ...who, code: `code-${name}-${tag}` };
}

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

const people = {} as Record<"borhan" | "istiyak" | "manager", Session>;

beforeAll(async () => {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-client.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://assist.example.test");
  vi.stubGlobal("fetch", fakeFetch);
  const viewRole = await role("GSI view", ["google_sheets.view"]);
  const manageRole = await role("GSI manage", ["google_sheets.view", "google_sheets.manage"]);
  people.manager = await user("Manager", manageRole, [ORIGINAL_PROJECT_ID]);
  const existing = await rawPrisma.project.findFirst({ where: { slug: "bizify" } });
  const bizProject = existing ?? (await createProjectWithDefaults({ name: "Bizify", slug: "bizify", status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma));
  ids.bizId = bizProject.id;
  biz = { ...biz, id: bizProject.id };
  people.borhan = await user("Borhan", viewRole, [ORIGINAL_PROJECT_ID]);
  people.istiyak = await user("Istiyak", viewRole, [ORIGINAL_PROJECT_ID]);
  for (const projectId of [ORIGINAL_PROJECT_ID, bizProject.id]) {
    await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key: "GOOGLE_SHEETS" } }, create: { projectId, key: "GOOGLE_SHEETS", enabled: true }, update: { enabled: true } });
  }
  forgetProjectFeatureStates();
});

beforeEach(() => {
  google.revoked.length = 0;
  google.calls.length = 0;
});

afterAll(async () => {
  await rawPrisma.userGoogleIdentity.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.googleIntegrationAccount.deleteMany({ where: { googleSubject: { endsWith: tag } } });
  await rawPrisma.projectFeature.deleteMany({ where: { key: "GOOGLE_SHEETS", projectId: { in: [ORIGINAL_PROJECT_ID, ids.bizId] } } });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  await rawPrisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await rawPrisma.permissionModule.deleteMany({ where: { id: { in: ids.roles } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function startLink(person: Session) {
  current = person;
  return runWithProject(isp, () => identityRoute.GET(new NextRequest("https://assist.example.test/p/isp-digital/api/google-sheets/identity")));
}
async function callback(query: Record<string, string>, cookie: string, person: Session) {
  current = person;
  const url = new URL("https://assist.example.test/api/google/oauth/callback");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return callbackRoute.GET(new NextRequest(url, { headers: { cookie: `${oauth.STATE_COOKIE}=${cookie}` } }));
}
/** Press "Link my Google account", then come back from Google as `account`. */
async function link(person: Session, account: ReturnType<typeof googleAccount>) {
  const start = await startLink(person);
  const cookie = start.cookies.get(oauth.STATE_COOKIE)!.value;
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  return callback({ code: account.code, state }, cookie, person);
}

describe("1. linking asks Google for who you are — nothing more", () => {
  it("the consent URL asks for openid + email only, no offline access, always with the account chooser", async () => {
    const res = await startLink(people.borhan);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(target.searchParams.get("scope")).toBe("openid email");
    expect(target.searchParams.get("access_type")).toBeNull();
    expect(target.searchParams.get("prompt")).toBe("select_account");
    expect(target.searchParams.get("redirect_uri")).toBe("https://assist.example.test/api/google/oauth/callback");
    expect(oauth.openOAuthState(res.cookies.get(oauth.STATE_COOKIE)!.value)).toMatchObject({ purpose: "IDENTITY", userId: people.borhan.userId, projectSlug: "isp-digital" });
  });

  it("a state sealed before purposes existed is read as a connection", () => {
    const legacy = oauth.newOAuthState("isp-digital", people.manager.userId);
    const withoutPurpose: Partial<typeof legacy> = { ...legacy };
    delete withoutPurpose.purpose;
    const sealed = encryptSecret(JSON.stringify(withoutPurpose));
    expect(oauth.openOAuthState(sealed)?.purpose).toBe("CONNECT");
  });
});

describe("2. linking, relinking and unlinking", () => {
  const borhanGoogle = googleAccount("borhan");

  it("a person with only the view permission links their own Google account; no token is kept, nothing is revoked, no project account is created", async () => {
    const res = await link(people.borhan, borhanGoogle);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`https://assist.example.test/p/isp-digital/google-sheets/identity?linked=${encodeURIComponent(borhanGoogle.email)}`);
    const rows = await rawPrisma.userGoogleIdentity.findMany({ where: { userId: people.borhan.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ googleSubject: borhanGoogle.sub, email: borhanGoogle.email });
    expect(JSON.stringify(rows[0])).not.toContain(borhanGoogle.access);
    expect(google.revoked).toEqual([]);
    expect(await rawPrisma.googleIntegrationAccount.count({ where: { googleSubject: borhanGoogle.sub } })).toBe(0);
  });

  it("the same Google account cannot be linked to a second login", async () => {
    const res = await link(people.istiyak, borhanGoogle);
    expect(res.headers.get("location")).toContain("google_error=linked_elsewhere");
    expect(await rawPrisma.userGoogleIdentity.count({ where: { userId: people.istiyak.userId } })).toBe(0);
  });

  it("relinking by its owner refreshes when it was proved, without a second row", async () => {
    const before = (await rawPrisma.userGoogleIdentity.findFirst({ where: { userId: people.borhan.userId } }))!;
    await new Promise((r) => setTimeout(r, 15));
    await link(people.borhan, borhanGoogle);
    const after = await rawPrisma.userGoogleIdentity.findMany({ where: { userId: people.borhan.userId } });
    expect(after).toHaveLength(1);
    expect(after[0]!.verifiedAt.getTime()).toBeGreaterThan(before.verifiedAt.getTime());
    expect(await runWithProject(isp, () => identity.identitiesForUsers([people.borhan.userId, people.istiyak.userId]))).toEqual(new Map([[people.borhan.userId, [borhanGoogle.email]]]));
  });

  it("only the owner unlinks it", async () => {
    const row = (await rawPrisma.userGoogleIdentity.findFirst({ where: { userId: people.borhan.userId } }))!;
    current = people.istiyak;
    expect(await runWithProject(isp, () => settingsActions.unlinkMyGoogleIdentityAction(row.id))).toEqual({ error: "That Google account is not linked to your login." });
    expect(await rawPrisma.userGoogleIdentity.count({ where: { id: row.id } })).toBe(1);
    current = people.borhan;
    expect((await runWithProject(isp, () => settingsActions.unlinkMyGoogleIdentityAction(row.id))).success).toMatch(/unlinked/);
    expect(await rawPrisma.userGoogleIdentity.count({ where: { id: row.id } })).toBe(0);
  });

  it("an identity sign-in can never connect an account, and a connection state never links an identity", async () => {
    // A CONNECT state from someone without the manage permission: refused before Google is asked.
    const connectState = oauth.newOAuthState("isp-digital", people.istiyak.userId);
    const res = await callback({ code: googleAccount("istiyak").code, state: connectState.state }, oauth.sealOAuthState(connectState), people.istiyak);
    expect(res.headers.get("location")).toContain("/settings/google-sheets?google_error=permission");
    expect(await rawPrisma.userGoogleIdentity.count({ where: { userId: people.istiyak.userId } })).toBe(0);
    expect(google.calls.filter((c) => c.includes("oauth2.googleapis.com/token"))).toEqual([]);
  });
});

describe("3. disconnecting never revokes a grant another project still uses (Phase 1 fix)", () => {
  it("the same Google account connected to two projects: disconnecting one leaves Google's grant alone", async () => {
    const subject = `shared-${tag}`;
    const make = (projectId: string) =>
      rawPrisma.googleIntegrationAccount.create({
        data: { projectId, googleSubject: subject, email: `shared.${tag}@example.test`, status: "CONNECTED", refreshTokenCiphertext: encryptSecret(`refresh-shared-${projectId}`) },
      });
    const inIsp = await make(ORIGINAL_PROJECT_ID);
    const inBiz = await make(ids.bizId);
    current = people.manager;
    await runWithProject(isp, () => accounts.disconnectGoogleAccount(inIsp.id, "manager"));
    expect(google.revoked).toEqual([]);
    expect(await rawPrisma.googleIntegrationAccount.findUnique({ where: { id: inIsp.id } })).toMatchObject({ status: "DISCONNECTED", refreshTokenCiphertext: null });
    expect(await rawPrisma.googleIntegrationAccount.findUnique({ where: { id: inBiz.id } })).toMatchObject({ status: "CONNECTED" });
    // The last project to disconnect it does revoke.
    await runWithProject(biz, () => accounts.disconnectGoogleAccount(inBiz.id, "manager"));
    expect(google.revoked).toEqual([`refresh-shared-${ids.bizId}`]);
  });
});
