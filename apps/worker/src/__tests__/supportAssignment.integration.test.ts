import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import type { InternalTeamMember, Team, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { buildSupportAssignmentNotices, createProjectWithDefaults, queueSupportAssignmentNotices } from "@support-automation/db";
import { slaOutcome } from "@support-automation/shared";
import { inIsp, prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import type { RawIncomingMessage } from "../pipeline/types.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { escalateOne, markOneOverdue, runSupportAssignmentTick } from "../supportAssignment/processor.js";
import { formatSupportAlert } from "../notifications/formatMessage.js";

/**
 * Support Assignment (SUPPORT_ASSIGNMENT.md), driven through the real pipeline and the real SLA
 * tick. Every assertion reads the case, its history and the Notification rows — what the dashboard
 * and the dispatcher read — never anything computed for the test.
 */

const RUN = String(randomInt(100_000, 999_999));
let seq = 0;
/** Digits only (team matching normalises to digits — see CLAUDE.md on test phone numbers). */
const phone = () => `8801${RUN}${String(++seq).padStart(3, "0")}`;

const T0 = Date.parse("2026-10-06T04:00:00Z"); // 10:00 Dhaka
const min = (n: number) => new Date(T0 + n * 60_000);

let accountA: WhatsAppAccount;
let accountB: WhatsAppAccount;
let groupA: WhatsAppGroup;
let groupB: WhatsAppGroup; // the SAME WhatsApp group as account B sees it
let managerGroup: WhatsAppGroup;
let support: Team;
let billing: Team;
let hasan: InternalTeamMember;
let borhan: InternalTeamMember;
let karim: InternalTeamMember; // Billing: assignable, but not in the Support Team
let admin: InternalTeamMember;
let savedTeams: string[] = [];
let savedAutomation: boolean | null = null;
let savedPrimaryId: string | null = null;
let savedSettings: Awaited<ReturnType<typeof prisma.supportAssignmentSettings.findUnique>> = null;
const otherProjects: string[] = [];
let creatorId = "";

const CUSTOMER = "8801912399601";
const CUSTOMER_2 = "8801912399602";

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
const send = (group: WhatsAppGroup, from: string, minute: number, body: string, overrides: Partial<RawIncomingMessage> = {}) =>
  processIncomingMessage(msg(group, from, minute, { body, ...overrides }));

const cases = () => prisma.supportAssignment.findMany({ where: { whatsappGroupId: groupA.whatsappGroupId }, orderBy: { createdAt: "asc" } });
const onlyCase = async () => {
  const all = await cases();
  expect(all).toHaveLength(1);
  return all[0]!;
};
const events = (assignmentId: string) => prisma.supportAssignmentEvent.findMany({ where: { assignmentId }, orderBy: [{ at: "asc" }, { id: "asc" }] });
const notices = (assignmentId: string) =>
  prisma.notification.findMany({ where: { event: "SUPPORT_ASSIGNMENT", payload: { path: ["assignmentId"], equals: assignmentId } }, orderBy: { createdAt: "asc" } });

async function member(name: string, team: Team | null) {
  const m = await prisma.internalTeamMember.create({ data: { name, phoneNumber: phone(), role: "Support", status: "ACTIVE", teamId: team?.id ?? null } });
  if (team) await prisma.teamMembership.create({ data: { teamMemberId: m.id, teamId: team.id, startedAt: null } });
  return m;
}

async function setSettings(data: { enabled?: boolean; escalationEnabled?: boolean; escalationAfterMinutes?: number; ignoredSenders?: string[] } = {}) {
  const base = {
    enabled: true,
    managerGroupIds: [managerGroup.whatsappGroupId],
    adminMemberIds: [admin.id],
    slaMinutes: 15,
    escalationEnabled: false,
    escalationAfterMinutes: 10,
    notifyEmployeeOnAssign: true,
    notifyEmployeeOnReassign: true,
    notifyManagerOnOverdue: true,
    notifyAdminOnOverdue: true,
    notifyAdminOnEscalation: true,
    notifyAdminOnCompletion: true,
    ignoredSenders: [] as string[],
  };
  await prisma.supportAssignmentSettings.upsert({ where: { id: "global" }, update: { ...base, ...data }, create: { id: "global", ...base, ...data } });
}

/** What the web's assign action does, through the same shared notice builder. */
async function assign(assignmentId: string, memberId: string, at: Date, kind: "ASSIGNED" | "REASSIGNED" = "ASSIGNED") {
  await inIsp(() =>
    prisma.$transaction(async (tx) => {
      const row = await tx.supportAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
      const settings = await tx.supportAssignmentSettings.findUniqueOrThrow({ where: { id: "global" } });
      await tx.supportAssignment.update({
        where: { id: assignmentId },
        data: {
          status: "ASSIGNED",
          assignedMemberId: memberId,
          assignedAt: at,
          assignmentRound: row.assignmentRound + 1,
          slaMinutes: settings.slaMinutes,
          dueAt: new Date(at.getTime() + settings.slaMinutes * 60_000),
          overdueAt: null,
          escalationLevel: 0,
          nextEscalationAt: null,
        },
      });
      await tx.supportAssignmentEvent.create({ data: { assignmentId, type: kind, at, memberId } });
      await queueSupportAssignmentNotices(tx, await buildSupportAssignmentNotices(tx, { assignmentId, kind, settings, now: at }));
    }),
  );
}
const tick = (minute: number) => runSupportAssignmentTick(min(minute));

beforeAll(async () => {
  const activity = await prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  savedTeams = activity.responseTrackingTeamIds;
  savedAutomation = (await prisma.automationSettings.findFirst())?.automationEnabled ?? null;
  await prisma.automationSettings.upsert({ where: { id: "global" }, update: { automationEnabled: false }, create: { id: "global", automationEnabled: false } });
  savedSettings = await prisma.supportAssignmentSettings.findUnique({ where: { id: "global" } });
  creatorId = (await rawPrisma.user.create({ data: { username: `sa-${RUN}`, email: `sa-${RUN}@example.test`, name: "sa", passwordHash: "x" } })).id;
  savedPrimaryId = (await prisma.whatsAppAccount.findFirst({ where: { isPrimary: true } }))?.id ?? null;
  if (savedPrimaryId) await prisma.whatsAppAccount.update({ where: { id: savedPrimaryId }, data: { isPrimary: false } });
});

beforeEach(async () => {
  resetProjectCachesForTests();
  const tag = randomUUID().slice(0, 8);
  support = await prisma.team.create({ data: { name: `Support ${tag}` } });
  billing = await prisma.team.create({ data: { name: `Billing ${tag}` } });
  hasan = await member("Hasan", support);
  borhan = await member("Borhan", support);
  karim = await member("Karim", billing);
  admin = await member("Admin Rudra", null);
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: [support.id] } });
  accountA = await prisma.whatsAppAccount.create({ data: { label: `Primary ${tag}`, status: "CONNECTED", isPrimary: true } });
  accountB = await prisma.whatsAppAccount.create({ data: { label: `Secondary ${tag}`, status: "CONNECTED" } });
  const digits = tag.replace(/\D/g, "");
  const waId = `1203631${RUN}${digits}@g.us`;
  groupA = await prisma.whatsAppGroup.create({ data: { accountId: accountA.id, whatsappGroupId: waId, name: "ABC Broadband Support", isActive: true, isMonitored: true } });
  groupB = await prisma.whatsAppGroup.create({ data: { accountId: accountB.id, whatsappGroupId: waId, name: "ABC Broadband Support", isActive: true, isMonitored: true } });
  managerGroup = await prisma.whatsAppGroup.create({
    data: { accountId: accountA.id, whatsappGroupId: `1203632${RUN}${digits}@g.us`, name: "Support Management", isActive: true },
  });
  await setSettings();
});

