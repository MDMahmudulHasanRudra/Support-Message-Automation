import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import type { Team, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { toDhakaDateOnly } from "@support-automation/shared";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import { recomputeAttendanceDay, recordOperatorAttendance } from "../teamManagement/attendance.js";
import { trackSupportResponse } from "../supportResponse/tracker.js";

/**
 * Report accuracy audit (19 Oct 2026), Phase 2, against real rows:
 *  - Duty History counts each message once, and each WhatsApp group once, however many of our
 *    numbers stored it (it used to double both in a group two of our numbers share);
 *  - it honours a member's "count their messages from" date, as the Team Report does;
 *  - a reply the member sent from WhatsApp Chat (through their linked login) is their attendance;
 *  - a day whose evidence moved away is withdrawn, not left standing;
 *  - Response Time: the same wait recorded by our second number is its TWIN (shown only for that
 *    account), and a reply answers every copy of the wait.
 */

const RUN = String(randomInt(100_000, 999_999));
let seq = 0;
const phone = () => `8801${RUN}${String(++seq).padStart(3, "0")}`;
const WGID = `120369${Date.now()}${RUN}@g.us`;
const DAY = new Date(Date.UTC(2025, 6, 9, 4, 0)); // 10:00 Dhaka, 9 July 2025
const at = (minutes: number) => new Date(DAY.getTime() + minutes * 60_000);

let accountA: WhatsAppAccount;
let accountB: WhatsAppAccount;
let groupA: WhatsAppGroup;
let groupB: WhatsAppGroup;
let support: Team;
let savedTeams: string[] = [];
const memberPhone = phone();
const laterPhone = phone();
const customer = phone();
let memberId = "";
let laterId = "";
let operatorId = "";
let userId = "";

async function stored(row: "A" | "B", key: string, sender: string, at: Date, direction: "INCOMING" | "OUTGOING" = "INCOMING", fromMe = false) {
  const account = row === "A" ? accountA : accountB;
  const group = row === "A" ? groupA : groupB;
  return prisma.message.create({
    data: {
      accountId: account.id,
      groupId: group.id,
      chatId: WGID,
      whatsappMessageId: `${fromMe ? "true" : "false"}_${WGID}_${key}_${sender}@c.us`,
      senderPhone: sender,
      senderJid: `${sender}@c.us`,
      direction,
      body: "text",
      normalizedBody: "text",
      timestampWa: at,
      processingStatus: "PROCESSED",
    },
  });
}

const day = (id: string) =>
  prisma.teamAttendanceDay.findUnique({ where: { teamMemberId_activityDate: { teamMemberId: id, activityDate: toDhakaDateOnly(DAY) } }, include: { groups: true } });

beforeAll(async () => {
  const settings = await prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  savedTeams = settings.responseTrackingTeamIds;
  support = await prisma.team.create({ data: { name: `Accuracy support ${RUN}` } });
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: [support.id] } });

  accountA = await prisma.whatsAppAccount.create({ data: { label: `Acc A ${RUN}`, status: "CONNECTED" } });
  accountB = await prisma.whatsAppAccount.create({ data: { label: `Acc B ${RUN}`, status: "CONNECTED" } });
  const row = (accountId: string) =>
    prisma.whatsAppGroup.create({ data: { accountId, whatsappGroupId: WGID, name: `Acc ${RUN}`, isActive: true, isMonitored: true, lastSyncedAt: new Date() } });
  groupA = await row(accountA.id);
  groupB = await row(accountB.id);

  const user = await prisma.user.create({ data: { username: `acc_${RUN}_${randomUUID().slice(0, 6)}`, email: `acc_${RUN}@example.test`, name: "Acc", passwordHash: "x" } });
  userId = user.id;
  memberId = (await prisma.internalTeamMember.create({ data: { name: `Rina ${RUN}`, phoneNumber: `+${memberPhone}`, role: "Support", teamId: support.id } })).id;
  await prisma.teamMembership.create({ data: { teamMemberId: memberId, teamId: support.id, startedAt: null } });
  laterId = (
    await prisma.internalTeamMember.create({ data: { name: `Later ${RUN}`, phoneNumber: `+${laterPhone}`, role: "Support", attributeFrom: at(60) } })
  ).id;
  operatorId = (await prisma.internalTeamMember.create({ data: { name: `Operator ${RUN}`, phoneNumber: `+${phone()}`, role: "Support", userId } })).id;
});

