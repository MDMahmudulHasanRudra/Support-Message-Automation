import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { fillRosterFromPattern, matchTeamMembersToWhatsApp } from "@support-automation/db";
import { createReportClassifier, createSenderResolver, pickNumberOperator } from "@support-automation/shared";
import { ISP_DIGITAL, inIsp, prisma, rawPrisma } from "./helpers/projectFixtures.js";

/** TEAM_AUTOMATION.md: a wrong match turns a customer into staff, so the "does not match" cases matter most. */

const run = String(randomInt(100_000, 999_999));
let seq = 0;
const phone = () => `+8801${run}${String(++seq).padStart(3, "0")}`;
const lid = () => `9${run}${String(++seq).padStart(8, "0")}`;
const memberIds: string[] = [];
const senderIds: string[] = [];
let accountId: string;
const groupIds: string[] = [];
let shiftId: string;

async function member(name: string, whatsappId: string | null = null) {
  const row = await prisma.internalTeamMember.create({ data: { name, phoneNumber: phone(), whatsappId, role: "Support" } });
  memberIds.push(row.id);
  return row;
}

/** A sender writing in `groups` different groups under a private ID. */
async function sender(id: string, name: string, groups: number) {
  senderIds.push(id);
  for (let i = 0; i < groups; i += 1) {
    await prisma.message.create({
      data: {
        accountId,
        groupId: groupIds[i]!,
        whatsappMessageId: `team-auto-${randomUUID()}`,
        chatId: `team-auto-${run}-${i}@g.us`,
        senderPhone: id,
        senderJid: `${id}@lid`,
        senderName: name,
        direction: "INCOMING",
        body: "hello",
        normalizedBody: "hello",
        timestampWa: new Date(),
      },
    });
  }
}

beforeAll(async () => {
  await inIsp(async () => {
    const account = await prisma.whatsAppAccount.create({ data: { label: `Team automation ${run}`, sessionId: `team-auto-${run}` } });
    accountId = account.id;
    for (let i = 0; i < 3; i += 1) {
      const group = await prisma.whatsAppGroup.create({ data: { accountId, whatsappGroupId: `team-auto-${run}-${i}@g.us`, name: `Group ${i}` } });
      groupIds.push(group.id);
    }
    const shift = await prisma.shiftTemplate.create({ data: { name: `Auto ${run}`, startMinute: 600, endMinute: 1140 } });
    shiftId = shift.id;
  });
});

afterAll(async () => {
  await rawPrisma.message.deleteMany({ where: { senderPhone: { in: senderIds } } });
  await rawPrisma.identityReattribution.deleteMany({ where: { memberIds: { hasSome: memberIds } } });
  await rawPrisma.whatsAppIdentityEvidence.deleteMany({ where: { projectId: ISP_DIGITAL, lid: { in: senderIds } } });
  await rawPrisma.dutyAssignmentChange.deleteMany({ where: { teamMemberId: { in: memberIds } } });
  await rawPrisma.dutyAssignment.deleteMany({ where: { teamMemberId: { in: memberIds } } });
  await rawPrisma.weeklyScheduleEntry.deleteMany({ where: { teamMemberId: { in: memberIds } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: memberIds } } });
  await rawPrisma.shiftTemplate.deleteMany({ where: { id: shiftId } });
  await rawPrisma.whatsAppGroup.deleteMany({ where: { id: { in: groupIds } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: accountId } });
});

