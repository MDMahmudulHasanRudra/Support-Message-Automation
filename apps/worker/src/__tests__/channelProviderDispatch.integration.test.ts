import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { processChannelEvent } from "../channels/inboundProcessor.js";

/**
 * Meta expansion B1: a recorded event is read only by its own connection's provider. What must hold:
 *   - a WhatsApp Cloud API event recorded against a Messenger connection never enters the Messenger
 *     pipeline: no conversation, no message, and the event is FAILED with the reason — never PROCESSED;
 *   - an event with no provider, or another channel's provider, is refused the same way. Before B1, any
 *     event that was not Telegram or website chat went to the Meta normaliser by default;
 *   - a genuine Messenger event on the same connection is still processed (nothing else changed).
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const PAGE = `dpage${tag}`;
let projectId = "";
let creatorId = "";
let messengerId = "";
let webchatId = "";
let n = 0;

const record = (connectionId: string, payload: object) => rawPrisma.channelInboundEvent.create({ data: { projectId, connectionId, dedupKey: `d-${tag}-${n++}`, payload } });
const process_ = async (connectionId: string, payload: object) => {
  const e = await record(connectionId, payload);
  await withProject(projectId, () => processChannelEvent(e, new Date(), noNetwork));
  return rawPrisma.channelInboundEvent.findUniqueOrThrow({ where: { id: e.id } });
};
// No real network: a profile lookup simply fails, which the inbox already tolerates.
const noNetwork = (async () => new Response(JSON.stringify({ error: { code: 100, message: "offline" } }), { status: 400 })) as typeof fetch;
const messengerItem = (mid: string) => ({ sender: { id: `cust${tag}` }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid, text: "hello" } });

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `dispatch_${tag}`, name: "Dispatch", passwordHash: "x" } })).id;
  const p = await createProjectWithDefaults({ name: `Dispatch ${tag}`, slug: `dispatch-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  projectId = p.id;
  await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId, key: "OMNICHANNEL" } }, data: { enabled: true } });
  messengerId = (
    await rawPrisma.channelConnection.create({
      data: { projectId, type: "MESSENGER", name: "Page", status: "CONNECTED", webhookKey: `dsm${tag}${tag}${tag}`, externalAccountId: PAGE, pageId: PAGE, accessTokenCiphertext: encryptSecret("EAAPAGE0000000000000000000") },
    })
  ).id;
  webchatId = (await rawPrisma.channelConnection.create({ data: { projectId, type: "WEBCHAT", name: "Site", status: "CONNECTED", webhookKey: `dsw${tag}${tag}${tag}`, externalAccountId: `site${tag}` } })).id;
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();
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

describe("provider dispatch of recorded events", () => {
  it("never puts a WhatsApp Cloud API event through the Messenger pipeline", async () => {
    const row = await process_(messengerId, {
      provider: "WHATSAPP_CLOUD",
      type: "MESSENGER",
      accountId: PAGE,
      item: messengerItem(`wamid.${tag}`),
    });
    expect(row.status).toBe("FAILED");
    expect(row.note).toMatch(/not processed|not available/);
    expect(await rawPrisma.channelMessage.count({ where: { projectId } })).toBe(0);
    expect(await rawPrisma.channelConversation.count({ where: { projectId } })).toBe(0);
  });

  it("refuses a missing provider, a mismatched Meta type and another channel's provider — never treated as processed", async () => {
    for (const [connectionId, payload] of [
      [messengerId, { item: messengerItem(`m1.${tag}`) }],
      [messengerId, { provider: "META", type: "INSTAGRAM", accountId: PAGE, item: messengerItem(`m2.${tag}`) }],
      [messengerId, { provider: "TELEGRAM", update: { update_id: 1 } }],
      [webchatId, { provider: "META", type: "MESSENGER", accountId: PAGE, item: messengerItem(`m3.${tag}`) }],
    ] as const) {
      const row = await process_(connectionId, payload);
      expect(row.status, JSON.stringify(payload)).toBe("FAILED");
      expect(row.attempts).toBeGreaterThanOrEqual(5);
    }
    expect(await rawPrisma.channelMessage.count({ where: { projectId } })).toBe(0);
  });

  it("still processes a genuine Messenger event on the same connection", async () => {
    const row = await process_(messengerId, { provider: "META", type: "MESSENGER", accountId: PAGE, item: messengerItem(`ok.${tag}`) });
    expect(row.status).toBe("PROCESSED");
    expect(await rawPrisma.channelMessage.count({ where: { projectId, externalMessageId: `ok.${tag}` } })).toBe(1);
  });
});
