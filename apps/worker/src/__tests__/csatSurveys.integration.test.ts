import "./helpers/requireTestDatabase.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createProjectWithDefaults } from "@support-automation/db";
import { CSAT_SURVEY_VARIANT, DEFAULT_CSAT_QUESTION } from "@support-automation/shared";
import { inIsp, ISP_DIGITAL, prisma, rawPrisma } from "./helpers/projectFixtures.js";
import { resetProjectCachesForTests, withProject } from "../project/context.js";
import { resetProjectFeatureCacheForTests } from "../project/features.js";
import { dispatchPendingCsatSurveys, recordCsatAnswerFromChannel, recordCsatAnswerFromWhatsApp, runCsatSurveyTick } from "../csat/csatSurveys.js";
import { isCooldownActive } from "../queue/cooldown.js";

/**
 * Satisfaction surveys in the worker (csat/csatSurveys.ts, CSAT.md): one survey per resolution asked through the
 * channel's one send queue, the cooldown, the refusals (group, team member, kill switch, MANUAL_ONLY, reply
 * window, a reopened conversation, the feature off), project isolation, and reading the customer's next message
 * as the answer — once, and never changed afterwards.
 */

const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const digits = `${Date.now()}`.slice(-7);
let seq = 0;
const phone = () => `88017${digits}${String(++seq).padStart(3, "0")}`;
const NOW = new Date();
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const ids = { accounts: [] as string[], connections: [] as string[], members: [] as string[], projects: [] as string[] };
let accountId = "";
let telegram = "";
let messenger = "";
let webchat = "";
let creatorId = "";

async function feature(projectId: string, key: string, enabled: boolean) {
  await rawPrisma.projectFeature.upsert({ where: { projectId_key: { projectId, key } }, create: { projectId, key, enabled }, update: { enabled } });
  resetProjectFeatureCacheForTests();
}
async function csatSettings(projectId: string, data: Partial<{ cooldownDays: number; whatsappPersonalEnabled: boolean; telegramEnabled: boolean }> = {}) {
  const all = { whatsappPersonalEnabled: true, webchatEnabled: true, messengerEnabled: true, instagramEnabled: true, telegramEnabled: true, cooldownDays: 7, questionText: null, ...data };
  await rawPrisma.csatSettings.upsert({ where: { projectId }, create: { projectId, ...all }, update: all });
}
async function automation(data: Record<string, unknown> = {}) {
  await prisma.automationSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
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
      ...data,
    },
  });
}

