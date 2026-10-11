import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, decryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { PERMISSIONS } from "@support-automation/shared";
import type { Session } from "@/server/auth";

/**
 * Messaging channels in the dashboard (OMNICHANNEL.md): connecting Messenger / Instagram / Telegram
 * against a fake Meta and a fake Telegram, receiving their webhooks, the unified inbox, and queueing a
 * person's reply — in two fresh projects, so neither can see the other.
 *
 * What must hold:
 *   - credentials Meta or Telegram reject are never saved; saved ones are encrypted and never returned;
 *   - a webhook is recorded only with a valid signature / secret, once per provider event however many
 *     times it is retried, only for an account a connection of THAT project has, and never processed
 *     on the request;
 *   - the unified inbox lists WhatsApp and the channels together from where each already lives, each
 *     channel's inbox only its own, and another project's conversations never;
 *   - a person's reply is queued once per nonce, refused outside the provider's window, tagged
 *     HUMAN_AGENT only when the connection says the permission is approved;
 *   - disconnecting keeps every conversation and cancels replies still waiting.
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
const connections = await import("@/server/channels/connections");
const inbox = await import("@/server/channels/inbox");
const connectionActions = await import("@/server/actions/channelConnections");
const inboxActions = await import("@/server/actions/channelInbox");
const metaRoute = await import("@/app/api/channels/meta/[key]/route");
const telegramRoute = await import("@/app/api/channels/telegram/[key]/route");

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let A: Project;
let B: Project;

// ── A fake Meta and a fake Telegram ───────────────────────────────────────────────────────────────
const APP_ID = "123456789012";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const PAGE_TOKEN = `EAAPAGE${tag}token0000000000`;
const USER_TOKEN = `EAAUSER${tag}token0000000000`;
/** A user token Meta answers WITHOUT an error when `category` is not refused — only the missing field gives it away. */
const QUIET_USER_TOKEN = `EAAQUIET${tag}token000000000`;
const PAGE_ID = `page${tag}`;
const PAGE2_ID = `pagetwo${tag}`;
const PAGE2_TOKEN = `EAAPAGETWO${tag}token00000000`;
const IG_ID = `ig${tag}`;
const BOT_TOKEN = `${700000000 + Math.floor(Math.random() * 1e6)}:AAH${tag}abcdefghijklmnopqrstuvwxyz`;
const BOT_ID = BOT_TOKEN.split(":")[0]!;