afterEach(async () => {
  await rawPrisma.notification.deleteMany({ where: { accountId: { in: [accountA.id, accountB.id] } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: [accountA.id, accountB.id] } } });
  await rawPrisma.teamMembership.deleteMany({ where: { teamId: { in: [support.id, billing.id] } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: [hasan.id, borhan.id, karim.id, admin.id] } } });
  await rawPrisma.team.deleteMany({ where: { id: { in: [support.id, billing.id] } } });
});

afterAll(async () => {
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { responseTrackingTeamIds: savedTeams } });
  if (savedAutomation !== null) await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: savedAutomation } });
  if (savedSettings) {
    const { id: _id, projectId: _p, updatedAt: _u, ...rest } = savedSettings;
    await prisma.supportAssignmentSettings.update({ where: { id: "global" }, data: rest });
  } else {
    await prisma.supportAssignmentSettings.deleteMany({});
  }
  if (savedPrimaryId) await prisma.whatsAppAccount.update({ where: { id: savedPrimaryId }, data: { isPrimary: true } }).catch(() => undefined);
  for (const projectId of otherProjects) {
    await rawPrisma.whatsAppAccount.deleteMany({ where: { projectId } });
  }
  await rawPrisma.$disconnect();
});

describe("qualification: which waits become cases", () => {
  it("does nothing while the module is off", async () => {
    await setSettings({ enabled: false });
    await send(groupA, CUSTOMER, 0, "Internet nai");
    expect(await cases()).toHaveLength(0);
  });

  it("a customer's question opens one UNASSIGNED case pointing at the message; more lines join it", async () => {
    await send(groupA, CUSTOMER, 0, "ভাই আমার internet এখনও slow");
    await send(groupA, CUSTOMER_2, 1, "Bill koto?");
    const c = await onlyCase();
    const first = await prisma.message.findFirstOrThrow({ where: { groupId: groupA.id, body: "ভাই আমার internet এখনও slow" } });
    expect(c).toMatchObject({ status: "UNASSIGNED", firstMessageId: first.id, ignoredMessageCount: 0, groupId: groupA.id });
    expect((await events(c.id)).map((e) => e.type)).toEqual(["OPENED"]);
  });

  it("'Thank you ভাই' alone is IGNORED and counted; a real question in the same wait turns it into a case", async () => {
    await send(groupA, CUSTOMER, 0, "Thank you ভাই");
    let c = await onlyCase();
    expect(c).toMatchObject({ status: "IGNORED", firstMessageId: null, ignoredMessageCount: 1 });
    await send(groupA, CUSTOMER, 1, "ok brother");
    c = await onlyCase();
    expect(c.ignoredMessageCount).toBe(2);
    await send(groupA, CUSTOMER, 2, "Package change korte chai");
    c = await onlyCase();
    expect(c.status).toBe("UNASSIGNED");
    expect(c.firstMessageAt?.getTime()).toBe(min(2).getTime());
    expect((await events(c.id)).map((e) => e.type)).toEqual(["IGNORED", "QUALIFIED"]);
  });

  it("an ignored keyword never matches inside another word", async () => {
    await send(groupA, CUSTOMER, 0, "book korechi, okhla theke");
    expect((await onlyCase()).status).toBe("UNASSIGNED");
  });

  it("an ignored sender's messages never become a case", async () => {
    await setSettings({ ignoredSenders: [CUSTOMER] });
    await send(groupA, CUSTOMER, 0, "All customers: maintenance tonight 12am");
    expect(await onlyCase()).toMatchObject({ status: "IGNORED" });
  });

  it("a team member's message opens nothing", async () => {
    await send(groupA, karim.phoneNumber, 0, "Checking the line now");
    await send(groupA, hasan.phoneNumber, 1, "Ami dekhchi");
    expect(await cases()).toHaveLength(0);
  });

  it("the same message seen by two of our accounts is ONE case", async () => {
    const m = msg(groupA, CUSTOMER, 0, { body: "Router kaj kortese na" });
    await processIncomingMessage(m);
    await processIncomingMessage({ ...m, accountId: accountB.id, whatsappMessageId: `${m.whatsappMessageId}_b` });
    expect(await cases()).toHaveLength(1);
  });

  it("a redelivered message changes nothing", async () => {
    const m = msg(groupA, CUSTOMER, 0, { body: "Net slow" });
    await processIncomingMessage(m);
    await processIncomingMessage(m);
    const c = await onlyCase();
    expect(await events(c.id)).toHaveLength(1);
  });
});

