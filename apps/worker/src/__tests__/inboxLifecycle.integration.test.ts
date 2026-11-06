import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inIsp, ISP_DIGITAL, rawPrisma } from "./helpers/projectFixtures.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { applyChannelCustomerMessage, recordWhatsAppConversationActivity, reopenEndedSnoozes } from "../inbox/lifecycle.js";

/**
 * Inbox V3 in the worker (inbox/lifecycle.ts): a customer's message moves a recorded conversation by the
 * project's policy, a snooze reopens at its time, and with the feature off nothing changes. Every move is one
 * conditional update plus one ConversationEvent, so a replay or two concurrent calls give one event.
 */

const tag = randomUUID().slice(0, 8);
let accountId = "";
let connectionId = "";
const chat = (n: string) => `${n}-${tag}@g.us`;
const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

async function setFeature(enabled: boolean) {
  await rawPrisma.projectFeature.upsert({
    where: { projectId_key: { projectId: ISP_DIGITAL, key: "UNIFIED_INBOX_V3" } },
    create: { projectId: ISP_DIGITAL, key: "UNIFIED_INBOX_V3", enabled },
    update: { enabled },
  });
  resetProjectFeatureCacheForTests();
}
async function setPolicy(reopenResolved: boolean, reopenSnoozed: boolean) {
  await rawPrisma.inboxLifecycleSettings.upsert({
    where: { projectId: ISP_DIGITAL },
    create: { projectId: ISP_DIGITAL, reopenResolvedOnCustomerMessage: reopenResolved, reopenSnoozedOnCustomerMessage: reopenSnoozed },
    update: { reopenResolvedOnCustomerMessage: reopenResolved, reopenSnoozedOnCustomerMessage: reopenSnoozed },
  });
}
async function state(chatId: string, status: "OPEN" | "PENDING" | "SNOOZED" | "RESOLVED", snoozedUntil: Date | null = null) {
  return rawPrisma.whatsAppConversationState.create({ data: { projectId: ISP_DIGITAL, accountId, chatId, conversationType: "GROUP", status, snoozedUntil } });
}
const stateOf = (chatId: string) => rawPrisma.whatsAppConversationState.findFirstOrThrow({ where: { accountId, chatId } });
const eventsOf = (chatId: string) => rawPrisma.conversationEvent.findMany({ where: { accountId, chatId }, orderBy: { createdAt: "asc" } });
const customerMessage = (chatId: string, at = NOW) => inIsp(() => recordWhatsAppConversationActivity({ accountId, chatId, at, fromCustomer: true }));

async function channelConversation(status: "OPEN" | "CLOSED" | "PENDING" | "SNOOZED", snoozedUntil: Date | null = null) {
  return rawPrisma.channelConversation.create({
    data: { projectId: ISP_DIGITAL, connectionId, type: "TELEGRAM", externalThreadId: `t-${randomUUID()}`, status, snoozedUntil, closedAt: status === "CLOSED" ? NOW : null },
  });
}

beforeAll(async () => {
  accountId = (await rawPrisma.whatsAppAccount.create({ data: { projectId: ISP_DIGITAL, label: `V3 ${tag}` } })).id;
  connectionId = (await rawPrisma.channelConnection.create({ data: { projectId: ISP_DIGITAL, type: "TELEGRAM", name: "@v3", status: "CONNECTED", webhookKey: `v3-${tag}` } })).id;
});

beforeEach(async () => {
  await setFeature(true);
  await rawPrisma.inboxLifecycleSettings.deleteMany({ where: { projectId: ISP_DIGITAL } });
});

afterAll(async () => {
  await rawPrisma.conversationEvent.deleteMany({ where: { OR: [{ accountId }, { channelConversation: { connectionId } }] } });
  await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId } });
  await rawPrisma.channelConnection.deleteMany({ where: { id: connectionId } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
  await rawPrisma.inboxLifecycleSettings.deleteMany({ where: { projectId: ISP_DIGITAL } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ISP_DIGITAL, key: "UNIFIED_INBOX_V3" } });
  resetProjectFeatureCacheForTests();
  await rawPrisma.$disconnect();
});