const meta = { calls: [] as string[], subscribeFails: false, linkedInstagram: true };
const telegram = { calls: [] as Array<{ method: string; body: Record<string, unknown> | null }>, webhookUrl: "" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.telegram.org") {
    const [, botPart, method] = url.pathname.split("/");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    telegram.calls.push({ method: method!, body });
    if (botPart !== `bot${BOT_TOKEN}`) return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    if (method === "getMe") return json({ ok: true, result: { id: Number(BOT_ID), is_bot: true, first_name: "Support Bot", username: `support_${tag}_bot` } });
    if (method === "setWebhook") {
      telegram.webhookUrl = String(body?.url);
      return json({ ok: true, result: true });
    }
    if (method === "deleteWebhook") return json({ ok: true, result: true });
    if (method === "getWebhookInfo") return json({ ok: true, result: { url: telegram.webhookUrl, pending_update_count: 0 } });
    return json({ ok: false, error_code: 404, description: "Not Found" }, 404);
  }
  meta.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? url.searchParams.get("access_token");
  if (url.pathname.endsWith(`/${APP_ID}`)) return auth === `${APP_ID}|${APP_SECRET}` ? json({ id: APP_ID, name: "Softify" }) : json({ error: { code: 190, message: "Invalid OAuth access token" } }, 400);
  // Every Page call must carry a valid appsecret_proof for its token.
  const proof = url.searchParams.get("appsecret_proof");
  if (auth && proof !== createHmac("sha256", APP_SECRET).update(auth).digest("hex")) return json({ error: { code: 100, message: "Invalid appsecret_proof" } }, 400);
  if (url.pathname.endsWith("/me")) {
    if (auth === PAGE_TOKEN) return json({ id: PAGE_ID, name: `Softify Page ${tag}`, category: "Software" });
    if (auth === PAGE2_TOKEN) return json({ id: PAGE2_ID, name: `Second Page ${tag}`, category: "Software" });
    if (auth === QUIET_USER_TOKEN) return json({ id: `person${tag}`, name: "Rudra" });
    if (auth === USER_TOKEN) return json({ error: { code: 100, message: "(#100) Tried accessing nonexisting field (category) on node type (User)" } }, 400);
    return json({ error: { code: 190, message: "Invalid OAuth access token" } }, 400);
  }
  if (url.pathname.endsWith(`/${PAGE_ID}`) && url.searchParams.get("fields")?.startsWith("instagram_business_account")) {
    return json(meta.linkedInstagram ? { id: PAGE_ID, instagram_business_account: { id: IG_ID, username: `softify_${tag}` } } : { id: PAGE_ID });
  }
  if (url.pathname.endsWith("/subscribed_apps")) {
    if (init?.method === "POST") return meta.subscribeFails ? json({ error: { code: 200, message: "(#200) Requires pages_messaging permission" } }, 403) : json({ success: true });
    if (init?.method === "DELETE") return json({ success: true });
    return json({ data: [{ id: APP_ID, subscribed_fields: ["messages"] }] });
  }
  return json({ error: { code: 803, message: "unexpected" } }, 404);
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
const people = {} as Record<"manager" | "agent" | "viewer", Session>;
const as = <T,>(person: Session, project: Project, fn: () => Promise<T>) => {
  current = person;
  return runWithProject(project, fn);
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function signed(body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  return { raw, signature: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` };
}
async function postMeta(key: string, body: unknown, secret = APP_SECRET) {
  const { raw, signature } = signed(body, secret);
  return metaRoute.POST(new NextRequest(`https://assist.example.test/api/channels/meta/${key}`, { method: "POST", body: raw, headers: { "x-hub-signature-256": signature } }), {
    params: Promise.resolve({ key }),
  });
}
async function postTelegram(key: string, update: unknown, secret: string | null) {
  return telegramRoute.POST(
    new NextRequest(`https://assist.example.test/api/channels/telegram/${key}`, { method: "POST", body: JSON.stringify(update), headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} }),
    { params: Promise.resolve({ key }) },
  );
}
const messengerBody = (pageId: string, items: unknown[]) => ({ object: "page", entry: [{ id: pageId, time: Date.now(), messaging: items }] });
const customerMessage = (pageId: string, user: string, mid: string, text: string) => ({ sender: { id: user }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text } });

const state = { messengerId: "", instagramId: "", telegramId: "", messengerKey: "", telegramKey: "", telegramSecret: "", verifyToken: "", bConnectionId: "" };

beforeAll(async () => {
  vi.stubEnv("NEXTAUTH_URL", "https://assist.example.test");
  vi.stubGlobal("fetch", fakeFetch);
  people.manager = await user("Manager", await role("CH manage", ["channels.view", "channels.manage", "messages.view", "conversations.reply"]));
  people.agent = await user("Agent", await role("CH agent", ["messages.view", "conversations.reply"]));
  people.viewer = await user("Viewer", await role("CH view", ["messages.view", "channels.view"]));
  const make = async (name: string) => {
    const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: people.manager.userId }, rawPrisma);
    ids.projects.push(p.id);
    await rawPrisma.projectAccess.createMany({ data: Object.values(people).map((u) => ({ projectId: p.id, userId: u.userId })), skipDuplicates: true });
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: p.id, key: "OMNICHANNEL" } }, data: { enabled: true } });
    return { id: p.id, slug: p.slug, name: `${name} ${tag}`, status: "ACTIVE" as const };
  };
  A = await make("OmniA");
  B = await make("OmniB");
  forgetProjectFeatureStates();
});

beforeEach(() => {
  meta.calls.length = 0;
  meta.subscribeFails = false;
  meta.linkedInstagram = true;
  telegram.calls.length = 0;
});

