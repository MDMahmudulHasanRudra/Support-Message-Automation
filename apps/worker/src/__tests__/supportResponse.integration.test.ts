import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import type { InternalTeamMember, Team, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { createProjectWithDefaults } from "@support-automation/db";
import { prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";

/**
 * Support response tracking (SUPPORT_RESPONSE.md), driven through the real pipeline exactly as
 * WhatsApp delivers messages: customers, Support Team members, another Team, the business number.
 * Every assertion reads `SupportResponseEpisode` rows — the data Unanswered Groups and Response Time
 * are built from — not anything a UI computed.
 */

const RUN = String(randomInt(100_000, 999_999));
let seq = 0;
/** Digits only (team matching normalises to digits — see CLAUDE.md on test phone numbers). */
const phone = () => `8801${RUN}${String(++seq).padStart(3, "0")}`;

let accountA: WhatsAppAccount;
let accountB: WhatsAppAccount;
let groupA: WhatsAppGroup;
let groupB: WhatsAppGroup; // the SAME WhatsApp group, name and id, as account B sees it
let support: Team;
let billing: Team;
let rudra: InternalTeamMember;
let hasan: InternalTeamMember;
let karim: InternalTeamMember; // Billing — another department
let savedTeams: string[] = [];
let savedAutomation: boolean | null = null;
let creatorId = "";
const otherProjects: string[] = [];

const T0 = Date.parse("2026-10-06T04:00:00Z"); // 10:00 Dhaka
const min = (n: number) => new Date(T0 + n * 60_000);

function msg(group: WhatsAppGroup, from: string, minute: number, overrides: Partial<RawIncomingMessage> = {}): RawIncomingMessage {
  return {
    accountId: group.accountId,
    whatsappMessageId: `false_${group.whatsappGroupId}_${randomUUID()}`,
    chatId: group.whatsappGroupId,
    whatsappGroupId: group.whatsappGroupId,
    senderPhone: from,
    senderName: null,
    direction: "INCOMING",
    body: `message at +${minute}m`,
    timestampWa: min(minute),
    ...overrides,
  };
}
const send = (group: WhatsAppGroup, from: string, minute: number, overrides: Partial<RawIncomingMessage> = {}) =>
  processIncomingMessage(msg(group, from, minute, overrides));
const episodes = (group: WhatsAppGroup) => prisma.supportResponseEpisode.findMany({ where: { groupId: group.id }, orderBy: { firstIncomingAt: "asc" } });

async function member(name: string, team: Team | null, opts: { startedAt?: Date | null } = {}) {
  const m = await prisma.internalTeamMember.create({ data: { name, phoneNumber: phone(), role: "Support", status: "ACTIVE", teamId: team?.id ?? null } });
  if (team) await prisma.teamMembership.create({ data: { teamMemberId: m.id, teamId: team.id, startedAt: opts.startedAt ?? null } });
  return m;
}

beforeAll(async () => {
  const settings = await prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  savedTeams = settings.responseTrackingTeamIds;
  savedAutomation = (await prisma.automationSettings.findFirst())?.automationEnabled ?? null;
  await prisma.automationSettings.upsert({ where: { id: "global" }, update: { automationEnabled: false }, create: { id: "global", automationEnabled: false } });
  creatorId = (await rawPrisma.user.create({ data: { username: `sr-${RUN}`, email: `sr-${RUN}@example.test`, name: "sr", passwordHash: "x" } })).id;
});

beforeEach(async () => {
  resetProjectCachesForTests();
  const tag = randomUUID().slice(0, 8);
  support = await prisma.team.create({ data: { name: `Support ${tag}` } });
  billing = await prisma.team.create({ data: { name: `Billing ${tag}` } });
  rudra = await member("Rudra", support);
  hasan = await member("Hasan", support);
  karim = await member("Karim", billing);
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: [support.id] } });
  accountA = await prisma.whatsAppAccount.create({ data: { label: `Primary ${tag}`, status: "CONNECTED" } });
  accountB = await prisma.whatsAppAccount.create({ data: { label: `Secondary ${tag}`, status: "CONNECTED" } });
  const waId = `1203630${RUN}${tag.replace(/\D/g, "")}@g.us`;
  groupA = await prisma.whatsAppGroup.create({ data: { accountId: accountA.id, whatsappGroupId: waId, name: "Famous Online & Softifybd", isActive: true } });
  groupB = await prisma.whatsAppGroup.create({ data: { accountId: accountB.id, whatsappGroupId: waId, name: "Famous Online & Softifybd", isActive: true } });
});