/** A WhatsApp personal chat the customer wrote in and a person resolved at `resolvedAt`, with its PENDING survey. */
async function resolvedWhatsApp(opts: { chatId?: string; resolvedAt?: Date; customerKey?: string } = {}) {
  const customer = phone();
  const chatId = opts.chatId ?? `${customer}@c.us`;
  const resolvedAt = opts.resolvedAt ?? minutesAgo(1);
  const message = await prisma.message.create({
    data: { accountId, whatsappMessageId: `false_${chatId}_${randomUUID()}`, chatId, senderPhone: chatId.split("@")[0]!, direction: "INCOMING", body: "my internet is down", normalizedBody: "my internet is down", timestampWa: minutesAgo(20) },
  });
  await prisma.whatsAppConversationState.upsert({
    where: { projectId_accountId_chatId: { projectId: ISP_DIGITAL, accountId, chatId } },
    create: { projectId: ISP_DIGITAL, accountId, chatId, conversationType: "PERSONAL", status: "RESOLVED", statusChangedAt: resolvedAt, resolvedAt },
    update: { status: "RESOLVED", statusChangedAt: resolvedAt, resolvedAt, snoozedUntil: null },
  });
  const survey = await newWhatsAppSurvey(chatId, resolvedAt, opts.customerKey);
  return { chatId, survey, message };
}
async function newWhatsAppSurvey(chatId: string, resolvedAt: Date, customerKey?: string) {
  const event = await prisma.conversationEvent.create({ data: { projectId: ISP_DIGITAL, accountId, chatId, kind: "RESOLVE", fromValue: "OPEN", toValue: "RESOLVED" } });
  return prisma.csatSurvey.create({
    data: { projectId: ISP_DIGITAL, channel: "WHATSAPP_PERSONAL", accountId, chatId, resolutionEventId: event.id, customerKey: customerKey ?? `wa:${chatId}`, resolvedAt },
  });
}
async function resolvedChannel(connectionId: string, type: "TELEGRAM" | "MESSENGER" | "WEBCHAT", opts: { lastInboundAt?: Date; kind?: "DIRECT" | "GROUP" } = {}) {
  const resolvedAt = minutesAgo(1);
  const thread = `t-${randomUUID()}`;
  const conversation = await prisma.channelConversation.create({
    data: { projectId: ISP_DIGITAL, connectionId, type, externalThreadId: thread, kind: opts.kind ?? "DIRECT", status: "CLOSED", closedAt: resolvedAt, statusChangedAt: resolvedAt, lastInboundAt: opts.lastInboundAt ?? minutesAgo(10) },
  });
  const event = await prisma.conversationEvent.create({ data: { projectId: ISP_DIGITAL, channelConversationId: conversation.id, kind: "RESOLVE", fromValue: "OPEN", toValue: "RESOLVED" } });
  const survey = await prisma.csatSurvey.create({
    data: { projectId: ISP_DIGITAL, channel: type, channelConversationId: conversation.id, resolutionEventId: event.id, customerKey: `ch:${connectionId}:${thread}`, resolvedAt },
  });
  return { conversation, survey };
}
const surveyOf = (id: string) => rawPrisma.csatSurvey.findUniqueOrThrow({ where: { id } });
const dispatch = (now = NOW) => inIsp(() => dispatchPendingCsatSurveys(now));
const outboundsFor = (chatId: string) => rawPrisma.outboundMessage.findMany({ where: { accountId, chatId } });

beforeAll(async () => {
  resetProjectCachesForTests();
  accountId = (await prisma.whatsAppAccount.create({ data: { label: `CSAT ${tag}`, status: "CONNECTED", phoneNumber: `88019${digits}999` } })).id;
  ids.accounts.push(accountId);
  telegram = (await prisma.channelConnection.create({ data: { type: "TELEGRAM", name: "@csat", status: "CONNECTED", webhookKey: `csat-t-${tag}` } })).id;
  messenger = (await prisma.channelConnection.create({ data: { type: "MESSENGER", name: "csat page", status: "CONNECTED", webhookKey: `csat-m-${tag}`, humanAgentEnabled: true } })).id;
  webchat = (await prisma.channelConnection.create({ data: { type: "WEBCHAT", name: "csat site", status: "CONNECTED", webhookKey: `csat-w-${tag}-abcdefghijkl` } })).id;
  ids.connections.push(telegram, messenger, webchat);
  creatorId = (await rawPrisma.user.create({ data: { username: `csat_${tag}`, email: `csat_${tag}@example.test`, name: "Creator", passwordHash: "x" } })).id;
});

beforeEach(async () => {
  await feature(ISP_DIGITAL, "CSAT_SURVEYS", true);
  await feature(ISP_DIGITAL, "OMNICHANNEL", true);
  await csatSettings(ISP_DIGITAL);
  await automation();
});

