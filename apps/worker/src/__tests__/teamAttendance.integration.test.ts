import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma, inIsp } from "./helpers/projectFixtures.js";
import type { AutomationSettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { getDhakaDayRange, toDhakaDateOnly } from "@support-automation/shared";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { recordTeamAttendance } from "../teamManagement/attendance.js";

/**
 * Team Management's attendance evidence, and the roster/leave rules derived from it.
 *
 * Same real-Postgres, unique-fixtures-with-cleanup convention as the other integration suites —
 * see `pipeline.integration.test.ts` for why. **Run this only against the isolated test database**
 * (`pnpm --filter @support-automation/worker test:isolated`); it creates team members, and a
 * member row that leaks into the live database would start attributing real customer messages to a
 * fictional colleague.
 *
 * The derivation rules live in `apps/web/src/server/teamManagementReports.ts`, which has no test
 * runner. They are covered here by hand-mirroring their Prisma queries, the same way
 * `permissionModules` and `userSessions` cover their server actions. Where that is what a test is
 * doing, it says so.
 */

let originalSettings: AutomationSettings;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
let secondGroup: WhatsAppGroup;
let preExistingActiveRuleIds: string[] = [];
const createdTeamMemberIds: string[] = [];
const createdShiftTemplateIds: string[] = [];
const createdLeaveTypeIds: string[] = [];

const PHONE_RUN_PREFIX = String(randomInt(100_000, 999_999));
let phoneSequence = 0;

/** Digits only — team-member matching normalises to digits, and a hex slice can fall under the minimum. */
function uniquePhone(): string {
  return `+8809${PHONE_RUN_PREFIX}${String(++phoneSequence).padStart(4, "0")}`;
}

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

async function makeTeamMember(overrides: { phoneNumber?: string; whatsappId?: string; status?: "ACTIVE" | "INACTIVE" } = {}) {
  const phoneNumber = overrides.phoneNumber ?? uniquePhone();
  const member = await prisma.internalTeamMember.create({
    data: {
      name: `Attendance Test ${randomUUID().slice(0, 8)}`,
      phoneNumber,
      whatsappId: overrides.whatsappId ?? null,
      role: "Support",
      status: overrides.status ?? "ACTIVE",
    },
  });
  createdTeamMemberIds.push(member.id);
  return member;
}

async function makeShiftTemplate(name: string, startMinute: number, endMinute: number, requiredHeadcount = 1) {
  const template = await prisma.shiftTemplate.create({
    data: { name: `${name} ${randomUUID().slice(0, 6)}`, startMinute, endMinute, requiredHeadcount },
  });
  createdShiftTemplateIds.push(template.id);
  return template;
}

async function makeLeaveType() {
  const type = await prisma.leaveType.create({ data: { name: `Test Leave ${randomUUID().slice(0, 8)}` } });
  createdLeaveTypeIds.push(type.id);
  return type;
}

/** A group message from `senderPhone`, through the real pipeline. */
async function sendGroupMessage(
  target: WhatsAppGroup,
  senderPhone: string,
  body: string,
  timestampWa: Date = new Date(),
) {
  const whatsappMessageId = randomUUID();
  await processIncomingMessage({
    accountId: account.id,
    whatsappMessageId,
    chatId: target.whatsappGroupId,
    whatsappGroupId: target.whatsappGroupId,
    senderPhone,
    direction: "INCOMING",
    body,
    timestampWa,
  });
  return whatsappMessageId;
}

function attendanceFor(teamMemberId: string, when: Date) {
  return prisma.teamAttendanceDay.findUnique({
    where: { teamMemberId_activityDate: { teamMemberId, activityDate: toDhakaDateOnly(when) } },
    include: { groups: true },
  });
}

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  // The engine reads every ACTIVE rule globally, so seeded rules would otherwise reply to fixtures.
  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((rule) => rule.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }
});

afterAll(async () => {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: { automationEnabled: originalSettings.automationEnabled },
  });
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "ACTIVE" } });
  }
});

beforeEach(async () => {
  await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: true } });
  account = await prisma.whatsAppAccount.create({
    data: { label: `Team Attendance Test ${randomUUID()}`, status: "CONNECTED" },
  });
  group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Attendance Group A", lastSyncedAt: new Date() },
  });
  secondGroup = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Attendance Group B", lastSyncedAt: new Date() },
  });
});