afterAll(async () => {
  const where = { projectId: { in: ids.projects } };
  await rawPrisma.channelMessage.deleteMany({ where });
  await rawPrisma.channelInboundEvent.deleteMany({ where });
  await rawPrisma.channelConversation.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.message.deleteMany({ where });
  await rawPrisma.whatsAppGroup.deleteMany({ where });
  await rawPrisma.whatsAppAccount.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: { in: ids.users } } });
  forgetProjectFeatureStates();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1. connecting", () => {
  it("refuses a viewer, and refuses credentials Meta rejects without saving anything", async () => {
    expect((await as(people.viewer, A, () => connectionActions.connectChannelAction({}, form({ type: "MESSENGER", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN })))).error).toBeTruthy();
    const wrongSecret = await as(people.manager, A, () =>
      connectionActions.connectChannelAction({}, form({ type: "MESSENGER", appId: APP_ID, appSecret: "ffffffffffffffffffffffffffffffff", pageAccessToken: PAGE_TOKEN })),
    );
    expect(wrongSecret.error).toMatch(/did not accept this App ID and App Secret/);
    const userToken = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "MESSENGER", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: USER_TOKEN })));
    expect(userToken.error).toMatch(/user token|person, not a Page|Page access token/);
    const quiet = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "MESSENGER", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: QUIET_USER_TOKEN })));
    expect(quiet.error).toMatch(/belongs to a person, not a Page/);
    expect(await rawPrisma.channelConnection.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("connects a Page: checked, subscribed, encrypted, and the view never carries a credential", async () => {
    const result = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "MESSENGER", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN })));
    expect(result).toMatchObject({ success: "Connected." });
    expect(meta.calls).toContain(`POST /v25.0/${PAGE_ID}/subscribed_apps`);
    const row = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "MESSENGER" } });
    state.messengerId = row.id;
    state.messengerKey = row.webhookKey;
    expect(row).toMatchObject({ status: "CONNECTED", externalAccountId: PAGE_ID, appId: APP_ID, createdByUsername: people.manager.username });
    expect(row.accessTokenCiphertext).not.toContain(PAGE_TOKEN);
    expect(decryptSecret(row.accessTokenCiphertext!)).toBe(PAGE_TOKEN);
    expect(decryptSecret(row.appSecretCiphertext!)).toBe(APP_SECRET);
    const view = await as(people.manager, A, () => connections.getChannelConnection(row.id, { revealVerifyToken: true }));
    state.verifyToken = view!.verifyToken!;
    expect(view!.webhookUrl).toBe(`https://assist.example.test/api/channels/meta/${row.webhookKey}`);
    const text = JSON.stringify(await as(people.manager, A, () => connections.listChannelConnections()));
    for (const secret of [PAGE_TOKEN, APP_SECRET, state.verifyToken, "Ciphertext"]) expect(text).not.toContain(secret);
    const logs = JSON.stringify(await rawPrisma.systemLog.findMany({ where: { projectId: A.id } }));
    for (const secret of [PAGE_TOKEN, APP_SECRET]) expect(logs).not.toContain(secret);
  });

  it("refuses the same Page twice in one project", async () => {
    const again = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "MESSENGER", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN })));
    expect(again.error).toMatch(/already connected/);
  });

  it("connects the Instagram account linked to the Page, and refuses a Page with none", async () => {
    meta.linkedInstagram = false;
    const none = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "INSTAGRAM", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN })));
    expect(none.error).toMatch(/no Instagram professional account linked/);
    meta.linkedInstagram = true;
    const ok = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "INSTAGRAM", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN })));
    expect(ok.success).toBe("Connected.");
    const row = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "INSTAGRAM" } });
    state.instagramId = row.id;
    expect(row).toMatchObject({ externalAccountId: IG_ID, pageId: PAGE_ID, name: `@softify_${tag}` });
  });

  it("saves a Page whose subscription Meta refused as ERROR, saying why", async () => {
    meta.subscribeFails = true;
    const result = await as(people.manager, B, () => connectionActions.connectChannelAction({}, form({ type: "MESSENGER", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: PAGE2_TOKEN })));
    expect(result.warning).toMatch(/did not subscribe the Page/);
    const row = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: B.id, type: "MESSENGER" } });
    state.bConnectionId = row.id;
    expect(row.status).toBe("ERROR");
  });

  it("connects a Telegram bot and registers its webhook with a secret", async () => {
    const bad = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "TELEGRAM", botToken: "12345:short" })));
    expect(bad.error).toMatch(/not a bot token/);
    const ok = await as(people.manager, A, () => connectionActions.connectChannelAction({}, form({ type: "TELEGRAM", botToken: BOT_TOKEN })));
    expect(ok.success).toBe("Connected.");
    const row = await rawPrisma.channelConnection.findFirstOrThrow({ where: { projectId: A.id, type: "TELEGRAM" } });
    state.telegramId = row.id;
    state.telegramKey = row.webhookKey;
    state.telegramSecret = decryptSecret(row.webhookSecretCiphertext!);
    const set = telegram.calls.find((c) => c.method === "setWebhook")!;
    expect(set.body).toMatchObject({ url: `https://assist.example.test/api/channels/telegram/${row.webhookKey}`, secret_token: state.telegramSecret });
    expect(row).toMatchObject({ status: "CONNECTED", externalAccountId: BOT_ID, externalUsername: `support_${tag}_bot` });
  });

  it("a health check reports what it checked", async () => {
    const result = await as(people.manager, A, () => connectionActions.testChannelAction(state.telegramId));
    expect(result.checks?.map((c) => c.label)).toEqual(expect.arrayContaining(["Bot token accepted", "Webhook points to this server"]));
    expect(result.checks?.find((c) => c.label === "Webhook points to this server")?.ok).toBe(true);
  });
});