afterAll(async () => {
  await rawPrisma.csatSurvey.deleteMany({ where: { OR: [{ accountId: { in: ids.accounts } }, { channelConversation: { connectionId: { in: ids.connections } } }] } });
  await rawPrisma.outboundMessage.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.conversationEvent.deleteMany({ where: { OR: [{ accountId: { in: ids.accounts } }, { channelConversation: { connectionId: { in: ids.connections } } }] } });
  await rawPrisma.whatsAppConversationState.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.message.deleteMany({ where: { accountId: { in: ids.accounts } } });
  await rawPrisma.channelMessage.deleteMany({ where: { connectionId: { in: ids.connections } } });
  await rawPrisma.channelConversation.deleteMany({ where: { connectionId: { in: ids.connections } } });
  await rawPrisma.channelConnection.deleteMany({ where: { id: { in: ids.connections } } });
  await rawPrisma.internalTeamMember.deleteMany({ where: { id: { in: ids.members } } });
  await rawPrisma.whatsAppAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await rawPrisma.csatSettings.deleteMany({ where: { projectId: ISP_DIGITAL } });
  await rawPrisma.projectFeature.deleteMany({ where: { projectId: ISP_DIGITAL, key: "CSAT_SURVEYS" } });
  const tables = (await rawPrisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.columns WHERE column_name = 'projectId' AND table_schema = 'public'`).map((r) => r.table_name);
  for (const projectId of ids.projects) {
    for (let pass = 0; pass < 4; pass++) for (const t of tables) await rawPrisma.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "projectId" = $1`, projectId).catch(() => undefined);
    await rawPrisma.project.deleteMany({ where: { id: projectId } });
  }
  await rawPrisma.user.deleteMany({ where: { id: creatorId } });
  resetProjectFeatureCacheForTests();
  await rawPrisma.$disconnect();
});

