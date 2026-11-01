import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, decryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Meta expansion A2 (docs/meta-expansion/04 §2): Social Studio's "Connect Facebook / Instagram" runs
 * through the platform's secure handover — the one registered callback on the platform address, back to
 * the customer's own address, claimed once by the same person in the same browser. Before A2 it kept its
 * state in a cookie on the callback's address, so it could never work from a customer's own address.
 *
 * Attacks pinned here: wrong host (start on the platform address; claim on another address), wrong user,
 * wrong browser (no / wrong / the messaging binding cookie), expired and replayed state, replayed claim,
 * cross-tenant claim, a messaging attempt claimed as publishing and the reverse, permission and feature
 * removed, workspace off the allowlist. And what must still hold: the publishing grant asks for publishing
 * permissions only, an existing publishing connection is updated in place, and no token is left behind.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

let current: Session;
let hostScope: { kind: "OPEN" | "CUSTOMER" | "PLATFORM" | "UNKNOWN"; customerId?: string } = { kind: "OPEN" };
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const ids = { roles: [] as string[], users: [] as string[], projects: [] as string[] };

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireSession: async () => current,
  getSession: async () => current,
}));
vi.mock("@/server/hostScope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/hostScope")>()),
  currentHostScope: async () => hostScope,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/projectPaths", () => ({ projectPath: async (p: string) => `/p/x${p}`, inWorkspace: async () => false }));