afterEach(async () => {
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [accountA.id, accountB.id] } } });
  await rawPrisma.teamMembership.deleteMany({ where: { teamId: { in: [support.id, billing.id] } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: [rudra.id, hasan.id, karim.id] } } });
  await rawPrisma.teamMembership.deleteMany({ where: { teamId: { in: [support.id, billing.id] } } });
  await rawPrisma.team.deleteMany({ where: { id: { in: [support.id, billing.id] } } });
});

afterAll(async () => {
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: savedTeams } });
  if (savedAutomation !== null) await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: savedAutomation } });
  await rawPrisma.$disconnect();
});

const CUSTOMER = "8801912345601";
const CUSTOMER_2 = "8801912345602";

describe("unanswered: one episode per wait", () => {
  it("a customer message opens an UNANSWERED episode pointing at that message", async () => {
    const m = msg(groupA, CUSTOMER, 0, { body: "Internet is not working." });
    await processIncomingMessage(m);
    const [e] = await episodes(groupA);
    const stored = await prisma.message.findFirstOrThrow({ where: { whatsappMessageId: m.whatsappMessageId } });
    expect(e).toMatchObject({ status: "UNANSWERED", accountId: accountA.id, incomingMessageCount: 1, firstIncomingMessageId: stored.id, latestIncomingMessageId: stored.id });
    expect(e!.firstIncomingAt.getTime()).toBe(min(0).getTime());
  });

  it("twenty customer messages — two customers, even — are still ONE episode", async () => {
    for (let i = 0; i < 20; i++) await send(groupA, i % 2 ? CUSTOMER : CUSTOMER_2, i);
    const all = await episodes(groupA);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "UNANSWERED", incomingMessageCount: 20 });
    expect(all[0]!.latestIncomingAt.getTime()).toBe(min(19).getTime());
  });

  it("messages arriving all at once still make one episode, counted once each", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => send(groupA, CUSTOMER, i)));
    const all = await episodes(groupA);
    expect(all).toHaveLength(1);
    expect(all[0]!.incomingMessageCount).toBe(8);
    expect(all[0]!.firstIncomingAt.getTime()).toBe(min(0).getTime());
  });

  it("nothing is tracked until a Support Team is chosen", async () => {
    await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: [] } });
    await send(groupA, CUSTOMER, 0);
    expect(await episodes(groupA)).toHaveLength(0);
  });
});

describe("answering", () => {
  it("a Support member's reply answers it: who, when, and how long from the FIRST message", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, CUSTOMER, 5);
    const reply = msg(groupA, rudra.phoneNumber, 11, { body: "Checking now" });
    await processIncomingMessage(reply);
    const [e] = await episodes(groupA);
    const replyRow = await prisma.message.findFirstOrThrow({ where: { whatsappMessageId: reply.whatsappMessageId } });
    expect(e).toMatchObject({ status: "ANSWERED", supportMemberId: rudra.id, supportTeamId: support.id, supportReplyMessageId: replyRow.id, responseSeconds: 11 * 60, incomingMessageCount: 2 });
    expect(e!.supportRepliedAt!.getTime()).toBe(min(11).getTime());
  });

  it("another team's reply does not answer; Support's later reply does, timed from the customer", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, karim.phoneNumber, 3);
    expect((await episodes(groupA))[0]).toMatchObject({ status: "UNANSWERED", incomingMessageCount: 1 });
    await send(groupA, hasan.phoneNumber, 20);
    expect((await episodes(groupA))[0]).toMatchObject({ status: "ANSWERED", supportMemberId: hasan.id, responseSeconds: 20 * 60 });
  });

  it("the business number — AI, rules, the dashboard, the business phone — never answers", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, "8801700000000", 1, { direction: "OUTGOING", body: "AI: please restart your router" });
    expect((await episodes(groupA))[0]).toMatchObject({ status: "UNANSWERED" });
    await send(groupA, rudra.phoneNumber, 9);
    expect((await episodes(groupA))[0]).toMatchObject({ status: "ANSWERED", supportMemberId: rudra.id, responseSeconds: 9 * 60 });
  });

  it("Support sending several messages answers once; nothing opens from Support's own messages", async () => {
    await send(groupA, CUSTOMER, 0);
    for (const m of [4, 5, 6]) await send(groupA, rudra.phoneNumber, m);
    const all = await episodes(groupA);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "ANSWERED", responseSeconds: 4 * 60 });
  });

  it("two cycles are two response records, each from its own first message", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, CUSTOMER, 10);
    await send(groupA, rudra.phoneNumber, 15);
    await send(groupA, CUSTOMER, 60);
    await send(groupA, CUSTOMER, 65);
    await send(groupA, hasan.phoneNumber, 80);
    const all = await episodes(groupA);
    expect(all.map((e) => [e.status, e.responseSeconds, e.incomingMessageCount, e.supportMemberId])).toEqual([
      ["ANSWERED", 15 * 60, 2, rudra.id],
      ["ANSWERED", 20 * 60, 2, hasan.id],
    ]);
  });

  it("two Support members replying moments apart: the earlier reply is the answer, whatever order they are processed in", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, hasan.phoneNumber, 12); // processed first, sent later
    await send(groupA, rudra.phoneNumber, 11); // processed second, sent earlier
    const all = await episodes(groupA);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "ANSWERED", supportMemberId: rudra.id, responseSeconds: 11 * 60 });
  });

  it("a customer message recovered late, older than the last answer, does not open a new wait", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, rudra.phoneNumber, 10);
    await send(groupA, CUSTOMER, 5); // arrived late, sent before the answer
    expect(await episodes(groupA)).toHaveLength(1);
  });
});

