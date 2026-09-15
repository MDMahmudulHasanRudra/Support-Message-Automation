import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { mentionTeamForHandover } from "../aiFallback/mentionTeam.js";

/**
 * Tagging a person inside the customer's own group when AI gives up.
 *
 * The risk worth testing is not "does it send" — it is who gets tagged and who does not. A mention
 * addresses a real contact, so someone mapped from message history (whose stored number is a
 * WhatsApp id) resolves to nobody; tagging them would produce a message that looks like help was
 * summoned when it was not.
 */

let account: WhatsAppAccount;
let group: WhatsAppGroup;
let settings: AutomationSettings;
const createdMemberIds: string[] = [];

const PHONE_PREFIX = String(randomInt(100_000, 999_999));
let phoneSequence = 0;
const uniquePhone = () => `+8809${PHONE_PREFIX}${String(++phoneSequence).padStart(4, "0")}`;

async function makeMember(overrides: { phoneNumber?: string; whatsappId?: string | null; status?: "ACTIVE" | "INACTIVE" } = {}) {
  const member = await prisma.internalTeamMember.create({
    data: {
      name: `Mention Test ${randomUUID()}`,
      phoneNumber: overrides.phoneNumber ?? uniquePhone(),
      whatsappId: overrides.whatsappId ?? null,
      role: "Support",
      status: overrides.status ?? "ACTIVE",
    },
  });
  createdMemberIds.push(member.id);
  return member;
}

async function runMention(): Promise<boolean> {
  const message = await prisma.message.create({
    data: {
      accountId: account.id,
      groupId: group.id,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      senderPhone: uniquePhone(),
      direction: "INCOMING",
      body: "help please",
      normalizedBody: "help please",
      timestampWa: new Date(),
      processingStatus: "PROCESSED",
    },
  });

  return mentionTeamForHandover({
    accountId: account.id,
    groupId: group.id,
    chatId: group.whatsappGroupId,
    toPhone: "8801700000999",
    incomingMessageId: message.id,
    settings,
    testMode: true,
  });
}

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({
    data: { label: `Mention Test ${randomUUID()}`, status: "CONNECTED" },
  });
  settings = await prisma.automationSettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });
});

afterEach(async () => {
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  if (group) await prisma.whatsAppGroup.deleteMany({ where: { id: group.id } });
  if (createdMemberIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: createdMemberIds } } });
    createdMemberIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => {});
  await prisma.$disconnect();
});

async function makeGroup(assignedTeamMemberId?: string) {
  group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: `${randomUUID().replace(/-/g, "").slice(0, 12)}-1234567890@g.us`,
      name: `Mention Group ${randomUUID()}`,
      isMonitored: true,
      isActive: true,
      assignedTeamMemberId,
    },
  });
  return group;
}

describe("who gets tagged", () => {
  it("tags the group's assigned member", async () => {
    const member = await makeMember();
    await makeGroup(member.id);

    expect(await runMention()).toBe(true);

    const outbound = await prisma.outboundMessage.findFirstOrThrow({ where: { accountId: account.id } });
    const digits = member.phoneNumber.replace(/\D/g, "");
    expect(outbound.mentions).toEqual([`${digits}@c.us`]);
    expect(outbound.body).toContain(`@${digits}`);
    expect(outbound.body).toContain(member.name);
  });

  it("falls back to whoever opted into handover alerts when the group has nobody assigned", async () => {
    const member = await makeMember();
    await prisma.teamMemberNotificationPreference.create({
      data: { teamMemberId: member.id, event: "AI_HUMAN_FALLBACK" },
    });
    await makeGroup();

    expect(await runMention()).toBe(true);
    const outbound = await prisma.outboundMessage.findFirstOrThrow({ where: { accountId: account.id } });
    expect(outbound.mentions).toHaveLength(1);
  });

  it("prefers the assigned member over the opted-in list", async () => {
    // Tagging everyone turns a request for help into a broadcast nobody feels responsible for.
    const assigned = await makeMember();
    const optedIn = await makeMember();
    await prisma.teamMemberNotificationPreference.create({
      data: { teamMemberId: optedIn.id, event: "AI_HUMAN_FALLBACK" },
    });
    await makeGroup(assigned.id);

    await runMention();
    const outbound = await prisma.outboundMessage.findFirstOrThrow({ where: { accountId: account.id } });
    expect(outbound.mentions).toEqual([`${assigned.phoneNumber.replace(/\D/g, "")}@c.us`]);
  });
});

describe("who does not get tagged", () => {
  it("skips a member whose stored number is really a WhatsApp id", async () => {
    // The mention would resolve to nobody, producing a message that looks like help was summoned.
    const lid = "161679983804516";
    const member = await makeMember({ phoneNumber: lid, whatsappId: lid });
    await makeGroup(member.id);

    expect(await runMention()).toBe(false);
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("skips an inactive assigned member rather than tagging them", async () => {
    const member = await makeMember({ status: "INACTIVE" });
    await makeGroup(member.id);

    expect(await runMention()).toBe(false);
  });

  it("queues nothing when there is nobody to tag at all", async () => {
    await makeGroup();

    expect(await runMention()).toBe(false);
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe("delivery", () => {
  it("goes through the outbound queue rather than sending directly", async () => {
    // One outbound mechanism: rate limits, membership verification and idempotency all have to
    // apply to this the same as any other message.
    const member = await makeMember();
    await makeGroup(member.id);
    await runMention();

    const outbound = await prisma.outboundMessage.findFirstOrThrow({ where: { accountId: account.id } });
    expect(outbound.status).toBe("PENDING");
    expect(outbound.chatId).toBe(group.whatsappGroupId);
  });
});
