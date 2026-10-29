import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults, prisma as rawPrisma } from "@support-automation/db";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { processChannelEvent } from "../channels/inboundProcessor.js";
import { sendNextQueued } from "../channels/outboundProcessor.js";

/**
 * Website chat in the worker (WEBSITE_CHAT.md): a visitor message recorded by the web becomes a
 * conversation exactly like a Messenger / Telegram message (and a replay stores nothing twice), and a
 * reply is delivered by being stored — no provider is ever called.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
let projectId = "";
let userId = "";
let connectionId = "";
const visitorId = `v_${tag}${tag}visitor`;
const run = <T,>(fn: () => Promise<T>) => withProject(projectId, fn);

beforeAll(async () => {
  userId = (await rawPrisma.user.create({ data: { username: `webchat_${tag}`, name: "Webchat", passwordHash: "x" } })).id;
  projectId = (await createProjectWithDefaults({ name: `Webchat ${tag}`, slug: `webchat-${tag}`, status: "ACTIVE", creatorUserId: userId }, rawPrisma)).id;
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key: "OMNICHANNEL" } }, update: { enabled: true }, create: { projectId, key: "OMNICHANNEL", enabled: true } });
  connectionId = (
    await rawPrisma.channelConnection.create({
      data: { projectId, type: "WEBCHAT", name: "Site", status: "CONNECTED", webhookKey: `wkw${tag}${tag}${tag}`, allowedOrigins: ["https://shop.example.com"] },
    })
  ).id;
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();
});

afterAll(async () => {
  const where = { projectId };
  await rawPrisma.channelMessage.deleteMany({ where });
  await rawPrisma.channelInboundEvent.deleteMany({ where });
  await rawPrisma.channelConversation.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId } });
});

function event(nonce: string, text: string) {
  return rawPrisma.channelInboundEvent.create({
    data: {
      projectId,
      connectionId,
      dedupKey: `wc:${visitorId}:${nonce}`,
      payload: { provider: "WEBCHAT", visitorId, nonce, text, name: "Rina (unverified)", email: null, occurredAt: new Date().toISOString() },
    },
  });
}

describe("website chat", () => {
  it("a visitor message opens a conversation once, however often it is processed", async () => {
    const e = await event("nonce0001", "Do you deliver to Sylhet?");
    await run(() => processChannelEvent(e));
    await run(() => processChannelEvent(e));
    const c = await rawPrisma.channelConversation.findFirstOrThrow({ where: { connectionId, externalThreadId: visitorId } });
    expect(c).toMatchObject({ type: "WEBCHAT", kind: "DIRECT", customerName: "Rina (unverified)", status: "OPEN" });
    const messages = await rawPrisma.channelMessage.findMany({ where: { conversationId: c.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "INBOUND", senderType: "CUSTOMER", text: "Do you deliver to Sylhet?", externalMessageId: "wc-nonce0001" });
  });

  it("a reply is delivered by being stored, with no provider call", async () => {
    const c = await rawPrisma.channelConversation.findFirstOrThrow({ where: { connectionId, externalThreadId: visitorId } });
    const reply = await rawPrisma.channelMessage.create({
      data: { projectId, connectionId, conversationId: c.id, type: "WEBCHAT", direction: "OUTBOUND", senderType: "AGENT", text: "Yes, within 2 days.", occurredAt: new Date(), deliveryStatus: "QUEUED" },
    });
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("no provider for website chat");
    }) as unknown as typeof fetch;
    await run(() => sendNextQueued(new Date(), fetchImpl));
    expect(called).toBe(false);
    expect((await rawPrisma.channelMessage.findUniqueOrThrow({ where: { id: reply.id } })).deliveryStatus).toBe("SENT");
  });

  it("a malformed recorded event is ignored, never guessed", async () => {
    const bad = await rawPrisma.channelInboundEvent.create({
      data: { projectId, connectionId, dedupKey: `wc:${visitorId}:bad00001`, payload: { provider: "WEBCHAT", visitorId: "nope", nonce: "bad00001", text: "x" } },
    });
    await run(() => processChannelEvent(bad));
    expect((await rawPrisma.channelInboundEvent.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe("IGNORED");
  });
});