describe("matching team members to their WhatsApp IDs", () => {
  it("links a member when WhatsApp itself paired their number with an ID", () =>
    inIsp(async () => {
      const m = await member(`Paired Person ${run}`);
      const id = lid();
      senderIds.push(id);
      await prisma.whatsAppIdentityEvidence.create({ data: { lid: id, phone: m.phoneNumber.replace(/\D/g, ""), source: "MESSAGE" } });
      await matchTeamMembersToWhatsApp(prisma, ISP_DIGITAL);
      const after = await prisma.internalTeamMember.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.whatsappId).toBe(id);
      expect(after.identityLinkSource).toBe("AUTO_PHONE");
    }));

  it("links by name only for one sender in three groups, and queues their history", () =>
    inIsp(async () => {
      const m = await member(`Exact Name ${run}`);
      const id = lid();
      await sender(id, `exact name (office) ${run}`.replace(" (office)", ""), 3);
      await matchTeamMembersToWhatsApp(prisma, ISP_DIGITAL);
      const after = await prisma.internalTeamMember.findUniqueOrThrow({ where: { id: m.id } });
      expect(after.whatsappId).toBe(id);
      expect(after.identityLinkSource).toBe("AUTO_NAME");
      expect(await prisma.identityReattribution.count({ where: { memberIds: { has: m.id } } })).toBe(1);
    }));

  it("never links a customer with the same name who writes in fewer groups", () =>
    inIsp(async () => {
      const m = await member(`Customer Name ${run}`);
      await sender(lid(), `Customer Name ${run}`, 2);
      await matchTeamMembersToWhatsApp(prisma, ISP_DIGITAL);
      expect((await prisma.internalTeamMember.findUniqueOrThrow({ where: { id: m.id } })).whatsappId).toBeNull();
    }));

  it("never links when two senders share the name", () =>
    inIsp(async () => {
      const m = await member(`Shared Name ${run}`);
      await sender(lid(), `Shared Name ${run}`, 3);
      await sender(lid(), `Shared Name ${run}`, 3);
      await matchTeamMembersToWhatsApp(prisma, ISP_DIGITAL);
      expect((await prisma.internalTeamMember.findUniqueOrThrow({ where: { id: m.id } })).whatsappId).toBeNull();
    }));

  it("leaves alone a member a person unlinked", () =>
    inIsp(async () => {
      const m = await member(`Unlinked Name ${run}`);
      await prisma.internalTeamMember.update({ where: { id: m.id }, data: { autoLinkOff: true } });
      await sender(lid(), `Unlinked Name ${run}`, 3);
      await matchTeamMembersToWhatsApp(prisma, ISP_DIGITAL);
      expect((await prisma.internalTeamMember.findUniqueOrThrow({ where: { id: m.id } })).whatsappId).toBeNull();
    }));
});

describe("the roster fills itself", () => {
  it("writes the pattern ahead, only into blanks, and leaves a person's change alone", () =>
    inIsp(async () => {
      const m = await member(`Roster Person ${run}`);
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await prisma.weeklyScheduleEntry.create({ data: { teamMemberId: m.id, weekday, shiftTemplateId: weekday === 5 ? null : shiftId } });
      }
      const now = new Date("2026-12-01T06:00:00.000Z");
      const moved = new Date(Date.UTC(2026, 11, 2));
      await prisma.dutyAssignment.create({ data: { teamMemberId: m.id, dutyDate: moved, status: "OFF", source: "MANUAL" } });
      await fillRosterFromPattern(prisma, now, 7);
      await fillRosterFromPattern(prisma, now, 7); // twice is the same as once
      const rows = await prisma.dutyAssignment.findMany({ where: { teamMemberId: m.id }, orderBy: { dutyDate: "asc" } });
      expect(rows).toHaveLength(8);
      expect(rows.find((r) => r.dutyDate.getTime() === moved.getTime())?.source).toBe("MANUAL");
      const friday = rows.find((r) => r.dutyDate.getUTCDay() === 5);
      expect(friday?.status).toBe("OFF");
      expect(rows.find((r) => r.dutyDate.getUTCDay() === 1)?.shiftName).toBe(`Auto ${run}`);
    }));
});

describe("who typed a reply on our number's phone", () => {
  const at = Date.UTC(2026, 10, 7, 6);
  const a = { memberId: "a", startedAt: null, endedAt: null };
  const b = { memberId: "b", startedAt: null, endedAt: null };

  it("credits a phone reply in reports, and never an AI, rule or broadcast send", () => {
    const row = { sender: "555", senderJid: "555@lid", direction: "OUTGOING", fromTeam: false, obMatched: false, actionType: null, ruleId: null, createdById: null };
    const classifier = createReportClassifier(createSenderResolver([]), new Set(["555"]), new Map(), () => "a");
    expect(classifier.classify(row as never, at)).toMatchObject({ kind: "MEMBER", memberId: "a" });
    for (const actionType of ["AUTO_REPLY", "GROUP_BROADCAST"]) {
      expect(classifier.classify({ ...row, obMatched: true, actionType } as never, at)).toMatchObject({ kind: "BUSINESS", memberId: null });
    }
    // With nobody set up, a phone reply stays the business number's, as it always was.
    const plain = createReportClassifier(createSenderResolver([]), new Set(["555"]), new Map());
    expect(plain.classify(row as never, at)).toMatchObject({ kind: "BUSINESS", memberId: null });
  });

  it("is the only person on the number", () => expect(pickNumberOperator([a], at)).toBe("a"));
  it("respects when they started and stopped", () => {
    expect(pickNumberOperator([{ ...a, startedAt: at + 1 }], at)).toBeNull();
    expect(pickNumberOperator([{ ...a, endedAt: at }], at)).toBeNull();
  });
  it("is whoever was on duty among several, and nobody if that does not settle it", () => {
    expect(pickNumberOperator([a, b], at, (id) => id === "b")).toBe("b");
    expect(pickNumberOperator([a, b], at, () => true)).toBeNull();
    expect(pickNumberOperator([a, b], at, () => false)).toBeNull();
    expect(pickNumberOperator([a, b], at)).toBeNull();
  });
});
