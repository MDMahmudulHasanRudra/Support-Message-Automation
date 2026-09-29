import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "./helpers/projectFixtures.js";
import type { AiSettings, AutomationSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { processOne } from "../queue/outboundQueueProcessor.js";
import { MockAiClient } from "./mockAiClient.js";
import { MockProvider } from "./mockProvider.js";
import type { AiClient, AiCompletionRequest, AiCompletionResult } from "@support-automation/ai-client";

/**
 * A mock whose completion actually takes time.
 *
 * `MockAiClient` resolves in the same microtask, so two concurrent pipeline passes serialise and
 * the enqueue-time cooldown check catches the second one. That is genuine behaviour and not what
 * the concurrency test is asserting: the point is what happens when both passes are inside the
 * provider call together, which is the ordinary case against a real model taking a second or two.
 */
class SlowMockAiClient implements AiClient {
  public requests: AiCompletionRequest[] = [];
  constructor(private readonly delayMs: number, private readonly texts: string[]) {}
  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.requests.push(request);
    const text = this.texts.shift() ?? this.texts[0] ?? "";
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { text, tokensUsed: 42, providerId: "mock-provider", modelId: "mock-model" };
  }
}

/**
 * The three findings from the final AI reply audit that need a live database to demonstrate:
 * same-group routing, the AI cooldown race, and the handover alert reaching every configured
 * destination.
 *
 * Same harness conventions as `aiFallback.integration.test.ts` — isolated postgres-test, every AI
 * call mocked, pre-existing active rules disabled for the duration so `evaluate()`'s global rule
 * load cannot make a real deployment's rules decide a test.
 */

let originalAutomationSettings: AutomationSettings;
let originalAiSettings: AiSettings;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
let preExistingActiveRuleIds: string[] = [];

