import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, SupportActivitySettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";

/**
 * Covers support-session tracking (apps/worker/src/supportActivity/sessionTracker.ts): group-level
 * open/close lifecycle, multi-group independence, completion-keyword-with-no-open-session as a
 * no-op, redelivery idempotency, and concurrent-open-race safety via the openGroupId unique
 * constraint. Same real-Postgres, uniquely-identified-fixtures-with-cleanup convention as
 * supportActivity.integration.test.ts (see that file's own doc comment for why) — deliberately a
 * sibling file, not an extension of it, since it exercises a materially different lifecycle
 * (session open/close) on top of the same detection pipeline.
 */

let originalSettings: AutomationSettings;
let originalSupportActivitySettings: SupportActivitySettings;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
let preExistingActiveRuleIds: string[] = [];
const createdTeamMemberIds: string[] = [];
const createdKeywordIds: string[] = [];
const createdRuleIds: string[] = [];

function uniquePhone(): string {
  return `+8809${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
}

function uniqueGroupJid(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-1234567890@g.us`;
}

async function resetAutomationSettings() {
  await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: true } });
}

async function setSupportActivityEnabled(enabled: boolean) {
  await prisma.supportActivitySettings.update({ where: { id: "global" }, data: { enabled } });
}

async function makeTeamMember(phoneNumber: string) {
  const member = await prisma.internalTeamMember.create({
    data: { name: "Test Support Member", phoneNumber, role: "Support", status: "ACTIVE" },
  });
  createdTeamMemberIds.push(member.id);
  return member;
}

async function makeKeyword(value: string, opts: { marksCompletion?: boolean } = {}) {
  const keyword = await prisma.supportKeyword.create({
    data: { value, isActive: true, marksCompletion: opts.marksCompletion ?? false },
  });
  createdKeywordIds.push(keyword.id);
  return keyword;
}

async function makeRule(keywordIds: string[]) {
  const rule = await prisma.supportRule.create({
    data: {
      name: `Test Session Rule ${randomUUID()}`,
      isActive: true,
      appliesToAllGroups: true,
      appliesToAllTeamMembers: true,
      triggerType: "KEYWORD_MATCH",
      keywords: { create: keywordIds.map((keywordId) => ({ keywordId })) },
    },
  });
  createdRuleIds.push(rule.id);
  return rule;
}

beforeAll(async () => {
  originalSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalSupportActivitySettings = await prisma.supportActivitySettings.upsert({
    where: { id: "global" },
    update: {},
    create: { id: "global" },
  });

  preExistingActiveRuleIds = (await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map(
    (r) => r.id,
  );
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }
});

afterAll(async () => {
  await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: originalSettings.automationEnabled } });
  await prisma.supportActivitySettings.update({
    where: { id: "global" },
    data: { enabled: originalSupportActivitySettings.enabled },
  });
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "ACTIVE" } });
  }
});

beforeEach(async () => {
  await resetAutomationSettings();
  await setSupportActivityEnabled(true);
  account = await prisma.whatsAppAccount.create({ data: { label: `Support Session Test ${randomUUID()}`, status: "CONNECTED" } });
  group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Test Support Group", lastSyncedAt: new Date() },
  });
});

afterEach(async () => {
  await prisma.supportSession.deleteMany({ where: { accountId: account.id } });
  await prisma.supportActivity.deleteMany({ where: { accountId: account.id } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }); // cascades WhatsAppGroup

  if (createdRuleIds.length) {
    await prisma.supportRule.deleteMany({ where: { id: { in: createdRuleIds } } });
    createdRuleIds.length = 0;
  }
  if (createdKeywordIds.length) {
    await prisma.supportKeyword.deleteMany({ where: { id: { in: createdKeywordIds } } });
    createdKeywordIds.length = 0;
  }
  if (createdTeamMemberIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: createdTeamMemberIds } } });
    createdTeamMemberIds.length = 0;
  }
});

async function sendGroupMessage(
  senderPhone: string,
  body: string,
  extra: { targetGroup?: WhatsAppGroup } = {},
) {
  const targetGroup = extra.targetGroup ?? group;
  const whatsappMessageId = randomUUID();
  await processIncomingMessage({
    accountId: account.id,
    whatsappMessageId,
    chatId: targetGroup.whatsappGroupId,
    whatsappGroupId: targetGroup.whatsappGroupId,
    senderPhone,
    direction: "INCOMING",
    body,
    timestampWa: new Date(),
  });
  return whatsappMessageId;
}

describe("Support Sessions — open lifecycle", () => {
  it("opens a session on the first team-member activity in a group with no open session", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("update")).id]);

    await sendGroupMessage(member.phoneNumber, "here is an update on the issue");

    const session = await prisma.supportSession.findFirstOrThrow({ where: { accountId: account.id } });
    expect(session.status).toBe("OPEN");
    expect(session.groupId).toBe(group.id);
    expect(session.startedByTeamMemberId).toBe(member.id);
    expect(session.openGroupId).toBe(group.id);
    expect(session.completedAt).toBeNull();
    expect(session.durationSeconds).toBeNull();
  });

  it("does not open a second session for a non-completion activity in an already-open group", async () => {
    const memberA = await makeTeamMember(uniquePhone());
    const memberB = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("update")).id]);

    await sendGroupMessage(memberA.phoneNumber, "here is an update");
    await sendGroupMessage(memberB.phoneNumber, "another update from me too");

    expect(await prisma.supportSession.count({ where: { accountId: account.id } })).toBe(1);
    const session = await prisma.supportSession.findFirstOrThrow({ where: { accountId: account.id } });
    // Attribution never changes once opened — only the first activity's sender sets this.
    expect(session.startedByTeamMemberId).toBe(memberA.id);
  });
});

