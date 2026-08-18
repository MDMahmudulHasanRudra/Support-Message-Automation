import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@support-automation/db";
import type { AutomationSettings, SupportActivitySettings, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";

/**
 * Covers Support Activity Tracking's message-pipeline integration: the feature's own
 * enable/disable gate, its cheap-filter-first guards (group message? team member?), keyword-match
 * detection, idempotent duplicate protection, and multi-account isolation. Same real-Postgres,
 * uniquely-identified-fixtures-with-cleanup convention as the other integration suites in this
 * directory — see pipeline.integration.test.ts's own doc comment for why.
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

async function makeKeyword(value: string) {
  const keyword = await prisma.supportKeyword.create({ data: { value, isActive: true } });
  createdKeywordIds.push(keyword.id);
  return keyword;
}

async function makeRule(
  keywordIdsOrOpts: string[] | { keywordIds?: string[]; triggerType?: "KEYWORD_MATCH" | "REPLY_TO_CUSTOMER" | "MENTION" },
) {
  const opts = Array.isArray(keywordIdsOrOpts) ? { keywordIds: keywordIdsOrOpts } : keywordIdsOrOpts;
  const rule = await prisma.supportRule.create({
    data: {
      name: `Test Rule ${randomUUID()}`,
      isActive: true,
      appliesToAllGroups: true,
      appliesToAllTeamMembers: true,
      triggerType: opts.triggerType ?? "KEYWORD_MATCH",
      keywords: { create: (opts.keywordIds ?? []).map((keywordId) => ({ keywordId })) },
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
  account = await prisma.whatsAppAccount.create({ data: { label: `Support Activity Test ${randomUUID()}`, status: "CONNECTED" } });
  group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueGroupJid(), name: "Test Support Group", lastSyncedAt: new Date() },
  });
});

afterEach(async () => {
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
  extra: { quotedWhatsappMessageId?: string; mentionedPhones?: string[] } = {},
) {
  const whatsappMessageId = randomUUID();
  await processIncomingMessage({
    accountId: account.id,
    whatsappMessageId,
    chatId: group.whatsappGroupId,
    whatsappGroupId: group.whatsappGroupId,
    senderPhone,
    direction: "INCOMING",
    body,
    timestampWa: new Date(),
    ...extra,
  });
  return whatsappMessageId;
}

describe("Support Activity Tracking — feature disabled (default)", () => {
  it("creates no SupportActivity row when the feature is disabled, and the message still processes normally", async () => {
    await setSupportActivityEnabled(false);
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("done")).id]);

    await sendGroupMessage(member.phoneNumber, "done");

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    expect(message.processingStatus).toBeDefined();
  });
});

describe("Support Activity Tracking — cheap-filter guards", () => {
  it("ignores a non-group (DM) message even from a team member with a matching keyword", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("done")).id]);

    await processIncomingMessage({
      accountId: account.id,
      whatsappMessageId: randomUUID(),
      chatId: member.phoneNumber,
      senderPhone: member.phoneNumber,
      direction: "INCOMING",
      body: "done",
      timestampWa: new Date(),
    });

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("ignores a group message from a non-team-member, even with a matching keyword", async () => {
    await makeRule([(await makeKeyword("done")).id]);
    await sendGroupMessage(uniquePhone(), "done");

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("does not match unrelated text from an active support member", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("done")).id]);

    await sendGroupMessage(member.phoneNumber, "just chatting, nothing to report");

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe("Support Activity Tracking — detection", () => {
  it("creates exactly one SupportActivity row for a real keyword match from a support member", async () => {
    const member = await makeTeamMember(uniquePhone());
    const keyword = await makeKeyword("done");
    const rule = await makeRule([keyword.id]);

    await sendGroupMessage(member.phoneNumber, "Issue is Done now");

    const activity = await prisma.supportActivity.findFirstOrThrow({ where: { accountId: account.id } });
    expect(activity.groupId).toBe(group.id);
    expect(activity.teamMemberId).toBe(member.id);
    expect(activity.ruleId).toBe(rule.id);
    expect(activity.keywordId).toBe(keyword.id);
  });

  it("does not block or alter normal rule evaluation / message processing", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("done")).id]);

    await sendGroupMessage(member.phoneNumber, "done");

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    // The pipeline must still run to completion for a message the detector also inspects.
    expect(await prisma.automationExecution.count({ where: { messageId: message.id } })).toBe(1);
  });
});

describe("Support Activity Tracking — REPLY_TO_CUSTOMER trigger", () => {
  it("creates an activity when a support member's message quotes a real customer message", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule({ triggerType: "REPLY_TO_CUSTOMER" });

    const customerMessageId = await sendGroupMessage(uniquePhone(), "my internet is not working");
    await sendGroupMessage(member.phoneNumber, "fixed now, please check", {
      quotedWhatsappMessageId: customerMessageId,
    });

    const activity = await prisma.supportActivity.findFirstOrThrow({ where: { accountId: account.id } });
    expect(activity.teamMemberId).toBe(member.id);
    expect(activity.keywordId).toBeNull();
  });

  it("does not fire when the quoted message is from another team member, not a customer", async () => {
    const memberA = await makeTeamMember(uniquePhone());
    const memberB = await makeTeamMember(uniquePhone());
    await makeRule({ triggerType: "REPLY_TO_CUSTOMER" });

    const internalMessageId = await sendGroupMessage(memberA.phoneNumber, "handling this one");
    await sendGroupMessage(memberB.phoneNumber, "ok, on it", { quotedWhatsappMessageId: internalMessageId });

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("does not fire on an ordinary message with no quoted reference", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule({ triggerType: "REPLY_TO_CUSTOMER" });

    await sendGroupMessage(member.phoneNumber, "just a regular message");

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe("Support Activity Tracking — MENTION trigger", () => {
  it("creates an activity when a support member @-mentions a customer", async () => {
    const member = await makeTeamMember(uniquePhone());
    const customerPhone = uniquePhone();
    await makeRule({ triggerType: "MENTION" });

    await sendGroupMessage(member.phoneNumber, "@customer please confirm", { mentionedPhones: [customerPhone] });

    const activity = await prisma.supportActivity.findFirstOrThrow({ where: { accountId: account.id } });
    expect(activity.teamMemberId).toBe(member.id);
    expect(activity.keywordId).toBeNull();
  });

  it("does not fire when only another team member is mentioned", async () => {
    const member = await makeTeamMember(uniquePhone());
    const otherMember = await makeTeamMember(uniquePhone());
    await makeRule({ triggerType: "MENTION" });

    await sendGroupMessage(member.phoneNumber, "@teammate can you take this?", {
      mentionedPhones: [otherMember.phoneNumber],
    });

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("does not fire when nobody is mentioned", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule({ triggerType: "MENTION" });

    await sendGroupMessage(member.phoneNumber, "no mentions here");

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe("Support Activity Tracking — idempotency", () => {
  it("never creates a second SupportActivity row when the same WhatsApp event is reprocessed", async () => {
    const member = await makeTeamMember(uniquePhone());
    await makeRule([(await makeKeyword("done")).id]);

    const whatsappMessageId = randomUUID();
    const raw = {
      accountId: account.id,
      whatsappMessageId,
      chatId: group.whatsappGroupId,
      whatsappGroupId: group.whatsappGroupId,
      senderPhone: member.phoneNumber,
      direction: "INCOMING" as const,
      body: "done",
      timestampWa: new Date(),
    };

    await processIncomingMessage(raw);
    await processIncomingMessage(raw); // simulates a redelivered/duplicate provider event

    expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(1);
  });
});

describe("Support Activity Tracking — multi-account isolation", () => {
  it("never lets one account's activity appear when querying scoped to a different account", async () => {
    const otherAccount = await prisma.whatsAppAccount.create({ data: { label: `Other Account ${randomUUID()}`, status: "CONNECTED" } });
    try {
      const member = await makeTeamMember(uniquePhone());
      await makeRule([(await makeKeyword("done")).id]);
      await sendGroupMessage(member.phoneNumber, "done");

      expect(await prisma.supportActivity.count({ where: { accountId: account.id } })).toBe(1);
      expect(await prisma.supportActivity.count({ where: { accountId: otherAccount.id } })).toBe(0);
    } finally {
      await prisma.whatsAppAccount.delete({ where: { id: otherAccount.id } });
    }
  });
});