const PHONE_RUN_PREFIX = String(randomInt(100_000, 999_999));
let phoneSequence = 0;
/** Digits only — team-member matching normalises to digits, and a hex slice can fall under the minimum. */
const uniquePhone = () => `+8809${PHONE_RUN_PREFIX}${String(++phoneSequence).padStart(4, "0")}`;
const uniqueChatId = () => `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;

const CONFIDENT_REPLY = [
  "INTENT: package change",
  "SCOPE: GENERAL",
  "CONFIDENCE: 96",
  "SHOULD_REPLY: YES",
  "RESPONSE: Sure, here is the answer.",
].join("\n");

beforeAll(async () => {
  originalAutomationSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalAiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((rule) => rule.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }

  account = await prisma.whatsAppAccount.create({
    data: { label: `AI Hardening Test ${randomUUID()}`, status: "CONNECTED" },
  });
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
  await prisma.whatsAppAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  await prisma.$disconnect();
});

beforeEach(async () => {
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
      // No artificial send delay: these tests drain the queue immediately.
      defaultReplyDelayMinMs: 0,
      defaultReplyDelayMaxMs: 0,
      teamsWebhookUrl: null,
      whatsappNotificationGroupIds: [],
    },
  });
  await prisma.aiSettings.update({
    where: { id: "global" },
    data: {
      aiEngineEnabled: true,
      autoResponseEnabled: true,
      autoResponseConfidenceThreshold: 90,
      // The knowledge gate has its own coverage; these suites are about routing, cooldown and
      // alert fan-out, so they use the permissive mode and declare SCOPE: GENERAL.
      aiResponseMode: "KNOWLEDGE_PLUS_GENERAL",
      generalAnswerMinConfidence: 90,
      aiReplyCooldownSeconds: 300,
      takeoverNotifyGroupIds: [],
      mentionTeamOnHandover: false,
    },
  });
  group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: uniqueChatId(),
      name: "AI Hardening Group",
      isMonitored: true,
      aiAutomationEnabled: true,
      lastSyncedAt: new Date(),
    },
  });
});

afterEach(async () => {
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.notification.deleteMany({ where: { accountId: account.id } });
  await prisma.notification.deleteMany({ where: { relatedMessage: { accountId: account.id } } });
  await prisma.automationExecution.deleteMany({ where: { message: { accountId: account.id } } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppGroup.deleteMany({ where: { id: group.id } });
});

const incoming = (body: string, senderPhone: string) => ({
  accountId: account.id,
  whatsappMessageId: randomUUID(),
  whatsappGroupId: group.whatsappGroupId,
  chatId: group.whatsappGroupId,
  senderPhone,
  direction: "INCOMING" as const,
  body,
  timestampWa: new Date(),
});

describe("same-group reply routing", () => {
  it("sends the AI reply back to the EXACT group the question arrived in", async () => {
    // The single most important production requirement in this system, and it had no assertion
    // anywhere: the reply must land in the group that asked, never another one and never a 1:1
    // chat. It is structurally correct — `chatId: raw.chatId` is threaded through — but
    // structurally correct and untested is how a refactor turns a reply into a wrong-group send.
    const other = await prisma.whatsAppGroup.create({
      data: {
        accountId: account.id,
        whatsappGroupId: uniqueChatId(),
        name: "A DIFFERENT group that must never receive this",
        isMonitored: true,
        aiAutomationEnabled: true,
        lastSyncedAt: new Date(),
      },
    });

    try {
      const client = new MockAiClient();
      client.nextText = CONFIDENT_REPLY;
      const senderPhone = uniquePhone();

      await processIncomingMessage(incoming("I want to change my package", senderPhone), client);

      const outbound = await prisma.outboundMessage.findMany({ where: { accountId: account.id } });
      expect(outbound).toHaveLength(1);
      // The assertion that matters.
      expect(outbound[0]!.chatId).toBe(group.whatsappGroupId);
      expect(outbound[0]!.chatId).not.toBe(other.whatsappGroupId);
      expect(outbound[0]!.actionType).toBe("AUTO_REPLY");

      // And the provider is handed that same chat id, so nothing between the queue row and the
      // WhatsApp call can redirect it.
      const provider = new MockProvider();
      await processOne(provider);
      expect(provider.sentMessages).toHaveLength(1);
      expect(provider.sentMessages[0]!.chatId).toBe(group.whatsappGroupId);
    } finally {
      await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
      await prisma.whatsAppGroup.delete({ where: { id: other.id } }).catch(() => undefined);
    }
  });

  it("never opens a 1:1 reply path — a direct message is not answered at all", async () => {
    // Group-only architecture. A message with no group resolves to `group: null`, and
    // `checkAiFallbackEligibility` refuses it outright, so no outbound row of any kind exists.
    const client = new MockAiClient();
    client.nextText = CONFIDENT_REPLY;
    const senderPhone = uniquePhone();

    await processIncomingMessage(
      {
        accountId: account.id,
        whatsappMessageId: randomUUID(),
        chatId: senderPhone.replace("+", "") + "@c.us",
        senderPhone,
        direction: "INCOMING",
        body: "I want to change my package",
        timestampWa: new Date(),
      },
      client,
    );

    expect(await prisma.outboundMessage.count({ where: { accountId: account.id } })).toBe(0);
    expect(client.requests).toHaveLength(0);
  });
});

describe("AI reply cooldown under concurrency", () => {
  it("holds back a second queued AI reply at SEND time", async () => {
    // The fix itself, tested directly rather than through a hoped-for interleaving. Two rule-less
    // AUTO_REPLY rows for one customer, both due — exactly the state the enqueue-time race can
    // leave behind. The send-time re-check was gated on `message.ruleId`, which is null for every
    // AI reply, so nothing looked at these on the way out and both went to the customer.
    const senderPhone = uniquePhone();
    for (const body of ["first answer", "second answer"]) {
      await prisma.outboundMessage.create({
        data: {
          accountId: account.id,
          chatId: group.whatsappGroupId,
          toPhone: senderPhone,
          body,
          actionType: "AUTO_REPLY",
          ruleId: null,
          idempotencyKey: `ai-${randomUUID()}`,
          scheduledAt: new Date(Date.now() - 1000),
        },
      });
    }

    const provider = new MockProvider();
    while (await processOne(provider)) {
      /* drain */
    }

    expect(provider.sentMessages).toHaveLength(1);
    const rows = await prisma.outboundMessage.findMany({
      where: { accountId: account.id, actionType: "AUTO_REPLY" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.filter((row) => row.status === "SENT")).toHaveLength(1);
    const held = rows.find((row) => row.status !== "SENT");
    expect(held?.status).toBe("CANCELLED");
    expect(held?.failureReason ?? "").toMatch(/cooldown/i);
  });

  it("does not send two AI replies to one customer inside the cooldown window", async () => {
    // People split a thought across two WhatsApp messages constantly, and the pipeline processes
    // them concurrently — `processIncomingMessage` is called fire-and-forget per message. Both
    // passes read the cooldown before either has enqueued, so both saw an empty window and both
    // queued a reply under DIFFERENT idempotency keys (the incoming message id differs, so the
    // key legitimately differs — this is not a duplicate-send bug, it is a cooldown bug).
    //
    // The send-time re-check was gated on `message.ruleId`, which is always null for an AI reply,
    // so nothing caught it on the way out either.
    // A completion that takes real time, so both passes are inside the AI call together and both
    // reach the post-call safety re-check before either has inserted its row. With an instant mock
    // the two runs happen to serialise and the enqueue-time check catches the second — which is
    // real, but it is luck, not a guarantee, and it is not what this test is about.
    const client = new SlowMockAiClient(40, [CONFIDENT_REPLY, CONFIDENT_REPLY]);
    const senderPhone = uniquePhone();

    await Promise.all([
      processIncomingMessage(incoming("my bill looks wrong", senderPhone), client),
      processIncomingMessage(incoming("and the package too", senderPhone), client),
    ]);

    // Both may well be QUEUED — the race at enqueue time is real and bounded. What must not happen
    // is both being SENT.
    const provider = new MockProvider();
    while (await processOne(provider)) {
      /* drain */
    }

    const sent = await prisma.outboundMessage.findMany({
      where: { accountId: account.id, actionType: "AUTO_REPLY", status: "SENT" },
    });
    expect(sent).toHaveLength(1);
    expect(provider.sentMessages).toHaveLength(1);

    // The one held back is settled, not left dangling for the stuck-work sweep to find.
    const notSent = await prisma.outboundMessage.findMany({
      where: { accountId: account.id, actionType: "AUTO_REPLY", status: { not: "SENT" } },
    });
    for (const row of notSent) {
      expect(row.status).toBe("CANCELLED");
      expect(row.failureReason ?? "").toMatch(/cooldown/i);
    }
  });

  it("still sends when the cooldown is switched off", async () => {
    // The guard must be the cooldown setting, not a blanket second-reply block — a deployment that
    // sets the cooldown to zero has said it wants every question answered.
    await prisma.aiSettings.update({ where: { id: "global" }, data: { aiReplyCooldownSeconds: 0 } });

    const client = new SlowMockAiClient(40, [CONFIDENT_REPLY, CONFIDENT_REPLY]);
    const senderPhone = uniquePhone();

    await Promise.all([
      processIncomingMessage(incoming("first question", senderPhone), client),
      processIncomingMessage(incoming("second question", senderPhone), client),
    ]);

    const provider = new MockProvider();
    while (await processOne(provider)) {
      /* drain */
    }

    expect(provider.sentMessages).toHaveLength(2);
  });

  it("does not hold back a human's manual reply", async () => {
    // MANUAL_REPLY is rule-less too. It must never be caught by an AI cooldown: the switch stops
    // the robot, not the operator.
    const client = new MockAiClient();
    client.nextText = CONFIDENT_REPLY;
    const senderPhone = uniquePhone();
    await processIncomingMessage(incoming("a question", senderPhone), client);

    await prisma.outboundMessage.create({
      data: {
        accountId: account.id,
        chatId: group.whatsappGroupId,
        toPhone: senderPhone,
        body: "A person typed this.",
        actionType: "MANUAL_REPLY",
        idempotencyKey: `manual-${randomUUID()}`,
        scheduledAt: new Date(Date.now() - 1000),
      },
    });

    const provider = new MockProvider();
    while (await processOne(provider)) {
      /* drain */
    }

    const manual = await prisma.outboundMessage.findFirstOrThrow({
      where: { accountId: account.id, actionType: "MANUAL_REPLY" },
    });
    expect(manual.status).toBe("SENT");
  });
});

describe("handover alert destinations", () => {
  it("alerts EVERY configured takeover group, not just the first", async () => {
    // `destination: takeoverDestinations[0]!` meant an admin who configured three groups had two
    // of them silently never told about a handover — the alert looked configured and reached one
    // place.
    const destinations = [uniqueChatId(), uniqueChatId(), uniqueChatId()];
    await prisma.aiSettings.update({
      where: { id: "global" },
      data: { takeoverNotifyGroupIds: destinations },
    });
    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { isPrimary: true } });

    const client = new MockAiClient();
    // Below the threshold, so this hands over rather than replying.
    client.nextText = ["INTENT: unclear", "SCOPE: GENERAL", "CONFIDENCE: 20", "SHOULD_REPLY: YES", "RESPONSE: maybe"].join("\n");

    await processIncomingMessage(incoming("something ambiguous", uniquePhone()), client);

    const notifications = await prisma.notification.findMany({
      where: { event: "AI_HUMAN_FALLBACK", accountId: account.id },
      select: { destination: true },
    });
    expect(new Set(notifications.map((n) => n.destination))).toEqual(new Set(destinations));

    // And the decision is still linked to exactly one of them — the handover is one event, however
    // many places it was announced in.
    const message = await prisma.message.findFirstOrThrow({ where: { accountId: account.id } });
    const decision = await prisma.aiFallbackDecision.findUniqueOrThrow({ where: { messageId: message.id } });
    expect(decision.outcome).toBe("HUMAN_FALLBACK");
    expect(decision.notificationId).not.toBeNull();

    await prisma.whatsAppAccount.update({ where: { id: account.id }, data: { isPrimary: false } });
  });
});
