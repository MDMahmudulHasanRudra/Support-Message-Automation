import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, createAiFallbackDecision } from "@support-automation/db";
import type { AiSettings, AutomationSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { checkAiFallbackEligibility } from "../aiFallback/eligibility.js";
import { parseFallbackResponse } from "../aiFallback/prompt.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * Integration tests for the Hybrid AI Automation fallback layer (apps/worker/src/aiFallback/).
 * Run against the isolated postgres-test database (see README.md's testing section) — every AI
 * call is mocked via MockAiClient, injected through processIncomingMessage's test-only
 * `aiClientOverride` parameter, never a real Anthropic call. Because processIncomingMessage()
 * loads ALL active rules globally (packages/engine's evaluate() has no per-test scoping), this
 * suite disables any pre-existing active rules for its duration and restores them afterward — the
 * same defensive pattern pipeline.integration.test.ts already uses.
 */

let originalAutomationSettings: AutomationSettings;
let originalAiSettings: AiSettings;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
let preExistingActiveRuleIds: string[] = [];
const createdTeamMemberIds: string[] = [];
const createdGroupIds: string[] = [];

function uniquePhone(): string {
  return `+8809${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function uniqueChatId(): string {
  return `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;
}

async function resetAutomationSettings(overrides: Partial<Prisma.AutomationSettingsUpdateInput> = {}) {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: {
      automationEnabled: true,
      mode: "SAFE_AUTO_REPLY",
      rateLimitingEnabled: true,
      maxRepliesPerClientPerHour: 100,
      maxRepliesPerClientPerDay: 1000,
      globalMaxPerMinute: 100,
      globalMaxPerHour: 1000,
      globalMaxPerDay: 10000,
      defaultReplyDelayMinMs: 0,
      defaultReplyDelayMaxMs: 0,
      teamsWebhookUrl: "https://example.invalid/webhook",
      whatsappNotificationGroupIds: [],
      ...overrides,
    },
  });
}

async function resetAiSettings(overrides: Partial<AiSettings> = {}) {
  await prisma.aiSettings.update({
    where: { id: "global" },
    data: {
      aiEngineEnabled: true,
      autoResponseEnabled: true,
      autoResponseConfidenceThreshold: 90,
      ...overrides,
    },
  });
}

async function resetGroup(overrides: Partial<WhatsAppGroup> = {}) {
  group = await prisma.whatsAppGroup.update({
    where: { id: group.id },
    data: { isMonitored: true, aiAutomationEnabled: true, ...overrides },
  });
}

beforeAll(async () => {
  originalAutomationSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalAiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((r) => r.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }

  account = await prisma.whatsAppAccount.create({ data: { label: `AI Fallback Test ${randomUUID()}`, status: "CONNECTED" } });
});

afterAll(async () => {
  await prisma.automationSettings.update({
    where: { id: "global" },
    data: originalAutomationSettings as unknown as Prisma.AutomationSettingsUpdateInput,
  });
  await prisma.aiSettings.update({ where: { id: "global" }, data: originalAiSettings as unknown as Prisma.AiSettingsUpdateInput });
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "ACTIVE" } });
  }
  await prisma.whatsAppAccount.delete({ where: { id: account.id } });
});

beforeEach(async () => {
  await resetAutomationSettings();
  await resetAiSettings();
  group = await prisma.whatsAppGroup.create({
    data: { accountId: account.id, whatsappGroupId: uniqueChatId(), name: "AI Fallback Test Group", isMonitored: true, aiAutomationEnabled: true, lastSyncedAt: new Date() },
  });
});

afterEach(async () => {
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.notification.deleteMany({ where: { relatedMessage: { accountId: account.id } } });
  await prisma.automationExecution.deleteMany({ where: { message: { accountId: account.id } } });
  await prisma.message.deleteMany({ where: { accountId: account.id } }); // cascades AiFallbackDecision
  await prisma.whatsAppGroup.delete({ where: { id: group.id } });
  if (createdGroupIds.length) {
    await prisma.whatsAppGroup.deleteMany({ where: { id: { in: createdGroupIds } } });
    createdGroupIds.length = 0;
  }
  if (createdTeamMemberIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: createdTeamMemberIds } } });
    createdTeamMemberIds.length = 0;
  }
});