describe("Teams change; history does not", () => {
  it("someone moved out of Support keeps their past answer, and no longer answers after the move", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, rudra.phoneNumber, 5);
    // Rudra moves to Billing at +30m.
    await prisma.teamMembership.updateMany({ where: { teamMemberId: rudra.id, endedAt: null }, data: { endedAt: min(30) } });
    await prisma.teamMembership.create({ data: { teamMemberId: rudra.id, teamId: billing.id, startedAt: min(30) } });
    await prisma.internalTeamMember.update({ where: { id: rudra.id }, data: { teamId: billing.id } });

    await send(groupA, CUSTOMER, 40);
    await send(groupA, rudra.phoneNumber, 45);
    const all = await episodes(groupA);
    expect(all[0]).toMatchObject({ status: "ANSWERED", supportMemberId: rudra.id, supportTeamId: support.id, responseSeconds: 5 * 60 });
    expect(all[1]).toMatchObject({ status: "UNANSWERED" });
  });

  it("a sender who is not on the roster is a customer — never guessed to be Support", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, "99999999999999", 3); // an unmapped LID
    expect((await episodes(groupA))[0]).toMatchObject({ status: "UNANSWERED", incomingMessageCount: 2 });
  });
});

describe("clearing", () => {
  it("a cleared episode stays cleared; a NEW customer message after it opens a new one; nothing is deleted", async () => {
    await send(groupA, CUSTOMER, 0);
    await send(groupA, CUSTOMER, 2);
    const messagesBefore = await prisma.message.count({ where: { groupId: groupA.id } });
    const [open] = await episodes(groupA);
    await prisma.supportResponseEpisode.update({ where: { id: open!.id }, data: { status: "CLEARED", clearedAt: min(5) } });

    await send(groupA, CUSTOMER, 1); // a late copy of an older message: belongs to the cleared wait
    expect(await episodes(groupA)).toHaveLength(1);

    await send(groupA, CUSTOMER, 20);
    const all = await episodes(groupA);
    expect(all.map((e) => e.status)).toEqual(["CLEARED", "UNANSWERED"]);
    expect(all[1]!.firstIncomingAt.getTime()).toBe(min(20).getTime());
    expect(await prisma.message.count({ where: { groupId: groupA.id } })).toBe(messagesBefore + 2);
  });
});

describe("isolation", () => {
  it("the same group under two accounts is two identities: one account's wait is not the other's", async () => {
    await send(groupA, CUSTOMER, 0);
    expect(await episodes(groupA)).toHaveLength(1);
    expect(await episodes(groupB)).toHaveLength(0);
    await send(groupB, CUSTOMER, 1);
    await send(groupA, rudra.phoneNumber, 4); // the reply reached account A's copy only
    expect((await episodes(groupA))[0]!.status).toBe("ANSWERED");
    expect((await episodes(groupB))[0]!.status).toBe("UNANSWERED");
  });

  it("another project's messages make episodes in that project only", async () => {
    const other = await createProjectWithDefaults(
      { name: `SR other ${randomUUID().slice(0, 6)}`, slug: `sr-other-${randomUUID().slice(0, 8)}`, status: "ACTIVE", creatorUserId: creatorId },
      rawPrisma,
    );
    otherProjects.push(other.id);
    const { group } = await withProject(other.id, async () => {
      const team = await prisma.team.create({ data: { name: "Support" } });
      await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: [team.id] } });
      const account = await prisma.whatsAppAccount.create({ data: { label: "Other", status: "CONNECTED" } });
      const group = await prisma.whatsAppGroup.create({ data: { accountId: account.id, whatsappGroupId: groupA.whatsappGroupId, name: groupA.name, isActive: true } });
      return { group };
    });
    await send(group, CUSTOMER, 0);
    const theirs = await rawPrisma.supportResponseEpisode.findMany({ where: { groupId: group.id } });
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.projectId).toBe(other.id);
    expect(await prisma.supportResponseEpisode.count({ where: { groupId: group.id } })).toBe(0); // invisible from ISP Digital
    expect(await episodes(groupA)).toHaveLength(0);
  });
});

