import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomInt } from "node:crypto";
import type { WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { toDhakaDateOnly } from "@support-automation/shared";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import { processNextReattribution } from "../teamManagement/reattribution.js";
import { recomputeAttendanceDay } from "../teamManagement/attendance.js";

/**
 * Report accuracy audit (19 Oct 2026), Phase 3: after a roster identity change, what was decided on
 * arrival is brought in line — the `isFromTeamMember` stamp, the member on Support Activity rows, and
 * Duty History — against real rows:
 *  - a colleague added after they wrote: their messages become staff, their activity theirs, their
 *    day on Duty History appears;
 *  - a member's "count their messages from" date splits their history at that moment;
 *  - deactivating somebody never turns their history into a customer's.
 */

const RUN = String(randomInt(100_000, 999_999));
let seq = 0;
const phone = () => `8801${RUN}${String(++seq).padStart(3, "0")}`;
const WGID = `120372${Date.now()}${RUN}@g.us`;
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
const at = (minutes: number) => new Date(twoDaysAgo.getTime() + minutes * 60_000);

let account: WhatsAppAccount;
let group: WhatsAppGroup;
const rinaPhone = phone();
const karimPhone = phone();
const leftPhone = phone();
const ids = { rina: "", karim: "", left: "", nadia: "", mover: "", taker: "" };

async function stored(key: string, sender: string, when: Date, fromTeam: boolean) {
  return prisma.message.create({
    data: {
      accountId: account.id,
      groupId: group.id,
      chatId: WGID,
      whatsappMessageId: `false_${WGID}_${key}${RUN}_${sender}@c.us`,
      senderPhone: sender,
      senderJid: `${sender}@c.us`,
      isFromTeamMember: fromTeam,
      direction: "INCOMING",
      body: "text",
      normalizedBody: "text",
      timestampWa: when,
      processingStatus: "PROCESSED",
    },
  });
}

const stamps = (sender: string) =>
  prisma.message.findMany({ where: { chatId: WGID, senderPhone: sender }, orderBy: { timestampWa: "asc" }, select: { isFromTeamMember: true } }).then((rows) => rows.map((r) => r.isFromTeamMember));

beforeAll(async () => {
  account = await prisma.whatsAppAccount.create({ data: { label: `Reattr ${RUN}`, status: "CONNECTED" } });
  group = await prisma.whatsAppGroup.create({ data: { accountId: account.id, whatsappGroupId: WGID, name: `Reattr ${RUN}`, isActive: true, isMonitored: true, lastSyncedAt: new Date() } });
});

afterAll(async () => {
  await prisma.identityReattribution.deleteMany({ where: { reason: { contains: RUN } } });
  await prisma.teamAttendanceDay.deleteMany({ where: { teamMemberId: { in: Object.values(ids).filter(Boolean) } } });
  await prisma.supportActivity.deleteMany({ where: { groupId: group.id } });
  await prisma.message.deleteMany({ where: { chatId: WGID } });
  await prisma.internalTeamMember.deleteMany({ where: { id: { in: Object.values(ids).filter(Boolean) } } });
  await prisma.whatsAppGroup.deleteMany({ where: { id: group.id } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: account.id } });
  await prisma.$disconnect();
});

describe("a colleague added after they wrote", () => {
  it("re-stamps their messages, credits their activity and records their Duty History day", async () => {
    const first = await stored("R1", rinaPhone, at(0), false);
    await stored("R2", rinaPhone, at(10), false);
    await prisma.supportActivity.create({ data: { accountId: account.id, groupId: group.id, teamMemberId: null, messageId: first.id, occurredAt: at(0) } });
    ids.rina = (await prisma.internalTeamMember.create({ data: { name: `Rina ${RUN}`, phoneNumber: `+${rinaPhone}`, role: "Support" } })).id;
    await prisma.identityReattribution.create({ data: { reason: `Rina ${RUN} added`, identifiers: [`+${rinaPhone}`], memberIds: [ids.rina] } });

    expect(await inIsp(() => processNextReattribution())).toBe(true);

    expect(await stamps(rinaPhone)).toEqual([true, true]);
    expect((await prisma.supportActivity.findUniqueOrThrow({ where: { messageId: first.id } })).teamMemberId).toBe(ids.rina);
    const day = await prisma.teamAttendanceDay.findUnique({
      where: { teamMemberId_activityDate: { teamMemberId: ids.rina, activityDate: toDhakaDateOnly(at(0)) } },
    });
    expect(day?.messageCount).toBe(2);
    const request = await prisma.identityReattribution.findFirstOrThrow({ where: { reason: `Rina ${RUN} added` } });
    expect(request.status).toBe("DONE");
  });
});

