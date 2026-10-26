import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, decryptSecret, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * "Connect with Facebook" through the platform's Meta app (docs/meta-integration), against a fake Meta,
 * in three fresh projects. What must hold:
 *   - off, or misconfigured, it does nothing at all (start refused, platform webhook 404);
 *   - the state is single-use, expires, and is stored only as a hash; a declined dialog connects nothing;
 *   - the result is handed only to the same person, in the same browser (binding cookie), once, and only
 *     inside the project that started it;
 *   - each Page is classified honestly; another workspace's one-click account is refused and never named;
 *   - a connection is CONNECTED only when Meta subscribed the Page; tokens are encrypted, the platform
 *     secret is never stored, the user token is wiped when the choice ends;
 *   - the same account can never be one-click in two projects (database index);
 *   - a manual connection keeps working, can be switched to one-click (same row, history kept), and its
 *     old webhook URL stops being accepted;
 *   - the platform webhook is signed, routed by account to the right project, deduplicated, and drops
 *     accounts no one-click connection holds — including another project's manual accounts;
 *   - deauthorize / data deletion are signed and only touch what that Facebook user authorised;
 *   - disconnecting Messenger keeps the Page subscribed while Instagram on the same Page still uses it.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

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
const oauth = await import("@/server/channels/metaOAuth");
const connections = await import("@/server/channels/connections");
const actions = await import("@/server/actions/channelConnections");
const connectRoute = await import("@/app/p/[project]/api/meta/connect/route");
const callbackRoute = await import("@/app/api/meta/oauth/callback/route");
const claimRoute = await import("@/app/p/[project]/api/meta/claim/route");
const platformWebhook = await import("@/app/api/meta/webhook/route");
const manualWebhook = await import("@/app/api/channels/meta/[key]/route");
const deauthRoute = await import("@/app/api/meta/deauthorize/route");
const deletionRoute = await import("@/app/api/meta/data-deletion/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;
let C: Project;

// ── A fake Meta ───────────────────────────────────────────────────────────────────────────────────
const PLATFORM_APP = "987654321098";
const PLATFORM_SECRET = "fedcba9876543210fedcba9876543210";
const VERIFY = `verify-${tag}-0123456789`;
const SHORT = `EAASHORT${tag}0000000000000`;
const LONG = `EAALONG${tag}00000000000000`;
const FB_USER = `7${Date.now()}`.slice(0, 15);
const P1 = `p1${tag}`; // Messaging + moderate, with Instagram
const P2 = `p2${tag}`; // analyst only
const P3 = `p3${tag}`; // connected manually in A first
const PX = `px${tag}`; // one-click in B
const IG1 = `ig1${tag}`;
const pageToken = (id: string) => `EAAPAGE${id}tok000000000`;

const meta = {
  calls: [] as string[],
  subscribeFails: false,
  granted: ["pages_show_list", "pages_manage_metadata", "pages_messaging", "instagram_basic", "instagram_manage_messages"],
  deadPageTokens: new Set<string>(),
  /** Meta answering a Page token with a DIFFERENT Page (a mix-up the connect step must refuse). */
  wrongPage: false,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const PAGES = () => [
  { id: P1, name: `Shop ${tag}`, tasks: ["MANAGE", "MESSAGING", "MODERATE"], instagram_business_account: { id: IG1, username: `shop_${tag}` } },
  { id: P2, name: `Blog ${tag}`, tasks: ["ANALYZE"] },
  { id: P3, name: `Manual ${tag}`, tasks: ["MANAGE", "MESSAGING", "MODERATE"] },
  { id: PX, name: `Other ${tag}`, tasks: ["MANAGE", "MESSAGING", "MODERATE"] },
];
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  meta.calls.push(`${method} ${url.pathname}`);
  if (url.pathname.endsWith("/oauth/access_token")) {
    if (url.searchParams.get("client_secret") !== PLATFORM_SECRET || url.searchParams.get("client_id") !== PLATFORM_APP) return json({ error: { code: 1, message: "bad client" } }, 400);
    if (url.searchParams.get("grant_type") === "fb_exchange_token") return url.searchParams.get("fb_exchange_token") === SHORT ? json({ access_token: LONG, expires_in: 5183944 }) : json({ error: { code: 190, message: "bad" } }, 400);
    if (url.searchParams.get("redirect_uri") !== "https://hub.example.test/api/meta/oauth/callback") return json({ error: { code: 100, message: "redirect_uri mismatch" } }, 400);
    return url.searchParams.get("code") === "GOOD" ? json({ access_token: SHORT, token_type: "bearer" }) : json({ error: { code: 100, message: "code used" } }, 400);
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? "";
  if (url.searchParams.get("appsecret_proof") !== createHmac("sha256", PLATFORM_SECRET).update(auth).digest("hex")) return json({ error: { code: 100, message: "Invalid appsecret_proof" } }, 400);
  if (meta.deadPageTokens.has(auth)) return json({ error: { code: 190, message: "Error validating access token" } }, 400);
  const pageOf = PAGES().find((p) => pageToken(p.id) === auth);
  if (url.pathname.endsWith("/me/permissions")) return json({ data: meta.granted.map((permission) => ({ permission, status: "granted" })) });
  if (url.pathname.endsWith("/me/accounts")) {
    if (auth !== LONG) return json({ error: { code: 190, message: "bad" } }, 400);
    const withTokens = (url.searchParams.get("fields") ?? "").includes("access_token");
    return json({ data: PAGES().map((p) => ({ ...p, ...(withTokens ? { access_token: pageToken(p.id) } : {}) })) });
  }
  if (url.pathname.endsWith("/me")) {
    if (auth === LONG) return json({ id: FB_USER, name: "Rudra Admin" });
    if (pageOf) return json({ id: meta.wrongPage ? `someone-else-${tag}` : pageOf.id, name: pageOf.name, category: "Shopping" });
    return json({ error: { code: 190, message: "bad" } }, 400);
  }
  if (url.searchParams.get("fields")?.startsWith("instagram_business_account")) {
    const page = PAGES().find((p) => url.pathname.endsWith(`/${p.id}`));
    return json({ id: page?.id, ...(page?.instagram_business_account ? { instagram_business_account: page.instagram_business_account } : {}) });
  }
  if (url.pathname.endsWith("/subscribed_apps")) {
    if (method === "POST") return meta.subscribeFails ? json({ error: { code: 200, message: "(#200) Requires pages_manage_metadata" } }, 403) : json({ success: true });
    if (method === "DELETE") return json({ success: true });
    return json({ data: [{ id: PLATFORM_APP, subscribed_fields: ["messages"] }] });
  }
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
  META_APP_ID: PLATFORM_APP,
  META_APP_SECRET: PLATFORM_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: VERIFY,
  META_OAUTH_REDIRECT_URI: "https://hub.example.test/api/meta/oauth/callback",
};
function enable(on = true) {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, on ? v : "");
  // The workspace allowlist fails closed; every test project is on it unless a test says otherwise.
  vi.stubEnv("META_ALLOWED_PROJECT_IDS", on ? [A, B, C].map((p) => p.id).join(",") : "");
}
const allowOnly = (...projects: Project[]) => vi.stubEnv("META_ALLOWED_PROJECT_IDS", projects.map((p) => p.id).join(" "));

/** Start a connection from a customer's address the way the button does, and return the pieces. */
async function start(person: Session, project: Project, query = "type=MESSENGER") {
  const response = await as(person, project, () =>
    connectRoute.GET(new NextRequest(`http://internal:8668/p/${project.slug}/api/meta/connect?${query}`, { headers: { "x-forwarded-host": "shop.customer.test", "x-forwarded-proto": "https" } })),
  );
  const location = response.headers.get("location") ?? "";
  const binding = response.cookies.get(oauth.META_BINDING_COOKIE)?.value ?? null;
  const state = location.startsWith("https://www.facebook.com/") ? new URL(location).searchParams.get("state") : null;
  return { location, binding, state };
}
async function callback(query: string) {
  const response = await callbackRoute.GET(new NextRequest(`https://hub.example.test/api/meta/oauth/callback?${query}`));
  return response.headers.get("location") ?? "";
}
async function claimVia(person: Session, project: Project, claimUrl: string, binding: string | null) {
  const c = new URL(claimUrl).searchParams.get("c") ?? "";
  const request = new NextRequest(`https://shop.customer.test/p/${project.slug}/api/meta/claim?c=${encodeURIComponent(c)}`, {
    headers: { "x-forwarded-host": "shop.customer.test", "x-forwarded-proto": "https", ...(binding ? { cookie: `${oauth.META_BINDING_COOKIE}=${binding}` } : {}) },
  });
  return (await as(person, project, () => claimRoute.GET(request))).headers.get("location") ?? "";
}
/** The whole way to the choice screen. */
async function authorize(person: Session, project: Project): Promise<string> {
  const s = await start(person, project);
  const claimUrl = await callback(`state=${s.state}&code=GOOD`);
  const landed = await claimVia(person, project, claimUrl, s.binding);
  const sessionId = /\/settings\/channels\/meta\/([a-z0-9]+)$/.exec(landed)?.[1];
  expect(sessionId, landed).toBeTruthy();
  return sessionId!;
}

function signed(body: unknown, secret = PLATFORM_SECRET) {
  const raw = JSON.stringify(body);
  return { raw, signature: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` };
}
const postPlatform = (body: unknown, secret = PLATFORM_SECRET) => {
  const { raw, signature } = signed(body, secret);
  return platformWebhook.POST(new NextRequest("https://hub.example.test/api/meta/webhook", { method: "POST", body: raw, headers: { "x-hub-signature-256": signature } }));
};
const pageBody = (entries: Array<{ id: string; mid: string }>) => ({
  object: "page",
  entry: entries.map((e) => ({ id: e.id, time: Date.now(), messaging: [{ sender: { id: `cust${tag}` }, recipient: { id: e.id }, timestamp: Date.now(), message: { mid: e.mid, text: "hello" } }] })),
});
const signedRequest = (payload: object, secret = PLATFORM_SECRET) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
};
const formPost = (url: string, fields: Record<string, string>) => new NextRequest(url, { method: "POST", body: new URLSearchParams(fields), headers: { "content-type": "application/x-www-form-urlencoded" } });

beforeAll(async () => {
  vi.stubEnv("NEXTAUTH_URL", "https://hub.example.test");
  vi.stubGlobal("fetch", fakeFetch);
  people.manager = await user("Manager", await role("Meta manage", ["channels.view", "channels.manage", "messages.view"]));
  people.other = await user("Other", await role("Meta manage 2", ["channels.view", "channels.manage", "messages.view"]));
  people.viewer = await user("Viewer", await role("Meta view", ["channels.view", "messages.view"]));
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: p.id, key: "OMNICHANNEL" } }, data: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("MetaA");
  B = await make("MetaB");
  C = await make("MetaC");
  forgetProjectFeatureStates();
});

beforeEach(() => {
  meta.calls.length = 0;
  meta.subscribeFails = false;
  meta.granted = ["pages_show_list", "pages_manage_metadata", "pages_messaging", "instagram_basic", "instagram_manage_messages"];
  meta.deadPageTokens.clear();
  meta.wrongPage = false;
  enable(true);
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.channelInboundEvent.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.metaOAuthSession.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1. off means off", () => {
  it("refuses to start and the platform webhook does not exist while it is not configured", async () => {
    enable(false);
    const s = await start(people.manager, A);
    expect(s.location).toContain("meta_error=not_configured");
    expect(s.binding).toBeNull();
    expect((await platformWebhook.POST(new NextRequest("https://hub.example.test/api/meta/webhook", { method: "POST", body: "{}" }))).status).toBe(404);
    expect((await platformWebhook.GET(new NextRequest(`https://hub.example.test/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=123`))).status).toBe(404);
    expect(await rawPrisma.metaOAuthSession.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("fails closed: configured but with no workspace allowlist, nothing starts and nothing is stored", async () => {
    vi.stubEnv("META_ALLOWED_PROJECT_IDS", "");
    const s = await start(people.manager, A);
    expect(s.location).toContain("meta_error=not_allowed");
    expect(s.binding).toBeNull();
    expect(await rawPrisma.metaOAuthSession.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("only workspaces on the allowlist can start; \"*\" means every workspace", async () => {
    allowOnly(B);
    expect((await start(people.manager, A)).location).toContain("meta_error=not_allowed");
    expect(await rawPrisma.metaOAuthSession.count({ where: { projectId: A.id } })).toBe(0);
    vi.stubEnv("META_ALLOWED_PROJECT_IDS", "*");
    expect((await start(people.manager, A)).location.startsWith("https://www.facebook.com/")).toBe(true);
    await rawPrisma.metaOAuthSession.deleteMany({ where: { projectId: A.id } });
  });

  it("a workspace taken off the list while its person is at Meta: the callback stores no token, the claim is refused", async () => {
    const atCallback = await start(people.manager, A);
    allowOnly(B, C);
    expect(await callback(`state=${atCallback.state}&code=GOOD`)).toBe(`https://shop.customer.test/p/${A.slug}/settings/channels?meta_error=not_allowed`);
    const failed = await rawPrisma.metaOAuthSession.findFirstOrThrow({ where: { projectId: A.id }, orderBy: { createdAt: "desc" } });
    expect(failed).toMatchObject({ status: "FAILED", userTokenCiphertext: null, claimHash: null, metaUserId: null });

    enable(true);
    const atClaim = await start(people.manager, A);
    const claimUrl = await callback(`state=${atClaim.state}&code=GOOD`);
    allowOnly(B, C);
    expect(await claimVia(people.manager, A, claimUrl, atClaim.binding)).toContain("meta_error=not_allowed");
    expect((await rawPrisma.metaOAuthSession.findFirstOrThrow({ where: { projectId: A.id }, orderBy: { createdAt: "desc" } })).claimedAt).toBeNull();
    await rawPrisma.metaOAuthSession.deleteMany({ where: { projectId: A.id } });
  });

  it("refuses a person without channels.manage", async () => {
    const s = await start(people.viewer, A);
    expect(s.location).toContain("meta_error=permission");
    expect(s.binding).toBeNull();
  });
});

describe("2. the dialog, the callback and the claim", () => {
  it("opens Meta's dialog for the platform app with a fresh state stored only as a hash", async () => {
    const s = await start(people.manager, A);
    const url = new URL(s.location);
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v25.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe(PLATFORM_APP);
    expect(url.searchParams.get("redirect_uri")).toBe(ENV.META_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toContain("pages_messaging");
    expect(s.state!.length).toBeGreaterThan(30);
    const row = await rawPrisma.metaOAuthSession.findFirstOrThrow({ where: { projectId: A.id }, orderBy: { createdAt: "desc" } });
    expect(row).toMatchObject({ status: "STARTED", returnOrigin: "https://shop.customer.test", returnPath: `/p/${A.slug}`, userId: people.manager.userId });
    expect(JSON.stringify(row)).not.toContain(s.state!);
    expect(JSON.stringify(row)).not.toContain(s.binding!);
  });

  it("uses a Facebook Login for Business configuration instead of scopes when one is set", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "112233445566");
    const url = new URL((await start(people.manager, A)).location);
    expect(url.searchParams.get("config_id")).toBe("112233445566");
    expect(url.searchParams.get("scope")).toBeNull();
    vi.stubEnv("META_LOGIN_CONFIG_ID", "");
  });

  it("refuses an unknown state, a declined dialog, a replay and an expired state", async () => {
    expect(await callback("state=thisstateneverexisted0000000000&code=GOOD")).toContain("meta_error%3Dexpired");

    const declined = await start(people.manager, A);
    expect(await callback(`state=${declined.state}&error=access_denied&error_reason=user_denied`)).toBe(`https://shop.customer.test/p/${A.slug}/settings/channels?meta_error=denied`);
    expect(await rawPrisma.metaOAuthSession.findFirst({ where: { projectId: A.id, status: "CANCELLED" } })).toBeTruthy();

    const once = await start(people.manager, A);
    expect(await callback(`state=${once.state}&code=GOOD`)).toContain("/api/meta/claim?c=");
    expect(await callback(`state=${once.state}&code=GOOD`)).toContain("meta_error=expired");

    const late = await start(people.manager, A);
    await rawPrisma.metaOAuthSession.updateMany({ where: { projectId: A.id, status: "STARTED" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await callback(`state=${late.state}&code=GOOD`)).toContain("meta_error=expired");
  });

  it("a code Meta will not redeem fails the attempt without storing anything", async () => {
    const s = await start(people.manager, A);
    expect(await callback(`state=${s.state}&code=BAD`)).toContain("meta_error=exchange_failed");
    const row = await rawPrisma.metaOAuthSession.findFirstOrThrow({ where: { projectId: A.id }, orderBy: { createdAt: "desc" } });
    expect(row).toMatchObject({ status: "FAILED", userTokenCiphertext: null, claimHash: null });
  });

  it("keeps the long-lived token encrypted, and hands the result only to the same person in the same browser, once", async () => {
    const s = await start(people.manager, A);
    const claimUrl = await callback(`state=${s.state}&code=GOOD`);
    expect(claimUrl.startsWith(`https://shop.customer.test/p/${A.slug}/api/meta/claim?c=`)).toBe(true);
    const row = await rawPrisma.metaOAuthSession.findFirstOrThrow({ where: { projectId: A.id }, orderBy: { createdAt: "desc" } });
    expect(row).toMatchObject({ status: "AUTHORIZED", metaUserId: FB_USER, metaUserName: "Rudra Admin" });
    expect(row.userTokenCiphertext).not.toContain(LONG);
    expect(decryptSecret(row.userTokenCiphertext!)).toBe(LONG);
    expect(row.grantedScopes).toContain("instagram_manage_messages");

    // Another person, even with the right cookie: refused. The right person without the cookie, or in
    // another project: refused. (The attacker-state / victim-login case is exactly the missing cookie.)
    expect(await claimVia(people.other, A, claimUrl, s.binding)).toContain("meta_error=session");
    expect(await claimVia(people.manager, A, claimUrl, null)).toContain("meta_error=binding");
    expect(await claimVia(people.manager, A, claimUrl, "a-different-binding-value-0000000")).toContain("meta_error=binding");
    expect(await claimVia(people.manager, B, claimUrl, s.binding)).toContain("meta_error=expired");
    const ok = await claimVia(people.manager, A, claimUrl, s.binding);
    expect(ok).toBe(`https://shop.customer.test/p/${A.slug}/settings/channels/meta/${row.id}`);
    expect(await claimVia(people.manager, A, claimUrl, s.binding)).toContain("meta_error=expired");
  });

  it("the choice screen opens only for the person who claimed it", async () => {
    const sessionId = await authorize(people.manager, A);
    await expect(as(people.other, A, () => oauth.loadMetaChoice({ sessionId, userId: people.other.userId }))).rejects.toMatchObject({ code: "session" });
    await expect(as(people.manager, B, () => oauth.loadMetaChoice({ sessionId, userId: people.manager.userId }))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("3. choosing and connecting", () => {
  it("B connects PX with one-click first", async () => {
    const sessionId = await authorize(people.manager, B);
    const outcomes = await as(people.manager, B, () => oauth.connectMetaAssets({ sessionId, userId: people.manager.userId, username: people.manager.username, keys: [`MESSENGER:${PX}`] }));
    expect(outcomes).toEqual([expect.objectContaining({ outcome: "CONNECTED" })]);
  });

  it("A has P3 connected manually (the original mode)", async () => {
    await rawPrisma.channelConnection.create({
      data: {
        projectId: A.id,
        type: "MESSENGER",
        name: "Manual",
        status: "CONNECTED",
        webhookKey: `manualkey${tag}000000000000`,
        externalAccountId: P3,
        pageId: P3,
        appId: "555555555555",
        accessTokenCiphertext: encryptSecret("EAAMANUAL0000000000000000"),
        appSecretCiphertext: encryptSecret("0123456789abcdef0123456789abcdef"),
      },
    });
  });

  it("classifies every Page honestly, and never names the other workspace", async () => {
    const sessionId = await authorize(people.manager, A);
    const choice = await as(people.manager, A, () => oauth.loadMetaChoice({ sessionId, userId: people.manager.userId }));
    const verdict = Object.fromEntries(choice.assets.map((a) => [a.key, a.availability]));
    expect(verdict).toMatchObject({
      [`MESSENGER:${P1}`]: "AVAILABLE",
      [`INSTAGRAM:${IG1}`]: "AVAILABLE",
      [`MESSENGER:${P2}`]: "MISSING_PAGE_ROLE",
      [`MESSENGER:${P3}`]: "MANUAL_HERE",
      [`MESSENGER:${PX}`]: "CONNECTED_ELSEWHERE",
    });
    expect(JSON.stringify(choice)).not.toContain(B.id);
    expect(JSON.stringify(choice)).not.toContain(B.slug);
    expect(JSON.stringify(choice)).not.toContain(pageToken(P1));
    // Listing never asked Meta for Page tokens.
    expect(meta.calls.filter((c) => c.endsWith("/me/accounts")).length).toBeGreaterThan(0);
  });

  it("refuses a declined permission on the screen", async () => {
    meta.granted = ["pages_show_list", "pages_manage_metadata", "pages_messaging"];
    const sessionId = await authorize(people.manager, A);
    const choice = await as(people.manager, A, () => oauth.loadMetaChoice({ sessionId, userId: people.manager.userId }));
    expect(choice.assets.find((a) => a.key === `INSTAGRAM:${IG1}`)).toMatchObject({ availability: "MISSING_PERMISSION", selectable: false });
    await as(people.manager, A, () => oauth.cancelMetaSession({ sessionId, userId: people.manager.userId }));
  });

  it("a viewer cannot connect anything", async () => {
    const sessionId = await authorize(people.manager, A);
    expect((await as(people.viewer, A, () => actions.connectMetaAssetsAction(sessionId, [`MESSENGER:${P1}`]))).error).toBeTruthy();
    await as(people.manager, A, () => oauth.cancelMetaSession({ sessionId, userId: people.manager.userId }));
  });

  it("connects Messenger and Instagram, switches the manual Page to one-click on the same row, and refuses the rest", async () => {
    const manual = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, externalAccountId: P3 } });
    const sessionId = await authorize(people.manager, A);
    const result = await as(people.manager, A, () =>
      actions.connectMetaAssetsAction(sessionId, [`MESSENGER:${P1}`, `INSTAGRAM:${IG1}`, `MESSENGER:${P3}`, `MESSENGER:${P2}`, `MESSENGER:${PX}`]),
    );
    const byKey = Object.fromEntries(result.outcomes!.map((o) => [o.key, o.outcome]));
    expect(byKey).toEqual({ [`MESSENGER:${P1}`]: "CONNECTED", [`INSTAGRAM:${IG1}`]: "CONNECTED", [`MESSENGER:${P3}`]: "CONNECTED", [`MESSENGER:${P2}`]: "REFUSED", [`MESSENGER:${PX}`]: "REFUSED" });

    const p1 = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "MESSENGER", externalAccountId: P1 } });
    expect(p1).toMatchObject({ authMode: "PLATFORM", status: "CONNECTED", appId: PLATFORM_APP, appSecretCiphertext: null, verifyTokenCiphertext: null, metaUserId: FB_USER });
    expect(decryptSecret(p1.accessTokenCiphertext!)).toBe(pageToken(P1));
    const switched = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: manual.id } });
    expect(switched).toMatchObject({ authMode: "PLATFORM", appSecretCiphertext: null, pageId: P3 });
    expect(switched.webhookKey).not.toBe(manual.webhookKey);

    const session = await rawPrisma.metaOAuthSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({ status: "COMPLETED", userTokenCiphertext: null });

    const view = await as(people.manager, A, () => connections.getChannelConnection(p1.id, { revealVerifyToken: true }));
    expect(view).toMatchObject({ authMode: "PLATFORM", webhookUrl: null });
    const text = JSON.stringify([view, await as(people.manager, A, () => connections.listChannelConnections())]);
    for (const secret of [pageToken(P1), PLATFORM_SECRET, LONG]) expect(text).not.toContain(secret);
    const logs = JSON.stringify(await rawPrisma.systemLog.findMany({ where: { projectId: A.id } }));
    for (const secret of [pageToken(P1), PLATFORM_SECRET, LONG, SHORT]) expect(logs).not.toContain(secret);

    // The switched connection's OLD manual webhook URL is no longer accepted.
    const raw = JSON.stringify(pageBody([{ id: P3, mid: `m.old.${tag}` }]));
    const sig = `sha256=${createHmac("sha256", "0123456789abcdef0123456789abcdef").update(raw).digest("hex")}`;
    const old = await manualWebhook.POST(new NextRequest(`https://hub.example.test/api/channels/meta/${manual.webhookKey}`, { method: "POST", body: raw, headers: { "x-hub-signature-256": sig } }), { params: Promise.resolve({ key: manual.webhookKey }) });
    expect(old.status).not.toBe(200);
  });

  it("a Page Meta does not subscribe is saved as ERROR, never CONNECTED", async () => {
    await rawPrisma.channelConnection.updateMany({ where: { projectId: A.id, externalAccountId: P1, type: "MESSENGER" }, data: { status: "DISCONNECTED" } });
    meta.subscribeFails = true;
    const sessionId = await authorize(people.manager, A);
    const outcomes = await as(people.manager, A, () => oauth.connectMetaAssets({ sessionId, userId: people.manager.userId, username: people.manager.username, keys: [`MESSENGER:${P1}`] }));
    expect(outcomes[0]).toMatchObject({ outcome: "SUBSCRIPTION_FAILED" });
    expect(await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "MESSENGER", externalAccountId: P1 } })).toMatchObject({ status: "ERROR" });
    meta.subscribeFails = false;
    const again = await authorize(people.manager, A);
    expect((await as(people.manager, A, () => oauth.connectMetaAssets({ sessionId: again, userId: people.manager.userId, username: people.manager.username, keys: [`MESSENGER:${P1}`] })))[0]).toMatchObject({ outcome: "CONNECTED" });
  });

  it("refuses a Page token Meta says belongs to a different Page", async () => {
    await rawPrisma.channelConnection.updateMany({ where: { projectId: A.id, externalAccountId: P1, type: "MESSENGER" }, data: { status: "DISCONNECTED" } });
    const sessionId = await authorize(people.manager, A);
    meta.wrongPage = true;
    const outcomes = await as(people.manager, A, () => oauth.connectMetaAssets({ sessionId, userId: people.manager.userId, username: people.manager.username, keys: [`MESSENGER:${P1}`] }));
    expect(outcomes[0]).toMatchObject({ outcome: "REFUSED" });
    expect(await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "MESSENGER", externalAccountId: P1 } })).toMatchObject({ status: "DISCONNECTED" });
    meta.wrongPage = false;
    const again = await authorize(people.manager, A);
    expect((await as(people.manager, A, () => oauth.connectMetaAssets({ sessionId: again, userId: people.manager.userId, username: people.manager.username, keys: [`MESSENGER:${P1}`] })))[0]).toMatchObject({ outcome: "CONNECTED" });
  });

  it("the database refuses the same account as one-click in a second project", async () => {
    await expect(
      rawPrisma.channelConnection.create({ data: { projectId: C.id, type: "MESSENGER", name: "dup", status: "CONNECTED", authMode: "PLATFORM", webhookKey: `dupkey${tag}0000000000000000`, externalAccountId: P1 } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // A MANUAL connection of the same Page in another project (its own app) is still allowed.
    const manualC = await rawPrisma.channelConnection.create({ data: { projectId: C.id, type: "MESSENGER", name: "own app", status: "CONNECTED", webhookKey: `ckey${tag}00000000000000000`, externalAccountId: P1, appId: "444444444444" } });
    expect(manualC.authMode).toBe("MANUAL");
  });
});

describe("4. the platform webhook", () => {
  it("verifies the handshake with the platform verify token only", async () => {
    const good = await platformWebhook.GET(new NextRequest(`https://hub.example.test/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`));
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("1158201444");
    expect((await platformWebhook.GET(new NextRequest("https://hub.example.test/api/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"))).status).toBe(403);
  });

  it("refuses a body not signed with the platform secret", async () => {
    expect((await postPlatform(pageBody([{ id: P1, mid: `m.bad.${tag}` }]), "0".repeat(32))).status).toBe(401);
    expect(await rawPrisma.channelInboundEvent.count({ where: { dedupKey: `msg:m.bad.${tag}` } })).toBe(0);
  });

  it("routes each account to its own project, once, and drops what no one-click connection holds", async () => {
    const body = pageBody([
      { id: P1, mid: `m.a.${tag}` },
      { id: PX, mid: `m.b.${tag}` },
      { id: `unknown${tag}`, mid: `m.u.${tag}` },
    ]);
    expect((await postPlatform(body)).status).toBe(200);
    expect((await postPlatform(body)).status).toBe(200);
    const a = await rawPrisma.channelInboundEvent.findMany({ where: { dedupKey: `msg:m.a.${tag}` } });
    const b = await rawPrisma.channelInboundEvent.findMany({ where: { dedupKey: `msg:m.b.${tag}` } });
    expect(a.map((e) => e.projectId)).toEqual([A.id]);
    expect(b.map((e) => e.projectId)).toEqual([B.id]);
    expect(await rawPrisma.channelInboundEvent.count({ where: { dedupKey: `msg:m.u.${tag}` } })).toBe(0);
    // C's MANUAL connection of P1 is never fed from the platform app.
    expect(await rawPrisma.channelInboundEvent.count({ where: { projectId: C.id } })).toBe(0);
  });

  it("a workspace off the allowlist receives nothing, while the others keep receiving", async () => {
    allowOnly(B, C);
    expect((await postPlatform(pageBody([{ id: P1, mid: `m.off.a.${tag}` }, { id: PX, mid: `m.off.b.${tag}` }]))).status).toBe(200);
    expect(await rawPrisma.channelInboundEvent.count({ where: { dedupKey: `msg:m.off.a.${tag}` } })).toBe(0);
    expect((await rawPrisma.channelInboundEvent.findMany({ where: { dedupKey: `msg:m.off.b.${tag}` } })).map((e) => e.projectId)).toEqual([B.id]);
  });

  it("a manual connection's own URL never feeds a one-click connection, even one naming the same app id", async () => {
    const ownSecret = "abcdefabcdefabcdefabcdefabcdef12";
    const key = `spoofkey${tag}0000000000000`;
    await rawPrisma.channelConnection.create({
      data: { projectId: A.id, type: "MESSENGER", name: "own app", status: "CONNECTED", webhookKey: key, externalAccountId: `own${tag}`, pageId: `own${tag}`, appId: PLATFORM_APP, appSecretCiphertext: encryptSecret(ownSecret) },
    });
    const raw = JSON.stringify(pageBody([{ id: P1, mid: `m.spoof.${tag}` }]));
    const sig = `sha256=${createHmac("sha256", ownSecret).update(raw).digest("hex")}`;
    const res = await manualWebhook.POST(new NextRequest(`https://hub.example.test/api/channels/meta/${key}`, { method: "POST", body: raw, headers: { "x-hub-signature-256": sig } }), { params: Promise.resolve({ key }) });
    expect(res.status).toBe(200);
    expect(await rawPrisma.channelInboundEvent.count({ where: { dedupKey: `msg:m.spoof.${tag}` } })).toBe(0);
  });
});

describe("5. health, disconnect and revocation", () => {
  it("checks a one-click connection with the platform secret, and asks for a Facebook reconnect when the token dies", async () => {
    const p1 = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "MESSENGER", externalAccountId: P1 } });
    const ok = await as(people.manager, A, () => connections.testConnection(p1.id));
    expect(ok.status).toBe("CONNECTED");
    expect(ok.checks.map((c) => c.label)).not.toContain("Meta verified the webhook address");
    meta.deadPageTokens.add(pageToken(P1));
    const dead = await as(people.manager, A, () => connections.testConnection(p1.id));
    expect(dead.status).toBe("NEEDS_RECONNECT");
    expect((await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: p1.id } })).lastError).toMatch(/Reconnect with Facebook/);
  });

  it("disconnecting Messenger keeps the Page subscribed while Instagram on it still uses it", async () => {
    const p1 = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "MESSENGER", externalAccountId: P1 } });
    const ig = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "INSTAGRAM", externalAccountId: IG1 } });
    await rawPrisma.channelConnection.update({ where: { id: p1.id }, data: { status: "CONNECTED" } });
    await as(people.manager, A, () => connections.disconnectConnection(p1.id));
    expect(meta.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    await as(people.manager, A, () => connections.disconnectConnection(ig.id));
    expect(meta.calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /v25.0/${P1}/subscribed_apps`]);
  });

  it("ignores a wrongly signed deauthorize, and on a real one marks only that person's connections for reconnecting", async () => {
    const before = await rawPrisma.channelConnection.findMany({ where: { projectId: { in: [A.id, B.id] }, authMode: "PLATFORM", status: "CONNECTED" }, select: { id: true } });
    expect(before.length).toBeGreaterThan(0);
    const bad = await deauthRoute.POST(formPost("https://hub.example.test/api/meta/deauthorize", { signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: FB_USER }, "1".repeat(32)) }));
    expect(bad.status).toBe(400);
    expect(await rawPrisma.channelConnection.count({ where: { id: { in: before.map((r) => r.id) }, status: "CONNECTED" } })).toBe(before.length);

    const good = await deauthRoute.POST(formPost("https://hub.example.test/api/meta/deauthorize", { signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: FB_USER }) }));
    expect(good.status).toBe(200);
    const after = await rawPrisma.channelConnection.findMany({ where: { id: { in: before.map((r) => r.id) } } });
    for (const row of after) expect(row).toMatchObject({ status: "NEEDS_RECONNECT", accessTokenCiphertext: null });
    // C's manual connection is not that person's authorisation and is untouched.
    expect(await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: C.id } })).toMatchObject({ status: "CONNECTED", authMode: "MANUAL" });
  });

  it("answers a data-deletion request with a code, forgets the person's Facebook id, and shows the status", async () => {
    const res = await deletionRoute.POST(formPost("https://hub.example.test/api/meta/data-deletion", { signed_request: signedRequest({ algorithm: "HMAC-SHA256", user_id: FB_USER }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[a-f0-9]{24}$/);
    expect(body.url).toBe(`https://hub.example.test/api/meta/data-deletion?code=${body.confirmation_code}`);
    expect(await rawPrisma.channelConnection.count({ where: { metaUserId: FB_USER } })).toBe(0);
    expect(await rawPrisma.metaOAuthSession.count({ where: { metaUserId: FB_USER } })).toBe(0);
    const status = await deletionRoute.GET(new NextRequest(body.url));
    expect(status.status).toBe(200);
    expect(await status.text()).toContain(body.confirmation_code);
    expect(await rawPrisma.metaDataDeletionRequest.count({ where: { confirmationCode: body.confirmation_code } })).toBe(1);
    await rawPrisma.metaDataDeletionRequest.deleteMany({ where: { confirmationCode: body.confirmation_code } });
  });
});