describe("assignment and completion", () => {
  it("assigning notifies the employee by direct message, with the configured wording", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c = await onlyCase();
    await assign(c.id, hasan.id, min(3));
    const [n] = await notices(c.id);
    expect(n).toMatchObject({ type: "WHATSAPP", event: "SUPPORT_ASSIGNMENT", destination: `${hasan.phoneNumber}@c.us`, accountId: accountA.id, status: "PENDING" });
    const text = await inIsp(() => formatSupportAlert(n!.payload as Record<string, unknown>));
    expect(text).toContain("New Support Assignment");
    expect(text).toContain("ABC Broadband Support");
    expect(text).toContain("Internet nai");
    expect(text).toContain("10:03 AM");
    expect(text).toContain("10:18 AM"); // due: 15 minutes later
    expect((await events(c.id)).map((e) => e.type)).toEqual(["OPENED", "ASSIGNED", "NOTIFIED"]);
  });

  it("the assignee's reply after assignment completes the case, with the response time, and tells the admins", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(3));
    const reply = msg(groupA, hasan.phoneNumber, 10, { body: "Bhai ami check korchi, 5 min" });
    await processIncomingMessage(reply);
    const c = await onlyCase();
    const stored = await prisma.message.findFirstOrThrow({ where: { whatsappMessageId: reply.whatsappMessageId } });
    expect(c).toMatchObject({ status: "COMPLETED", responderMemberId: hasan.id, completionMessageId: stored.id, responseSeconds: 7 * 60 });
    expect(c.closedAt).not.toBeNull();
    const all = await notices(c.id);
    expect(all.map((n) => (n.payload as { templateKey: string }).templateKey)).toEqual(["SUPPORT_ASSIGNMENT_ASSIGNED", "SUPPORT_ASSIGNMENT_COMPLETED"]);
    expect(all[1]!.destination).toBe(`${admin.phoneNumber}@c.us`);
    expect(slaOutcome({ ...c, assignedAt: c.assignedAt!.getTime(), dueAt: c.dueAt!.getTime(), completedAt: c.completedAt!.getTime(), closedAt: c.closedAt!.getTime() })).toBe("MET");
  });

  it("a reply from somebody else does NOT complete it: the case closes as answered by someone else, uncredited", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(3));
    await send(groupA, borhan.phoneNumber, 5, "Line ta reset kore dilam");
    const c = await onlyCase();
    expect(c).toMatchObject({ status: "ANSWERED_BY_OTHER", responderMemberId: borhan.id, completedAt: null, responseSeconds: null });
    // Nobody is alerted about a customer who has been answered.
    await tick(60);
    expect((await notices(c.id)).map((n) => (n.payload as { templateKey: string }).templateKey)).toEqual(["SUPPORT_ASSIGNMENT_ASSIGNED"]);
  });

  it("a reply from the assignee sent BEFORE the assignment never completes it", async () => {
    // Karim is not in the Support Team, so his earlier message does not answer the wait either.
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, karim.id, min(10));
    await send(groupA, karim.phoneNumber, 5, "Dekhchi"); // recovered late, sent at +5
    expect((await onlyCase()).status).toBe("ASSIGNED");
    await send(groupA, karim.phoneNumber, 12, "Fixed it, please check now");
    expect((await onlyCase()).status).toBe("COMPLETED");
  });

  it("an assignee outside the Support Team still completes by replying (matching is by person, not Team)", async () => {
    await send(groupA, CUSTOMER, 0, "Bill koto?");
    const c0 = await onlyCase();
    await assign(c0.id, karim.id, min(1));
    await send(groupA, karim.phoneNumber, 4, "Apnar bill 1200 taka");
    expect(await onlyCase()).toMatchObject({ status: "COMPLETED", responderMemberId: karim.id, responseSeconds: 180 });
  });

  it("an assignee's bare 'ok' is not support: the case stays theirs until a real reply", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1));
    await send(groupA, hasan.phoneNumber, 2, "ok");
    expect((await onlyCase()).status).toBe("ASSIGNED");
    await send(groupA, hasan.phoneNumber, 6, "Router ta restart korun please");
    expect((await onlyCase()).status).toBe("COMPLETED");
  });

  it("an unassigned case answered by the team closes on its own", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    await send(groupA, borhan.phoneNumber, 2, "Dekhchi bhai");
    expect(await onlyCase()).toMatchObject({ status: "ANSWERED_BY_OTHER", assignedMemberId: null, responderMemberId: borhan.id });
  });

  it("after a case closes, the customer's next message opens a new one; a late old message opens nothing", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    await send(groupA, borhan.phoneNumber, 2, "Dekhchi bhai");
    await send(groupA, CUSTOMER, 1, "(recovered late) still nai"); // older than the closing reply
    expect(await cases()).toHaveLength(1);
    await send(groupA, CUSTOMER, 30, "Abar net chole gelo");
    const all = await cases();
    expect(all.map((c) => c.status)).toEqual(["ANSWERED_BY_OTHER", "UNASSIGNED"]);
  });
});

