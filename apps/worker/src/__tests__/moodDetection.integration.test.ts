import "./helpers/requireTestDatabase.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomInt, randomUUID } from "node:crypto";
import type { MoodDetectionSettings, Prisma, WhatsAppAccount, WhatsAppGroup } from "@prisma/client";
import type { AiClient } from "@support-automation/ai-client";
import { createProjectWithDefaults } from "@support-automation/db";
import { DEFAULT_MOOD_POLICIES, MOOD_CUSTOMER_MESSAGE_VARIANT } from "@support-automation/shared";
import { prisma, rawPrisma, inIsp, ISP_DIGITAL } from "./helpers/projectFixtures.js";
import { recordMoodSignal } from "../mood/moodDetection.js";
import { analyzeMoodEvent, processNextMoodEvent, recoverStuckMoodWork, runMoodAction } from "../mood/moodProcessor.js";
import { withProject } from "../project/context.js";
import { isCooldownActive } from "../queue/cooldown.js";
import { processIncomingMessage } from "../pipeline/processIncomingMessage.js";
import { MockAiClient } from "./mockAiClient.js";

/**
 * Mood Detection end to end against the database (MOOD_DETECTION.md): the pipeline's pre-filter,
 * the processor's alert and cooldown, and each action — every one of them isolated to the project
 * and never triggered by a team member.
 */

const PREFIX = String(randomInt(100_000, 999_999));
let seq = 0;
const phone = () => `8809${PREFIX}${String(++seq).padStart(4, "0")}`;

let account: WhatsAppAccount;
let secondAccount: WhatsAppAccount;
let group: WhatsAppGroup;
let twinGroup: WhatsAppGroup;
let internalGroup: WhatsAppGroup;
let savedSettings: MoodDetectionSettings | null = null;
let savedAutomation: { automationEnabled: boolean; mode: string; whatsappNotificationGroupIds: string[]; teamsWebhookUrl: string | null } | null = null;
let savedPrimaryId: string | null = null;
const memberIds: string[] = [];

const waGroupId = () => `${randomUUID().replace(/-/g, "").slice(0, 12)}-1600000000@g.us`;

async function setSettings(data: Partial<Prisma.MoodDetectionSettingsUncheckedCreateInput>) {
  await prisma.moodDetectionSettings.upsert({
    where: { id: "global" },
    update: data,
    create: { id: "global", ...data },
  });
}

async function storeMessage(opts: { body: string; sender: string; at?: Date; groupRow?: WhatsAppGroup; whatsappMessageId?: string; fromTeam?: boolean }) {
  const g = opts.groupRow ?? group;
  return prisma.message.create({
    data: {
      accountId: g.accountId,
      groupId: g.id,
      whatsappMessageId: opts.whatsappMessageId ?? randomUUID(),
      chatId: g.whatsappGroupId,
      senderPhone: opts.sender,
      direction: "INCOMING",
      body: opts.body,
      normalizedBody: opts.body.toLowerCase(),
      timestampWa: opts.at ?? new Date(),
      isFromTeamMember: opts.fromTeam ?? false,
      processingStatus: "PROCESSED",
    },
  });
}

async function signal(opts: { body: string; sender: string; at?: Date; groupRow?: WhatsAppGroup; whatsappMessageId?: string; fromTeam?: boolean; isSticker?: boolean }) {
  const message = await storeMessage(opts);
  const g = opts.groupRow ?? group;
  const result = await inIsp(() =>
    recordMoodSignal({
      messageId: message.id,
      accountId: g.accountId,
      whatsappGroupId: g.whatsappGroupId,
      whatsappMessageId: message.whatsappMessageId,
      chatId: g.whatsappGroupId,
      group: { id: g.id, isMonitored: g.isMonitored },
      isFromTeamMember: opts.fromTeam ?? false,
      senderPhone: opts.sender,
      body: opts.body,
      timestampWa: message.timestampWa,
      isSticker: opts.isSticker ?? false,
    }),
  );
  return { message, result };
}

async function eventFor(messageId: string) {
  return prisma.customerMoodEvent.findUnique({ where: { messageId } });
}