describe("parseFallbackResponse", () => {
  it("parses a well-formed response", () => {
    const result = parseFallbackResponse("INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?");
    expect(result.intent).toBe("package change");
    expect(result.confidence).toBe(96);
    expect(result.shouldReply).toBe(true);
    expect(result.responseText).toBe("Sure, which package?");
  });

  it("treats SHOULD_REPLY: NO + RESPONSE: NONE as no drafted reply", () => {
    const result = parseFallbackResponse("INTENT: complaint\nCONFIDENCE: 40\nSHOULD_REPLY: NO\nRESPONSE: NONE");
    expect(result.shouldReply).toBe(false);
    expect(result.responseText).toBeNull();
  });

  it("clamps an out-of-range confidence value", () => {
    expect(parseFallbackResponse("CONFIDENCE: 150\nSHOULD_REPLY: YES\nRESPONSE: x").confidence).toBe(100);
    expect(parseFallbackResponse("CONFIDENCE: -5\nSHOULD_REPLY: YES\nRESPONSE: x").confidence).toBe(0);
  });

  it("returns null confidence when the AI didn't follow the requested format", () => {
    const result = parseFallbackResponse("I think this customer wants a refund.");
    expect(result.confidence).toBeNull();
  });
});

describe("checkAiFallbackEligibility", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const baseCtx = {
    automationEnabled: true,
    mode: "SAFE_AUTO_REPLY" as const,
    group: { isMonitored: true, aiAutomationEnabled: true, aiSuppressedUntil: null as Date | null },
    aiEngineEnabled: true,
    autoResponseEnabled: true,
    now,
  };

  it("is eligible when every gate passes", () => {
    expect(checkAiFallbackEligibility(baseCtx)).toEqual({ eligible: true });
  });

  it("is eligible under FULL_RULE_AUTOMATION too", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, mode: "FULL_RULE_AUTOMATION" })).toEqual({ eligible: true });
  });

  it("blocks when the kill switch is off", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, automationEnabled: false }).eligible).toBe(false);
  });

  it("blocks under MANUAL_ONLY", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, mode: "MANUAL_ONLY" }).eligible).toBe(false);
  });

  it("blocks a message with no group (direct message)", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, group: null }).eligible).toBe(false);
  });

  it("blocks an unmonitored group", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, group: { isMonitored: false, aiAutomationEnabled: true, aiSuppressedUntil: null } }).eligible).toBe(false);
  });

  it("blocks a group that hasn't opted in to AI automation", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, group: { isMonitored: true, aiAutomationEnabled: false, aiSuppressedUntil: null } }).eligible).toBe(false);
  });

  it("blocks when a team member is actively handling the group (human takeover)", () => {
    const suppressedUntil = new Date(now.getTime() + 60_000); // still in the future relative to `now`
    expect(
      checkAiFallbackEligibility({ ...baseCtx, group: { ...baseCtx.group, aiSuppressedUntil: suppressedUntil } }).eligible,
    ).toBe(false);
  });

  it("is eligible once the human-takeover window has elapsed", () => {
    const suppressedUntil = new Date(now.getTime() - 60_000); // already in the past relative to `now`
    expect(
      checkAiFallbackEligibility({ ...baseCtx, group: { ...baseCtx.group, aiSuppressedUntil: suppressedUntil } }),
    ).toEqual({ eligible: true });
  });

  it("blocks when AI Engine is disabled", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, aiEngineEnabled: false }).eligible).toBe(false);
  });

  it("blocks when auto-response is disabled", () => {
    expect(checkAiFallbackEligibility({ ...baseCtx, autoResponseEnabled: false }).eligible).toBe(false);
  });
});

describe("createAiFallbackDecision idempotency", () => {
  it("returns an error instead of throwing for a duplicate messageId", async () => {
    const phone = uniquePhone();
    const message = await prisma.message.create({
      data: {
        accountId: account.id, whatsappMessageId: randomUUID(), chatId: phone, senderPhone: phone,
        direction: "INCOMING", body: "test", normalizedBody: "test", timestampWa: new Date(), processingStatus: "PROCESSED",
      },
    });

    const first = await createAiFallbackDecision({ messageId: message.id, accountId: account.id, outcome: "HUMAN_FALLBACK", reason: "LOW_CONFIDENCE" });
    const second = await createAiFallbackDecision({ messageId: message.id, accountId: account.id, outcome: "HUMAN_FALLBACK", reason: "LOW_CONFIDENCE" });

    expect("id" in first).toBe(true);
    expect("error" in second).toBe(true);
    expect(await prisma.aiFallbackDecision.count({ where: { messageId: message.id } })).toBe(1);
  });
});