describe("SLA, overdue and escalation", () => {
  it("past its deadline (plus the grace minute) the case goes overdue once, alerting the manager group and admins once", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1)); // due +16
    await tick(16.5); // inside the grace minute
    expect((await onlyCase()).status).toBe("ASSIGNED");
    await tick(18);
    await tick(19);
    await tick(25);
    const c = await onlyCase();
    expect(c.status).toBe("OVERDUE");
    const overdue = (await notices(c.id)).filter((n) => (n.payload as { templateKey: string }).templateKey === "SUPPORT_ASSIGNMENT_OVERDUE");
    expect(overdue.map((n) => n.destination).sort()).toEqual([`${admin.phoneNumber}@c.us`, managerGroup.whatsappGroupId].sort());
    const text = await inIsp(() => formatSupportAlert(overdue[0]!.payload as Record<string, unknown>));
    expect(text).toContain("Hasan");
    expect(text).toContain("Overdue by: 2m 00s");
    expect((await events(c.id)).filter((e) => e.type === "OVERDUE")).toHaveLength(1);
  });

  it("escalates once, and never after the case is completed", async () => {
    await setSettings({ escalationEnabled: true, escalationAfterMinutes: 10 });
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1)); // due +16, overdue at +18, escalation at +28
    await tick(18);
    await tick(29);
    await tick(40);
    let c = await onlyCase();
    expect(c.escalationLevel).toBe(1);
    expect((await notices(c.id)).filter((n) => (n.payload as { templateKey: string }).templateKey === "SUPPORT_ASSIGNMENT_ESCALATED")).toHaveLength(1);

    // A second case: completed before its escalation time, so it never escalates.
    await send(groupA, hasan.phoneNumber, 41, "Done, check korun");
    await send(groupA, CUSTOMER, 50, "Abar problem");
    const second = (await cases())[1]!;
    await assign(second.id, hasan.id, min(51)); // due +66, overdue at +68, escalation at +78
    await tick(68);
    await send(groupA, hasan.phoneNumber, 70, "Fixed");
    await tick(90);
    c = await prisma.supportAssignment.findUniqueOrThrow({ where: { id: second.id } });
    expect(c).toMatchObject({ status: "COMPLETED", escalationLevel: 0, nextEscalationAt: null });
    expect((await notices(second.id)).some((n) => (n.payload as { templateKey: string }).templateKey === "SUPPORT_ASSIGNMENT_ESCALATED")).toBe(false);
  });

  it("a reply SENT before the deadline but arriving after the overdue mark still completes, and counts as on time", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1)); // due +16
    await tick(18); // overdue
    await send(groupA, hasan.phoneNumber, 15, "Restart korun"); // sent at +15, processed late
    const c = await onlyCase();
    expect(c.status).toBe("COMPLETED");
    expect(slaOutcome({ status: c.status, assignedAt: c.assignedAt!.getTime(), dueAt: c.dueAt!.getTime(), completedAt: c.completedAt!.getTime(), closedAt: c.closedAt!.getTime() })).toBe("MET");
  });

  it("reassigning an overdue case gives a fresh deadline, notifies the new person, and keeps the history", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1));
    await tick(18);
    await assign(c0.id, borhan.id, min(20), "REASSIGNED");
    let c = await onlyCase();
    expect(c).toMatchObject({ status: "ASSIGNED", assignedMemberId: borhan.id, assignmentRound: 2 });
    const reassigned = (await notices(c.id)).filter((n) => (n.payload as { templateKey: string }).templateKey === "SUPPORT_ASSIGNMENT_REASSIGNED");
    expect(reassigned.map((n) => n.destination)).toEqual([`${borhan.phoneNumber}@c.us`]);
    await send(groupA, borhan.phoneNumber, 25, "Fixed bhai");
    c = await onlyCase();
    expect(c).toMatchObject({ status: "COMPLETED", responderMemberId: borhan.id, responseSeconds: 5 * 60 });
    expect((await events(c.id)).map((e) => e.type)).toEqual(["OPENED", "ASSIGNED", "NOTIFIED", "OVERDUE", "NOTIFIED", "NOTIFIED", "REASSIGNED", "NOTIFIED", "COMPLETED", "NOTIFIED"]);
  });
});

