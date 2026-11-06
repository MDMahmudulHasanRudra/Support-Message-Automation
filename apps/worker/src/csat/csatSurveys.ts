import type { CsatChannel, CsatSurveyStatus, Prisma } from "@prisma/client";
import {
  CSAT_ANSWER_WINDOW_HOURS,
  CSAT_DISPATCH_MAX_DELAY_MINUTES,
  CSAT_SURVEY_VARIANT,
  channelMessagePreview,
  csatChannelEnabled,
  csatQuestionFor,
  decideReplyWindow,
  DEFAULT_CSAT_SWITCHES,
  parseCsatRating,
  validateChannelText,
  type ChannelType,
  type CsatChannelSwitches,
} from "@support-automation/shared";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { buildOutboundIdempotencyKey } from "../pipeline/idempotency.js";
import { checkAutoReplySafety } from "../pipeline/safety.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { resolveTeamSender } from "../pipeline/teamFilter.js";
import { currentProjectId, forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";

/**
 * Post-conversation CSAT in the worker (CSAT.md, feature CSAT_SURVEYS, off by default). Two halves:
 *
 *   ASKING — the dashboard records a PENDING `CsatSurvey` when a person resolves a conversation (one per
 *   RESOLVE event, unique). This loop decides, per survey, whether it may be asked NOW and through which of the
 *   ONE send path of that channel: WhatsApp through `enqueueOutboundMessage` (its own idempotency variant, every
 *   safety gate and rate limit of an automatic reply), Messenger / Instagram / Telegram as a QUEUED
 *   `ChannelMessage` (the channels' send queue, the automated reply window, never the HUMAN_AGENT tag), website
 *   chat as a card the widget shows (nothing is sent). Every refusal is recorded as SKIPPED with the reason, and
 *   nothing is ever retried later: a satisfaction survey is optional, and a late one is noise.
 *
 *   READING — the customer's NEXT message after the survey went out, within 24 hours, is read once. If it is
 *   nothing but a rating ("5", "৫", "4/5", "⭐⭐⭐⭐") that is the answer; anything else closes the survey
 *   unanswered. Either way the message itself is stored and processed exactly as it would have been: these hooks
 *   only ever write the survey row, and never throw.
 *
 * Refused, always: a WhatsApp group (also a database CHECK), a channel group thread, a chat with a team member
 * or one of our own numbers, the kill switch or MANUAL_ONLY, a conversation reopened before the survey went out,
 * a customer asked within the project's cooldown, and a survey older than CSAT_DISPATCH_MAX_DELAY_MINUTES.
 */

const LOOP_NAME = "csat-surveys";
const BATCH = 20;

export function startCsatSurveyProcessor(intervalMs = 5_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void runCsatSurveyTick(new Date())
      .catch((err) => console.error("[csat] survey pass failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export async function runCsatSurveyTick(now: Date = new Date()): Promise<void> {
  await forEachProject(LOOP_NAME, () => dispatchPendingCsatSurveys(now));
}

interface Settings extends CsatChannelSwitches {
  questionText: string | null;
  cooldownDays: number;
}

async function loadSettings(): Promise<Settings> {
  const row = await prisma.csatSettings.findFirst({
    select: { whatsappPersonalEnabled: true, webchatEnabled: true, messengerEnabled: true, instagramEnabled: true, telegramEnabled: true, questionText: true, cooldownDays: true },
  });
  return row ?? { ...DEFAULT_CSAT_SWITCHES, questionText: null, cooldownDays: 7 };
}

const SURVEY_SELECT = {
  id: true,
  channel: true,
  channelConversationId: true,
  accountId: true,
  chatId: true,
  customerKey: true,
  resolvedAt: true,
  createdAt: true,
} as const;
type PendingSurvey = {
  id: string;
  channel: CsatChannel;
  channelConversationId: string | null;
  accountId: string | null;
  chatId: string | null;
  customerKey: string;
  resolvedAt: Date;
  createdAt: Date;
};

/** Settles every waiting survey of the current project: asked, or skipped with the reason. Returns how many were asked. */
export async function dispatchPendingCsatSurveys(now: Date = new Date()): Promise<number> {
  const pending = await prisma.csatSurvey.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: BATCH, select: SURVEY_SELECT });
  if (!pending.length) return 0;
  const featureOn = await projectHasFeature("CSAT_SURVEYS");
  const settings = featureOn ? await loadSettings() : null;
  let asked = 0;
  for (const survey of pending) {
    try {
      const outcome = settings ? await dispatchOne(survey, settings, now) : { skip: "Satisfaction surveys were switched off for this project." };
      if ("skip" in outcome) await settle(survey.id, "SKIPPED", outcome.skip);
      else asked++;
    } catch (err) {
      console.error("[csat] could not decide a survey", err);
      await settle(survey.id, "SKIPPED", "The survey could not be sent because of an error.").catch(() => undefined);
    }
  }
  return asked;
}

async function settle(id: string, status: CsatSurveyStatus, skipReason: string): Promise<void> {
  await prisma.csatSurvey.updateMany({ where: { id, status: "PENDING" }, data: { status, skipReason } });
}

type Outcome = { sent: true } | { skip: string };

async function dispatchOne(survey: PendingSurvey, settings: Settings, now: Date): Promise<Outcome> {
  if (now.getTime() - survey.resolvedAt.getTime() > CSAT_DISPATCH_MAX_DELAY_MINUTES * 60_000) {
    return { skip: `Not asked: more than ${CSAT_DISPATCH_MAX_DELAY_MINUTES} minutes passed after the conversation was resolved.` };
  }
  if (!csatChannelEnabled(settings, survey.channel)) return { skip: "Not asked: surveys are switched off for this channel." };
  // The robot stops for the kill switch and MANUAL_ONLY on every channel, the card included.
  const automation = await getAutomationSettings();
  if (!automation.automationEnabled) return { skip: "Not asked: automation is paused (kill switch)." };
  if (automation.mode === "MANUAL_ONLY") return { skip: "Not asked: automation mode is MANUAL_ONLY." };

  if (survey.channel === "WHATSAPP_PERSONAL") return dispatchWhatsApp(survey, settings, automation, now);
  return dispatchChannel(survey, settings, now);
}

/** Serialises the cooldown check and the ask for one customer, in Postgres (two workers share no memory). */
async function underCustomerLock(survey: PendingSurvey, settings: Settings, now: Date, ask: (tx: TxClient) => Promise<Outcome>): Promise<Outcome> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`csat:${currentProjectId()}:${survey.customerKey}`})::bigint)`;
      if (settings.cooldownDays > 0) {
        const recent = await tx.csatSurvey.findFirst({
          where: { customerKey: survey.customerKey, status: "SENT", id: { not: survey.id }, sentAt: { gte: new Date(now.getTime() - settings.cooldownDays * 86_400_000) } },
          select: { id: true },
        });
        if (recent) return { skip: `Not asked: this customer was asked within the last ${settings.cooldownDays} day${settings.cooldownDays === 1 ? "" : "s"}.` };
      }
      return ask(tx);
    },
    { timeout: 20_000 },
  );
}
type TxClient = Prisma.TransactionClient;

// ── WhatsApp personal chats ──────────────────────────────────────────────────────────────────────

async function dispatchWhatsApp(
  survey: PendingSurvey,
  settings: Settings,
  automation: Awaited<ReturnType<typeof getAutomationSettings>>,
  now: Date,
): Promise<Outcome> {
  const accountId = survey.accountId!;
  const chatId = survey.chatId!;
  if (chatId.endsWith("@g.us")) return { skip: "Not asked: a WhatsApp group is never surveyed." };

  const state = await prisma.whatsAppConversationState.findFirst({ where: { accountId, chatId }, select: { status: true, statusChangedAt: true } });
  if (!state || state.status !== "RESOLVED" || state.statusChangedAt.getTime() !== survey.resolvedAt.getTime()) {
    return { skip: "Not asked: the conversation changed (reopened) before the survey went out." };
  }

  const latest = await prisma.message.findFirst({
    where: { accountId, chatId, direction: "INCOMING" },
    orderBy: { timestampWa: "desc" },
    select: { id: true, senderPhone: true, senderJid: true, isFromTeamMember: true },
  });
  if (!latest) return { skip: "Not asked: the customer has not written in this chat." };
  if (latest.isFromTeamMember || (await resolveTeamSender(latest.senderPhone, latest.senderJid)).isRosterMember) {
    return { skip: "Not asked: this chat is with a team member." };
  }
  const chatUser = chatId.split("@")[0]!.replace(/\D/g, "");
  const ownNumbers = await prisma.whatsAppAccount.findMany({ where: { phoneNumber: { not: null } }, select: { phoneNumber: true } });
  if (chatUser && ownNumbers.some((a) => a.phoneNumber!.replace(/\D/g, "") === chatUser)) return { skip: "Not asked: this chat is with one of our own numbers." };

  // The gates every automatic reply passes: kill switch, MANUAL_ONLY and the rate limits protecting the number.
  const safety = await checkAutoReplySafety({ accountId, toPhone: latest.senderPhone, groupId: null, rule: null, cooldownSeconds: null, settings: automation });
  if (!safety.allowed) return { skip: `Not asked: ${safety.reason}` };

  const question = csatQuestionFor("WHATSAPP_PERSONAL", settings.questionText);
  return underCustomerLock(survey, settings, now, async (tx) => {
    const queued = await enqueueOutboundMessage({
      accountId,
      chatId,
      toPhone: latest.senderPhone,
      body: question,
      incomingMessageId: latest.id,
      ruleId: null,
      actionType: "AUTO_REPLY",
      settings: automation,
      idempotencyVariant: CSAT_SURVEY_VARIANT,
    });
    let outboundMessageId = queued.outboundMessageId ?? null;
    if (!queued.queued) {
      // Already queued for this customer message: a re-run of this survey after a crash (attach it), or an
      // earlier survey that asked after the same message (then this one is not asked again).
      const key = buildOutboundIdempotencyKey({ accountId, chatId, incomingMessageId: latest.id, ruleId: null, actionType: "AUTO_REPLY", variant: CSAT_SURVEY_VARIANT });
      const existing = await tx.outboundMessage.findFirst({ where: { idempotencyKey: key }, select: { id: true, csatSurvey: { select: { id: true } } } });
      if (!existing || (existing.csatSurvey && existing.csatSurvey.id !== survey.id)) return { skip: "Not asked: the customer was already asked after their last message." };
      outboundMessageId = existing.id;
    }
    const moved = await tx.csatSurvey.updateMany({ where: { id: survey.id, status: "PENDING" }, data: { status: "SENT", sentAt: now, question, outboundMessageId } });
    if (moved.count === 0) return { skip: "Not asked: already settled." };
    await logSystemEvent("INFO", "csat", "CSAT_SURVEY_QUEUED", { channel: "WHATSAPP_PERSONAL", accountId, outboundMessageId }, { targetType: "CsatSurvey", targetId: survey.id });
    return { sent: true };
  });
}

// ── Messenger, Instagram, Telegram and website chat ──────────────────────────────────────────────

async function dispatchChannel(survey: PendingSurvey, settings: Settings, now: Date): Promise<Outcome> {
  if (!(await projectHasFeature("OMNICHANNEL"))) return { skip: "Not asked: the messaging channels are switched off for this project." };
  const conversation = await prisma.channelConversation.findFirst({
    where: { id: survey.channelConversationId! },
    select: {
      id: true,
      type: true,
      kind: true,
      status: true,
      statusChangedAt: true,
      lastInboundAt: true,
      connection: { select: { id: true, enabled: true, status: true } },
    },
  });
  if (!conversation) return { skip: "Not asked: the conversation no longer exists." };
  if (conversation.kind !== "DIRECT") return { skip: "Not asked: a group chat is never surveyed." };
  if (conversation.status !== "CLOSED" || conversation.statusChangedAt?.getTime() !== survey.resolvedAt.getTime()) {
    return { skip: "Not asked: the conversation changed (reopened) before the survey went out." };
  }
  const { connection } = conversation;
  if (!connection.enabled || connection.status === "DISCONNECTED" || connection.status === "NEEDS_RECONNECT") {
    return { skip: "Not asked: the channel connection is switched off or needs reconnecting." };
  }
  const type = conversation.type as ChannelType;
  const question = csatQuestionFor(survey.channel, settings.questionText);

  if (type === "WEBCHAT") {
    // A card in the visitor's widget: nothing is sent anywhere, so there is no window to check.
    return underCustomerLock(survey, settings, now, async (tx) => {
      const moved = await tx.csatSurvey.updateMany({ where: { id: survey.id, status: "PENDING" }, data: { status: "SENT", sentAt: now, question } });
      return moved.count ? { sent: true } : { skip: "Not asked: already settled." };
    });
  }

  // An automated message: only inside the standard window, never with the HUMAN_AGENT tag.
  const window = decideReplyWindow({ type, lastInboundAt: conversation.lastInboundAt, now, humanAgentEnabled: false, automated: true });
  if (!window.allowed) return { skip: `Not asked: ${window.reason}` };
  if (window.tag) return { skip: "Not asked: only a person may reply outside the standard window." };
  const tooLong = validateChannelText(type, question);
  if (tooLong) return { skip: `Not asked: ${tooLong}` };

  return underCustomerLock(survey, settings, now, async (tx) => {
    const message = await tx.channelMessage.upsert({
      where: { projectId_idempotencyKey: { projectId: currentProjectId(), idempotencyKey: `csat:${survey.id}` } },
      create: {
        conversationId: conversation.id,
        connectionId: connection.id,
        type,
        direction: "OUTBOUND",
        // Automated, so the send queue re-checks the kill switch and the automated window at send time.
        senderType: "AI",
        senderName: "Satisfaction survey",
        text: question,
        contentType: "TEXT",
        occurredAt: now,
        deliveryStatus: "QUEUED",
        idempotencyKey: `csat:${survey.id}`,
        messagingType: window.messagingType,
      },
      update: {},
      select: { id: true },
    });
    const moved = await tx.csatSurvey.updateMany({ where: { id: survey.id, status: "PENDING" }, data: { status: "SENT", sentAt: now, question, channelMessageId: message.id } });
    if (moved.count === 0) return { skip: "Not asked: already settled." };
    await tx.channelConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now, lastMessagePreview: channelMessagePreview(question, "TEXT"), lastMessageDirection: "OUTBOUND" },
    });
    return { sent: true };
  });
}

// ── Reading the answer from the customer's next message ──────────────────────────────────────────

const answerWindowStart = (at: Date) => new Date(at.getTime() - CSAT_ANSWER_WINDOW_HOURS * 3_600_000);

/**
 * A new WhatsApp message (persistIncomingMessage, after the Message insert, once per new message). Only a
 * customer's message in a personal chat, after the survey message actually went out, within 24 hours, and only
 * the first such message. Never throws, never changes the message or its processing.
 */
export async function recordCsatAnswerFromWhatsApp(input: { accountId: string; chatId: string; messageId: string; body: string; at: Date; fromCustomer: boolean }): Promise<void> {
  try {
    if (!input.fromCustomer || input.chatId.endsWith("@g.us")) return;
    if (!(await projectHasFeature("CSAT_SURVEYS"))) return;
    const survey = await prisma.csatSurvey.findFirst({
      where: {
        accountId: input.accountId,
        chatId: input.chatId,
        status: "SENT",
        answerClosedAt: null,
        sentAt: { gte: answerWindowStart(input.at) },
        outboundMessage: { status: "SENT", sentAt: { lte: input.at } },
      },
      orderBy: { sentAt: "desc" },
      select: { id: true },
    });
    if (survey) await closeWithMessage(survey.id, input.messageId, input.body, input.at);
  } catch (err) {
    console.error("[csat] could not read a WhatsApp message as a survey answer", err);
  }
}

/** The same, for a customer's Messenger / Instagram / Telegram message (channels/inboundProcessor.ts). */
export async function recordCsatAnswerFromChannel(input: { conversationId: string; messageId: string; text: string | null; at: Date }): Promise<void> {
  try {
    if (!(await projectHasFeature("CSAT_SURVEYS"))) return;
    const survey = await prisma.csatSurvey.findFirst({
      where: {
        channelConversationId: input.conversationId,
        status: "SENT",
        answerClosedAt: null,
        sentAt: { gte: answerWindowStart(input.at) },
        // A website chat card is answered in the widget only; a text survey only once it really went out.
        channelMessage: { deliveryStatus: { in: ["SENT", "DELIVERED", "READ"] }, sentAt: { lte: input.at } },
      },
      orderBy: { sentAt: "desc" },
      select: { id: true },
    });
    if (survey) await closeWithMessage(survey.id, input.messageId, input.text ?? "", input.at);
  } catch (err) {
    console.error("[csat] could not read a channel message as a survey answer", err);
  }
}

async function closeWithMessage(surveyId: string, messageId: string, text: string, at: Date): Promise<void> {
  const rating = parseCsatRating(text);
  // Conditional on still being open: a replay, a second worker or a late message never overwrites anything.
  await prisma.csatSurvey.updateMany({
    where: { id: surveyId, answerClosedAt: null, answeredAt: null },
    data: rating ? { answerClosedAt: at, answeredAt: at, rating, answerSource: "MESSAGE", answerMessageId: messageId } : { answerClosedAt: at },
  });
}