describe("a customer's WhatsApp message", () => {
  it("reopens a resolved conversation once, with one REOPEN event naming why — never message text", async () => {
    const c = chat("resolved");
    await state(c, "RESOLVED");
    await customerMessage(c);
    await customerMessage(c, new Date(NOW.getTime() + 1000));
    expect((await stateOf(c)).status).toBe("OPEN");
    const events = await eventsOf(c);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "REOPEN", fromValue: "RESOLVED", toValue: "OPEN", actorId: null, context: { reason: "CUSTOMER_MESSAGE" } });
  });

  it("ends a snooze early as UNSNOOZE; makes PENDING open whatever the policy", async () => {
    const s = chat("snoozed");
    await state(s, "SNOOZED", new Date(NOW.getTime() + 3_600_000));
    await customerMessage(s);
    expect(await stateOf(s)).toMatchObject({ status: "OPEN", snoozedUntil: null });
    expect((await eventsOf(s))[0]?.kind).toBe("UNSNOOZE");

    await setPolicy(false, false);
    const p = chat("pending");
    await state(p, "PENDING");
    await customerMessage(p);
    expect((await stateOf(p)).status).toBe("OPEN");
  });

  it("follows the policy when it says to keep resolved and snoozed as they are", async () => {
    await setPolicy(false, false);
    const r = chat("keep-resolved");
    const s = chat("keep-snoozed");
    await state(r, "RESOLVED");
    await state(s, "SNOOZED", new Date(NOW.getTime() + 3_600_000));
    await customerMessage(r, minutesAgo(1));
    await customerMessage(s);
    expect(await stateOf(r)).toMatchObject({ status: "RESOLVED", lastCustomerMessageAt: minutesAgo(1) });
    expect((await stateOf(s)).status).toBe("SNOOZED");
    expect(await eventsOf(r)).toHaveLength(0);
  });

  it("a team member's message never changes the status, and an older message never moves times back", async () => {
    const c = chat("team");
    await state(c, "PENDING");
    await inIsp(() => recordWhatsAppConversationActivity({ accountId, chatId: c, at: NOW, fromCustomer: false }));
    await inIsp(() => recordWhatsAppConversationActivity({ accountId, chatId: c, at: minutesAgo(30), fromCustomer: false }));
    expect(await stateOf(c)).toMatchObject({ status: "PENDING", lastActivityAt: NOW, lastCustomerMessageAt: null });
  });

  it("creates nothing for a chat nobody acted on, and does nothing while the feature is off", async () => {
    const untouched = chat("untouched");
    await customerMessage(untouched);
    expect(await rawPrisma.whatsAppConversationState.count({ where: { accountId, chatId: untouched } })).toBe(0);

    const c = chat("feature-off");
    await state(c, "RESOLVED");
    await setFeature(false);
    await customerMessage(c);
    expect((await stateOf(c)).status).toBe("RESOLVED");
    expect(await eventsOf(c)).toHaveLength(0);
  });

  it("two copies of the same message arriving at once give one change and one event", async () => {
    const c = chat("race");
    await state(c, "RESOLVED");
    await Promise.all([customerMessage(c), customerMessage(c), customerMessage(c)]);
    expect((await stateOf(c)).status).toBe("OPEN");
    expect(await eventsOf(c)).toHaveLength(1);
  });
});

describe("snoozes and channel conversations", () => {
  it("a snooze whose time has come reopens once; one still running is left alone", async () => {
    const due = chat("due");
    const later = chat("later");
    await state(due, "SNOOZED", minutesAgo(1));
    await state(later, "SNOOZED", new Date(NOW.getTime() + 3_600_000));
    const channelDue = await channelConversation("SNOOZED", minutesAgo(2));
    expect(await inIsp(() => reopenEndedSnoozes(NOW))).toBeGreaterThanOrEqual(2);
    expect(await inIsp(() => reopenEndedSnoozes(NOW))).toBe(0);
    expect((await stateOf(due)).status).toBe("OPEN");
    expect((await stateOf(later)).status).toBe("SNOOZED");
    expect(await rawPrisma.channelConversation.findUniqueOrThrow({ where: { id: channelDue.id } })).toMatchObject({ status: "OPEN", snoozedUntil: null });
    expect(await rawPrisma.conversationEvent.findMany({ where: { channelConversationId: channelDue.id } })).toEqual([
      expect.objectContaining({ kind: "UNSNOOZE", fromValue: "SNOOZED", toValue: "OPEN", context: expect.objectContaining({ reason: "SNOOZE_ENDED" }) }),
    ]);
  });

  it("with the feature on, the policy decides a channel message; off, the caller keeps the old reopen rule", async () => {
    await setPolicy(false, true);
    const closed = await channelConversation("CLOSED");
    expect(await inIsp(() => applyChannelCustomerMessage(closed.id))).toBe(true);
    expect((await rawPrisma.channelConversation.findUniqueOrThrow({ where: { id: closed.id } })).status).toBe("CLOSED");

    const pending = await channelConversation("PENDING");
    expect(await inIsp(() => applyChannelCustomerMessage(pending.id))).toBe(true);
    expect((await rawPrisma.channelConversation.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("OPEN");

    await setFeature(false);
    expect(await inIsp(() => applyChannelCustomerMessage(closed.id))).toBe(false);
    expect(await inIsp(() => reopenEndedSnoozes(NOW))).toBe(0);
  });
});