const { runWithProject } = await import("@/server/projectContext");
const { forgetProjectFeatureStates } = await import("@/server/projectFeatures");
const oauth = await import("@/server/channels/metaOAuth");
const socialConnect = await import("@/app/p/[project]/api/social/meta/connect/route");
const socialClaim = await import("@/app/p/[project]/api/social/meta/claim/route");
const retiredCallback = await import("@/app/api/social/meta/callback/route");
const messagingConnect = await import("@/app/p/[project]/api/meta/connect/route");
const messagingClaim = await import("@/app/p/[project]/api/meta/claim/route");
const callbackRoute = await import("@/app/api/meta/oauth/callback/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;

// ── A fake Meta ───────────────────────────────────────────────────────────────────────────────────
const APP = "987654321077";
const SECRET = "0123456789abcdef0123456789abcdef";
const SHORT = `EAASHORT${tag}0000000000000`;
const LONG = `EAALONG${tag}00000000000000`;
const FB_USER = `8${Date.now()}`.slice(0, 15);
const PAGE = `sp${tag}`;
const IG = `sig${tag}`;
const PUBLISHING = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"];
const meta = { calls: [] as string[], listFails: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  meta.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
  if (url.pathname.endsWith("/oauth/access_token")) {
    if (url.searchParams.get("client_secret") !== SECRET) return json({ error: { code: 1, message: "bad client" } }, 400);
    if (url.searchParams.get("grant_type") === "fb_exchange_token") return json({ access_token: LONG, expires_in: 5183944 });
    // The publishing grant is redeemed against the PLATFORM callback — the only registered redirect URI.
    if (url.searchParams.get("redirect_uri") !== "https://admin.example.test/api/meta/oauth/callback") return json({ error: { code: 100, message: "redirect_uri mismatch" } }, 400);
    return url.searchParams.get("code") === "GOOD" ? json({ access_token: SHORT }) : json({ error: { code: 100, message: "code used" } }, 400);
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? "";
  if (url.searchParams.get("appsecret_proof") !== createHmac("sha256", SECRET).update(auth).digest("hex")) return json({ error: { code: 100, message: "Invalid appsecret_proof" } }, 400);
  if (url.pathname.endsWith("/me/permissions")) return json({ data: PUBLISHING.map((permission) => ({ permission, status: "granted" })) });
  if (url.pathname.endsWith("/me/accounts")) {
    if (meta.listFails) return json({ error: { code: 2, message: "temporarily unavailable" } }, 500);
    const withTokens = (url.searchParams.get("fields") ?? "").includes("access_token");
    return json({ data: [{ id: PAGE, name: `Studio ${tag}`, tasks: ["MANAGE", "CREATE_CONTENT"], instagram_business_account: { id: IG, username: `studio_${tag}` }, ...(withTokens ? { access_token: `EAAPAGE${PAGE}tok000000000000` } : {}) }] });
  }
  if (url.pathname.endsWith("/me")) return json({ id: FB_USER, name: "Studio Admin" });
  return json({ error: { code: 803, message: `unexpected ${url.pathname}` } }, 404);
};

// ── People and fixtures ───────────────────────────────────────────────────────────────────────────
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
const people = {} as Record<"manager" | "other" | "viewer", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};

const ENV = {
  META_INTEGRATION_ENABLED: "true",
  META_APP_ID: APP,
  META_APP_SECRET: SECRET,
  META_WEBHOOK_VERIFY_TOKEN: `verify-${tag}-0123456789`,
  META_OAUTH_REDIRECT_URI: "https://admin.example.test/api/meta/oauth/callback",
};
function enable() {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv("META_ALLOWED_PROJECT_IDS", [A, B].map((p) => p.id).join(","));
  vi.stubEnv("META_LOGIN_CONFIG_ID", "");
  vi.stubEnv("META_SOCIAL_LOGIN_CONFIG_ID", "");
}

const CUSTOMER = "shop.customer.test";
const headersFor = (host: string, cookie?: string) => ({ "x-forwarded-host": host, "x-forwarded-proto": "https", ...(cookie ? { cookie } : {}) });

async function start(person: Session, project: Project, host = CUSTOMER) {
  const response = await as(person, project, () => socialConnect.GET(new NextRequest(`http://internal:8668/p/${project.slug}/api/social/meta/connect`, { headers: headersFor(host) })));
  const location = response.headers.get("location") ?? "";
  return {
    location,
    binding: response.cookies.get(oauth.META_SOCIAL_BINDING_COOKIE)?.value ?? null,
    messagingCookie: response.cookies.get(oauth.META_BINDING_COOKIE)?.value ?? null,
    state: location.startsWith("https://www.facebook.com/") ? new URL(location).searchParams.get("state") : null,
  };
}
const callback = async (query: string) => (await callbackRoute.GET(new NextRequest(`https://admin.example.test/api/meta/oauth/callback?${query}`))).headers.get("location") ?? "";
async function claim(person: Session, project: Project, claimUrl: string, cookie: string | null, host = CUSTOMER) {
  const c = new URL(claimUrl).searchParams.get("c") ?? "";
  const request = new NextRequest(`https://${host}/p/${project.slug}/api/social/meta/claim?c=${encodeURIComponent(c)}`, { headers: headersFor(host, cookie ?? undefined) });
  return (await as(person, project, () => socialClaim.GET(request))).headers.get("location") ?? "";
}
const socialCookie = (binding: string | null) => (binding ? `${oauth.META_SOCIAL_BINDING_COOKIE}=${binding}` : null);
const latest = (project: Project) => rawPrisma.metaOAuthSession.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } });

beforeAll(async () => {
  vi.stubEnv("NEXTAUTH_URL", "https://admin.example.test");
  vi.stubGlobal("fetch", fakeFetch);
  people.manager = await user("SManager", await role("Social manage", ["social.view", "social.manage", "channels.view", "channels.manage", "messages.view"]));
  people.other = await user("SOther", await role("Social manage 2", ["social.view", "social.manage"]));
  people.viewer = await user("SViewer", await role("Social view", ["social.view"]));
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    for (const key of ["SOCIAL_STUDIO", "OMNICHANNEL"] as const) {
      await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId: p.id, key } }, create: { projectId: p.id, key, enabled: true }, update: { enabled: true } });
    }
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("SocialA");
  B = await make("SocialB");
  forgetProjectFeatureStates();
});

