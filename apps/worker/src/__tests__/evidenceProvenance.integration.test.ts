import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import { createKnowledgeItem, prisma } from "@support-automation/db";
import type { AiSettings, AutomationSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * Provenance: can this system explain, later, why it said what it said?
 *
 * `AiFallbackDecision` recorded the answer and nothing about the evidence behind it, so editing a
 * knowledge entry made every past reply built on it unexplainable — and there is no recovering
 * that after the fact. The evidence has to be recorded at the moment it is used.
 *
 * The other thing these prove is the model-swap contract: the same question over the same evidence
 * produces the same fingerprint whichever model answers, so a difference between two models is
 * attributable to the models rather than to the inputs having quietly moved.
 */

let originalAutomationSettings: AutomationSettings;
let originalAiSettings: AiSettings;
let account: WhatsAppAccount;
let group: WhatsAppGroup;
let preExistingActiveRuleIds: string[] = [];
const createdItemIds: string[] = [];

const PHONE_RUN_PREFIX = String(randomInt(100_000, 999_999));
let phoneSequence = 0;
const uniquePhone = () => `+8809${PHONE_RUN_PREFIX}${String(++phoneSequence).padStart(4, "0")}`;
const uniqueChatId = () => `${randomUUID().replace(/-/g, "").slice(0, 10)}-9999999999@g.us`;

/** Distinctive, so retrieval finds this suite's fixture and nothing another suite left behind. */
const MARKER = `quorvex${randomUUID().replace(/-/g, "").slice(0, 8)}`;

const REPLY = (text: string) =>
  ["INTENT: billing", "SCOPE: GENERAL", "CONFIDENCE: 96", "SHOULD_REPLY: YES", `RESPONSE: ${text}`].join("\n");

beforeAll(async () => {
  originalAutomationSettings = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  originalAiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  preExistingActiveRuleIds = (
    await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })
  ).map((rule) => rule.id);
  if (preExistingActiveRuleIds.length) {
    await prisma.automationRule.updateMany({ where: { id: { in: preExistingActiveRuleIds } }, data: { status: "DISABLED" } });
  }
  account = await prisma.whatsAppAccount.create({ data: { label: `Provenance ${randomUUID()}`, status: "CONNECTED" } });
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
      rateLimitingEnabled: false,
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
      aiResponseMode: "KNOWLEDGE_PLUS_GENERAL",
      generalAnswerMinConfidence: 90,
      aiReplyCooldownSeconds: 0,
      takeoverNotifyGroupIds: [],
      mentionTeamOnHandover: false,
    },
  });
  group = await prisma.whatsAppGroup.create({
    data: {
      accountId: account.id,
      whatsappGroupId: uniqueChatId(),
      name: "Provenance Group",
      isMonitored: true,
      aiAutomationEnabled: true,
      lastSyncedAt: new Date(),
    },
  });
});

afterEach(async () => {
  await prisma.outboundMessage.deleteMany({ where: { accountId: account.id } });
  await prisma.message.deleteMany({ where: { accountId: account.id } });
  await prisma.whatsAppGroup.deleteMany({ where: { id: group.id } });
  if (createdItemIds.length) {
    await prisma.aiKnowledgeItem.deleteMany({ where: { id: { in: createdItemIds } } });
    createdItemIds.length = 0;
  }
});

async function seedKnowledge(title: string) {
  const item = await createKnowledgeItem({
    title,
    category: "FAQ",
    question: `What is ${MARKER}?`,
    answer: `The ${MARKER} charge is applied monthly.`,
    source: "MANUAL",
    sourceGroupId: null,
    aiGenerated: false,
    humanVerified: true,
  });
  createdItemIds.push(item.id);
  return item;
}

const incoming = (body: string) => ({
  accountId: account.id,
  whatsappMessageId: randomUUID(),
  whatsappGroupId: group.whatsappGroupId,
  chatId: group.whatsappGroupId,
  senderPhone: uniquePhone(),
  direction: "INCOMING" as const,
  body,
  timestampWa: new Date(),
});

async function decisionWithSnapshot() {
  const message = await prisma.message.findFirstOrThrow({
    where: { accountId: account.id, direction: "INCOMING" },
    orderBy: { createdAt: "desc" },
  });
  return prisma.aiFallbackDecision.findUniqueOrThrow({
    where: { messageId: message.id },
    include: { evidenceSnapshot: { include: { items: { orderBy: { rank: "asc" } } } } },
  });
}