afterAll(async () => {
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: savedTeams } });
  await prisma.supportResponseEpisode.deleteMany({ where: { groupId: { in: [groupA.id, groupB.id] } } });
  await prisma.teamAttendanceDay.deleteMany({ where: { teamMemberId: { in: [memberId, laterId, operatorId] } } });
  await prisma.outboundMessage.deleteMany({ where: { chatId: WGID } });
  await prisma.message.deleteMany({ where: { chatId: WGID } });
  await prisma.teamMembership.deleteMany({ where: { teamMemberId: { in: [memberId, laterId, operatorId] } } });
  await prisma.internalTeamMember.deleteMany({ where: { id: { in: [memberId, laterId, operatorId] } } });
  await prisma.whatsAppGroup.deleteMany({ where: { id: { in: [groupA.id, groupB.id] } } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [accountA.id, accountB.id] } } });
  await prisma.team.deleteMany({ where: { id: support.id } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("Duty History counts what the Team Report counts", () => {
  it("counts a message both of our numbers stored once, and the group once", async () => {
    await stored("A", "M1", memberPhone, at(0));
    await stored("B", "M1", memberPhone, at(0));
    await stored("A", "M2", memberPhone, at(5));
    await inIsp(() => recomputeAttendanceDay(memberId, DAY));
    const row = await day(memberId);
    expect(row).toMatchObject({ messageCount: 2, uniqueGroupCount: 1 });
    expect(row!.groups).toHaveLength(1);
  });

  it("does not count messages from before a member's 'count their messages from' date", async () => {
    await stored("A", "L1", laterPhone, at(10));
    await stored("A", "L2", laterPhone, at(70));
    await inIsp(() => recomputeAttendanceDay(laterId, DAY));
    expect(await day(laterId)).toMatchObject({ messageCount: 1, firstActivityAt: at(70) });
  });

  it("credits a reply typed in WhatsApp Chat to the member linked to that login", async () => {
    const echo = await stored("A", "OP1", "8801000000000", at(20), "OUTGOING", true);
    await prisma.outboundMessage.create({
      data: {
        accountId: accountA.id,
        chatId: WGID,
        toPhone: WGID,
        body: "text",
        actionType: "MANUAL_REPLY",
        idempotencyKey: `acc-op-${RUN}`,
        status: "SENT",
        sentAt: at(20),
        providerMessageId: echo.whatsappMessageId,
        createdById: userId,
      },
    });
    await inIsp(() => recordOperatorAttendance({ providerMessageId: echo.whatsappMessageId, timestampWa: at(20) }));
    expect(await day(operatorId)).toMatchObject({ messageCount: 1, uniqueGroupCount: 1 });
  });

  it("withdraws a day whose evidence no longer belongs to the member", async () => {
    await prisma.internalTeamMember.update({ where: { id: laterId }, data: { attributeFrom: at(24 * 60) } });
    await inIsp(() => recomputeAttendanceDay(laterId, DAY));
    expect(await day(laterId)).toBeNull();
  });
});

describe("Response Time: one wait is one row", () => {
  const track = (message: { id: string; groupId: string | null; accountId: string; senderPhone: string; timestampWa: Date }, direction: "INCOMING" | "OUTGOING" = "INCOMING") =>
    inIsp(() =>
      trackSupportResponse({
        messageId: message.id,
        groupId: message.groupId,
        accountId: message.accountId,
        direction,
        senderPhone: message.senderPhone,
        senderJid: `${message.senderPhone}@c.us`,
        timestampWa: message.timestampWa,
      }),
    );

  it("marks our second number's copy of a wait as its twin, and answers both with one reply", async () => {
    const askedA = await stored("A", "Q1", customer, at(200));
    const askedB = await stored("B", "Q1", customer, at(200));
    await track(askedA);
    await track(askedB);
    const episodes = await prisma.supportResponseEpisode.findMany({ where: { groupId: { in: [groupA.id, groupB.id] } }, orderBy: { createdAt: "asc" } });
    expect(episodes.map((e) => e.isTwin)).toEqual([false, true]);

    // The reply reaches only number A (B's session was down): both copies are answered anyway.
    const reply = await stored("A", "R1", memberPhone, at(205));
    await track(reply);
    const after = await prisma.supportResponseEpisode.findMany({ where: { groupId: { in: [groupA.id, groupB.id] } } });
    expect(after.map((e) => e.status)).toEqual(["ANSWERED", "ANSWERED"]);
    expect(after.every((e) => e.supportMemberId === memberId && e.responseSeconds === 300)).toBe(true);
  });
});