describe("asking on WhatsApp — one survey per resolution, through the outbound queue", () => {
  it("queues exactly one AUTO_REPLY with the survey's own variant, and a second pass sends nothing more", async () => {
    const { chatId, survey, message } = await resolvedWhatsApp();
    expect(await dispatch()).toBe(1);
    expect(await dispatch()).toBe(0);
    const rows = await outboundsFor(chatId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionType: "AUTO_REPLY", body: DEFAULT_CSAT_QUESTION, relatedMessageId: message.id, toPhone: chatId.split("@")[0], ruleId: null });
    expect(rows[0]!.idempotencyKey.endsWith(`:${CSAT_SURVEY_VARIANT}`)).toBe(true);
    expect(await surveyOf(survey.id)).toMatchObject({ status: "SENT", outboundMessageId: rows[0]!.id, question: DEFAULT_CSAT_QUESTION });
  });

  it("a re-run after a crash between queueing and recording attaches the same message, never a second one", async () => {
    const { chatId, survey } = await resolvedWhatsApp();
    await dispatch();
    await rawPrisma.csatSurvey.update({ where: { id: survey.id }, data: { status: "PENDING", sentAt: null, outboundMessageId: null } });
    await dispatch();
    const rows = await outboundsFor(chatId);
    expect(rows).toHaveLength(1);
    expect(await surveyOf(survey.id)).toMatchObject({ status: "SENT", outboundMessageId: rows[0]!.id });
  });

  it("the cooldown: a second resolution of the same customer within the window is not asked", async () => {
    const { chatId } = await resolvedWhatsApp();
    await dispatch();
    // The customer wrote again and the conversation was resolved again.
    await prisma.message.create({
      data: { accountId, whatsappMessageId: `false_${chatId}_${randomUUID()}`, chatId, senderPhone: chatId.split("@")[0]!, direction: "INCOMING", body: "again", normalizedBody: "again", timestampWa: minutesAgo(2) },
    });
    const resolvedAt = minutesAgo(0.5);
    await prisma.whatsAppConversationState.updateMany({ where: { accountId, chatId }, data: { statusChangedAt: resolvedAt } });
    const second = await newWhatsAppSurvey(chatId, resolvedAt);
    await dispatch();
    expect(await surveyOf(second.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("within the last 7 days") });
    expect(await outboundsFor(chatId)).toHaveLength(1);

    // Cooldown 0: every resolution may ask (a fresh customer message gives it its own outbound key).
    await csatSettings(ISP_DIGITAL, { cooldownDays: 0 });
    const third = await newWhatsAppSurvey(chatId, resolvedAt);
    await dispatch();
    expect(await surveyOf(third.id)).toMatchObject({ status: "SENT" });
    expect(await outboundsFor(chatId)).toHaveLength(2);
  });

  it("never to a team member", async () => {
    const memberPhone = phone();
    const member = await prisma.internalTeamMember.create({ data: { name: "Rakib", phoneNumber: `+${memberPhone}`, role: "Support", status: "ACTIVE" } });
    ids.members.push(member.id);
    const { chatId, survey } = await resolvedWhatsApp({ chatId: `${memberPhone}@c.us` });
    await dispatch();
    expect(await surveyOf(survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("team member") });
    expect(await outboundsFor(chatId)).toHaveLength(0);
  });

  it("never in a WhatsApp group — the database refuses the row", async () => {
    const chatId = `${tag}-${randomUUID().slice(0, 6)}@g.us`;
    const event = await prisma.conversationEvent.create({ data: { projectId: ISP_DIGITAL, accountId, chatId, kind: "RESOLVE", fromValue: "OPEN", toValue: "RESOLVED" } });
    await expect(
      prisma.csatSurvey.create({ data: { projectId: ISP_DIGITAL, channel: "WHATSAPP_PERSONAL", accountId, chatId, resolutionEventId: event.id, customerKey: `wa:${chatId}`, resolvedAt: NOW } }),
    ).rejects.toThrow(/CsatSurvey_never_a_group/);
  });

  it("the kill switch and MANUAL_ONLY: not asked, with the reason", async () => {
    await automation({ automationEnabled: false });
    const a = await resolvedWhatsApp();
    await dispatch();
    expect(await surveyOf(a.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("kill switch") });
    await automation({ mode: "MANUAL_ONLY" });
    const b = await resolvedWhatsApp();
    await dispatch();
    expect(await surveyOf(b.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("MANUAL_ONLY") });
    expect([...(await outboundsFor(a.chatId)), ...(await outboundsFor(b.chatId))]).toHaveLength(0);
  });

  it("a conversation reopened before the survey went out, a channel switched off, or a stale survey: not asked", async () => {
    const reopened = await resolvedWhatsApp();
    await prisma.whatsAppConversationState.updateMany({ where: { accountId, chatId: reopened.chatId }, data: { status: "OPEN", statusChangedAt: NOW } });
    const stale = await resolvedWhatsApp({ resolvedAt: minutesAgo(45) });
    await dispatch();
    expect(await surveyOf(reopened.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("reopened") });
    expect(await surveyOf(stale.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("30 minutes") });

    await csatSettings(ISP_DIGITAL, { whatsappPersonalEnabled: false });
    const off = await resolvedWhatsApp();
    await dispatch();
    expect(await surveyOf(off.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("switched off for this channel") });
  });

  it("the feature off: nothing is asked and nothing is read as an answer", async () => {
    const { chatId, survey } = await resolvedWhatsApp();
    await feature(ISP_DIGITAL, "CSAT_SURVEYS", false);
    expect(await dispatch()).toBe(0);
    expect(await surveyOf(survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("switched off") });
    expect(await outboundsFor(chatId)).toHaveLength(0);
  });

  it("a survey is not an AI answer: it does not arm the AI reply cooldown", async () => {
    const { chatId } = await resolvedWhatsApp();
    await dispatch();
    const [row] = await outboundsFor(chatId);
    await rawPrisma.outboundMessage.update({ where: { id: row!.id }, data: { status: "SENT", sentAt: NOW } });
    expect(await inIsp(() => isCooldownActive({ accountId, toPhone: row!.toPhone, ruleId: null, cooldownSeconds: 3600 }))).toBe(false);
  });
});