describe("notification failures never fail the assignment", () => {
  it("an assignee with only a WhatsApp id is assigned, and the skipped message is recorded with the reason", async () => {
    await prisma.internalTeamMember.update({ where: { id: hasan.id }, data: { whatsappId: hasan.phoneNumber } });
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1));
    expect((await onlyCase()).status).toBe("ASSIGNED");
    expect(await notices(c0.id)).toHaveLength(0);
    const skipped = (await events(c0.id)).find((e) => e.type === "NOTIFY_SKIPPED");
    expect(skipped?.detail).toContain("no phone number");
  });

  it("muted in the Notification Center: nothing is queued, and the history says why", async () => {
    await prisma.notificationEventSetting.upsert({
      where: { projectId_event: { projectId: "proj_isp_digital", event: "SUPPORT_ASSIGNMENT" } },
      update: { enabled: false },
      create: { event: "SUPPORT_ASSIGNMENT", enabled: false },
    });
    try {
      await send(groupA, CUSTOMER, 0, "Internet nai");
      const c0 = await onlyCase();
      await assign(c0.id, hasan.id, min(1));
      expect(await notices(c0.id)).toHaveLength(0);
      expect((await events(c0.id)).find((e) => e.type === "NOTIFY_SKIPPED")?.detail).toContain("muted");
    } finally {
      await prisma.notificationEventSetting.deleteMany({ where: { event: "SUPPORT_ASSIGNMENT" } });
    }
  });
});

