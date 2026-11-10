import "./helpers/requireTestDatabase";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createProjectWithDefaults, decryptSecret, prisma as rawPrisma } from "@support-automation/db";

/**
 * WhatsApp (Official API) in the dashboard, against a fake Meta. What must hold: a webhook counts only when Meta's signature is right, and only for a
 * number connected in that project; a saved token is encrypted; a template goes only to somebody who has written in, only if approved, and only once.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { runWithProject } = await import("@/server/projectContext");
const connections = await import("@/server/channels/connections");
const templates = await import("@/server/channels/cloudTemplates");
const metaRoute = await import("@/app/api/channels/meta/[key]/route");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const digits = tag.replace(/\D/g, "7").padEnd(8, "7");
const PHONE_ID = `1${digits}`;
const WABA_ID = `2${digits}`;
const APP_ID = `3${digits}`;
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = `EAACLOUD${tag}token0000000000`;

type Project = { id: string; slug: string; name: string; status: "ACTIVE" };
let project: Project;
let userId = "";
let connectionId = "";
let webhookKey = "";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const metaCalls: string[] = [];
const fakeMeta = (async (input: unknown) => {
  const url = new URL(String(input));
  metaCalls.push(url.pathname);
  if (url.pathname.endsWith(`/${PHONE_ID}`)) return json({ id: PHONE_ID, display_phone_number: "+880 1711 000000", verified_name: "Acme ISP" });
  if (url.pathname.endsWith(`/${WABA_ID}/subscribed_apps`)) return json({ success: true });
  if (url.pathname.endsWith(`/${WABA_ID}/message_templates`))
    return json({
      data: [
        { name: "bill_due", language: "en", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hi {{1}}, pay {{2}}." }] },
        { name: "promo", language: "en", category: "MARKETING", status: "REJECTED", components: [{ type: "BODY", text: "Sale" }] },
      ],
    });
  return json({ error: { code: 100, message: `unexpected ${url.pathname}` } }, 400);
}) as typeof fetch;

const inProject = <T>(fn: () => Promise<T>) => runWithProject({ ...project, tenant: null } as never, fn);
const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const post = (raw: string, signature: string | null) =>
  metaRoute.POST(new NextRequest(`https://assist.example.test/api/channels/meta/${webhookKey}`, { method: "POST", body: raw, headers: signature ? { "x-hub-signature-256": signature } : {} }), { params: Promise.resolve({ key: webhookKey }) });
const webhook = (phoneNumberId: string, id: string) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: WABA_ID, changes: [{ field: "messages", value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ id, from: "8801711111111", type: "text", timestamp: "1762682400", text: { body: "hello" } }] } }] }] });
const events = () => rawPrisma.channelInboundEvent.count({ where: { projectId: project.id } });

beforeAll(async () => {
  userId = (await rawPrisma.user.create({ data: { username: `wc_${tag}`, name: "WC", passwordHash: "x" } })).id;
  const p = await createProjectWithDefaults({ name: `WC ${tag}`, slug: `wc-${tag}`, status: "ACTIVE", creatorUserId: userId }, rawPrisma);
  project = { id: p.id, slug: p.slug, name: `WC ${tag}`, status: "ACTIVE" };
  const r = await inProject(() => connections.connectWhatsAppCloud({ phoneNumberId: PHONE_ID, wabaId: WABA_ID, accessToken: TOKEN, appId: APP_ID, appSecret: APP_SECRET, username: "tester", fetchImpl: fakeMeta }));
  expect(r).toMatchObject({ status: "CONNECTED", warning: null });
  connectionId = r.id;
  webhookKey = (await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })).webhookKey;
});

afterAll(async () => {
  const where = { projectId: project.id };
  await rawPrisma.channelMessage.deleteMany({ where });
  await rawPrisma.channelConversation.deleteMany({ where });
  await rawPrisma.channelInboundEvent.deleteMany({ where });
  await rawPrisma.whatsAppCloudTemplate.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId } });
});

describe("connecting a number", () => {
  it("stores the token encrypted and subscribes the app", async () => {
    const row = await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.accessTokenCiphertext).not.toContain(TOKEN);
    expect(decryptSecret(row.accessTokenCiphertext!)).toBe(TOKEN);
    expect(row).toMatchObject({ type: "WHATSAPP_CLOUD", externalAccountId: PHONE_ID, pageId: PHONE_ID, wabaId: WABA_ID });
    expect(metaCalls.some((c) => c.endsWith(`/${WABA_ID}/subscribed_apps`))).toBe(true);
  });

  it("refuses the same number twice in one project", async () => {
    await expect(inProject(() => connections.connectWhatsAppCloud({ phoneNumberId: PHONE_ID, wabaId: WABA_ID, accessToken: TOKEN, appId: APP_ID, appSecret: APP_SECRET, username: "tester", fetchImpl: fakeMeta }))).rejects.toThrow(/already connected/);
  });
});

describe("the webhook", () => {
  it("refuses a missing or wrong signature and records nothing", async () => {
    const raw = webhook(PHONE_ID, `wamid.${tag}a`);
    expect((await post(raw, null)).status).toBe(401);
    expect((await post(raw, sign(raw, "not-the-secret"))).status).toBe(401);
    expect(await events()).toBe(0);
  });

  it("drops a number nobody connected", async () => {
    const raw = webhook(`4${digits}`, `wamid.${tag}b`);
    expect((await post(raw, sign(raw))).status).toBe(200);
    expect(await events()).toBe(0);
  });

  it("records a signed message once, however often Meta retries it", async () => {
    const raw = webhook(PHONE_ID, `wamid.${tag}c`);
    expect((await post(raw, sign(raw))).status).toBe(200);
    expect((await post(raw, sign(raw))).status).toBe(200);
    expect(await events()).toBe(1);
    expect((await rawPrisma.channelInboundEvent.findFirstOrThrow({ where: { projectId: project.id } })).connectionId).toBe(connectionId);
  });
});

describe("templates", () => {
  let conversationId = "";
  let templateId = "";

  beforeAll(async () => {
    expect(await inProject(() => templates.syncCloudTemplates(connectionId, fakeMeta))).toEqual({ count: 2 });
    conversationId = (await rawPrisma.channelConversation.create({ data: { projectId: project.id, connectionId, type: "WHATSAPP_CLOUD", kind: "DIRECT", externalThreadId: "8801711111111", lastInboundAt: new Date(Date.now() - 48 * 3_600_000) } })).id;
    templateId = (await rawPrisma.whatsAppCloudTemplate.findFirstOrThrow({ where: { connectionId, name: "bill_due" } })).id;
  });
  const send = (over: Partial<Parameters<typeof templates.queueCloudTemplate>[0]> = {}) => inProject(() => templates.queueCloudTemplate({ conversationId, templateId, params: ["Rahim", "500"], nonce: `nonce-${tag}`, userId, ...over }));

  it("offers only approved ones", async () => {
    expect((await inProject(() => templates.usableTemplates(conversationId))).map((t) => t.name)).toEqual(["bill_due"]);
  });

  it("queues one, once per press, with what the customer will read", async () => {
    const first = await send();
    expect(first.duplicate).toBe(false);
    expect((await send()).messageId).toBe(first.messageId);
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: first.messageId } })).toMatchObject({ text: "Hi Rahim, pay 500.", templateName: "bill_due", deliveryStatus: "QUEUED", createdByUserId: userId });
  });

  it("refuses a rejected template and an unfilled blank", async () => {
    const rejected = await rawPrisma.whatsAppCloudTemplate.findFirstOrThrow({ where: { connectionId, name: "promo" } });
    await expect(send({ templateId: rejected.id, params: [], nonce: `n2-${tag}abc` })).rejects.toThrow(/not approved/);
    await expect(send({ params: ["Rahim"], nonce: `n3-${tag}abc` })).rejects.toThrow(/every blank/);
  });

  it("will not start a conversation with somebody who never wrote in", async () => {
    const cold = await rawPrisma.channelConversation.create({ data: { projectId: project.id, connectionId, type: "WHATSAPP_CLOUD", kind: "DIRECT", externalThreadId: "8801722222222", lastInboundAt: null } });
    await expect(send({ conversationId: cold.id, nonce: `n4-${tag}abc` })).rejects.toThrow(/messaged you/);
  });
});