describe("an answer records what it was built on", () => {
  it("writes a snapshot naming the entry AND the version the model actually read", async () => {
    const item = await seedKnowledge(`${MARKER} billing`);
    const client = new MockAiClient();
    client.nextText = REPLY("It is charged monthly.");

    await processIncomingMessage(incoming(`tell me about ${MARKER}`), client);

    const decision = await decisionWithSnapshot();
    expect(decision.outcome).toBe("AI_REPLIED");
    expect(decision.evidenceSnapshot).not.toBeNull();

    const snapshot = decision.evidenceSnapshot!;
    expect(snapshot.knowledgeCount).toBe(1);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.knowledgeItemId).toBe(item.id);
    expect(snapshot.items[0]!.knowledgeVersion).toBe(1);
    expect(snapshot.items[0]!.rank).toBe(0);
    expect(snapshot.items[0]!.scope).toBe("GLOBAL");
  });

  it("stays explainable after the knowledge is edited underneath it", async () => {
    // The whole point. Six months on, "which version did the AI read?" must still have an answer,
    // and that answer must resolve to the text as it was — not as it has since become.
    const item = await seedKnowledge(`${MARKER} billing`);
    const client = new MockAiClient();
    client.nextText = REPLY("It is charged monthly.");
    await processIncomingMessage(incoming(`tell me about ${MARKER}`), client);

    // Somebody corrects the entry afterwards, exactly as the edit action does.
    await prisma.$transaction([
      prisma.aiKnowledgeVersion.create({
        data: {
          itemId: item.id,
          version: 2,
          title: `${MARKER} billing`,
          category: "FAQ",
          answer: `The ${MARKER} charge is applied WEEKLY.`,
          changeSummary: "Corrected.",
        },
      }),
      prisma.aiKnowledgeItem.update({
        where: { id: item.id },
        data: { answer: `The ${MARKER} charge is applied WEEKLY.`, currentVersion: 2 },
      }),
    ]);

    const decision = await decisionWithSnapshot();
    expect(decision.evidenceSnapshot!.items[0]!.knowledgeVersion).toBe(1);

    // And version 1 still resolves to what it said at the time, which is what makes the version
    // number worth recording rather than merely reassuring.
    const asRead = await prisma.aiKnowledgeVersion.findFirstOrThrow({
      where: { itemId: item.id, version: decision.evidenceSnapshot!.items[0]!.knowledgeVersion },
    });
    expect(asRead.answer).toContain("monthly");
    expect(asRead.answer).not.toContain("WEEKLY");
  });

  it("survives the knowledge item being deleted", async () => {
    // SetNull, not Cascade: deleting an entry must not erase the record that it once grounded an
    // answer. The denormalised title is what keeps the row readable afterwards.
    const item = await seedKnowledge(`${MARKER} doomed`);
    const client = new MockAiClient();
    client.nextText = REPLY("Answer.");
    await processIncomingMessage(incoming(`tell me about ${MARKER}`), client);

    await prisma.aiKnowledgeItem.delete({ where: { id: item.id } });
    createdItemIds.length = 0;

    const decision = await decisionWithSnapshot();
    expect(decision.evidenceSnapshot!.items[0]!.knowledgeItemId).toBeNull();
    expect(decision.evidenceSnapshot!.items[0]!.title).toBe(`${MARKER} doomed`);
  });
});

describe("interaction metadata", () => {
  it("records timing, finish reason, correlation and the versions of this system", async () => {
    await seedKnowledge(`${MARKER} billing`);
    const client = new MockAiClient();
    client.nextText = REPLY("Answer.");
    const raw = incoming(`tell me about ${MARKER}`);

    await processIncomingMessage(raw, client);

    const decision = await decisionWithSnapshot();
    expect(decision.latencyMs).not.toBeNull();
    expect(decision.finishReason).toBe("stop");
    expect(decision.promptVersion).toBeTruthy();
    expect(decision.retrievalVersion).toBeTruthy();
    expect(decision.evidenceFingerprint).toBeTruthy();
    // The pipeline's own trace id, reused rather than a second correlation scheme.
    expect(decision.correlationId).toBe(`${raw.accountId}:${raw.whatsappMessageId}`);
    // Denormalised from the snapshot so "same evidence?" needs no join.
    expect(decision.evidenceFingerprint).toBe(decision.evidenceSnapshot!.fingerprint);
  });
});

describe("changing the model changes nothing but the generation", () => {
  it("produces the same evidence fingerprint from a different model over the same knowledge", async () => {
    // The model-replacement contract, stated as a test: knowledge, versions, scope and the
    // fingerprint are properties of the DATA, and swapping the model may not disturb any of them.
    await seedKnowledge(`${MARKER} billing`);

    const modelA = new MockAiClient();
    modelA.nextText = REPLY("Model A's wording.");
    await processIncomingMessage(incoming(`tell me about ${MARKER}`), modelA);
    const first = await decisionWithSnapshot();

    const modelB = new MockAiClient();
    modelB.nextText = REPLY("Model B words it entirely differently.");
    await processIncomingMessage(incoming(`tell me about ${MARKER}`), modelB);
    const second = await decisionWithSnapshot();

    // Two separate interactions...
    expect(second.id).not.toBe(first.id);
    expect(second.responseText).not.toBe(first.responseText);
    // ...over provably identical evidence.
    expect(second.evidenceFingerprint).toBe(first.evidenceFingerprint);
    expect(second.evidenceSnapshot!.items[0]!.knowledgeItemId).toBe(first.evidenceSnapshot!.items[0]!.knowledgeItemId);
    expect(second.evidenceSnapshot!.items[0]!.knowledgeVersion).toBe(first.evidenceSnapshot!.items[0]!.knowledgeVersion);
  });

  it("changes the fingerprint when the evidence itself changes", async () => {
    // The other direction, and the reason the first assertion means anything: a fingerprint that
    // never moved would prove nothing at all.
    await seedKnowledge(`${MARKER} billing`);
    const client = new MockAiClient();
    client.nextText = REPLY("Answer.");
    await processIncomingMessage(incoming(`tell me about ${MARKER}`), client);
    const before = await decisionWithSnapshot();

    await seedKnowledge(`${MARKER} billing extra`);
    client.nextText = REPLY("Answer.");
    await processIncomingMessage(incoming(`tell me about ${MARKER}`), client);
    const after = await decisionWithSnapshot();

    expect(after.evidenceFingerprint).not.toBe(before.evidenceFingerprint);
  });
});
