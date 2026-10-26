import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { sendNextQueued } from "../channels/outboundProcessor.js";
import { CHECK_EVERY_MS, runMetaHealthTick } from "../channels/metaHealth.js";

/**
 * The worker's half of "Connect with Facebook" (docs/meta-integration): a one-click (PLATFORM)
 * connection stores no app secret, so the worker must use the platform's from the environment for
 * `appsecret_proof`; and the scheduled health check. What must hold:
 *   - a reply on a one-click connection is sent, signed with the PLATFORM secret; without it, nothing
 *     is sent and the reason says so;
 *   - a token Meta no longer accepts → NEEDS_RECONNECT, and the queue then sends nothing with it;
 *   - a Page Meta unsubscribed is subscribed again once; if Meta refuses, ERROR with the reason;
 *   - a network failure changes no status; a connection checked recently is not checked again;
 *   - manual connections are never touched by this check; nothing runs while the app is unconfigured;
 *   - abandoned attempts expire and lose their user token.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const PLATFORM_APP = "987654321098";
const PLATFORM_SECRET = "fedcba9876543210fedcba9876543210";
const PAGE = `wpage${tag}`;
const TOKEN = `EAAWPAGE${tag}token0000000000`;
const ENV = { META_APP_SECRET: PLATFORM_SECRET };

let projectId = "";
let creatorId = "";
let connectionId = "";
let manualId = "";
let conversationId = "";

const fake = { calls: [] as string[], dead: false, subscribed: true, subscribeRefused: false, network: false };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  fake.calls.push(`${method} ${url.pathname}`);
  if (fake.network) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace("Bearer ", "") ?? url.searchParams.get("access_token") ?? "";
  if (url.searchParams.get("appsecret_proof") !== createHmac("sha256", PLATFORM_SECRET).update(auth).digest("hex")) return json({ error: { code: 100, message: "Invalid appsecret_proof" } }, 400);
  if (fake.dead) return json({ error: { code: 190, message: "Error validating access token" } }, 400);
  if (url.pathname.endsWith("/messages")) return json({ recipient_id: "cust", message_id: `m.sent.${tag}.${fake.calls.length}` });
  if (url.pathname.endsWith("/me")) return json({ id: PAGE, category: "Shopping" });
  if (url.pathname.endsWith("/subscribed_apps")) {
    if (method === "POST") {
      if (fake.subscribeRefused) return json({ error: { code: 200, message: "(#200) Requires pages_manage_metadata" } }, 403);
      fake.subscribed = true;
      return json({ success: true });
    }
    return json({ data: fake.subscribed ? [{ id: PLATFORM_APP }] : [] });
  }
  return json({ error: { code: 803, message: "unexpected" } }, 404);
}) as typeof fetch;

const run = <T,>(fn: () => Promise<T>) => withProject(projectId, fn);
const reload = () => rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: connectionId } });
const markDue = () => rawPrisma.channelConnection.updateMany({ where: { id: connectionId }, data: { lastCheckedAt: new Date(Date.now() - CHECK_EVERY_MS - 60_000) } });
async function queueReply() {
  return rawPrisma.channelMessage.create({
    data: { projectId, conversationId, connectionId, type: "MESSENGER", direction: "OUTBOUND", senderType: "AGENT", text: "On it", occurredAt: new Date(), deliveryStatus: "QUEUED", idempotencyKey: `t-${randomUUID()}` },
  });
}

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `metaw_${tag}`, name: "Meta worker", passwordHash: "x" } })).id;
  const p = await createProjectWithDefaults({ name: `Meta worker ${tag}`, slug: `meta-w-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  projectId = p.id;
  await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId, key: "OMNICHANNEL" } }, data: { enabled: true } });
  connectionId = (
    await rawPrisma.channelConnection.create({
      data: { projectId, type: "MESSENGER", name: "One-click Page", status: "CONNECTED", authMode: "PLATFORM", appId: PLATFORM_APP, webhookKey: `wmp${tag}${tag}${tag}`, externalAccountId: PAGE, pageId: PAGE, accessTokenCiphertext: encryptSecret(TOKEN), lastCheckedAt: new Date() },
    })
  ).id;
  manualId = (
    await rawPrisma.channelConnection.create({
      data: { projectId, type: "INSTAGRAM", name: "Manual", status: "CONNECTED", appId: "111111111111", webhookKey: `wmm${tag}${tag}${tag}`, externalAccountId: `ig${tag}`, pageId: `other${tag}`, accessTokenCiphertext: encryptSecret("EAAMANUAL0000000000000000"), appSecretCiphertext: encryptSecret("0123456789abcdef0123456789abcdef"), lastCheckedAt: new Date(0) },
    })
  ).id;
  conversationId = (await rawPrisma.channelConversation.create({ data: { projectId, connectionId, type: "MESSENGER", externalThreadId: `cust${tag}`, lastInboundAt: new Date() } })).id;
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();
});

beforeEach(() => {
  fake.calls.length = 0;
  fake.dead = false;
  fake.subscribed = true;
  fake.subscribeRefused = false;
  fake.network = false;
});

afterAll(async () => {
  const where = { projectId };
  await rawPrisma.channelMessage.deleteMany({ where });
  await rawPrisma.channelConversation.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.metaOAuthSession.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: creatorId } });
  delete process.env.META_APP_SECRET;
});

describe("sending on a one-click connection", () => {
  it("is signed with the platform secret from the environment", async () => {
    process.env.META_APP_SECRET = PLATFORM_SECRET;
    const reply = await queueReply();
    await run(() => sendNextQueued(new Date(), fakeFetch));
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({ deliveryStatus: "SENT" });
    expect(fake.calls).toContain(`POST /v25.0/${PAGE}/messages`);
  });

  it("sends nothing when the server has no platform secret, and says why", async () => {
    delete process.env.META_APP_SECRET;
    const reply = await queueReply();
    await run(() => sendNextQueued(new Date(), fakeFetch));
    const row = await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: reply.id } });
    expect(row.deliveryStatus).toBe("FAILED");
    expect(row.lastError).toMatch(/Connect with Facebook is not configured/);
    expect(fake.calls).toEqual([]);
  });
});

describe("the scheduled health check", () => {
  it("does nothing while the platform app is not configured", async () => {
    await markDue();
    await runMetaHealthTick(new Date(), fakeFetch, {});
    expect(fake.calls).toEqual([]);
  });

  it("skips a connection checked recently, and never touches a manual one", async () => {
    await rawPrisma.channelConnection.update({ where: { id: connectionId }, data: { lastCheckedAt: new Date() } });
    // The manual connection is long overdue by the same rule — and must still be left alone.
    await rawPrisma.channelConnection.update({ where: { id: manualId }, data: { lastCheckedAt: new Date(0) } });
    await runMetaHealthTick(new Date(), fakeFetch, ENV);
    expect(fake.calls).toEqual([]);
    expect(await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: manualId } })).toMatchObject({ status: "CONNECTED", lastCheckedAt: new Date(0) });
  });

  it("subscribes a Page Meta dropped, once", async () => {
    await markDue();
    fake.subscribed = false;
    await runMetaHealthTick(new Date(), fakeFetch, ENV);
    expect(fake.calls).toContain(`POST /v25.0/${PAGE}/subscribed_apps`);
    expect(await reload()).toMatchObject({ status: "CONNECTED", lastError: null });
  });

  it("reads ERROR with the reason when Meta refuses to subscribe it again", async () => {
    await markDue();
    fake.subscribed = false;
    fake.subscribeRefused = true;
    await runMetaHealthTick(new Date(), fakeFetch, ENV);
    const row = await reload();
    expect(row.status).toBe("ERROR");
    expect(row.lastError).toMatch(/refused to subscribe it again/);
  });

  it("changes nothing on a network failure", async () => {
    await rawPrisma.channelConnection.update({ where: { id: connectionId }, data: { status: "CONNECTED", lastError: null } });
    await markDue();
    fake.network = true;
    await runMetaHealthTick(new Date(), fakeFetch, ENV);
    expect(await reload()).toMatchObject({ status: "CONNECTED", lastError: null });
  });

  it("marks a dead token for reconnecting, and the queue then sends nothing with it", async () => {
    await markDue();
    fake.dead = true;
    await runMetaHealthTick(new Date(), fakeFetch, ENV);
    const row = await reload();
    expect(row.status).toBe("NEEDS_RECONNECT");
    expect(row.lastError).toMatch(/Reconnect with Facebook/);
    process.env.META_APP_SECRET = PLATFORM_SECRET;
    fake.calls.length = 0;
    const reply = await queueReply();
    await run(() => sendNextQueued(new Date(), fakeFetch));
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: reply.id } })).deliveryStatus).toBe("FAILED");
    expect(fake.calls).toEqual([]);
  });

  it("expires abandoned attempts and wipes their user token", async () => {
    const s = await rawPrisma.metaOAuthSession.create({
      data: { projectId, userId: creatorId, purpose: "CONNECT", status: "AUTHORIZED", stateHash: `h${tag}`, browserBindingHash: "b", returnOrigin: "https://x.test", returnPath: "/p/x", userTokenCiphertext: encryptSecret("EAAUSER"), expiresAt: new Date(Date.now() - 1000) },
    });
    await runMetaHealthTick(new Date(), fakeFetch, {});
    expect(await rawPrisma.metaOAuthSession.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "EXPIRED", userTokenCiphertext: null });
  });
});