describe("Hybrid AI Automation fallback — pipeline integration", () => {
  it("never invokes AI when a rule matches", async () => {
    const rule = await prisma.automationRule.create({
      data: {
        name: "Greeting", type: "AUTO_REPLY", matchType: "KEYWORDS", keywords: ["hello"],
        actions: [{ type: "AUTO_REPLY" }], priority: 70, status: "ACTIVE", replyMessage: "hi!",
      },
    });
    const client = new MockAiClient();

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "hello there", timestampWa: new Date() },
      client,
    );

    expect(client.requests).toHaveLength(0);
    expect(await prisma.aiFallbackDecision.count({ where: { accountId: account.id } })).toBe(0);
    await prisma.automationRule.delete({ where: { id: rule.id } });
  });

  it("invokes AI exactly once on a genuine NO_MATCH and replies when confidence clears the threshold", async () => {
    const client = new MockAiClient();
    client.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package would you like?";

    const senderPhone = uniquePhone();
    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone, direction: "INCOMING", body: "I want to change my package", timestampWa: new Date() },
      client,
    );

    expect(client.requests).toHaveLength(1);
    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(decision.outcome).toBe("AI_REPLIED");
    expect(decision.confidenceScore).toBe(96);
    expect(decision.outboundMessageId).not.toBeNull();

    const outbound = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: decision.outboundMessageId! } });
    expect(outbound.ruleId).toBeNull();
    expect(outbound.actionType).toBe("AUTO_REPLY");
    expect(outbound.body).toBe("Sure, which package would you like?");
  });

  it("falls back to human when confidence is below the threshold", async () => {
    const client = new MockAiClient();
    client.nextText = "INTENT: unclear\nCONFIDENCE: 55\nSHOULD_REPLY: YES\nRESPONSE: Maybe this helps?";

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "something ambiguous", timestampWa: new Date() },
      client,
    );

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(decision.outcome).toBe("HUMAN_FALLBACK");
    expect(decision.reason).toBe("LOW_CONFIDENCE");
    expect(decision.notificationId).not.toBeNull();

    const notification = await prisma.notification.findUniqueOrThrow({ where: { id: decision.notificationId! } });
    expect(notification.type).toBe("TEAMS");
    const payload = notification.payload as Record<string, unknown>;
    expect(payload.alertKind).toBe("AI_ASSISTANCE_REQUIRED");
  });

  it("falls back to human when the AI declines to reply", async () => {
    const client = new MockAiClient();
    client.nextText = "INTENT: complaint\nCONFIDENCE: 92\nSHOULD_REPLY: NO\nRESPONSE: NONE";

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "a real complaint", timestampWa: new Date() },
      client,
    );

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(decision.outcome).toBe("HUMAN_FALLBACK");
    expect(decision.reason).toBe("AI_DECLINED");
  });

  it("falls back to human when the AI response is malformed", async () => {
    const client = new MockAiClient();
    client.nextText = "I'm not sure, maybe 80% confident?";

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "something odd", timestampWa: new Date() },
      client,
    );

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(decision.outcome).toBe("HUMAN_FALLBACK");
    expect(decision.reason).toBe("MALFORMED_RESPONSE");
  });

  it("falls back to human, without throwing, when no AI provider is configured", async () => {
    // No clientOverride passed — exercises the real resolveAiClient("RESPONSE") path, which
    // returns null because no AiModelConfig row exists for the RESPONSE job in this test DB.
    await expect(
      processIncomingMessage({
        accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId,
        chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "no provider configured", timestampWa: new Date(),
      }),
    ).resolves.not.toThrow();

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(decision.outcome).toBe("HUMAN_FALLBACK");
    expect(decision.reason).toBe("AI_UNAVAILABLE");
  });

  it("is a silent no-op when the group hasn't opted in to AI automation", async () => {
    await resetGroup({ aiAutomationEnabled: false });
    const client = new MockAiClient();

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "unmatched message", timestampWa: new Date() },
      client,
    );

    expect(client.requests).toHaveLength(0);
    expect(await prisma.aiFallbackDecision.count({ where: { accountId: account.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { relatedMessage: { accountId: account.id } } })).toBe(0);
  });

  it("is a silent no-op when AI Engine is disabled in AI Settings", async () => {
    await resetAiSettings({ aiEngineEnabled: false });
    const client = new MockAiClient();

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "unmatched with AI engine off", timestampWa: new Date() },
      client,
    );

    expect(client.requests).toHaveLength(0);
    expect(await prisma.aiFallbackDecision.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("is a silent no-op when Auto Response is disabled in AI Settings", async () => {
    await resetAiSettings({ autoResponseEnabled: false });
    const client = new MockAiClient();

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "unmatched with auto response off", timestampWa: new Date() },
      client,
    );

    expect(client.requests).toHaveLength(0);
    expect(await prisma.aiFallbackDecision.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("is a silent no-op under MANUAL_ONLY mode", async () => {
    await resetAutomationSettings({ mode: "MANUAL_ONLY" });
    const client = new MockAiClient();

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "unmatched under manual only", timestampWa: new Date() },
      client,
    );

    expect(client.requests).toHaveLength(0);
    expect(await prisma.aiFallbackDecision.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("falls back to human when the safety re-check blocks the send (rate limit exhausted)", async () => {
    await resetAutomationSettings({ maxRepliesPerClientPerHour: 0 });
    const client = new MockAiClient();
    client.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure!";

    await processIncomingMessage(
      { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "package change please", timestampWa: new Date() },
      client,
    );

    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(decision.outcome).toBe("HUMAN_FALLBACK");
    expect(decision.reason).toMatch(/^SAFETY_BLOCKED:/);
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
  });

  describe("confidence boundaries (Slice 3)", () => {
    async function sendWithConfidence(confidenceLine: string, senderPhone: string) {
      const client = new MockAiClient();
      client.nextText = `INTENT: test\n${confidenceLine}\nSHOULD_REPLY: YES\nRESPONSE: A drafted reply.`;
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone, direction: "INCOMING", body: "boundary test message", timestampWa: new Date() },
        client,
      );
      const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, senderPhone } });
      return prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    }

    it("confidence 100 replies", async () => {
      const decision = await sendWithConfidence("CONFIDENCE: 100", uniquePhone());
      expect(decision.outcome).toBe("AI_REPLIED");
    });

    it("confidence exactly at the threshold (90) replies", async () => {
      const decision = await sendWithConfidence("CONFIDENCE: 90", uniquePhone());
      expect(decision.outcome).toBe("AI_REPLIED");
    });

    it("confidence one below the threshold (89) falls back to human", async () => {
      const decision = await sendWithConfidence("CONFIDENCE: 89", uniquePhone());
      expect(decision.outcome).toBe("HUMAN_FALLBACK");
      expect(decision.reason).toBe("LOW_CONFIDENCE");
    });

    it("confidence 0 falls back to human", async () => {
      const decision = await sendWithConfidence("CONFIDENCE: 0", uniquePhone());
      expect(decision.outcome).toBe("HUMAN_FALLBACK");
      expect(decision.reason).toBe("LOW_CONFIDENCE");
    });

    it("missing confidence entirely fails closed (never treated as 100%)", async () => {
      const client = new MockAiClient();
      client.nextText = "SHOULD_REPLY: YES\nRESPONSE: A drafted reply.";
      const senderPhone = uniquePhone();
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone, direction: "INCOMING", body: "boundary test message", timestampWa: new Date() },
        client,
      );
      const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, senderPhone } });
      const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
      expect(decision.outcome).toBe("HUMAN_FALLBACK");
      expect(decision.reason).toBe("MALFORMED_RESPONSE");
    });
  });

  describe("AI reply cooldown (Slice 3)", () => {
    it("blocks an immediate second eligible reply to the same client, without spending a new AI call", async () => {
      await resetAiSettings({ aiReplyCooldownSeconds: 3600 });
      const senderPhone = uniquePhone();
      const firstClient = new MockAiClient();
      firstClient.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?";
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone, direction: "INCOMING", body: "first message", timestampWa: new Date() },
        firstClient,
      );
      const firstMessage = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, senderPhone } });
      const firstDecision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: firstMessage.id } });
      expect(firstDecision.outcome).toBe("AI_REPLIED");

      const secondClient = new MockAiClient();
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone, direction: "INCOMING", body: "second message right after", timestampWa: new Date() },
        secondClient,
      );
      const secondMessage = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, senderPhone, id: { not: firstMessage.id } } });
      const secondDecision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: secondMessage.id } });

      expect(secondDecision.outcome).toBe("HUMAN_FALLBACK");
      expect(secondDecision.reason).toMatch(/^SAFETY_BLOCKED:.*cooldown/i);
      // The pre-AI-call check caught this before spending a real API call.
      expect(secondClient.requests).toHaveLength(0);
    });

    it("does not block a different client in the same cooldown window", async () => {
      await resetAiSettings({ aiReplyCooldownSeconds: 3600 });
      const firstClient = new MockAiClient();
      firstClient.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?";
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "first client message", timestampWa: new Date() },
        firstClient,
      );

      const otherPhone = uniquePhone();
      const secondClient = new MockAiClient();
      secondClient.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?";
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: otherPhone, direction: "INCOMING", body: "different client message", timestampWa: new Date() },
        secondClient,
      );

      const otherMessage = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, senderPhone: otherPhone } });
      const otherDecision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: otherMessage.id } });
      expect(otherDecision.outcome).toBe("AI_REPLIED");
      expect(secondClient.requests).toHaveLength(1);
    });

    it("is disabled entirely when aiReplyCooldownSeconds is 0", async () => {
      await resetAiSettings({ aiReplyCooldownSeconds: 0 });
      const senderPhone = uniquePhone();
      for (let i = 0; i < 2; i++) {
        const client = new MockAiClient();
        client.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?";
        await processIncomingMessage(
          { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone, direction: "INCOMING", body: `message ${i}`, timestampWa: new Date() },
          client,
        );
      }
      const decisions = await prisma.aiFallbackDecision.findMany({ where: { accountId: account.id } });
      expect(decisions.every((d) => d.outcome === "AI_REPLIED")).toBe(true);
      expect(decisions).toHaveLength(2);
    });
  });

  describe("human takeover (Slice 3)", () => {
    it("suppresses AI in the same group for the configured window after a team member speaks, and resumes automatically afterward", async () => {
      await resetAiSettings({ humanTakeoverCooldownMinutes: 30 });
      const teamPhone = uniquePhone();
      const teamMember = await prisma.internalTeamMember.create({ data: { name: "Test Agent", phoneNumber: teamPhone, role: "Support", status: "ACTIVE" } });
      createdTeamMemberIds.push(teamMember.id);

      await processIncomingMessage({
        accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId,
        chatId: group.whatsappGroupId, senderPhone: teamPhone, direction: "INCOMING", body: "I'm handling this now", timestampWa: new Date(),
      });
      const suppressedGroup = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: group.id } });
      expect(suppressedGroup.aiSuppressedUntil).not.toBeNull();
      expect(suppressedGroup.aiSuppressedUntil!.getTime()).toBeGreaterThan(Date.now());

      const client = new MockAiClient();
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "unmatched during takeover", timestampWa: new Date() },
        client,
      );
      expect(client.requests).toHaveLength(0);
      const customerMessage = await prisma.message.findFirstOrThrow({ where: { accountId: account.id, body: "unmatched during takeover" } });
      expect(await prisma.aiFallbackDecision.count({ where: { messageId: customerMessage.id } })).toBe(0);
    });

    it("does not suppress a different group", async () => {
      const teamPhone = uniquePhone();
      const teamMember = await prisma.internalTeamMember.create({ data: { name: "Test Agent", phoneNumber: teamPhone, role: "Support", status: "ACTIVE" } });
      createdTeamMemberIds.push(teamMember.id);
      const otherGroup = await prisma.whatsAppGroup.create({
        data: { accountId: account.id, whatsappGroupId: uniqueChatId(), name: "Other Group", isMonitored: true, aiAutomationEnabled: true, lastSyncedAt: new Date() },
      });
      createdGroupIds.push(otherGroup.id);

      await processIncomingMessage({
        accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId,
        chatId: group.whatsappGroupId, senderPhone: teamPhone, direction: "INCOMING", body: "handling this group", timestampWa: new Date(),
      });

      const client = new MockAiClient();
      client.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?";
      await processIncomingMessage(
        { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: otherGroup.whatsappGroupId, chatId: otherGroup.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING", body: "unmatched in other group", timestampWa: new Date() },
        client,
      );
      expect(client.requests).toHaveLength(1);
    });
  });
});

describe("Hybrid AI Automation — duplicate-delivery idempotency (Slice 3)", () => {
  it("never invokes AI, or creates a second decision, when the same WhatsApp event is redelivered", async () => {
    const client = new MockAiClient();
    client.nextText = "INTENT: package change\nCONFIDENCE: 96\nSHOULD_REPLY: YES\nRESPONSE: Sure, which package?";
    const raw = {
      accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId,
      chatId: group.whatsappGroupId, senderPhone: uniquePhone(), direction: "INCOMING" as const,
      body: "redelivered message", timestampWa: new Date(),
    };

    await processIncomingMessage(raw, client);
    await processIncomingMessage(raw, client); // simulates a redelivered/duplicate provider event

    expect(client.requests).toHaveLength(1); // AI was never asked twice for the same message
    expect(await prisma.message.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prisma.aiFallbackDecision.count({ where: { accountId: account.id } })).toBe(1);
    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(1);
  });
});