describe("the stamp means 'a colleague when they wrote it'", () => {
  it("splits a member's history at their 'count their messages from' date", async () => {
    await stored("K1", karimPhone, at(0), true);
    await stored("K2", karimPhone, at(120), false);
    ids.karim = (
      await prisma.internalTeamMember.create({ data: { name: `Karim ${RUN}`, phoneNumber: `+${karimPhone}`, role: "Support", attributeFrom: at(60) } })
    ).id;
    await prisma.identityReattribution.create({ data: { reason: `Karim ${RUN} dated`, identifiers: [karimPhone], memberIds: [ids.karim] } });
    await inIsp(() => processNextReattribution());
    expect(await stamps(karimPhone)).toEqual([false, true]);
  });

  it("keeps a deactivated colleague's history as staff", async () => {
    await stored("L1", leftPhone, at(0), true);
    ids.left = (await prisma.internalTeamMember.create({ data: { name: `Left ${RUN}`, phoneNumber: `+${leftPhone}`, role: "Support", status: "INACTIVE" } })).id;
    await prisma.identityReattribution.create({ data: { reason: `Left ${RUN} deactivated`, identifiers: [leftPhone], memberIds: [ids.left] } });
    await inIsp(() => processNextReattribution());
    expect(await stamps(leftPhone)).toEqual([true]);
  });
});

describe("a colleague who was already supporting customers before they were added", () => {
  it("gets their earlier work into the Activity Feed, and the request reports what was found", async () => {
    const settings = await prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    const wasEnabled = settings.enabled;
    await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { enabled: true } });
    const rule = await prisma.supportRule.create({ data: { name: `Any message ${RUN}`, triggerType: "ANY_MESSAGE" } });
    try {
      const nadiaPhone = phone();
      await stored("N1", nadiaPhone, at(0), false);
      await stored("N2", nadiaPhone, at(30), false);
      const nadia = (await prisma.internalTeamMember.create({ data: { name: `Nadia ${RUN}`, phoneNumber: `+${nadiaPhone}`, role: "Support" } })).id;
      ids.nadia = nadia;
      await prisma.identityReattribution.create({ data: { reason: `Nadia ${RUN} added`, identifiers: [nadiaPhone], memberIds: [nadia] } });
      await inIsp(() => processNextReattribution());

      expect(await prisma.supportActivity.count({ where: { teamMemberId: nadia } })).toBe(2);
      const request = await prisma.identityReattribution.findFirstOrThrow({ where: { reason: `Nadia ${RUN} added` } });
      expect((request.result as { members: Record<string, { messages: number; groups: number }> }).members[nadia]).toMatchObject({ messages: 2, groups: 1 });
    } finally {
      await prisma.supportActivity.deleteMany({ where: { ruleId: rule.id } });
      await prisma.supportRule.delete({ where: { id: rule.id } });
      await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { enabled: wasEnabled } });
    }
  });
});

describe("B1: a deactivated member's Duty History follows a corrected identifier", () => {
  it("withdraws the days of a deactivated member whose number was corrected to another person's", async () => {
    const wrongPhone = phone();
    const newPhone = phone();
    const takerPhone = phone();
    // "mover" held the number the messages were sent from, and was counted for them while active.
    ids.mover = (await prisma.internalTeamMember.create({ data: { name: `Mover ${RUN}`, phoneNumber: `+${wrongPhone}`, role: "Support" } })).id;
    ids.taker = (await prisma.internalTeamMember.create({ data: { name: `Taker ${RUN}`, phoneNumber: `+${takerPhone}`, role: "Support" } })).id;
    await stored("V1", wrongPhone, at(0), true);
    await stored("V2", wrongPhone, at(5), true);
    await inIsp(() => recomputeAttendanceDay(ids.mover, at(0)));
    const key = { teamMemberId_activityDate: { teamMemberId: ids.mover, activityDate: toDhakaDateOnly(at(0)) } };
    expect((await prisma.teamAttendanceDay.findUnique({ where: key }))?.messageCount).toBe(2);

    // They leave; later an admin finds the number was never theirs: it moves to the person who really had it.
    await prisma.internalTeamMember.update({ where: { id: ids.mover }, data: { status: "INACTIVE", phoneNumber: `+${newPhone}` } });
    await prisma.internalTeamMember.update({ where: { id: ids.taker }, data: { phoneNumber: `+${wrongPhone}` } });
    await prisma.identityReattribution.create({
      data: { reason: `Number corrected ${RUN}`, identifiers: [wrongPhone, takerPhone], memberIds: [ids.mover, ids.taker] },
    });
    expect(await inIsp(() => processNextReattribution())).toBe(true);

    // The same two messages were counted on BOTH members' Duty History before the fix.
    expect(await prisma.teamAttendanceDay.findUnique({ where: key })).toBeNull();
    const takerDay = await prisma.teamAttendanceDay.findUnique({
      where: { teamMemberId_activityDate: { teamMemberId: ids.taker, activityDate: toDhakaDateOnly(at(0)) } },
    });
    expect(takerDay?.messageCount).toBe(2);
  });

  it("recomputing a deactivated member still counts what the roster credits them with", async () => {
    const goneId = ids.left;
    expect((await prisma.internalTeamMember.findUniqueOrThrow({ where: { id: goneId } })).status).toBe("INACTIVE");
    await inIsp(() => recomputeAttendanceDay(goneId, at(0)));
    const day = await prisma.teamAttendanceDay.findUnique({
      where: { teamMemberId_activityDate: { teamMemberId: goneId, activityDate: toDhakaDateOnly(at(0)) } },
    });
    // Left's one stamped message (L1) is theirs on Duty History, as it is in the Team Report.
    expect(day?.messageCount).toBe(1);
  });
});