describe("the safety net", () => {
  it("a case whose wait was answered while the hook was not running is settled from the wait's own record", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    // As if the hook had failed: the episode is answered by Borhan, the case still says UNASSIGNED.
    await prisma.supportResponseEpisode.update({
      where: { id: c0.episodeId },
      data: { status: "ANSWERED", supportMemberId: borhan.id, supportRepliedAt: min(3), responseSeconds: 180, updatedAt: min(3) },
    });
    await tick(10);
    expect(await onlyCase()).toMatchObject({ status: "ANSWERED_BY_OTHER", responderMemberId: borhan.id });
  });

  it("a wait cleared on Messages → Unanswered groups cancels its case", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await prisma.supportResponseEpisode.update({ where: { id: c0.episodeId }, data: { status: "CLEARED", clearedAt: min(2), updatedAt: min(2) } });
    await tick(10);
    expect(await onlyCase()).toMatchObject({ status: "CANCELLED" });
  });
});

describe("project isolation", () => {
  it("another project's identical group and customer never touch this project's case", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const project = await createProjectWithDefaults(
      { name: `SA other ${randomUUID().slice(0, 6)}`, slug: `sa-other-${randomUUID().slice(0, 8)}`, status: "ACTIVE", creatorUserId: creatorId },
      rawPrisma,
    );
    otherProjects.push(project.id);
    await withProject(project.id, async () => {
      const acct = await prisma.whatsAppAccount.create({ data: { label: "Other", status: "CONNECTED" } });
      await prisma.whatsAppGroup.create({ data: { accountId: acct.id, whatsappGroupId: groupA.whatsappGroupId, name: "ABC Broadband Support", isActive: true } });
      await prisma.supportAssignmentSettings.create({ data: { id: "global", enabled: true } });
      const team = await prisma.team.create({ data: { name: "Support" } });
      await prisma.supportActivitySettings.upsert({ where: { id: "global" }, update: { responseTrackingTeamIds: [team.id] }, create: { id: "global", responseTrackingTeamIds: [team.id] } });
      await processIncomingMessage(msg({ ...groupA, accountId: acct.id }, CUSTOMER, 1, { body: "Amar o net nai" }));
      expect(await prisma.supportAssignment.count()).toBe(1);
    });
    const c = await onlyCase();
    expect(c.projectId).toBe("proj_isp_digital");
    expect(await prisma.supportAssignment.count({ where: { whatsappGroupId: groupA.whatsappGroupId } })).toBe(1);
  });
});