afterEach(async () => {
  if (createdTeamMemberIds.length) {
    await prisma.teamAttendanceDay.deleteMany({ where: { teamMemberId: { in: createdTeamMemberIds } } });
    await prisma.dutyAssignmentChange.deleteMany({ where: { teamMemberId: { in: createdTeamMemberIds } } });
    await prisma.dutyAssignment.deleteMany({ where: { teamMemberId: { in: createdTeamMemberIds } } });
    await prisma.leaveRequest.deleteMany({ where: { teamMemberId: { in: createdTeamMemberIds } } });
    await prisma.weeklyScheduleEntry.deleteMany({ where: { teamMemberId: { in: createdTeamMemberIds } } });
  }
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.supportActivity.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }); // cascades the groups

  if (createdTeamMemberIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: createdTeamMemberIds } } });
    createdTeamMemberIds.length = 0;
  }
  if (createdLeaveTypeIds.length) {
    await prisma.leaveType.deleteMany({ where: { id: { in: createdLeaveTypeIds } } });
    createdLeaveTypeIds.length = 0;
  }
  if (createdShiftTemplateIds.length) {
    await prisma.shiftTemplate.deleteMany({ where: { id: { in: createdShiftTemplateIds } } });
    createdShiftTemplateIds.length = 0;
  }
});

describe("attendance evidence — one record per person per day", () => {
  it("records 7 messages across 2 groups as ONE day row with count 7 and 2 group rows", async () => {
    const member = await makeTeamMember();

    for (let i = 0; i < 5; i += 1) await sendGroupMessage(group, member.phoneNumber, `message ${i}`);
    for (let i = 0; i < 2; i += 1) await sendGroupMessage(secondGroup, member.phoneNumber, `message ${i}`);

    const day = await attendanceFor(member.id, new Date());
    expect(day).not.toBeNull();
    expect(day!.messageCount).toBe(7);
    expect(day!.uniqueGroupCount).toBe(2);
    expect(day!.groups).toHaveLength(2);
    expect(day!.groups.reduce((sum, row) => sum + row.messageCount, 0)).toBe(7);
  });

  it("counts a duplicate delivery of the same WhatsApp message once", async () => {
    const member = await makeTeamMember();
    const whatsappMessageId = randomUUID();

    const deliver = () =>
      processIncomingMessage({
        accountId: account.id,
        whatsappMessageId,
        chatId: group.whatsappGroupId,
        whatsappGroupId: group.whatsappGroupId,
        senderPhone: member.phoneNumber,
        direction: "INCOMING",
        body: "same message twice",
        timestampWa: new Date(),
      });

    await deliver();
    await deliver(); // WhatsApp redelivery — the Message unique constraint absorbs it

    const day = await attendanceFor(member.id, new Date());
    expect(day!.messageCount).toBe(1);
  });

  it("is unchanged by re-running the hook — it recomputes rather than incrementing", async () => {
    const member = await makeTeamMember();
    await sendGroupMessage(group, member.phoneNumber, "one");
    await sendGroupMessage(group, member.phoneNumber, "two");

    const before = await attendanceFor(member.id, new Date());

    // Exactly what a stranded-message re-run or a catch-up replay does.
    for (let i = 0; i < 4; i += 1) {
      await inIsp(() => recordTeamAttendance({
        groupId: group.id,
        isFromTeamMember: true,
        senderPhone: member.phoneNumber,
        timestampWa: new Date(),
      }));
    }

    const after = await attendanceFor(member.id, new Date());
    expect(after!.messageCount).toBe(before!.messageCount);
    expect(after!.messageCount).toBe(2);
    expect(after!.groups).toHaveLength(1);
  });

  it("ignores a customer, an unknown sender, and a deactivated member", async () => {
    const customerPhone = uniquePhone();
    const inactive = await makeTeamMember({ status: "INACTIVE" });

    await sendGroupMessage(group, customerPhone, "my internet is down");
    await sendGroupMessage(group, inactive.phoneNumber, "hello");

    expect(await attendanceFor(inactive.id, new Date())).toBeNull();
    expect(await prisma.teamAttendanceDay.count({ where: { teamMemberId: { in: createdTeamMemberIds } } })).toBe(0);
  });

  it("attributes a member identified only by a LID", async () => {
    // Most of a roster is added from message history, which carries a LID rather than a number —
    // so `phoneNumber` and `whatsappId` hold the same value and both must resolve to one person.
    const lid = `1234567${String(randomInt(1000000, 9999999))}`;
    const member = await makeTeamMember({ phoneNumber: lid, whatsappId: lid });

    await sendGroupMessage(group, lid, "working the late shift");

    const day = await attendanceFor(member.id, new Date());
    expect(day!.messageCount).toBe(1);
  });

  it("places a late-night message on the Dhaka day it was sent, not the UTC one", async () => {
    const member = await makeTeamMember();
    // 02:00 Dhaka on the 13th is 20:00 UTC on the 12th. Handing Prisma the raw instant would file
    // this under the 12th and quietly cost somebody their late shift.
    const lateNight = new Date(Date.UTC(2026, 8, 12, 20, 30));

    await sendGroupMessage(group, member.phoneNumber, "still here", lateNight);

    const wrongDay = await prisma.teamAttendanceDay.findUnique({
      where: { teamMemberId_activityDate: { teamMemberId: member.id, activityDate: new Date(Date.UTC(2026, 8, 12)) } },
    });
    const rightDay = await prisma.teamAttendanceDay.findUnique({
      where: { teamMemberId_activityDate: { teamMemberId: member.id, activityDate: new Date(Date.UTC(2026, 8, 13)) } },
    });
    expect(wrongDay).toBeNull();
    expect(rightDay).not.toBeNull();
    expect(rightDay!.messageCount).toBe(1);
  });

  it("counts messages sent BEFORE the person was added to the roster", async () => {
    // `Message.isFromTeamMember` is stamped at insert time, so it is false for everything sent
    // before somebody joined. Filtering the recompute on it would silently discard their morning.
    const phone = uniquePhone();
    await sendGroupMessage(group, phone, "answered this as an unknown sender");

    const member = await makeTeamMember({ phoneNumber: phone });
    await sendGroupMessage(group, phone, "and this one after being added");

    const day = await attendanceFor(member.id, new Date());
    expect(day!.messageCount).toBe(2);
  });
});