beforeEach(() => {
  meta.calls.length = 0;
  meta.listFails = false;
  hostScope = { kind: "OPEN" };
  enable();
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.socialAccount.deleteMany({ where });
  await rawPrisma.socialConnection.deleteMany({ where });
  await rawPrisma.metaOAuthSession.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1. starting on the customer's address", () => {
  it("opens Meta's dialog with publishing permissions only, through the platform callback, with its own binding cookie", async () => {
    const s = await start(people.manager, A);
    const url = new URL(s.location);
    expect(url.searchParams.get("client_id")).toBe(APP);
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.META_OAUTH_REDIRECT_URI);
    const scope = url.searchParams.get("scope")!.split(",");
    expect(scope).toEqual(expect.arrayContaining(["pages_manage_posts", "instagram_content_publish"]));
    expect(scope).not.toContain("pages_messaging");
    expect(scope).not.toContain("instagram_manage_messages");
    expect(url.searchParams.get("auth_type")).toBe("rerequest");
    expect(s.binding).toBeTruthy();
    expect(s.messagingCookie).toBeNull();
    const row = await latest(A);
    expect(row).toMatchObject({ purpose: "SOCIAL_CONNECT", status: "STARTED", returnOrigin: `https://${CUSTOMER}`, returnPath: `/p/${A.slug}`, channelType: null, connectionId: null });
    expect(JSON.stringify(row)).not.toContain(s.state!);
    expect(JSON.stringify(row)).not.toContain(s.binding!);
  });

  it("uses the publishing Login-for-Business configuration, never the messaging one", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "111111111111");
    expect(new URL((await start(people.manager, A)).location).searchParams.get("config_id")).toBeNull();
    vi.stubEnv("META_SOCIAL_LOGIN_CONFIG_ID", "222222222222");
    const url = new URL((await start(people.manager, A)).location);
    expect(url.searchParams.get("config_id")).toBe("222222222222");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("wrong host: never starts on the platform's own address or an unknown one", async () => {
    for (const kind of ["PLATFORM", "UNKNOWN"] as const) {
      hostScope = { kind };
      const before = await rawPrisma.metaOAuthSession.count({ where: { projectId: A.id } });
      const s = await start(people.manager, A);
      expect(s.location).toContain("social_error=permission");
      expect(s.binding).toBeNull();
      expect(await rawPrisma.metaOAuthSession.count({ where: { projectId: A.id } })).toBe(before);
    }
  });

  it("refuses without social.manage, with Social Studio off, and in a workspace off the allowlist", async () => {
    expect((await start(people.viewer, A)).location).toContain("social_error=permission");
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: B.id, key: "SOCIAL_STUDIO" } }, data: { enabled: false } });
    forgetProjectFeatureStates();
    expect((await start(people.manager, B)).location).toContain("social_error=permission");
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: B.id, key: "SOCIAL_STUDIO" } }, data: { enabled: true } });
    forgetProjectFeatureStates();
    vi.stubEnv("META_ALLOWED_PROJECT_IDS", A.id);
    const s = await start(people.manager, B);
    expect(s.location).toContain("social_error=not_configured");
    expect(await rawPrisma.metaOAuthSession.count({ where: { projectId: B.id } })).toBe(0);
  });
});