describe("guards that only a race or a late message reaches", () => {
  it("a case closed while its wait stays open: a late, older customer message opens nothing; a newer one opens a case", async () => {
    // Karim is not in the Support Team, so his reply completes the case without answering the wait.
    await send(groupA, CUSTOMER, 0, "Bill koto?");
    const c0 = await onlyCase();
    await assign(c0.id, karim.id, min(1));
    await send(groupA, karim.phoneNumber, 4, "Apnar bill 1200 taka");
    expect((await onlyCase()).status).toBe("COMPLETED");
    expect((await prisma.supportResponseEpisode.findUniqueOrThrow({ where: { id: c0.episodeId } })).status).toBe("UNANSWERED");
    await send(groupA, CUSTOMER, 3, "(recovered late) taka kivabe dibo?"); // sent before the completing reply
    expect(await cases()).toHaveLength(1);
    await send(groupA, CUSTOMER, 20, "Abar ekta problem");
    expect((await cases()).map((c) => c.status)).toEqual(["COMPLETED", "UNASSIGNED"]);
  });

  it("the loop's snapshot is stale — the case was completed after it was read: no overdue, no alert, no escalation", async () => {
    await setSettings({ escalationEnabled: true, escalationAfterMinutes: 10 });
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1));
    const snapshot = await prisma.supportAssignment.findUniqueOrThrow({
      where: { id: c0.id },
      select: { id: true, assignmentRound: true, slaMinutes: true, assignedMemberId: true, assignedMember: { select: { name: true } } },
    });
    await send(groupA, hasan.phoneNumber, 10, "Fixed, check korun");
    const settings = await prisma.supportAssignmentSettings.findUniqueOrThrow({ where: { id: "global" } });
    expect(await inIsp(() => markOneOverdue(snapshot, settings, min(20)))).toBe(false);
    expect(await inIsp(() => escalateOne(snapshot, settings, min(40)))).toBe(false);
    const c = await onlyCase();
    expect(c).toMatchObject({ status: "COMPLETED", overdueAt: null, escalationLevel: 0 });
    const kinds = (await notices(c.id)).map((n) => (n.payload as { templateKey: string }).templateKey);
    expect(kinds).toEqual(["SUPPORT_ASSIGNMENT_ASSIGNED", "SUPPORT_ASSIGNMENT_COMPLETED"]);
  });

  it("a stale snapshot from before a reassignment marks nothing overdue for the new owner", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1));
    const snapshot = await prisma.supportAssignment.findUniqueOrThrow({
      where: { id: c0.id },
      select: { id: true, assignmentRound: true, slaMinutes: true, assignedMemberId: true, assignedMember: { select: { name: true } } },
    });
    await assign(c0.id, borhan.id, min(17), "REASSIGNED");
    const settings = await prisma.supportAssignmentSettings.findUniqueOrThrow({ where: { id: "global" } });
    expect(await inIsp(() => markOneOverdue(snapshot, settings, min(18)))).toBe(false);
    expect(await onlyCase()).toMatchObject({ status: "ASSIGNED", assignedMemberId: borhan.id, overdueAt: null });
  });

  it("queueing the same notifications twice sends them once", async () => {
    await send(groupA, CUSTOMER, 0, "Internet nai");
    const c0 = await onlyCase();
    await assign(c0.id, hasan.id, min(1));
    const settings = await prisma.supportAssignmentSettings.findUniqueOrThrow({ where: { id: "global" } });
    const again = await inIsp(() =>
      prisma.$transaction(async (tx) =>
        queueSupportAssignmentNotices(tx, await buildSupportAssignmentNotices(tx, { assignmentId: c0.id, kind: "ASSIGNED", settings, now: min(1) })),
      ),
    );
    expect(again).toEqual({ queued: 0, skipped: 0 });
    expect(await notices(c0.id)).toHaveLength(1);
    expect((await events(c0.id)).filter((e) => e.type === "NOTIFIED")).toHaveLength(1);
  });
});