describe("2. webhooks", () => {
  it("Meta's verification handshake answers only the right token", async () => {
    const url = (token: string) => `https://assist.example.test/api/channels/meta/${state.messengerKey}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;
    const wrong = await metaRoute.GET(new NextRequest(url("nope")), { params: Promise.resolve({ key: state.messengerKey }) });
    expect(wrong.status).toBe(403);
    const right = await metaRoute.GET(new NextRequest(url(state.verifyToken)), { params: Promise.resolve({ key: state.messengerKey }) });
    expect(right.status).toBe(200);
    expect(await right.text()).toBe("1158201444");
    expect((await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: state.messengerId } })).webhookVerifiedAt).not.toBeNull();
  });

  it("refuses a body without the app's signature, and records nothing", async () => {
    const body = messengerBody(PAGE_ID, [customerMessage(PAGE_ID, "U1", `m.forged.${tag}`, "hi")]);
    expect((await postMeta(state.messengerKey, body, "ffffffffffffffffffffffffffffffff")).status).toBe(401);
    const unsigned = await metaRoute.POST(new NextRequest(`https://assist.example.test/api/channels/meta/${state.messengerKey}`, { method: "POST", body: JSON.stringify(body) }), {
      params: Promise.resolve({ key: state.messengerKey }),
    });
    expect(unsigned.status).toBe(401);
    expect((await postMeta(`unknown${tag}unknown${tag}`, body)).status).toBe(404);
    expect(await rawPrisma.channelInboundEvent.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("records each event once, however often Meta retries the body", async () => {
    const body = messengerBody(PAGE_ID, [customerMessage(PAGE_ID, "U1", `m.1.${tag}`, "Internet is down"), { sender: { id: "U1" }, recipient: { id: PAGE_ID }, timestamp: Date.now(), read: { watermark: Date.now() } }]);
    for (let i = 0; i < 3; i++) expect((await postMeta(state.messengerKey, body)).status).toBe(200);
    const events = await rawPrisma.channelInboundEvent.findMany({ where: { projectId: A.id } });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.status === "PENDING" && e.connectionId === state.messengerId)).toBe(true);
    // Recorded, not processed: no conversation exists until the worker runs.
    expect(await rawPrisma.channelConversation.count({ where: { projectId: A.id } })).toBe(0);
  });

  it("routes an Instagram body arriving at the Messenger URL to the Instagram connection of the same app, and drops accounts nobody connected", async () => {
    const ig = { object: "instagram", entry: [{ id: IG_ID, time: 1, messaging: [customerMessage(IG_ID, "IGU1", `ig.1.${tag}`, "price?")] }] };
    const stranger = messengerBody(`stranger${tag}`, [customerMessage(`stranger${tag}`, "U9", `m.stranger.${tag}`, "hello")]);
    expect((await postMeta(state.messengerKey, ig)).status).toBe(200);
    expect((await postMeta(state.messengerKey, stranger)).status).toBe(200);
    expect(await rawPrisma.channelInboundEvent.count({ where: { connectionId: state.instagramId } })).toBe(1);
    expect(await rawPrisma.channelInboundEvent.count({ where: { dedupKey: `msg:m.stranger.${tag}` } })).toBe(0);
  });

  it("never records project A's Page through project B's connection, even with the same app", async () => {
    const intoB = messengerBody(PAGE_ID, [customerMessage(PAGE_ID, "U2", `m.cross.${tag}`, "cross")]);
    const bKey = (await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: state.bConnectionId } })).webhookKey;
    expect((await postMeta(bKey, intoB)).status).toBe(200);
    expect(await rawPrisma.channelInboundEvent.count({ where: { dedupKey: `msg:m.cross.${tag}` } })).toBe(0);
  });

  it("Telegram: the secret is required, and an update is recorded once", async () => {
    const update = { update_id: 900001, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private", first_name: "Nusrat" }, from: { id: 4242, is_bot: false, first_name: "Nusrat" }, text: "bill?" } };
    expect((await postTelegram(state.telegramKey, update, null)).status).toBe(401);
    expect((await postTelegram(state.telegramKey, update, "wrong-secret")).status).toBe(401);
    expect((await postTelegram(state.messengerKey, update, state.telegramSecret)).status).toBe(404);
    for (let i = 0; i < 2; i++) expect((await postTelegram(state.telegramKey, update, state.telegramSecret)).status).toBe(200);
    expect(await rawPrisma.channelInboundEvent.count({ where: { connectionId: state.telegramId } })).toBe(1);
  });
});