describe("2. Meta's answer at the platform callback", () => {
  it("sends the browser back to the customer's address, to the Social Studio claim, holding the token only encrypted", async () => {
    const s = await start(people.manager, A);
    const claimUrl = await callback(`state=${s.state}&code=GOOD`);
    expect(claimUrl.startsWith(`https://${CUSTOMER}/p/${A.slug}/api/social/meta/claim?c=`)).toBe(true);
    const row = await latest(A);
    expect(row).toMatchObject({ status: "AUTHORIZED", metaUserId: FB_USER, purpose: "SOCIAL_CONNECT" });
    expect(row.userTokenCiphertext).not.toContain(LONG);
    expect(decryptSecret(row.userTokenCiphertext!)).toBe(LONG);
    expect(row.grantedScopes).toContain("pages_manage_posts");
  });

  it("expired state, declined dialog and a replayed state all come back to Social Studio's page, never connected", async () => {
    const declined = await start(people.manager, A);
    expect(await callback(`state=${declined.state}&error=access_denied`)).toBe(`https://${CUSTOMER}/p/${A.slug}/social/accounts?social_error=denied`);

    const once = await start(people.manager, A);
    expect(await callback(`state=${once.state}&code=GOOD`)).toContain("/api/social/meta/claim?c=");
    expect(await callback(`state=${once.state}&code=GOOD`)).toBe(`https://${CUSTOMER}/p/${A.slug}/social/accounts?social_error=expired`);

    const late = await start(people.manager, A);
    await rawPrisma.metaOAuthSession.updateMany({ where: { projectId: A.id, status: "STARTED" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await callback(`state=${late.state}&code=GOOD`)).toBe(`https://${CUSTOMER}/p/${A.slug}/social/accounts?social_error=expired`);
    expect(await rawPrisma.socialConnection.count({ where: { projectId: A.id } })).toBe(0);
  });
});

describe("3. the claim", () => {
  it("refuses the wrong user, the wrong browser, the wrong address and another workspace — then connects once", async () => {
    const s = await start(people.manager, A);
    const claimUrl = await callback(`state=${s.state}&code=GOOD`);

    expect(await claim(people.other, A, claimUrl, socialCookie(s.binding))).toContain("social_error=session");
    expect(await claim(people.manager, A, claimUrl, null)).toContain("social_error=binding");
    expect(await claim(people.manager, A, claimUrl, socialCookie("a-different-binding-value-000000000"))).toContain("social_error=binding");
    // The messaging cookie holding the right value is still not the Social Studio binding.
    expect(await claim(people.manager, A, claimUrl, `${oauth.META_BINDING_COOKIE}=${s.binding}`)).toContain("social_error=binding");
    // The right cookie value presented on another address (a cookie never travels there, but a value can be copied).
    expect(await claim(people.manager, A, claimUrl, socialCookie(s.binding), "other.customer.test")).toContain("social_error=binding");
    // Cross-tenant: the claim code in another workspace is simply not found there.
    expect(await claim(people.manager, B, claimUrl, socialCookie(s.binding))).toContain("social_error=expired");
    expect(await rawPrisma.socialConnection.count({ where: { projectId: { in: [A.id, B.id] } } })).toBe(0);

    const ok = await claim(people.manager, A, claimUrl, socialCookie(s.binding));
    expect(ok).toBe(`https://${CUSTOMER}/p/${A.slug}/social/accounts?connected=2&attention=0`);
    const connection = await rawPrisma.socialConnection.findFirstOrThrow({ where: { projectId: A.id } });
    expect(connection).toMatchObject({ provider: "META", externalUserId: FB_USER, externalUserName: "Studio Admin", status: "CONNECTED" });
    expect(decryptSecret(connection.credentialCiphertext!)).toBe(LONG);
    expect((await rawPrisma.socialAccount.findMany({ where: { projectId: A.id }, select: { platform: true, status: true } })).map((a) => `${a.platform}:${a.status}`).sort()).toEqual(["FACEBOOK_PAGE:ACTIVE", "INSTAGRAM:ACTIVE"]);
    expect(await rawPrisma.socialAccount.count({ where: { projectId: B.id } })).toBe(0);
    expect(await latest(A)).toMatchObject({ status: "COMPLETED", userTokenCiphertext: null });

    // Replay of the same claim, even with everything else right.
    expect(await claim(people.manager, A, claimUrl, socialCookie(s.binding))).toContain("social_error=expired");
  });

  it("an expired attempt cannot be claimed", async () => {
    const s = await start(people.manager, A);
    const claimUrl = await callback(`state=${s.state}&code=GOOD`);
    await rawPrisma.metaOAuthSession.updateMany({ where: { projectId: A.id, status: "AUTHORIZED" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await claim(people.manager, A, claimUrl, socialCookie(s.binding))).toContain("social_error=expired");
  });

  it("a person who lost social.manage while at Meta cannot claim, even their own attempt", async () => {
    const lost = await user("SLost", await role("Social manage 3", ["social.view", "social.manage"]));
    await rawPrisma.projectAccess.createMany({ data: [{ projectId: A.id, userId: lost.userId }] });
    const s = await start(lost, A);
    const claimUrl = await callback(`state=${s.state}&code=GOOD`);
    const viewOnly = await rawPrisma.user.findUniqueOrThrow({ where: { id: people.viewer.userId }, select: { permissionModuleId: true } });
    await rawPrisma.user.update({ where: { id: lost.userId }, data: { permissionModuleId: viewOnly.permissionModuleId } });
    expect(await claim(lost, A, claimUrl, socialCookie(s.binding))).toContain("social_error=permission");
    expect(await latest(A)).toMatchObject({ claimedAt: null });
  });

  it("connecting again updates the same publishing connection; a Meta failure keeps nothing of the attempt", async () => {
    const before = await rawPrisma.socialConnection.count({ where: { projectId: A.id } });
    const s = await start(people.manager, A);
    const claimUrl = await callback(`state=${s.state}&code=GOOD`);
    expect(await claim(people.manager, A, claimUrl, socialCookie(s.binding))).toContain("connected=2");
    expect(await rawPrisma.socialConnection.count({ where: { projectId: A.id } })).toBe(before);

    meta.listFails = true;
    const f = await start(people.manager, A);
    const failUrl = await callback(`state=${f.state}&code=GOOD`);
    expect(await claim(people.manager, A, failUrl, socialCookie(f.binding))).toContain("social_error=meta");
    expect(await latest(A)).toMatchObject({ status: "FAILED", userTokenCiphertext: null });
  });
});

describe("4. messaging and publishing grants stay apart", () => {
  it("a publishing attempt cannot be claimed on the messaging side, nor open the messaging choice screen", async () => {
    const s = await start(people.manager, A);
    const claimUrl = await callback(`state=${s.state}&code=GOOD`);
    const c = new URL(claimUrl).searchParams.get("c")!;
    const viaMessaging = await as(people.manager, A, () =>
      messagingClaim.GET(new NextRequest(`https://${CUSTOMER}/p/${A.slug}/api/meta/claim?c=${encodeURIComponent(c)}`, { headers: headersFor(CUSTOMER, `${oauth.META_BINDING_COOKIE}=${s.binding}`) })),
    );
    expect(viaMessaging.headers.get("location")).toContain("meta_error=expired");
    const row = await latest(A);
    await expect(as(people.manager, A, () => oauth.loadMetaChoice({ sessionId: row.id, userId: people.manager.userId }))).rejects.toMatchObject({ code: "not_found" });
  });

  it("a messaging attempt cannot be claimed as a publishing one", async () => {
    const response = await as(people.manager, A, () => messagingConnect.GET(new NextRequest(`http://internal:8668/p/${A.slug}/api/meta/connect?type=MESSENGER`, { headers: headersFor(CUSTOMER) })));
    const binding = response.cookies.get(oauth.META_BINDING_COOKIE)?.value ?? null;
    const state = new URL(response.headers.get("location")!).searchParams.get("state");
    const claimUrl = await callback(`state=${state}&code=GOOD`);
    expect(claimUrl).toContain("/api/meta/claim?c=");
    expect(await claim(people.manager, A, claimUrl, socialCookie(binding))).toContain("social_error=expired");
    expect(await latest(A)).toMatchObject({ purpose: "CONNECT", claimedAt: null });
  });
});

describe("5. the retired callback", () => {
  it("redeems nothing and ends on a clear start-again", async () => {
    const before = meta.calls.length;
    const response = await retiredCallback.GET(new NextRequest("https://admin.example.test/api/social/meta/callback?state=x&code=GOOD"));
    expect(response.headers.get("location")).toContain("social_error%3Dexpired");
    expect(meta.calls.length).toBe(before);
  });
});
