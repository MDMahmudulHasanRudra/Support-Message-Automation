import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createProjectWithDefaults, encryptSecret, prisma as rawPrisma } from "@support-automation/db";
import { prisma } from "../db.js";
import { withProject, resetProjectCachesForTests } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { runMetaHealthTick } from "../channels/metaHealth.js";
import { formatSupportAlert } from "../notifications/formatMessage.js";
import { sweepReconnectAlerts } from "../channels/reconnectAlert.js";

/**
 * Meta expansion A3: a messaging channel that needs reconnecting is ANNOUNCED (Notification Center event
 * CHANNEL_NEEDS_RECONNECT) — it used to change status silently. What must hold:
 *   - once per breakage, whatever marked it (health check, a refused send, Meta's deauthorize), manual or
 *     one-click, Telegram too — and even while the platform Meta app is not configured;
 *   - fixed and broken again is announced again; a muted event writes no row and is not retried;
 *   - another project's connection is never announced in this one;
 *   - the alert names the connection and says where to fix it.
 */

process.env.AI_CREDENTIALS_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const TEAMS = `https://example.invalid/teams-${tag}`;
let creatorId = "";
let P = "";
let Q = "";
let messengerId = "";
let telegramId = "";
let otherId = "";

const inP = <T,>(fn: () => Promise<T>) => withProject(P, fn);
const alerts = (projectId: string) => rawPrisma.notification.findMany({ where: { projectId, event: "CHANNEL_NEEDS_RECONNECT" }, orderBy: { createdAt: "asc" } });
const tick = (projectId = P) => withProject(projectId, () => sweepReconnectAlerts(new Date()));

async function project(name: string): Promise<string> {
  const p = await createProjectWithDefaults({ name: `${name} ${tag}`, slug: `${name.toLowerCase()}-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
  await rawPrisma.projectFeature.update({ where: { projectId_key: { projectId: p.id, key: "OMNICHANNEL" } }, data: { enabled: true } });
  await withProject(p.id, async () => {
    await prisma.automationSettings.upsert({ where: { id: "global" }, update: { teamsWebhookUrl: TEAMS, whatsappNotificationGroupIds: [] }, create: { id: "global", teamsWebhookUrl: TEAMS, whatsappNotificationGroupIds: [] } });
  });
  return p.id;
}

beforeAll(async () => {
  creatorId = (await rawPrisma.user.create({ data: { username: `reconnect_${tag}`, name: "Reconnect", passwordHash: "x" } })).id;
  P = await project("ReconnectP");
  Q = await project("ReconnectQ");
  messengerId = (
    await rawPrisma.channelConnection.create({
      data: { projectId: P, type: "MESSENGER", name: `Shop Page ${tag}`, status: "CONNECTED", authMode: "PLATFORM", webhookKey: `rcm${tag}${tag}${tag}`, externalAccountId: `pg${tag}`, pageId: `pg${tag}`, accessTokenCiphertext: encryptSecret("EAAPAGE00000000000000000") },
    })
  ).id;
  telegramId = (await rawPrisma.channelConnection.create({ data: { projectId: P, type: "TELEGRAM", name: `Bot ${tag}`, status: "CONNECTED", webhookKey: `rct${tag}${tag}${tag}`, externalAccountId: `bot${tag}` } })).id;
  otherId = (await rawPrisma.channelConnection.create({ data: { projectId: Q, type: "INSTAGRAM", name: `Other ${tag}`, status: "CONNECTED", webhookKey: `rco${tag}${tag}${tag}`, externalAccountId: `ig${tag}` } })).id;
  resetProjectCachesForTests();
  resetProjectFeatureCacheForTests();
});

beforeEach(async () => {
  await rawPrisma.notificationEventSetting.deleteMany({ where: { projectId: { in: [P, Q] }, event: "CHANNEL_NEEDS_RECONNECT" } });
});

afterAll(async () => {
  const where = { projectId: { in: [P, Q] } };
  await rawPrisma.notification.deleteMany({ where });
  await rawPrisma.notificationEventSetting.deleteMany({ where });
  await rawPrisma.channelConnection.deleteMany({ where });
  await rawPrisma.systemLog.deleteMany({ where });
  await rawPrisma.projectFeature.deleteMany({ where });
  await rawPrisma.projectAccess.deleteMany({ where: { userId: creatorId } });
});

const breakIt = (id: string, lastError = "Facebook no longer accepts this connection's access. Reconnect with Facebook.") =>
  rawPrisma.channelConnection.update({ where: { id }, data: { status: "NEEDS_RECONNECT", lastError, lastErrorAt: new Date() } });

describe("announcing a channel that needs reconnecting", () => {
  it("announces once — from the scheduled tick even with no platform Meta app configured — naming the connection and the fix", async () => {
    await breakIt(messengerId);
    // No META_APP_SECRET: the health checks do not run, the announcement still must.
    await runMetaHealthTick(new Date(), fetch, {});
    await tick();
    const sent = await alerts(P);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "TEAMS", destination: TEAMS });
    expect(sent[0]!.payload).toMatchObject({ alertKind: "CHANNEL_NEEDS_RECONNECT", connectionId: messengerId, channel: "Facebook Messenger" });
    const text = await inP(() => formatSupportAlert(sent[0]!.payload as Record<string, unknown>));
    expect(text).toContain(`Shop Page ${tag}`);
    expect(text).toContain("Reconnect with Facebook");
    expect((await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: messengerId } })).reconnectAlertedAt).not.toBeNull();
  });

  it("fixed and broken again is announced again", async () => {
    await rawPrisma.channelConnection.update({ where: { id: messengerId }, data: { status: "CONNECTED", lastError: null } });
    await tick();
    expect((await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: messengerId } })).reconnectAlertedAt).toBeNull();
    await breakIt(messengerId);
    await tick();
    expect(await alerts(P)).toHaveLength(2);
  });

  it("covers Telegram, with its own fix", async () => {
    await breakIt(telegramId, "Telegram no longer accepts this bot token.");
    await tick();
    const last = (await alerts(P)).at(-1)!;
    expect(last.payload).toMatchObject({ connectionId: telegramId, channel: "Telegram", action: expect.stringContaining("bot token") });
  });

  it("a muted event writes nothing and is not retried every tick", async () => {
    await rawPrisma.channelConnection.update({ where: { id: telegramId }, data: { status: "CONNECTED" } });
    await tick();
    await withProject(P, () => prisma.notificationEventSetting.create({ data: { event: "CHANNEL_NEEDS_RECONNECT", enabled: false } }));
    const before = (await alerts(P)).length;
    await breakIt(telegramId);
    await tick();
    await tick();
    expect(await alerts(P)).toHaveLength(before);
    expect((await rawPrisma.channelConnection.findUniqueOrThrow({ where: { id: telegramId } })).reconnectAlertedAt).not.toBeNull();
  });

  it("never announces another project's connection", async () => {
    await breakIt(otherId);
    const before = (await alerts(P)).length;
    await tick(P);
    expect(await alerts(P)).toHaveLength(before);
    expect(await alerts(Q)).toHaveLength(0);
    await tick(Q);
    const q = await alerts(Q);
    expect(q).toHaveLength(1);
    expect(q[0]!.payload).toMatchObject({ connectionId: otherId });
  });
});