describe("asking on the channels", () => {
  it("Telegram: one QUEUED automated ChannelMessage keyed on the survey, no tag", async () => {
    const { conversation, survey } = await resolvedChannel(telegram, "TELEGRAM");
    await dispatch();
    await dispatch();
    const rows = await rawPrisma.channelMessage.findMany({ where: { conversationId: conversation.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: "OUTBOUND", senderType: "AI", deliveryStatus: "QUEUED", idempotencyKey: `csat:${survey.id}`, messagingTag: null });
    expect(await surveyOf(survey.id)).toMatchObject({ status: "SENT", channelMessageId: rows[0]!.id });
  });

  it("Messenger outside the 24-hour window: never asked, even with the Human Agent permission on", async () => {
    const { conversation, survey } = await resolvedChannel(messenger, "MESSENGER", { lastInboundAt: new Date(NOW.getTime() - 30 * 3_600_000) });
    await dispatch();
    expect(await surveyOf(survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("automated reply") });
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it("the kill switch and MANUAL_ONLY stop the channels and the website card too (nothing downstream would)", async () => {
    await automation({ automationEnabled: false });
    const telegramOff = await resolvedChannel(telegram, "TELEGRAM");
    const cardOff = await resolvedChannel(webchat, "WEBCHAT");
    await dispatch();
    expect(await surveyOf(telegramOff.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("kill switch") });
    expect(await surveyOf(cardOff.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("kill switch") });
    await automation({ mode: "MANUAL_ONLY" });
    const cardManual = await resolvedChannel(webchat, "WEBCHAT");
    await dispatch();
    expect(await surveyOf(cardManual.survey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("MANUAL_ONLY") });
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: telegramOff.conversation.id } })).toBe(0);
  });

  it("website chat: shown as a card — SENT, and nothing is sent anywhere", async () => {
    const { conversation, survey } = await resolvedChannel(webchat, "WEBCHAT");
    await dispatch();
    expect(await surveyOf(survey.id)).toMatchObject({ status: "SENT", channelMessageId: null, outboundMessageId: null });
    expect(await rawPrisma.channelMessage.count({ where: { conversationId: conversation.id } })).toBe(0);
  });
});

describe("reading the customer's next message", () => {
  async function sentSurvey() {
    const r = await resolvedWhatsApp();
    await dispatch();
    const [row] = await outboundsFor(r.chatId);
    await rawPrisma.outboundMessage.update({ where: { id: row!.id }, data: { status: "SENT", sentAt: minutesAgo(1) } });
    return r;
  }
  const reply = (chatId: string, body: string, at = NOW, fromCustomer = true) =>
    inIsp(() => recordCsatAnswerFromWhatsApp({ accountId, chatId, messageId: `m-${randomUUID()}`, body, at, fromCustomer }));

  it("a Bangla digit is the answer; a later message changes nothing", async () => {
    const { chatId, survey } = await sentSurvey();
    await reply(chatId, "৫");
    await reply(chatId, "1", new Date(NOW.getTime() + 1000));
    expect(await surveyOf(survey.id)).toMatchObject({ rating: 5, answerSource: "MESSAGE" });
  });

  it("anything else closes the survey unanswered, and a rating after that does not count", async () => {
    const { chatId, survey } = await sentSurvey();
    await reply(chatId, "5 days and still no internet");
    await reply(chatId, "5", new Date(NOW.getTime() + 1000));
    const row = await surveyOf(survey.id);
    expect(row.rating).toBeNull();
    expect(row.answerClosedAt).not.toBeNull();
  });

  it("a message before the survey actually went out, or from the team, is not read", async () => {
    const { chatId, survey } = await sentSurvey();
    await reply(chatId, "4", minutesAgo(3));
    await reply(chatId, "4", NOW, false);
    expect(await surveyOf(survey.id)).toMatchObject({ rating: null, answerClosedAt: null });
    await reply(chatId, "4/5");
    expect(await surveyOf(survey.id)).toMatchObject({ rating: 4 });
  });

  it("a channel message: the same rule", async () => {
    const { conversation, survey } = await resolvedChannel(telegram, "TELEGRAM");
    await dispatch();
    await rawPrisma.channelMessage.updateMany({ where: { conversationId: conversation.id }, data: { deliveryStatus: "SENT", sentAt: minutesAgo(1) } });
    await inIsp(() => recordCsatAnswerFromChannel({ conversationId: conversation.id, messageId: `cm-${tag}`, text: "⭐⭐⭐⭐", at: NOW }));
    expect(await surveyOf(survey.id)).toMatchObject({ rating: 4, answerSource: "MESSAGE" });
  });

  it("an answer is final: the database refuses to change it", async () => {
    const { chatId, survey } = await sentSurvey();
    await reply(chatId, "2");
    await expect(rawPrisma.csatSurvey.update({ where: { id: survey.id }, data: { rating: 5 } })).rejects.toThrow(/cannot be changed/);
    await expect(rawPrisma.$executeRaw`UPDATE "CsatSurvey" SET "comment" = 'edited' WHERE id = ${survey.id}`).rejects.toThrow(/cannot be changed/);
    expect(await surveyOf(survey.id)).toMatchObject({ rating: 2, comment: null });
  });

  it("the feature off: a rating is not read", async () => {
    const { chatId, survey } = await sentSurvey();
    await feature(ISP_DIGITAL, "CSAT_SURVEYS", false);
    await reply(chatId, "5");
    expect(await surveyOf(survey.id)).toMatchObject({ rating: null, answerClosedAt: null });
  });
});