describe("attendance evidence — concurrency", () => {
  it("10 concurrent messages across 3 groups give ONE row, count 10, 3 groups", async () => {
    // The lost-update case, and the reason `recordTeamAttendance` takes a Postgres advisory lock
    // rather than relying on the recompute being idempotent. Idempotent is only true SEQUENTIALLY:
    // A reads 9 while B reads 10 and writes 10, then A writes its stale 9. An application-memory
    // lock would not close this — two worker processes share no memory to lock in.
    //
    // Three details of the setup are load-bearing and were arrived at by experiment. Please do not
    // simplify them; each was tried and each failed to detect a deliberately removed lock.
    //
    //  1. Each task writes its OWN message and then recomputes. Writing all ten up front and only
    //     then racing the recomputes proves nothing — every racer reads the same settled ten.
    //  2. The arrivals are STAGGERED. Without it the ten creates all complete before the first
    //     recompute's SELECT runs, and the race never happens.
    //  3. It runs many ROUNDS. With the lock deleted a single round is short only about three
    //     times in ten, so a one-round test would pass through a real regression more often than
    //     it caught it.
    //
    // Verified by deleting the lock: ten probe rounds returned 10, 8, 9, 9, 10, 10, 10, 10, 10, 8
    // — counts silently short with nothing anywhere to show for it. With the lock, ten of ten.
    const ROUNDS = 14;
    const thirdGroup = await prisma.whatsAppGroup.create({
      data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Attendance Group C", lastSyncedAt: new Date() },
    });
    const groups = [group, secondGroup, thirdGroup];

    for (let round = 0; round < ROUNDS; round += 1) {
      const member = await makeTeamMember();
      const now = new Date();

      await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          await new Promise((resolve) => setTimeout(resolve, i * 12));
          const target = groups[i % 3]!;
          await prisma.message.create({
            data: {
              accountId: account.id,
              whatsappMessageId: randomUUID(),
              chatId: target.whatsappGroupId,
              groupId: target.id,
              senderPhone: member.phoneNumber,
              direction: "INCOMING",
              body: `concurrent ${i}`,
              normalizedBody: `concurrent ${i}`,
              timestampWa: now,
              isFromTeamMember: true,
              processingStatus: "PROCESSED",
            },
          });
          await inIsp(() => recordTeamAttendance({
            groupId: target.id,
            isFromTeamMember: true,
            senderPhone: member.phoneNumber,
            timestampWa: now,
          }));
        }),
      );

      const rows = await prisma.teamAttendanceDay.findMany({
        where: { teamMemberId: member.id },
        include: { groups: true },
      });
      expect(rows, `round ${round}`).toHaveLength(1);
      expect(rows[0]!.messageCount, `round ${round} message count`).toBe(10);
      expect(rows[0]!.uniqueGroupCount, `round ${round} unique groups`).toBe(3);
      expect(rows[0]!.groups, `round ${round} group rows`).toHaveLength(3);
      expect(rows[0]!.groups.reduce((sum, row) => sum + row.messageCount, 0)).toBe(10);
    }
  });
});