describe("Support Sessions — completion (group-level, any member can close)", () => {
  it("closes the open session when a marksCompletion keyword fires, crediting whoever sent it", async () => {
    const opener = await makeTeamMember(uniquePhone());
    const closer = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("update")).id, (await makeKeyword("done", { marksCompletion: true })).id]);

    await sendGroupMessage(opener.phoneNumber, "here is an update");
    await sendGroupMessage(closer.phoneNumber, "all done");

    const session = await prisma.supportSession.findFirstOrThrow({ where: { accountId: account.id } });
    expect(session.status).toBe("COMPLETED");
    expect(session.startedByTeamMemberId).toBe(opener.id);
    expect(session.completedByTeamMemberId).toBe(closer.id);
    expect(session.openGroupId).toBeNull();
    expect(session.completedAt).not.toBeNull();
    expect(session.durationSeconds).not.toBeNull();
    expect(session.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("opens a fresh session after a prior one in the same group has completed", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("update")).id, (await makeKeyword("done", { marksCompletion: true })).id]);

    await sendGroupMessage(member.phoneNumber, "update one");
    await sendGroupMessage(member.phoneNumber, "done");
    await sendGroupMessage(member.phoneNumber, "update two, new issue");

    expect(await prisma.supportSession.count({ where: { accountId: account.id } })).toBe(2);
    const open = await prisma.supportSession.findFirstOrThrow({ where: { accountId: account.id, status: "OPEN" } });
    expect(open.openGroupId).toBe(group.id);
  });

  it("is a no-op when a completion keyword fires with no open session for that group", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("done", { marksCompletion: true })).id]);

    // No prior activity opened a session for this group — a stray "done" should just record the
    // SupportActivity normally and touch no SupportSession.
    await sendGroupMessage(member.phoneNumber, "done");

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prisma.supportSession.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe("Support Sessions — redelivery idempotency", () => {
  it("does not double-act on session state when the same messageId is reprocessed", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("starting")).id, (await makeKeyword("done", { marksCompletion: true })).id]);

    const openWhatsappMessageId = randomUUID();
    const openRaw = {
      accountId: account.id,
      whatsappMessageId: openWhatsappMessageId,
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: member.phoneNumber,
      direction: "INCOMING" as const,
      body: "starting work on this",
      timestampWa: new Date(),
    };
    await processIncomingMessage(openRaw);
    await processIncomingMessage(openRaw); // redelivered open — must not create a second session

    expect(await prisma.supportSession.count({ where: { accountId: account.id } })).toBe(1);

    const closeWhatsappMessageId = randomUUID();
    const closeRaw = {
      accountId: account.id,
      whatsappMessageId: closeWhatsappMessageId,
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: member.phoneNumber,
      direction: "INCOMING" as const,
      body: "done",
      timestampWa: new Date(),
    };
    await processIncomingMessage(closeRaw);
    await processIncomingMessage(closeRaw); // redelivered close — must not re-close / recompute

    const session = await prisma.supportSession.findFirstOrThrow({ where: { accountId: account.id } });
    expect(session.status).toBe("COMPLETED");
  });
});

describe("Support Sessions — multi-group independence", () => {
  it("lets many groups each have their own OPEN session at the same time", async () => {
    const groupB = await prisma.whatsAppGroup.create({
      data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Test Support Group B", lastSyncedAt: new Date() },
    });
    const groupC = await prisma.whatsAppGroup.create({
      data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Test Support Group C", lastSyncedAt: new Date() },
    });

    const rahim = await makeTeamMember(uniquePhone());
    const karim = await makeTeamMember(uniquePhone());
    const salam = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("update")).id]);

    await sendGroupMessage(rahim.phoneNumber, "update", { targetGroup: group });
    await sendGroupMessage(karim.phoneNumber, "update", { targetGroup: groupB });
    await sendGroupMessage(salam.phoneNumber, "update", { targetGroup: groupC });

    const openSessions = await prisma.supportSession.findMany({ where: { accountId: account.id, status: "OPEN" } });
    expect(openSessions).toHaveLength(3);
    expect(new Set(openSessions.map((s) => s.groupId))).toEqual(new Set([group.id, groupB.id, groupC.id]));
  });

  it("only ever allows one OPEN session per group, even under concurrent opens", async () => {
    const memberA = await makeTeamMember(uniquePhone());
    const memberB = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("update")).id]);

    await Promise.all([
      sendGroupMessage(memberA.phoneNumber, "update from A"),
      sendGroupMessage(memberB.phoneNumber, "update from B"),
    ]);

    expect(await prisma.supportSession.count({ where: { accountId: account.id, status: "OPEN" } })).toBe(1);
  });
});