describe("project isolation", () => {
  it("each project's surveys are asked under its own feature and settings, and a survey cannot name another project's chat", async () => {
    const biz = await createProjectWithDefaults({ name: `CSAT Biz ${tag}`, slug: `csat-biz-${tag}`, status: "ACTIVE", creatorUserId: creatorId }, rawPrisma);
    ids.projects.push(biz.id);
    resetProjectCachesForTests();
    const bizAccount = await rawPrisma.whatsAppAccount.create({ data: { projectId: biz.id, label: `CSAT Biz ${tag}`, status: "CONNECTED" } });
    const bizChat = `${phone()}@c.us`;
    const bizEvent = await rawPrisma.conversationEvent.create({ data: { projectId: biz.id, accountId: bizAccount.id, chatId: bizChat, kind: "RESOLVE", fromValue: "OPEN", toValue: "RESOLVED" } });
    const bizSurvey = await rawPrisma.csatSurvey.create({
      data: { projectId: biz.id, channel: "WHATSAPP_PERSONAL", accountId: bizAccount.id, chatId: bizChat, resolutionEventId: bizEvent.id, customerKey: `wa:${bizChat}`, resolvedAt: minutesAgo(1) },
    });
    // Biz never switched the feature on: its survey is skipped, ISP's is asked, in one tick over every project.
    const isp = await resolvedWhatsApp();
    await runCsatSurveyTick(NOW);
    expect(await surveyOf(isp.survey.id)).toMatchObject({ status: "SENT" });
    expect(await surveyOf(bizSurvey.id)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("switched off") });
    expect(await rawPrisma.outboundMessage.count({ where: { accountId: bizAccount.id } })).toBe(0);

    // ISP's dispatch never sees Biz's rows.
    const bizPending = await rawPrisma.csatSurvey.create({
      data: { projectId: biz.id, channel: "WHATSAPP_PERSONAL", accountId: bizAccount.id, chatId: bizChat, resolutionEventId: (await rawPrisma.conversationEvent.create({ data: { projectId: biz.id, accountId: bizAccount.id, chatId: bizChat, kind: "RESOLVE" } })).id, customerKey: `wa:${bizChat}`, resolvedAt: minutesAgo(1) },
    });
    await dispatch();
    expect(await surveyOf(bizPending.id)).toMatchObject({ status: "PENDING" });

    // A Biz survey naming ISP's account is refused by the database (the same-project trigger).
    const another = await rawPrisma.conversationEvent.create({ data: { projectId: biz.id, accountId: bizAccount.id, chatId: bizChat, kind: "RESOLVE" } });
    await expect(
      rawPrisma.csatSurvey.create({ data: { projectId: biz.id, channel: "WHATSAPP_PERSONAL", accountId, chatId: bizChat, resolutionEventId: another.id, customerKey: "x", resolvedAt: NOW } }),
    ).rejects.toThrow(/project/i);
    // And Biz's own dispatch, in its own context, reads only Biz's rows.
    await feature(biz.id, "CSAT_SURVEYS", true);
    await withProject(biz.id, () => dispatchPendingCsatSurveys(NOW));
    expect(await surveyOf(isp.survey.id)).toMatchObject({ status: "SENT" });
  });
});