/**
 * The derivation rules, mirrored from `teamManagementReports.ts`. `apps/web` has no test runner,
 * so these assert the DATA the page reads — the assignment row, the evidence row, the leave row —
 * rather than the page's own rendering.
 */
describe("roster against evidence", () => {
  async function assign(teamMemberId: string, status: "DUTY" | "OFF", template?: { id: string; name: string; startMinute: number; endMinute: number }) {
    return prisma.dutyAssignment.create({
      data: {
        teamMemberId,
        dutyDate: toDhakaDateOnly(new Date()),
        status,
        shiftTemplateId: template?.id ?? null,
        shiftName: template?.name ?? null,
        shiftStartMinute: template?.startMinute ?? null,
        shiftEndMinute: template?.endMinute ?? null,
        source: "MANUAL",
      },
    });
  }

  it("scheduled OFF plus activity leaves the OFF row intact and the evidence beside it", async () => {
    const member = await makeTeamMember();
    await assign(member.id, "OFF");
    await sendGroupMessage(group, member.phoneNumber, "helping out on my day off");

    const assignment = await prisma.dutyAssignment.findUnique({
      where: { teamMemberId_dutyDate: { teamMemberId: member.id, dutyDate: toDhakaDateOnly(new Date()) } },
    });
    const day = await attendanceFor(member.id, new Date());

    // OFF + activity is read as OFF_DAY_DUTY. The roster row is NOT rewritten to say they were on
    // duty — the plan and the evidence stay separate records, and the reading is derived.
    expect(assignment!.status).toBe("OFF");
    expect(day!.messageCount).toBe(1);
  });

  it("scheduled DUTY with no messages records no attendance row at all — never an ABSENT one", async () => {
    const member = await makeTeamMember();
    const morning = await makeShiftTemplate("Morning", 10 * 60, 19 * 60);
    await assign(member.id, "DUTY", morning);

    const day = await attendanceFor(member.id, new Date());
    // No evidence means no evidence. Nothing in the system may write a verdict here; the page
    // derives "no activity recorded", and only a manager's override can ever say ABSENT.
    expect(day).toBeNull();
  });

  it("a manual override sits beside the evidence rather than replacing it", async () => {
    const member = await makeTeamMember();
    await sendGroupMessage(group, member.phoneNumber, "one message");

    const activityDate = toDhakaDateOnly(new Date());
    await prisma.teamAttendanceDay.update({
      where: { teamMemberId_activityDate: { teamMemberId: member.id, activityDate } },
      data: { override: "ABSENT", overrideReason: "Left after one message" },
    });

    // A later message recomputes the counts and must NOT clear the manager's verdict.
    await sendGroupMessage(group, member.phoneNumber, "another message");

    const day = await attendanceFor(member.id, new Date());
    expect(day!.messageCount).toBe(2);
    expect(day!.override).toBe("ABSENT");
    expect(day!.overrideReason).toBe("Left after one message");
  });

  it("editing a shift template does not change what an existing assignment says", async () => {
    const member = await makeTeamMember();
    const late = await makeShiftTemplate("Late", 13 * 60, 22 * 60);
    await assign(member.id, "DUTY", late);

    await prisma.shiftTemplate.update({ where: { id: late.id }, data: { startMinute: 14 * 60, endMinute: 23 * 60 } });

    const assignment = await prisma.dutyAssignment.findUnique({
      where: { teamMemberId_dutyDate: { teamMemberId: member.id, dutyDate: toDhakaDateOnly(new Date()) } },
    });
    expect(assignment!.shiftStartMinute).toBe(13 * 60);
    expect(assignment!.shiftEndMinute).toBe(22 * 60);
  });

  it("refuses a second assignment for the same person on the same date", async () => {
    const member = await makeTeamMember();
    await assign(member.id, "DUTY");
    // The guard that stops a coverage assignment silently overwriting somebody's existing shift.
    await expect(assign(member.id, "DUTY")).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("leave and coverage", () => {
  it("approved leave keeps the duty row, and effective coverage subtracts the person", async () => {
    const morning = await makeShiftTemplate("Morning", 10 * 60, 19 * 60, 2);
    const leaveType = await makeLeaveType();
    const onLeave = await makeTeamMember();
    const working = await makeTeamMember();
    const dutyDate = toDhakaDateOnly(new Date());

    for (const member of [onLeave, working]) {
      await prisma.dutyAssignment.create({
        data: {
          teamMemberId: member.id,
          dutyDate,
          status: "DUTY",
          shiftTemplateId: morning.id,
          shiftName: morning.name,
          shiftStartMinute: morning.startMinute,
          shiftEndMinute: morning.endMinute,
          source: "MANUAL",
        },
      });
    }

    await prisma.leaveRequest.create({
      data: {
        teamMemberId: onLeave.id,
        leaveTypeId: leaveType.id,
        startDate: dutyDate,
        endDate: dutyDate,
        dayCount: 1,
        status: "APPROVED",
      },
    });

    // Mirrors getCoverageForDate: assigned minus anyone unavailable, floored at zero.
    const assigned = await prisma.dutyAssignment.findMany({
      where: { dutyDate, shiftTemplateId: morning.id, status: { in: ["DUTY", "COVERAGE", "EXTRA_DUTY"] } },
      select: { teamMemberId: true },
    });
    const unavailable = await prisma.leaveRequest.count({
      where: {
        status: "APPROVED",
        startDate: { lte: dutyDate },
        endDate: { gte: dutyDate },
        teamMemberId: { in: assigned.map((row) => row.teamMemberId) },
      },
    });

    // The original assignment is preserved — which is exactly what makes the gap explicable rather
    // than the shift simply looking empty.
    expect(assigned).toHaveLength(2);
    expect(unavailable).toBe(1);
    const effective = assigned.length - unavailable;
    expect(effective).toBe(1);
    expect(Math.max(0, morning.requiredHeadcount - effective)).toBe(1);
  });

  it("activity during approved leave is recorded, and the leave is not cancelled", async () => {
    const leaveType = await makeLeaveType();
    const member = await makeTeamMember();
    const dutyDate = toDhakaDateOnly(new Date());

    const request = await prisma.leaveRequest.create({
      data: {
        teamMemberId: member.id,
        leaveTypeId: leaveType.id,
        startDate: dutyDate,
        endDate: dutyDate,
        dayCount: 1,
        status: "APPROVED",
      },
    });

    await sendGroupMessage(group, member.phoneNumber, "just checking in from leave");

    const day = await attendanceFor(member.id, new Date());
    const after = await prisma.leaveRequest.findUnique({ where: { id: request.id } });

    // A contradiction to surface to a human, never something the software resolves on its own by
    // cancelling somebody's approved leave.
    expect(day!.messageCount).toBe(1);
    expect(after!.status).toBe("APPROVED");
  });
});

describe("the Dhaka day window the recompute uses", () => {
  it("does not pull in a message from the day before", async () => {
    const member = await makeTeamMember();
    const now = new Date();
    const { start } = getDhakaDayRange(now);
    const yesterday = new Date(start.getTime() - 60 * 60 * 1000);

    await sendGroupMessage(group, member.phoneNumber, "yesterday", yesterday);
    await sendGroupMessage(group, member.phoneNumber, "today", now);

    const today = await attendanceFor(member.id, now);
    const before = await attendanceFor(member.id, yesterday);
    expect(today!.messageCount).toBe(1);
    expect(before!.messageCount).toBe(1);
  });
});