/** Records and analyses one message; returns the event after analysis. */
async function analyse(opts: Parameters<typeof signal>[0], aiClient?: AiClient | null) {
  const { message } = await signal(opts);
  const event = await eventFor(message.id);
  if (!event) return { message, event: null };
  await inIsp(() => analyzeMoodEvent(event.id, aiClient === undefined ? {} : { aiClient }));
  return { message, event: await prisma.customerMoodEvent.findUniqueOrThrow({ where: { id: event.id } }) };
}

const fakeAi = (text: string): AiClient => ({ complete: async () => ({ text, tokensUsed: 1, providerId: "fake", modelId: "fake" }) }) as unknown as AiClient;

beforeAll(async () => {
  savedSettings = await prisma.moodDetectionSettings.findUnique({ where: { id: "global" } });
  const automation = await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  savedAutomation = {
    automationEnabled: automation.automationEnabled,
    mode: automation.mode,
    whatsappNotificationGroupIds: automation.whatsappNotificationGroupIds,
    teamsWebhookUrl: automation.teamsWebhookUrl,
  };
  const primary = await prisma.whatsAppAccount.findFirst({ where: { isPrimary: true } });
  savedPrimaryId = primary?.id ?? null;
  if (primary) await prisma.whatsAppAccount.update({ where: { id: primary.id }, data: { isPrimary: false } });

  account = await prisma.whatsAppAccount.create({ data: { label: `Mood ${randomUUID()}`, status: "CONNECTED", isPrimary: true } });
  secondAccount = await prisma.whatsAppAccount.create({ data: { label: `Mood 2 ${randomUUID()}`, status: "CONNECTED" } });
});

beforeEach(async () => {
  const id = waGroupId();
  group = await prisma.whatsAppGroup.create({ data: { accountId: account.id, whatsappGroupId: id, name: `Mood Group ${seq}`, isMonitored: true, isActive: true, chatReviewedAt: new Date() } });
  twinGroup = await prisma.whatsAppGroup.create({ data: { accountId: secondAccount.id, whatsappGroupId: id, name: `Mood Group ${seq}`, isMonitored: true, isActive: true, chatReviewedAt: new Date() } });
  internalGroup = await prisma.whatsAppGroup.create({ data: { accountId: account.id, whatsappGroupId: waGroupId(), name: "Escalations", isMonitored: true, isActive: true } });
  await setSettings({ enabled: true, internalGroupIds: [internalGroup.whatsappGroupId], policies: DEFAULT_MOOD_POLICIES as unknown as Prisma.InputJsonValue, sensitivity: "BALANCED", cooldownMinutes: 30, useAiClassification: false });
  await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: true, mode: "FULL_RULE_AUTOMATION" } });
});

