import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { processChannelEvent } from "../channels/inboundProcessor.js";
import { runChannelOutboundTick } from "../channels/outboundProcessor.js";

/**
 * WhatsApp (Official API) through the channels' own pipeline, with Meta simulated. What must hold: a message makes a channel conversation and
 * touches no WhatsApp (Legacy) table; a free reply goes only inside 24 hours; a person's template goes after it; the switch stops both directions.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const PHONE_ID = `9${tag.replace(/\D/g, "1")}`;
const CUSTOMER = "8801711111111";
let projectId = "";
let creatorId = "";
let connectionId = "";
let n = 0;

interface Sent {
  url: string;
  body: Record<string, unknown>;
}
const sent: Sent[] = [];
const fakeMeta = (async (url: unknown, init?: RequestInit) => {
  sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
  return new Response(JSON.stringify({ messages: [{ id: `wamid.out${n++}` }] }), { status: 200 });
}) as typeof fetch;

const processEvent = async (item: object) => {
  const e = await rawPrisma.channelInboundEvent.create({ data: { projectId, connectionId, dedupKey: `w-${tag}-${n++}`, payload: { provider: "WHATSAPP_CLOUD", accountId: PHONE_ID, item } } });
  await withProject(projectId, () => processChannelEvent(e, new Date(), fakeMeta));
  return rawPrisma.channelInboundEvent.findUniqueOrThrow({ where: { id: e.id } });
};
const inbound = (id: string, text: string) => ({ kind: "message", contact: { wa_id: CUSTOMER, profile: { name: "Rahim" } }, message: { id, from: CUSTOMER, type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } } });
const setFeature = async (enabled: boolean) => {
  await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId, key: "WHATSAPP_OFFICIAL" } }, data: { enabled } });
  resetProjectFeatureCacheForTests();
};
const conversation = () => rawPrisma.channelConversation.findFirstOrThrow({ where: { projectId, connectionId } });
const queue = async (data: { text: string; templateName?: string; params?: string[] }) => {
  const c = await conversation();
  return rawPrisma.channelMessage.create({
    data: { projectId, conversationId: c.id, connectionId, type: "WHATSAPP_CLOUD", direction: "OUTBOUND", senderType: "AGENT", text: data.text, contentType: "TEXT", occurredAt: new Date(), deliveryStatus: "QUEUED", idempotencyKey: `q-${tag}-${n++}`, ...(data.templateName ? { templateName: data.templateName, templateLanguage: "en", templateParams: data.params ?? [] } : {}) },
  });
};
const setLastInbound = async (hoursAgo: number) => {
  const c = await conversation();
  await rawPrisma.channelConversation.update({ where: { id: c.id }, data: { lastInboundAt: new Date(Date.now() - hoursAgo * 3_600_000) } });
};
const tick = () => runChannelOutboundTick(new Date(), fakeMeta);

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `cloud_${tag}`, name: "Cloud", passwordHash: "x" } })).id;
  const p = await createProjectWithDefaults({ name: `Cloud ${tag}`, slug: `cloud-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  projectId = p.id;
  await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId, key: "OMNICHANNEL" } }, data: { enabled: true } });
  connectionId = (
    await rawPrisma.channelConnection.create({
      data: { projectId, type: "WHATSAPP_CLOUD", name: "Official", status: "CONNECTED", enabled: true, webhookKey: `wc${tag}${tag}${tag}`, externalAccountId: PHONE_ID, pageId: PHONE_ID, wabaId: "123456", appId: "654321", accessTokenCiphertext: encryptSecret("token"), appSecretCiphertext: encryptSecret("secret") },
    })
  ).id;
  resetProjectCachesForTests();
  await setFeature(true);
});

afterAll(async () => {
  const where = { projectId };
  await rawPrisma.channelMessage.deleteMany({ where });
  await rawPrisma.channelConversation.deleteMany({ where });
  await rawPrisma.channelInboundEvent.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: creatorId } });
});

describe("WhatsApp (Official API)", () => {
  it("makes a channel conversation from a message, and writes nothing to WhatsApp (Legacy)", async () => {
    const event = await processEvent(inbound(`wamid.${tag}1`, "my internet is down"));
    expect(event.status).toBe("PROCESSED");
    const c = await conversation();
    expect(c).toMatchObject({ type: "WHATSAPP_CLOUD", externalThreadId: CUSTOMER, customerName: "Rahim" });
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: c.id, direction: "INBOUND" } })).toBe(1);
    expect(await rawPrisma.message.count({ where: { projectId } })).toBe(0);
    expect(await rawPrisma.outboundMessage.count({ where: { projectId } })).toBe(0);
  });

  it("sends a free reply inside 24 hours, to the customer's number from this number", async () => {
    sent.length = 0;
    const m = await queue({ text: "We are looking at it." });
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain(`/${PHONE_ID}/messages`);
    expect(sent[0]!.body).toMatchObject({ messaging_product: "whatsapp", to: CUSTOMER, type: "text", text: { body: "We are looking at it." } });
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).deliveryStatus).toBe("SENT");
  });

  it("refuses a free reply after 24 hours without calling Meta", async () => {
    await setLastInbound(30);
    sent.length = 0;
    const m = await queue({ text: "Late reply" });
    await tick();
    expect(sent).toHaveLength(0);
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ deliveryStatus: "FAILED" });
  });

  it("sends a person's template after 24 hours, with its blanks", async () => {
    sent.length = 0;
    const m = await queue({ text: "Hi Rahim", templateName: "bill_due", params: ["Rahim"] });
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ type: "template", template: { name: "bill_due", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Rahim" }] }] } });
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).deliveryStatus).toBe("SENT");
    await setLastInbound(0);
  });

  it("records a delivery failure Meta reports afterwards", async () => {
    const m = await queue({ text: "Will bounce" });
    await tick();
    const row = await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } });
    await processEvent({ kind: "status", status: { id: row.externalMessageId, status: "failed", errors: [{ title: "Number not on WhatsApp" }] } });
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ deliveryStatus: "FAILED" });
  });

  it("stops both directions when the module is switched off", async () => {
    await setFeature(false);
    sent.length = 0;
    const m = await queue({ text: "Should not go" });
    await tick();
    expect(sent).toHaveLength(0);
    expect(await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ deliveryStatus: "FAILED" });
    const before = await rawPrisma.channelMessage.count({ where: { projectId, direction: "INBOUND" } });
    await processEvent(inbound(`wamid.${tag}2`, "are you there"));
    expect(await rawPrisma.channelMessage.count({ where: { projectId, direction: "INBOUND" } })).toBe(before);
    await setFeature(true);
  });
});
