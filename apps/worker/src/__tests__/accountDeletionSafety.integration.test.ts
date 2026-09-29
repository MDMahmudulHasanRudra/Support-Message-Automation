import "./helpers/requireTestDatabase.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import {
  countAccountHistory,
  reconcileAttendanceAfterAccountRemoval,
} from "@support-automation/db";

/**
 * Deleting a WhatsApp account destroys fourteen cascading relations, and nothing counted them.
 *
 * `deleteWhatsAppAccount` guarded on exactly two things — is this the last account, is it Primary —
 * and then hard-deleted. Everything hanging off the row went with it: every Message, every
 * SupportActivity, every SupportSession, every AiFallbackDecision, every escalation case, the
 * groups and their whole configuration. The confirmation said "synced groups and message history",
 * which is true and radically incomplete, and the codebase's own standard is the opposite:
 * soft-delete over hard-delete for records with historical value.
 *
 * The second half is worse because it is silent. `TeamAttendanceGroup` cascades from the account;
 * `TeamAttendanceDay`, which holds `messageCount` and `uniqueGroupCount`, hangs off
 * InternalTeamMember and SURVIVES. So after a delete the duty row still reads "93 messages across
 * 23 groups" while expanding it shows nothing at all — numbers that cannot be reconciled and give
 * no sign they are wrong.
 *
 * Both halves are pure-ish data functions in packages/db so the worker suite can reach them; the
 * web action composes them. Every test here was confirmed to fail before they existed.
 */

let account: { id: string };
let otherAccount: { id: string };
let member: { id: string };
const uniqueChatId = () => `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;
/** Digits only — team-member matching normalises to digits, and a hex slice can fall under the minimum. */
const uniquePhone = () => `8809${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function makeGroup(accountId: string) {
  return prisma.whatsAppGroup.create({
    data: { accountId, whatsappGroupId: uniqueChatId(), name: `G ${randomUUID().slice(0, 6)}`, lastSyncedAt: new Date() },
  });
}

beforeEach(async () => {
  account = await prisma.whatsAppAccount.create({ data: { label: `Del ${randomUUID()}`, status: "CONNECTED" } });
  otherAccount = await prisma.whatsAppAccount.create({ data: { label: `Keep ${randomUUID()}`, status: "CONNECTED" } });
  member = await prisma.internalTeamMember.create({
    data: { name: `Member ${randomUUID().slice(0, 6)}`, phoneNumber: uniquePhone(), role: "Support", status: "ACTIVE" },
  });
});

afterEach(async () => {
  await prisma.teamAttendanceDay.deleteMany({ where: { teamMemberId: member.id } });
  await prisma.internalTeamMember.deleteMany({ where: { id: member.id } });
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [account.id, otherAccount.id] } } });
});

describe("counting what a delete would destroy", () => {
  it("reports zero for an account that has never been used", async () => {
    const impact = await countAccountHistory(account.id, prisma);
    expect(impact.total).toBe(0);
    expect(impact.hasHistory).toBe(false);
  });

  it("counts messages, groups and support history separately, not as one lump", async () => {
    // Named separately because they are not interchangeable to the person deciding: losing a
    // group's configuration is an afternoon's work, losing the support record is unrecoverable.
    const group = await makeGroup(account.id);
    const message = await prisma.message.create({
      data: {
        accountId: account.id,
        groupId: group.id,
        whatsappMessageId: `m-${randomUUID()}`,
        chatId: group.whatsappGroupId,
        senderPhone: uniquePhone(),
        direction: "INCOMING",
        body: "hello",
        normalizedBody: "hello",
        timestampWa: new Date(),
      },
    });
    await prisma.supportActivity.create({
      data: {
        accountId: account.id,
        groupId: group.id,
        teamMemberId: member.id,
        messageId: message.id,
        occurredAt: new Date(),
      },
    });

    const impact = await countAccountHistory(account.id, prisma);
    expect(impact.hasHistory).toBe(true);
    expect(impact.messages).toBe(1);
    expect(impact.groups).toBe(1);
    expect(impact.supportActivities).toBe(1);
    expect(impact.total).toBeGreaterThanOrEqual(3);
  });

  it("does not count another account's history", async () => {
    const group = await makeGroup(otherAccount.id);
    await prisma.message.create({
      data: {
        accountId: otherAccount.id,
        groupId: group.id,
        whatsappMessageId: `m-${randomUUID()}`,
        chatId: group.whatsappGroupId,
        senderPhone: uniquePhone(),
        direction: "INCOMING",
        body: "not mine",
        normalizedBody: "not mine",
        timestampWa: new Date(),
      },
    });

    expect((await countAccountHistory(account.id, prisma)).total).toBe(0);
  });

  it("counts attendance evidence, which is the part that leaves a lie behind", async () => {
    const group = await makeGroup(account.id);
    const day = await prisma.teamAttendanceDay.create({
      data: { teamMemberId: member.id, activityDate: new Date("2026-09-10T00:00:00.000Z"), messageCount: 5, uniqueGroupCount: 1 },
    });
    await prisma.teamAttendanceGroup.create({
      data: { attendanceDayId: day.id, groupId: group.id, accountId: account.id, messageCount: 5, firstAt: new Date(), lastAt: new Date() },
    });

    expect((await countAccountHistory(account.id, prisma)).attendanceEvidence).toBe(1);
  });
});

