import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type {
  AutomationSettings,
  Prisma,
  SupportEscalationSettings,
  WhatsAppAccount,
  WhatsAppGroup,
  WhatsAppServiceRoute,
} from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { processOneCase } from "../escalation/escalationQueue.js";

/**
 * Covers Priority-Based Support Monitoring & Escalation's state machine
 * (case open/continue, tier progression, idempotent duplicate-notification
 * protection, kill switch, maxEscalations cap) and its two integration
 * points into the message pipeline (opening a case, human-reply detection).
 * Same real-Postgres-instance convention as the other integration suites in
 * this directory — see pipeline.integration.test.ts's own doc comment.
 */

let originalSettings: AutomationSettings;
let originalEscalationSettings: SupportEscalationSettings;
let originalPrioritySupportRoute: WhatsAppServiceRoute | null;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
const createdTeamMemberIds: string[] = [];
let preExistingActiveRuleIds: string[] = [];

/**
 * Digits only, unlike other suites' hex-based uniquePhone() helpers — this file's phone numbers
 * get run through normalizePhoneNumber() (for real, in escalationQueue.ts's DM-sending code), so
 * a hex letter being stripped as non-digit here could flakily drop below the 8-digit minimum.
 */
function uniquePhone(): string {
  return `+8809${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

async function resetAutomationSettings(overrides: Partial<Prisma.AutomationSettingsUpdateInput> = {}) {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: { automationEnabled: true, rateLimitingEnabled: false, whatsappNotificationGroupIds: ["escalation-alerts@g.us"], ...overrides },
  });
}

async function resetEscalationSettings(overrides: Partial<Prisma.SupportEscalationSettingsUncheckedUpdateInput> = {}) {
  await prisma.supportEscalationSettings.update({
    where: { id: "global" },
    data: { enabled: true, escalationAdminId: null, ...overrides },
  });
}

/** Instant SLA for deterministic tests — no real waiting between tiers. */
async function makeInstantPolicy(maxEscalations = 5) {
  await prisma.supportPriorityPolicy.upsert({
    where: { priority: "P1" },
    update: { firstAlertMinutes: 0, secondAlertMinutes: 0, memberEscalationMinutes: 0, adminEscalationMinutes: 0, followUpIntervalMinutes: 0, maxEscalations },
    create: { priority: "P1", firstAlertMinutes: 0, secondAlertMinutes: 0, memberEscalationMinutes: 0, adminEscalationMinutes: 0, followUpIntervalMinutes: 0, maxEscalations },
  });
}

async function makeTeamMember(phoneNumber: string) {
  const member = await prisma.internalTeamMember.create({
    data: { name: "Test Member", phoneNumber, role: "Support", status: "ACTIVE" },
  });
  createdTeamMemberIds.push(member.id);
  return member;
}

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalEscalationSettings = await prisma.supportEscalationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalPrioritySupportRoute = await prisma.whatsAppServiceRoute.findUnique({ where: { serviceKey: "PRIORITY_SUPPORT" } });

  preExistingActiveRuleIds = (await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map((r) => r.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }
});

afterAll(async () => {
  await prisma.automationSettings.update({ where: { id: "global" }, data: originalSettings as unknown as Prisma.AutomationSettingsUpdateInput });
  await prisma.supportEscalationSettings.update({
    where: { id: "global" },
    data: originalEscalationSettings as unknown as Prisma.SupportEscalationSettingsUncheckedUpdateInput,
  });
  if (originalPrioritySupportRoute) {
    await prisma.whatsAppServiceRoute.update({
      where: { serviceKey: "PRIORITY_SUPPORT" },
      data: originalPrioritySupportRoute as unknown as Prisma.WhatsAppServiceRouteUncheckedUpdateInput,
    });
  } else {
    await prisma.whatsAppServiceRoute.deleteMany({ where: { serviceKey: "PRIORITY_SUPPORT" } });
  }
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "ACTIVE" } });
  }
});

beforeEach(async () => {
  await resetAutomationSettings();
  await resetEscalationSettings();
  await makeInstantPolicy();
  account = await prisma.whatsAppAccount.create({
    data: { label: `Escalation Test Account ${randomUUID()}`, status: "CONNECTED" },
  });
  // processOneCase() now resolves a WhatsApp account via resolveWhatsAppAccount() before firing
  // any tier (multi-account routing) — point PRIORITY_SUPPORT explicitly at this test's own
  // account rather than marking it globally Primary. This suite runs against the same shared dev
  // Postgres instance the real worker/dashboard use (see this file's own doc comment), and only
  // one row in the whole database may ever be Primary — mutating that global singleton per test
  // would collide with whatever the real running system has already promoted. A dedicated,
  // per-service route has no such global uniqueness constraint, so it's the safe knob to touch.
  await prisma.whatsAppServiceRoute.upsert({
    where: { serviceKey: "PRIORITY_SUPPORT" },
    update: { accountId: account.id, fallbackPolicy: "STRICT_NO_FALLBACK", enabled: true },
    create: { serviceKey: "PRIORITY_SUPPORT", accountId: account.id, fallbackPolicy: "STRICT_NO_FALLBACK", enabled: true },
  });
  group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "VIP Clients", priority: "P1", lastSyncedAt: new Date() },
  });
});

afterEach(async () => {
  await prisma.notification.deleteMany({ where: { relatedMessage: { accountId: account.id } } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }); // cascades WhatsAppGroup -> SupportEscalationCase -> SupportEscalationEvent

  if (createdTeamMemberIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: createdTeamMemberIds } } });
    createdTeamMemberIds.length = 0;
  }
});

async function sendCustomerMessage(body = "internet not working") {
  const phone = uniquePhone();
  await processIncomingMessage({
    accountId: account.id,
    whatsappMessageId: randomUUID(),
    chatId: group.whatsappGroupId,
    whatsappGroupId: group.whatsappGroupId,
    senderPhone: phone,
    direction: "INCOMING",
    body,
    timestampWa: new Date(),
  });
  return phone;
}

describe("Scenario 1: opening a case", () => {
  it("opens a case the moment a customer messages a P1 group", async () => {
    await sendCustomerMessage();

    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });
    expect(caseRow.priority).toBe("P1");
    expect(caseRow.status).toBe("NEW");
    expect(caseRow.escalationLevel).toBe(0);
    expect(caseRow.nextCheckAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("does not open a case for a group with no priority assigned", async () => {
    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { priority: null } });
    await sendCustomerMessage();
    expect(await prisma.supportEscalationCase.count({ where: { groupId: group.id } })).toBe(0);
  });

  it("does not open a case when escalationMonitoringEnabled is off, even with a priority set", async () => {
    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { escalationMonitoringEnabled: false } });
    await sendCustomerMessage();
    expect(await prisma.supportEscalationCase.count({ where: { groupId: group.id } })).toBe(0);
  });

  it("continues the existing case instead of opening a duplicate for a second customer message", async () => {
    await sendCustomerMessage("first message");
    const first = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });

    await sendCustomerMessage("still waiting, please help");
    expect(await prisma.supportEscalationCase.count({ where: { groupId: group.id } })).toBe(1);

    const after = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: first.id } });
    expect(after.lastCustomerMessageAt.getTime()).toBeGreaterThanOrEqual(first.lastCustomerMessageAt.getTime());
  });
});

describe("Scenario 2: human reply stops escalation", () => {
  it("marks the case HUMAN_REPLIED and stops further processing once an active team member replies in-chat", async () => {
    await sendCustomerMessage();
    const teamPhone = uniquePhone();
    await makeTeamMember(teamPhone);

    await processIncomingMessage({
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: teamPhone,
      direction: "INCOMING",
      body: "On it, looking now.",
      timestampWa: new Date(),
    });

    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });
    expect(caseRow.status).toBe("HUMAN_REPLIED");
    expect(caseRow.humanRepliedAt).not.toBeNull();

    const event = await prisma.supportEscalationEvent.findFirstOrThrow({ where: { caseId: caseRow.id, eventType: "HUMAN_REPLIED" } });
    expect(event.recipientType).toBe("SYSTEM");

    const handled = await processOneCase();
    // Nothing left due for THIS case — a HUMAN_REPLIED case is excluded from the active-status claim set.
    const stillHumanReplied = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(stillHumanReplied.status).toBe("HUMAN_REPLIED");
    expect(stillHumanReplied.escalationLevel).toBe(0);
    void handled;
  });
});

describe("Scenario 3: tier progression", () => {
  it("fires FIRST_NOTIFICATION to every configured group and advances to WAITING_FOR_HUMAN", async () => {
    await sendCustomerMessage();
    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });

    const handled = await processOneCase();
    expect(handled).toBe(true);

    const updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.status).toBe("WAITING_FOR_HUMAN");
    expect(updated.escalationLevel).toBe(1);

    const events = await prisma.supportEscalationEvent.findMany({ where: { caseId: caseRow.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("FIRST_NOTIFICATION");
    expect(events[0]!.recipientType).toBe("GROUP");
    expect(events[0]!.recipientKey).toBe("escalation-alerts@g.us");
    expect(events[0]!.notificationId).not.toBeNull();

    const notification = await prisma.notification.findUniqueOrThrow({ where: { id: events[0]!.notificationId! } });
    expect(notification.type).toBe("WHATSAPP");
    expect(notification.destination).toBe("escalation-alerts@g.us");
  });

  it("progresses through member and admin tiers using each recipient's WhatsApp contact id", async () => {
    const member = await makeTeamMember(uniquePhone());
    const admin = await makeTeamMember(uniquePhone());
    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { assignedTeamMemberId: member.id } });
    await resetEscalationSettings({ escalationAdminId: admin.id });

    await sendCustomerMessage();
    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });

    await processOneCase(); // FIRST_NOTIFICATION -> WAITING_FOR_HUMAN
    await processOneCase(); // SECOND_NOTIFICATION -> SECOND_ALERT
    await processOneCase(); // MEMBER_NOTIFICATION -> MEMBER_ESCALATED

    let updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.status).toBe("MEMBER_ESCALATED");
    expect(updated.escalationLevel).toBe(3);

    const memberEvent = await prisma.supportEscalationEvent.findFirstOrThrow({
      where: { caseId: caseRow.id, eventType: "MEMBER_NOTIFICATION" },
    });
    expect(memberEvent.recipientKey).toBe(member.id);
    const memberNotification = await prisma.notification.findUniqueOrThrow({ where: { id: memberEvent.notificationId! } });
    expect(memberNotification.destination).toBe(`${member.phoneNumber.replace(/\D/g, "")}@c.us`);

    await processOneCase(); // ADMIN_NOTIFICATION -> ADMIN_ESCALATED
    updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.status).toBe("ADMIN_ESCALATED");
    expect(updated.escalationLevel).toBe(4);

    const adminEvent = await prisma.supportEscalationEvent.findFirstOrThrow({
      where: { caseId: caseRow.id, eventType: "ADMIN_NOTIFICATION" },
    });
    expect(adminEvent.recipientKey).toBe(admin.id);

    await processOneCase(); // FOLLOW_UP -> FOLLOW_UP (repeats)
    updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.status).toBe("FOLLOW_UP");
    expect(updated.escalationLevel).toBe(5);
  });

  it("skips a tier with no configured recipient but still advances state", async () => {
    // No assigned member, no escalation admin configured on purpose.
    await sendCustomerMessage();
    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });

    await processOneCase(); // FIRST_NOTIFICATION
    await processOneCase(); // SECOND_NOTIFICATION
    await processOneCase(); // member tier: no assigned member -> skipped, still advances

    const updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.status).toBe("MEMBER_ESCALATED");
    const memberEvents = await prisma.supportEscalationEvent.count({ where: { caseId: caseRow.id, eventType: "MEMBER_NOTIFICATION" } });
    expect(memberEvents).toBe(0); // nothing to send, nothing recorded — but the state machine didn't get stuck
  });
});

describe("Scenario 4: duplicate-notification protection", () => {
  it("never double-fires the same tier+recipient, and self-heals the state transition if a previous tick crashed after firing but before advancing", async () => {
    await sendCustomerMessage();
    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });

    // Simulate: a prior tick already recorded the FIRST_NOTIFICATION event (and its Notification)
    // but crashed before updating case.status/escalationLevel — the case is still sitting in NEW.
    // relatedMessageId is set so this row is swept by afterEach's cleanup like a real one would be.
    const notification = await prisma.notification.create({
      data: { type: "WHATSAPP", destination: "escalation-alerts@g.us", payload: {}, relatedMessageId: caseRow.triggerMessageId },
    });
    await prisma.supportEscalationEvent.create({
      data: {
        caseId: caseRow.id,
        level: 0,
        eventType: "FIRST_NOTIFICATION",
        recipientType: "GROUP",
        recipientKey: "escalation-alerts@g.us",
        recipientLabel: "escalation-alerts@g.us",
        notificationId: notification.id,
      },
    });

    await processOneCase();

    const events = await prisma.supportEscalationEvent.findMany({ where: { caseId: caseRow.id, eventType: "FIRST_NOTIFICATION" } });
    expect(events).toHaveLength(1); // no duplicate row, no duplicate Notification
    // Scoped to this case's trigger message, not a bare destination-string count, so this
    // assertion can never be polluted by another test/run's rows sharing the same destination.
    expect(await prisma.notification.count({ where: { relatedMessageId: caseRow.triggerMessageId } })).toBe(1);

    const updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.status).toBe("WAITING_FOR_HUMAN"); // still advanced despite the tier already being "sent"
    expect(updated.escalationLevel).toBe(1);
  });
});

describe("Scenario 5: kill switch and maxEscalations cap", () => {
  it("defers a due case without acting when the feature is disabled", async () => {
    await sendCustomerMessage();
    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });
    await resetEscalationSettings({ enabled: false });

    await processOneCase();

    expect(await prisma.supportEscalationEvent.count({ where: { caseId: caseRow.id } })).toBe(0);
    const updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.status).toBe("NEW");
    expect(updated.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("stops firing once maxEscalations is reached, without erroring", async () => {
    await makeInstantPolicy(1); // cap at 1 total escalation
    await sendCustomerMessage();
    const caseRow = await prisma.supportEscalationCase.findFirstOrThrow({ where: { groupId: group.id } });

    await processOneCase(); // fires the one allowed escalation, level -> 1
    let updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.escalationLevel).toBe(1);

    await prisma.supportEscalationCase.update({ where: { id: caseRow.id }, data: { nextCheckAt: new Date() } });
    await processOneCase(); // at the cap now — must defer, not fire a second notification

    const eventsAfterCap = await prisma.supportEscalationEvent.count({ where: { caseId: caseRow.id } });
    expect(eventsAfterCap).toBe(1);
    updated = await prisma.supportEscalationCase.findUniqueOrThrow({ where: { id: caseRow.id } });
    expect(updated.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });
});