describe("3. the unified inbox", () => {
  const conv = { messenger: "", telegramGroup: "", instagram: "", other: "" };

  beforeAll(async () => {
    // What the worker would have written; the inbox only reads it.
    const pid = { projectId: A.id };
    const m = await rawPrisma.channelConversation.create({
      data: { ...pid, connectionId: state.messengerId, type: "MESSENGER", externalThreadId: "U1", customerName: `Rahim ${tag}`, lastMessageAt: ago(5), lastInboundAt: ago(5), lastMessagePreview: "Internet is down", lastMessageDirection: "INBOUND" },
    });
    conv.messenger = m.id;
    await rawPrisma.channelMessage.create({ data: { ...pid, conversationId: m.id, connectionId: state.messengerId, type: "MESSENGER", direction: "INBOUND", senderType: "CUSTOMER", externalMessageId: `m.1.${tag}`, text: "Internet is down since morning", occurredAt: ago(5) } });
    const g = await rawPrisma.channelConversation.create({
      data: { ...pid, connectionId: state.telegramId, type: "TELEGRAM", externalThreadId: "-1001", kind: "GROUP", title: `Branch ${tag}`, lastMessageAt: ago(30), lastInboundAt: ago(30), lastMessagePreview: "ok", lastMessageDirection: "INBOUND", status: "CLOSED" },
    });
    conv.telegramGroup = g.id;
    const i = await rawPrisma.channelConversation.create({
      data: { ...pid, connectionId: state.instagramId, type: "INSTAGRAM", externalThreadId: "IGU1", customerUsername: `nusrat_${tag}`, lastMessageAt: ago(26 * 60), lastInboundAt: ago(26 * 60), lastMessagePreview: "price?", lastMessageDirection: "INBOUND", assignedUserId: people.agent.userId },
    });
    conv.instagram = i.id;
    const o = await rawPrisma.channelConversation.create({
      data: { projectId: B.id, connectionId: state.bConnectionId, type: "MESSENGER", externalThreadId: "UB", customerName: `Other project ${tag}`, lastMessageAt: ago(1), lastInboundAt: ago(1), lastMessagePreview: "secret", lastMessageDirection: "INBOUND" },
    });
    conv.other = o.id;
    // A WhatsApp group in project A, with a waiting customer — read through WhatsApp Chat's own reader.
    const account = await rawPrisma.whatsAppAccount.create({ data: { ...pid, label: `WA ${tag}`, status: "CONNECTED" } });
    const group = await rawPrisma.whatsAppGroup.create({ data: { ...pid, accountId: account.id, whatsappGroupId: `omni-${tag}@g.us`, name: `WA group ${tag}`, isActive: true } });
    await rawPrisma.message.create({
      data: { ...pid, accountId: account.id, groupId: group.id, chatId: group.whatsappGroupId, whatsappMessageId: `omni-${tag}-1`, senderPhone: "8801700000001", direction: "INCOMING", body: "router red light", normalizedBody: "router red light", timestampWa: ago(10), processingStatus: "PROCESSED" },
    });
  });

  it("All lists WhatsApp and every channel together, newest first, and nothing of another project", async () => {
    const result = await as(people.agent, A, () => inbox.loadInbox({ scope: "all", viewerId: people.agent.userId }));
    const titles = result.items.map((i) => i.title);
    expect(titles).toEqual([`Rahim ${tag}`, `WA group ${tag}`, `@nusrat_${tag}`]);
    expect(result.items.map((i) => i.channel)).toEqual(["MESSENGER", "WHATSAPP", "INSTAGRAM"]);
    expect(result.items[1]!.href).toMatch(/^\/chat\/account\//);
    expect(result.items[0]!.href).toBe(`/conversations/all/c/${conv.messenger}`);
    expect(JSON.stringify(result)).not.toContain("Other project");
    expect(result.counts).toMatchObject({ all: 3, closed: 1, mine: 1 });
    expect(result.counts.byChannel).toMatchObject({ WHATSAPP: 1, MESSENGER: 1, INSTAGRAM: 1, TELEGRAM: 0 });
  });

  it("a channel's inbox is that channel only — the same rows, not a copy", async () => {
    const ig = await as(people.agent, A, () => inbox.loadInbox({ scope: "instagram", viewerId: people.agent.userId }));
    expect(ig.items.map((i) => i.channel)).toEqual(["INSTAGRAM"]);
    expect(ig.items[0]!.key).toBe(`ch:${conv.instagram}`);
    const wa = await as(people.agent, A, () => inbox.loadInbox({ scope: "whatsapp", viewerId: people.agent.userId }));
    expect(wa.items.map((i) => i.channel)).toEqual(["WHATSAPP"]);
  });

  it("filters: closed, assigned to me, needs reply, search by message text", async () => {
    const closed = await as(people.agent, A, () => inbox.loadInbox({ scope: "all", view: "closed", viewerId: people.agent.userId }));
    expect(closed.items.map((i) => i.title)).toEqual([`Branch ${tag}`]);
    const mine = await as(people.agent, A, () => inbox.loadInbox({ scope: "all", view: "mine", viewerId: people.agent.userId }));
    expect(mine.items.map((i) => i.title)).toEqual([`@nusrat_${tag}`]);
    const needs = await as(people.agent, A, () => inbox.loadInbox({ scope: "all", view: "needs-reply", viewerId: people.agent.userId }));
    expect(needs.items.map((i) => i.title).sort()).toEqual([`@nusrat_${tag}`, `Rahim ${tag}`, `WA group ${tag}`].sort());
    const found = await as(people.agent, A, () => inbox.loadInbox({ scope: "all", search: "since morning", viewerId: people.agent.userId }));
    expect(found.items.map((i) => i.title)).toEqual([`Rahim ${tag}`]);
  });

  it("another project's conversation cannot be opened, replied to or listed by action", async () => {
    expect(await as(people.agent, A, () => inbox.getChannelThread(conv.other))).toBeNull();
    const reply = await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.other, "hi", `nonce-${tag}-x`));
    expect(reply.error).toMatch(/no longer exists/);
    const listed = await as(people.agent, A, () => inboxActions.listInboxAction({ scope: "all", search: "Other project" }));
    expect(listed!.items).toEqual([]);
  });

  it("reading needs the feature: with Omnichannel off the list action answers nothing", async () => {
    await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: A.id, key: "OMNICHANNEL" } }, data: { enabled: false } });
    forgetProjectFeatureStates();
    try {
      expect(await as(people.agent, A, () => inboxActions.listInboxAction({ scope: "all" }))).toBeNull();
      expect((await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.messenger, "hi", `nonce-${tag}-off`))).error).toMatch(/not enabled/);
    } finally {
      await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: A.id, key: "OMNICHANNEL" } }, data: { enabled: true } });
      forgetProjectFeatureStates();
    }
  });

  it("a reply is queued once per nonce, pauses AI, and marks the conversation read", async () => {
    expect((await as(people.viewer, A, () => inboxActions.sendChannelReplyAction(conv.messenger, "hello", `nonce-${tag}-v`))).error).toBeTruthy();
    const nonce = `nonce-${tag}-1`;
    const first = await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.messenger, "  We are checking your line.  ", nonce));
    const second = await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.messenger, "  We are checking your line.  ", nonce));
    expect(first.messageId).toBe(second.messageId);
    expect(second.success).toBe("Already queued.");
    const queued = await rawPrisma.channelMessage.findMany({ where: { conversationId: conv.messenger, direction: "OUTBOUND" } });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ text: "We are checking your line.", deliveryStatus: "QUEUED", senderType: "AGENT", createdByUserId: people.agent.userId, messagingType: "RESPONSE", messagingTag: null });
    const c = await rawPrisma.channelConversation.findUniqueOrThrow({ where: { id: conv.messenger } });
    expect(c.aiSuppressedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(c.reviewedAt).not.toBeNull();
    expect(c.lastMessageDirection).toBe("OUTBOUND");
    // Answered now: it leaves "needs reply".
    const needs = await as(people.agent, A, () => inbox.loadInbox({ scope: "messenger", view: "needs-reply", viewerId: people.agent.userId }));
    expect(needs.items).toEqual([]);
  });

  it("refuses a reply past Meta's 24 hours, and tags it HUMAN_AGENT once the permission is switched on", async () => {
    const late = await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.instagram, "Sorry for the wait", `nonce-${tag}-late`));
    expect(late.error).toMatch(/Human Agent/);
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: conv.instagram } })).toBe(0);
    await as(people.manager, A, () => connectionActions.setChannelFlagsAction(state.instagramId, { humanAgentEnabled: true }));
    const tagged = await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.instagram, "Sorry for the wait", `nonce-${tag}-late2`));
    expect(tagged.error).toBeUndefined();
    expect(await rawPrisma.channelMessage.findFirstOrThrow({ where: { conversationId: conv.instagram } })).toMatchObject({ messagingType: "MESSAGE_TAG", messagingTag: "HUMAN_AGENT" });
    // Instagram counts bytes: 400 Bangla letters are 1,200 bytes.
    const tooLong = await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.instagram, "আ".repeat(400), `nonce-${tag}-long`));
    expect(tooLong.error).toMatch(/1000 bytes/);
  });

  it("a failed reply can be sent again; an unconfirmed one only after the person confirms", async () => {
    const msg = await rawPrisma.channelMessage.findFirstOrThrow({ where: { conversationId: conv.messenger, direction: "OUTBOUND" } });
    await rawPrisma.channelMessage.update({ where: { id: msg.id }, data: { deliveryStatus: "UNKNOWN", lastError: "timed out" } });
    expect((await as(people.agent, A, () => inboxActions.retryChannelReplyAction(msg.id, false))).error).toMatch(/not known whether/);
    expect((await as(people.agent, A, () => inboxActions.retryChannelReplyAction(msg.id, true))).success).toBe("Queued again.");
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: msg.id } })).toMatchObject({ deliveryStatus: "QUEUED", lastError: null, attempts: 0 });
  });

  it("disconnecting keeps every conversation, cancels waiting replies, and wipes the credentials", async () => {
    const result = await as(people.manager, A, () => connectionActions.disconnectChannelAction(state.messengerId));
    expect(result.success).toMatch(/Disconnected/);
    expect(meta.calls).toContain(`DELETE /v25.0/${PAGE_ID}/subscribed_apps`);
    const row = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: state.messengerId } });
    expect(row).toMatchObject({ status: "DISCONNECTED", enabled: false, accessTokenCiphertext: null, appSecretCiphertext: null, verifyTokenCiphertext: null });
    expect(await rawPrisma.channelConversation.count({ where: { connectionId: state.messengerId } })).toBe(1);
    expect(await rawPrisma.channelMessage.findFirstOrThrow({ where: { conversationId: conv.messenger, direction: "OUTBOUND" } })).toMatchObject({ deliveryStatus: "FAILED" });
    // Its webhook URL no longer records anything.
    expect((await postMeta(state.messengerKey, messengerBody(PAGE_ID, [customerMessage(PAGE_ID, "U1", `m.after.${tag}`, "hello?")]))).status).toBe(404);
    const reply = await as(people.agent, A, () => inboxActions.sendChannelReplyAction(conv.messenger, "still there?", `nonce-${tag}-dc`));
    expect(reply.error).toMatch(/disconnected/);
    // Reconnecting brings back the same row, with a fresh webhook address and verify token.
    const back = await as(people.manager, A, () =>
      connectionActions.updateChannelCredentialsAction({}, form({ connectionId: state.messengerId, type: "MESSENGER", appId: APP_ID, appSecret: APP_SECRET, pageAccessToken: PAGE_TOKEN })),
    );
    expect(back.success).toMatch(/accepted/);
    const revived = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: state.messengerId } });
    expect(revived.status).toBe("CONNECTED");
    expect(revived.webhookKey).not.toBe(state.messengerKey);
    expect(revived.verifyTokenCiphertext).not.toBeNull();
  });
});