afterEach(async () => {
  const accounts = [account.id, secondAccount.id];
  await prisma.moodAlert.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.customerMoodEvent.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.notification.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.outboundMessage.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.message.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.whatsAppGroup.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.notificationEventSetting.deleteMany({ where: { event: "MOOD_ALERT" } });
  await prisma.whatsAppServiceRoute.deleteMany({ where: { serviceKey: "NOTIFY_WHATSAPP", accountId: { in: accounts } } });
  if (memberIds.length) {
    await prisma.internalTeamMember.deleteMany({ where: { id: { in: memberIds } } });
    memberIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.whatsAppAccount.deleteMany({ where: { id: { in: [account.id, secondAccount.id] } } });
  if (savedPrimaryId) await prisma.whatsAppAccount.update({ where: { id: savedPrimaryId }, data: { isPrimary: true } }).catch(() => undefined);
  if (savedSettings) {
    const { id: _id, projectId: _p, updatedAt: _u, ...rest } = savedSettings;
    await prisma.moodDetectionSettings.update({ where: { id: "global" }, data: { ...rest, policies: (rest.policies ?? undefined) as Prisma.InputJsonValue | undefined } });
  } else {
    await prisma.moodDetectionSettings.deleteMany({});
  }
  if (savedAutomation) {
    await prisma.automationSettings.update({
      where: { id: "global" },
      data: { ...savedAutomation, mode: savedAutomation.mode as never },
    });
  }
  await prisma.$disconnect();
});

describe("the pipeline pre-filter", () => {
  it("an ordinary message writes nothing", async () => {
    const { message, result } = await signal({ body: "please check my bill", sender: phone() });
    expect(result.recorded).toBe(false);
    expect(await eventFor(message.id)).toBeNull();
  });

  it("a team member's message never triggers, whatever it says", async () => {
    const { message } = await signal({ body: "worst service 😡😡", sender: phone(), fromTeam: true });
    expect(await eventFor(message.id)).toBeNull();
  });

  it("nothing happens while Mood Detection is off", async () => {
    await setSettings({ enabled: false });
    const { message } = await signal({ body: "worst service 😡", sender: phone() });
    expect(await eventFor(message.id)).toBeNull();
  });

  it("an unmonitored group and the internal escalation group are never read", async () => {
    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { isMonitored: false } });
    group = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: group.id } });
    const first = await signal({ body: "worst service 😡", sender: phone() });
    expect(await eventFor(first.message.id)).toBeNull();
    const second = await signal({ body: "worst service 😡", sender: phone(), groupRow: internalGroup });
    expect(await eventFor(second.message.id)).toBeNull();
  });

  it("an angry customer is recorded once and AI is paused at once in every account's copy of the group", async () => {
    const { message, result } = await signal({ body: "Worst service ever 😡", sender: phone() });
    expect(result.recorded).toBe(true);
    expect(result.aiSuppressedUntil).toBeInstanceOf(Date);
    const event = await eventFor(message.id);
    expect(event).toMatchObject({ mood: "ANGRY", status: "PENDING" });
    expect(event!.signals).toEqual(expect.arrayContaining(["STRONG_NEGATIVE_LANGUAGE", "ANGRY_EMOJI"]));
    const copies = await prisma.whatsAppGroup.findMany({ where: { whatsappGroupId: group.whatsappGroupId } });
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(copy.aiSuppressedUntil!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it("is idempotent per message: a replay and the second account's copy add nothing", async () => {
    const sender = phone();
    const whatsappMessageId = randomUUID();
    const { message } = await signal({ body: "worst service 😡", sender, whatsappMessageId });
    const replay = await inIsp(() =>
      recordMoodSignal({ messageId: message.id, accountId: account.id, whatsappGroupId: group.whatsappGroupId, whatsappMessageId, chatId: group.whatsappGroupId, group, isFromTeamMember: false, senderPhone: sender, body: message.body, timestampWa: message.timestampWa, isSticker: false }),
    );
    expect(replay.recorded).toBe(false);
    await signal({ body: "worst service 😡", sender, whatsappMessageId, groupRow: twinGroup });
    expect(await prisma.customerMoodEvent.count({ where: { whatsappGroupId: group.whatsappGroupId } })).toBe(1);
  });

  it("a sticker is recorded as an unknown signal and never acted on", async () => {
    const { event } = await analyse({ body: "[Sticker]", sender: phone(), isSticker: true });
    expect(event).toMatchObject({ mood: "NEUTRAL", triggered: false, status: "ANALYZED", alertId: null });
    expect(event!.signals).toEqual(["UNKNOWN_STICKER_SIGNAL"]);
  });
});

describe("the processor: one alert per escalation", () => {
  it("an angry reading opens one alert with the policy's actions", async () => {
    const { event } = await analyse({ body: "Worst service ever 😡", sender: phone() });
    expect(event).toMatchObject({ triggered: true, status: "ANALYZED" });
    const alert = await prisma.moodAlert.findUniqueOrThrow({ where: { id: event!.alertId! }, include: { actions: true } });
    expect(alert).toMatchObject({ mood: "ANGRY", level: 3, priority: "HIGH", triggerCount: 1 });
    expect(alert.actions.map((a) => a.action).sort()).toEqual(["CONVERSATION", "INTERNAL_ALERT", "NEEDS_ATTENTION", "NOTIFY_TEAM"]);
  });

  it("further angry messages inside the cooldown attach to it and alert nobody again", async () => {
    const sender = phone();
    const first = await analyse({ body: "Worst service ever 😡", sender });
    await prisma.moodAlertAction.updateMany({ where: { alertId: first.event!.alertId! }, data: { status: "DONE" } });
    const second = await analyse({ body: "useless, terrible 😡", sender });
    expect(second.event!.alertId).toBe(first.event!.alertId);
    const alert = await prisma.moodAlert.findUniqueOrThrow({ where: { id: first.event!.alertId! }, include: { actions: true } });
    expect(alert.triggerCount).toBe(2);
    expect(alert.actions).toHaveLength(4);
    expect(alert.actions.every((a) => a.status === "DONE")).toBe(true);
    expect(await prisma.moodAlert.count({ where: { whatsappGroupId: group.whatsappGroupId } })).toBe(1);
  });

  it("a rise to very angry inside the cooldown escalates the same alert and alerts again at the new level", async () => {
    const sender = phone();
    const first = await analyse({ body: "Worst service ever 😡", sender });
    await prisma.moodAlertAction.updateMany({ where: { alertId: first.event!.alertId! }, data: { status: "DONE" } });
    const second = await analyse({ body: "I am very angry, worst service, I will complain to your manager 😡", sender });
    expect(second.event!.mood).toBe("VERY_ANGRY");
    expect(second.event!.alertId).toBe(first.event!.alertId);
    const alert = await prisma.moodAlert.findUniqueOrThrow({ where: { id: first.event!.alertId! }, include: { actions: true } });
    expect(alert).toMatchObject({ mood: "VERY_ANGRY", level: 4, priority: "CRITICAL" });
    const byAction = Object.fromEntries(alert.actions.map((a) => [a.action, a.status]));
    expect(byAction).toMatchObject({ NOTIFY_TEAM: "PENDING", INTERNAL_ALERT: "PENDING", CONVERSATION: "PENDING" });
  });

  it("a sticker in between does not break the trend", async () => {
    const sender = phone();
    await analyse({ body: "internet still not working", sender, at: new Date(Date.now() - 30 * 60_000) });
    await analyse({ body: "barbar eki problem 😤", sender, at: new Date(Date.now() - 20 * 60_000) });
    await analyse({ body: "[Sticker]", sender, isSticker: true, at: new Date(Date.now() - 10 * 60_000) });
    const { event } = await analyse({ body: "Worst service ever 😡", sender });
    expect(event!.previousMood).toBe("FRUSTRATED");
    expect(event!.mood).toBe("VERY_ANGRY");
  });

  it("after the cooldown a new escalation opens a new alert", async () => {
    const sender = phone();
    const first = await analyse({ body: "Worst service ever 😡", sender });
    await prisma.moodAlert.update({ where: { id: first.event!.alertId! }, data: { cooldownUntil: new Date(Date.now() - 1000) } });
    const second = await analyse({ body: "useless, terrible 😡", sender });
    expect(second.event!.alertId).not.toBe(first.event!.alertId);
  });

  it("respects the threshold and the emotion switch", async () => {
    const concerned = await analyse({ body: "internet still not working, when will it be fixed?", sender: phone() });
    expect(concerned.event).toMatchObject({ mood: "CONCERNED", triggered: false, alertId: null });

    await setSettings({ policies: { ...DEFAULT_MOOD_POLICIES, ANGRY: { ...DEFAULT_MOOD_POLICIES.ANGRY, trigger: false } } as unknown as Prisma.InputJsonValue });
    const angry = await analyse({ body: "Worst service ever 😡", sender: phone() });
    expect(angry.event).toMatchObject({ mood: "ANGRY", triggered: false, alertId: null });
    expect(angry.event!.decisionNote).toMatch(/not a trigger/);
  });

  it("asks the AI only about an ambiguous reading, and never sends it a name or number", async () => {
    await setSettings({ useAiClassification: true });
    const sender = phone();
    const prompts: string[] = [];
    const client = { complete: async (req: { userPrompt: string }) => { prompts.push(req.userPrompt); return { text: "MOOD: ANGRY\nCONFIDENCE: 90\nSIGNALS: STRONG_NEGATIVE_LANGUAGE", tokensUsed: 1, providerId: "f", modelId: "f" }; } } as unknown as AiClient;
    const { event } = await analyse({ body: "wow amazing service 😡", sender }, client);
    expect(event).toMatchObject({ aiRequested: true, aiUsed: true, mood: "ANGRY", triggered: true });
    expect(event!.signals).toContain("AI_CLASSIFIED");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("[CUSTOMER]");
    expect(prompts[0]).not.toContain(sender);

    const clear = await analyse({ body: "Worst service ever 😡", sender: phone() }, client);
    expect(clear.event!.aiRequested).toBe(false);
    expect(prompts).toHaveLength(1);
  });

  it("an unreadable AI answer leaves the rule-based reading in place", async () => {
    await setSettings({ useAiClassification: true });
    const { event } = await analyse({ body: "wow amazing service 😡", sender: phone() }, fakeAi("The customer seems annoyed."));
    expect(event).toMatchObject({ aiUsed: false, triggered: false });
    expect(event!.decisionNote).toMatch(/could not be read/);
  });

  it("a reading that throws is retried, then left FAILED", async () => {
    const message = await storeMessage({ body: "x", sender: phone() });
    const bad = await prisma.customerMoodEvent.create({
      data: { messageId: message.id, accountId: account.id, groupId: group.id, whatsappGroupId: group.whatsappGroupId, customerKey: message.senderPhone, messageAt: message.timestampWa, mood: "FURIOUS", confidence: 0.9, status: "PENDING", scheduledAt: new Date(Date.now() - 60_000) },
    });
    for (let i = 0; i < 3; i += 1) {
      await prisma.customerMoodEvent.update({ where: { id: bad.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } });
      // Other suites' rows are not left PENDING, so the oldest due row is this one.
      expect(await processNextMoodEvent()).toBe(true);
    }
    const after = await prisma.customerMoodEvent.findUniqueOrThrow({ where: { id: bad.id } });
    expect(after).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(after.lastError).toMatch(/Unknown stored mood/);
  });

  it("work left PROCESSING by a dead worker goes back to the queue", async () => {
    const { message } = await signal({ body: "Worst service ever 😡", sender: phone() });
    const event = (await eventFor(message.id))!;
    await rawPrisma.$executeRaw`UPDATE "CustomerMoodEvent" SET status = 'PROCESSING', "updatedAt" = now() - interval '10 minutes' WHERE id = ${event.id}`;
    expect(await recoverStuckMoodWork()).toBeGreaterThanOrEqual(1);
    expect((await eventFor(message.id))!.status).toBe("PENDING");
  });
});

describe("actions", () => {
  async function alertWithActions(body = "Worst service ever 😡") {
    const { event } = await analyse({ body, sender: phone() });
    return prisma.moodAlert.findUniqueOrThrow({ where: { id: event!.alertId! }, include: { actions: true } });
  }
  const actionId = (alert: { actions: Array<{ id: string; action: string }> }, action: string) => alert.actions.find((a) => a.action === action)!.id;

  it("needs attention puts the conversation back in every inbox's Waiting list", async () => {
    const alert = await alertWithActions();
    const outcome = await inIsp(() => runMoodAction(actionId(alert, "NEEDS_ATTENTION")));
    expect(outcome.done).toBe(true);
    const copies = await prisma.whatsAppGroup.findMany({ where: { whatsappGroupId: group.whatsappGroupId } });
    expect(copies.every((c) => c.chatReviewedAt === null)).toBe(true);
  });

  it("the team alert goes through Notification Center routing as MOOD_ALERT, and a mute writes nothing", async () => {
    await prisma.whatsAppServiceRoute.upsert({
      where: { projectId_serviceKey: { projectId: ISP_DIGITAL, serviceKey: "NOTIFY_WHATSAPP" } },
      update: { accountId: account.id, enabled: true },
      create: { serviceKey: "NOTIFY_WHATSAPP", accountId: account.id, enabled: true },
    });
    const destination = waGroupId();
    await prisma.notificationEventSetting.upsert({
      where: { projectId_event: { projectId: ISP_DIGITAL, event: "MOOD_ALERT" } },
      update: { enabled: true, whatsappGroupIds: [destination] },
      create: { event: "MOOD_ALERT", enabled: true, whatsappGroupIds: [destination] },
    });
    const alert = await alertWithActions();
    const outcome = await inIsp(() => runMoodAction(actionId(alert, "NOTIFY_TEAM")));
    expect(outcome.done).toBe(true);
    const sent = await prisma.notification.findFirstOrThrow({ where: { destination } });
    expect(sent).toMatchObject({ event: "MOOD_ALERT", type: "WHATSAPP", accountId: account.id });
    expect(sent.payload).toMatchObject({ alertKind: "MOOD_ALERT", priority: "HIGH", groupName: group.name });

    await prisma.notificationEventSetting.update({ where: { projectId_event: { projectId: ISP_DIGITAL, event: "MOOD_ALERT" } }, data: { enabled: false } });
    const muted = await alertWithActions();
    const mutedOutcome = await inIsp(() => runMoodAction(actionId(muted, "NOTIFY_TEAM")));
    expect(mutedOutcome).toMatchObject({ done: false, detail: expect.stringMatching(/muted/) });
    expect(await prisma.notification.count({ where: { destination } })).toBe(1);
  });

  it("the internal alert tags the group's assigned member with a structured mention", async () => {
    const member = await prisma.internalTeamMember.create({ data: { name: `Mood Owner ${seq}`, phoneNumber: `+${phone()}`, role: "Support", status: "ACTIVE" } });
    memberIds.push(member.id);
    await prisma.whatsAppGroup.updateMany({ where: { whatsappGroupId: group.whatsappGroupId }, data: { assignedTeamMemberId: member.id } });
    const alert = await alertWithActions();
    const outcome = await inIsp(() => runMoodAction(actionId(alert, "INTERNAL_ALERT")));
    expect(outcome.done).toBe(true);
    const sent = await prisma.notification.findFirstOrThrow({ where: { destination: internalGroup.whatsappGroupId } });
    const digits = member.phoneNumber.replace(/\D/g, "");
    expect(sent.payload).toMatchObject({ mentions: [`${digits}@c.us`], mentionTags: `@${digits}`, assignedTo: member.name });
  });

  it("the customer message is sent once per alert, from the Primary number, and never past the kill switch", async () => {
    await setSettings({ policies: { ...DEFAULT_MOOD_POLICIES, ANGRY: { ...DEFAULT_MOOD_POLICIES.ANGRY, customerMessage: true } } as unknown as Prisma.InputJsonValue });
    const alert = await alertWithActions();
    const id = actionId(alert, "CUSTOMER_MESSAGE");
    expect((await inIsp(() => runMoodAction(id))).done).toBe(true);
    expect((await inIsp(() => runMoodAction(id))).done).toBe(false);
    const rows = await prisma.outboundMessage.findMany({ where: { chatId: group.whatsappGroupId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(account.id);
    expect(rows[0]!.idempotencyKey.endsWith(`:${MOOD_CUSTOMER_MESSAGE_VARIANT}`)).toBe(true);
    // It is not an answer: the AI reply cooldown does not count it, so the customer's next message
    // can still be answered.
    expect(await inIsp(() => isCooldownActive({ accountId: account.id, toPhone: rows[0]!.toPhone, ruleId: null, cooldownSeconds: 300 }))).toBe(false);

    await prisma.automationSettings.update({ where: { id: "global" }, data: { automationEnabled: false } });
    const blocked = await alertWithActions("useless, terrible service 😡 really worst");
    await prisma.moodAlert.update({ where: { id: blocked.id }, data: {} });
    // A new customer in the same group gets their own alert.
    const outcome = await inIsp(() => runMoodAction(actionId(blocked, "CUSTOMER_MESSAGE")));
    expect(outcome).toMatchObject({ done: false, detail: expect.stringMatching(/kill switch/) });
  });

  it("the conversation action only ever extends the pause", async () => {
    const alert = await alertWithActions();
    const far = new Date(Date.now() + 10 * 3_600_000);
    await prisma.whatsAppGroup.updateMany({ where: { whatsappGroupId: group.whatsappGroupId }, data: { aiSuppressedUntil: far } });
    const outcome = await inIsp(() => runMoodAction(actionId(alert, "CONVERSATION")));
    expect(outcome.detail).toMatch(/already held back/);
    const copy = await prisma.whatsAppGroup.findUniqueOrThrow({ where: { id: group.id } });
    expect(copy.aiSuppressedUntil!.getTime()).toBe(far.getTime());
  });
});

describe("the pipeline: an angry customer is not answered by AI in the same breath", () => {
  it("the AI fallback is skipped for the message that paused it — and runs when Mood Detection is off", async () => {
    const ai = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
    const activeRules = (await prisma.automationRule.findMany({ where: { status: "ACTIVE" }, select: { id: true } })).map((r) => r.id);
    await prisma.automationRule.updateMany({ where: { id: { in: activeRules } }, data: { status: "DISABLED" } });
    await prisma.aiSettings.update({
      where: { id: "global" },
      data: { aiEngineEnabled: true, autoResponseEnabled: true, autoResponseConfidenceThreshold: 90, aiResponseMode: "KNOWLEDGE_PLUS_GENERAL", generalAnswerMinConfidence: 90, aiAutomationScope: "PER_GROUP", unableToUnderstandReplyEnabled: false, mentionTeamOnHandover: false },
    });
    await prisma.whatsAppGroup.update({ where: { id: group.id }, data: { aiAutomationEnabled: true } });
    try {
      const send = async (client: MockAiClient) => {
        client.nextText = ["INTENT: complaint", "SCOPE: GENERAL", "CONFIDENCE: 96", "SHOULD_REPLY: YES", "RESPONSE: Happy to help!"].join("\n");
        await processIncomingMessage(
          { accountId: account.id, whatsappMessageId: randomUUID(), whatsappGroupId: group.whatsappGroupId, chatId: group.whatsappGroupId, senderPhone: phone(), direction: "INCOMING", body: "Worst service ever 😡", timestampWa: new Date() },
          client,
        );
      };
      const paused = new MockAiClient();
      await send(paused);
      expect(paused.requests).toHaveLength(0);
      expect(await prisma.customerMoodEvent.count({ where: { whatsappGroupId: group.whatsappGroupId } })).toBe(1);

      await setSettings({ enabled: false });
      await prisma.whatsAppGroup.updateMany({ where: { whatsappGroupId: group.whatsappGroupId }, data: { aiSuppressedUntil: null } });
      const control = new MockAiClient();
      await send(control);
      expect(control.requests).toHaveLength(1);
    } finally {
      await prisma.aiFallbackDecision.deleteMany({ where: { accountId: account.id } });
      await prisma.aiSettings.update({ where: { id: "global" }, data: ai as unknown as Prisma.AiSettingsUpdateInput });
      await prisma.automationRule.updateMany({ where: { id: { in: activeRules } }, data: { status: "ACTIVE" } });
    }
  });
});

describe("project isolation", () => {
  it("another project's switch decides for its own messages, and its rows stay in that project", async () => {
    const tag = randomUUID().slice(0, 8);
    const owner = await rawPrisma.user.create({ data: { username: `mood_${tag}`, email: `mood_${tag}@example.test`, name: "Mood", passwordHash: "x" } });
    const biz = await createProjectWithDefaults({ name: `Mood Biz ${tag}`, slug: `mood-biz-${tag}`, status: "ACTIVE", creatorUserId: owner.id }, rawPrisma);
    try {
      const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: "Mood Biz", status: "CONNECTED" } });
      const bizGroup = await rawPrisma.whatsAppGroup.create({ data: { projectId: biz.id, accountId: bizAccount.id, whatsappGroupId: waGroupId(), name: "Biz", isMonitored: true, isActive: true } });
      const send = async () => {
        const message = await rawPrisma.message.create({
          data: { projectId: biz.id, accountId: bizAccount.id, groupId: bizGroup.id, whatsappMessageId: randomUUID(), chatId: bizGroup.whatsappGroupId, senderPhone: phone(), direction: "INCOMING", body: "Worst service ever 😡", normalizedBody: "worst service ever", timestampWa: new Date(), processingStatus: "PROCESSED" },
        });
        await withProject(biz.id, () =>
          recordMoodSignal({ messageId: message.id, accountId: bizAccount.id, whatsappGroupId: bizGroup.whatsappGroupId, whatsappMessageId: message.whatsappMessageId, chatId: bizGroup.whatsappGroupId, group: bizGroup, isFromTeamMember: false, senderPhone: message.senderPhone, body: message.body, timestampWa: message.timestampWa, isSticker: false }),
        );
        return rawPrisma.customerMoodEvent.findUnique({ where: { messageId: message.id } });
      };
      // ISP Digital has Mood Detection on; the new project starts with it off.
      expect(await send()).toBeNull();
      await rawPrisma.moodDetectionSettings.update({ where: { projectId: biz.id }, data: { enabled: true } });
      const event = await send();
      expect(event!.projectId).toBe(biz.id);
      await withProject(biz.id, () => analyzeMoodEvent(event!.id));
      const alert = await rawPrisma.moodAlert.findFirstOrThrow({ where: { accountId: bizAccount.id } });
      expect(alert.projectId).toBe(biz.id);
      // ISP Digital's client cannot see it.
      expect(await prisma.moodAlert.count({ where: { id: alert.id } })).toBe(0);
    } finally {
      const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
      for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, biz.id).catch(() => undefined);
      await rawPrisma.project.deleteMany({ where: { id: biz.id } });
      await rawPrisma.projectAccess.deleteMany({ where: { userId: owner.id } });
      await rawPrisma.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    }
  });
});