describe("attendance stays honest after an account is removed", () => {
  it("recomputes a day down to the evidence that is left", async () => {
    // The failure this exists for: the day row keeps 12 messages across 2 groups while only one
    // group's evidence survives.
    const mine = await makeGroup(account.id);
    const theirs = await makeGroup(otherAccount.id);
    const day = await prisma.teamAttendanceDay.create({
      data: {
        teamMemberId: member.id,
        activityDate: new Date("2026-09-11T00:00:00.000Z"),
        messageCount: 12,
        uniqueGroupCount: 2,
        firstActivityAt: new Date("2026-09-11T04:00:00.000Z"),
        lastActivityAt: new Date("2026-09-11T14:00:00.000Z"),
      },
    });
    await prisma.teamAttendanceGroup.createMany({
      data: [
        { attendanceDayId: day.id, groupId: mine.id, accountId: account.id, messageCount: 7, firstAt: new Date("2026-09-11T04:00:00.000Z"), lastAt: new Date("2026-09-11T09:00:00.000Z") },
        { attendanceDayId: day.id, groupId: theirs.id, accountId: otherAccount.id, messageCount: 5, firstAt: new Date("2026-09-11T10:00:00.000Z"), lastAt: new Date("2026-09-11T14:00:00.000Z") },
      ],
    });

    const affected = await prisma.teamAttendanceGroup.findMany({
      where: { accountId: account.id },
      select: { attendanceDayId: true },
    });
    await prisma.whatsAppAccount.delete({ where: { id: account.id } });
    await reconcileAttendanceAfterAccountRemoval(affected.map((row) => row.attendanceDayId), prisma);

    const after = await prisma.teamAttendanceDay.findUniqueOrThrow({ where: { id: day.id } });
    expect(after.messageCount).toBe(5);
    expect(after.uniqueGroupCount).toBe(1);
    expect(after.firstActivityAt?.toISOString()).toBe("2026-09-11T10:00:00.000Z");
    expect(after.lastActivityAt?.toISOString()).toBe("2026-09-11T14:00:00.000Z");
  });

  it("zeroes a day whose every group belonged to the deleted account, without deleting the row", async () => {
    // The row itself must survive: it can carry a manager's AttendanceOverride, which is their
    // explicit verdict and is not evidence this function is entitled to throw away.
    const mine = await makeGroup(account.id);
    const day = await prisma.teamAttendanceDay.create({
      data: {
        teamMemberId: member.id,
        activityDate: new Date("2026-09-12T00:00:00.000Z"),
        messageCount: 9,
        uniqueGroupCount: 1,
        firstActivityAt: new Date("2026-09-12T05:00:00.000Z"),
        lastActivityAt: new Date("2026-09-12T11:00:00.000Z"),
        override: "WORKED",
        overrideReason: "was on site",
      },
    });
    await prisma.teamAttendanceGroup.create({
      data: { attendanceDayId: day.id, groupId: mine.id, accountId: account.id, messageCount: 9, firstAt: new Date("2026-09-12T05:00:00.000Z"), lastAt: new Date("2026-09-12T11:00:00.000Z") },
    });

    await prisma.whatsAppAccount.delete({ where: { id: account.id } });
    await reconcileAttendanceAfterAccountRemoval([day.id], prisma);

    const after = await prisma.teamAttendanceDay.findUniqueOrThrow({ where: { id: day.id } });
    expect(after.messageCount).toBe(0);
    expect(after.uniqueGroupCount).toBe(0);
    expect(after.firstActivityAt).toBeNull();
    expect(after.lastActivityAt).toBeNull();
    // The manager's verdict is untouched.
    expect(after.override).toBe("WORKED");
    expect(after.overrideReason).toBe("was on site");
  });

  it("leaves a day the deleted account never contributed to alone", async () => {
    const theirs = await makeGroup(otherAccount.id);
    const day = await prisma.teamAttendanceDay.create({
      data: { teamMemberId: member.id, activityDate: new Date("2026-09-13T00:00:00.000Z"), messageCount: 4, uniqueGroupCount: 1 },
    });
    await prisma.teamAttendanceGroup.create({
      data: { attendanceDayId: day.id, groupId: theirs.id, accountId: otherAccount.id, messageCount: 4, firstAt: new Date(), lastAt: new Date() },
    });

    // Nothing of this account's touched that day, so nothing is passed in — and nothing moves.
    await reconcileAttendanceAfterAccountRemoval([], prisma);

    const after = await prisma.teamAttendanceDay.findUniqueOrThrow({ where: { id: day.id } });
    expect(after.messageCount).toBe(4);
    expect(after.uniqueGroupCount).toBe(1);
  });

  it("is safe to run twice — it converges rather than accumulating", async () => {
    const theirs = await makeGroup(otherAccount.id);
    const day = await prisma.teamAttendanceDay.create({
      data: { teamMemberId: member.id, activityDate: new Date("2026-09-14T00:00:00.000Z"), messageCount: 99, uniqueGroupCount: 9 },
    });
    await prisma.teamAttendanceGroup.create({
      data: { attendanceDayId: day.id, groupId: theirs.id, accountId: otherAccount.id, messageCount: 3, firstAt: new Date(), lastAt: new Date() },
    });

    await reconcileAttendanceAfterAccountRemoval([day.id], prisma);
    const once = await prisma.teamAttendanceDay.findUniqueOrThrow({ where: { id: day.id } });
    await reconcileAttendanceAfterAccountRemoval([day.id], prisma);
    const twice = await prisma.teamAttendanceDay.findUniqueOrThrow({ where: { id: day.id } });

    expect(once.messageCount).toBe(3);
    expect(twice.messageCount).toBe(3);
    expect(twice.uniqueGroupCount).toBe(once.uniqueGroupCount);
  });
});
