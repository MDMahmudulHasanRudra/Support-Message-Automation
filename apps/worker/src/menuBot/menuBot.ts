import type { AutomationSettings, MenuBot, MenuSession, Prisma } from "@prisma/client";
import {
  advanceMenu,
  decideReplyWindow,
  channelMessagePreview,
  MENU_BOT_VARIANT,
  menuTriggerMatches,
  readMenuTree,
  startMenu,
  validateChannelText,
  type MenuBotChannel,
  type MenuBotWording,
  type MenuStep,
  type MenuTree,
} from "@support-automation/shared";
import { getAiSettings } from "../ai/settings.js";
import { sendHumanFallbackAlert } from "../aiFallback/runAiFallback.js";
import { prisma } from "../db.js";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { checkAutoReplySafety } from "../pipeline/safety.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { currentProjectId } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";

/**
 * Menu bots in the message path (MENU_BOTS.md). A running menu takes the customer's next message before the rules; a new
 * one starts only when no rule matched, so anything already automated keeps working exactly as it did. With no bot
 * switched on this is one small query and nothing else happens.
 *
 * Only ever an answer to a message the customer just sent. Every reply passes the same safety gate and the same queue as
 * any other automatic reply. A person stepping in ends the menu, and after a hand-off the bot stays quiet for a while.
 *
 * One step per customer message: a `MenuEvent` per (project, message) is written with the state change in one transaction
 * under a per-chat lock, so a replay re-sends the same words under the same key and never advances the menu twice.
 */

type Bot = MenuBot;

interface Where {
  session: Prisma.MenuSessionWhereInput;
  create: Prisma.MenuSessionUncheckedCreateInput extends infer T ? Partial<T> : never;
  lockKey: string;
}

export type StepResult = { reply: string; status: "ACTIVE" | "HANDED_OFF"; bot: Bot; nodeTitle: string | null; replayed: boolean } | null;

const wordingOf = (bot: Bot): MenuBotWording => ({ invalidText: bot.invalidText, handoffText: bot.handoffText, backLabel: bot.backLabel, homeLabel: bot.homeLabel, maxInvalid: bot.maxInvalid });

async function activeBots(): Promise<Bot[]> {
  const bots = await prisma.menuBot.findMany({ where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  if (bots.length === 0) return [];
  return (await projectHasFeature("MENU_BOTS")) ? bots : [];
}

const event = (bot: Bot, session: { id: string }, messageRef: string, step: MenuStep, tree: MenuTree | null) => ({
  botId: bot.id,
  sessionId: session.id,
  messageRef,
  kind: step.event,
  nodeId: step.action === "REPLY" ? step.nodeId : null,
  nodeTitle: step.action === "REPLY" ? (tree?.nodes[step.nodeId]?.title ?? null) : null,
  optionLabel: step.action === "REPLY" ? step.optionLabel : null,
  replyText: step.action === "REPLY" ? step.reply : null,
});

const isDuplicate = (err: unknown) => (err as { code?: string }).code === "P2002";

/** Moves a running session on by one message. Null when this message is not the menu's to answer. */
async function stepRunning(bots: Bot[], where: Where, messageRef: string, text: string, now: Date, humanSteppedIn: (session: MenuSession) => Promise<boolean>): Promise<StepResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${where.lockKey})::bigint)`;
      const session = await tx.menuSession.findFirst({ where: { ...where.session, status: "ACTIVE" } });
      if (!session) return null;
      const close = (status: "ENDED" | "EXPIRED") => tx.menuSession.updateMany({ where: { id: session.id, status: "ACTIVE" }, data: { status, endedAt: now } });

      const bot = bots.find((b) => b.id === session.botId);
      if (!bot) {
        await close("ENDED");
        return null;
      }
      const done = await tx.menuEvent.findFirst({ where: { messageRef }, select: { replyText: true, nodeTitle: true } });
      if (done) return done.replyText ? { reply: done.replyText, status: "ACTIVE" as const, bot, nodeTitle: done.nodeTitle, replayed: true } : null;

      if (session.expiresAt <= now) {
        await close("EXPIRED");
        return null;
      }
      if (await humanSteppedIn(session)) {
        await close("ENDED");
        return null;
      }
      const tree = readMenuTree(bot.tree);
      if (!tree) {
        await close("ENDED");
        return null;
      }
      const step = advanceMenu(tree, { nodeId: session.nodeId, path: session.path, invalidCount: session.invalidCount }, text, wordingOf(bot), bot.keywords);
      await tx.menuEvent.create({ data: event(bot, session, messageRef, step, tree) });
      if (step.action === "RELEASE") {
        await close("ENDED");
        return null;
      }
      const closing = step.status === "HANDED_OFF";
      await tx.menuSession.update({
        where: { id: session.id },
        data: { nodeId: step.state.nodeId, path: step.state.path, invalidCount: step.state.invalidCount, lastActivityAt: now, expiresAt: new Date(now.getTime() + bot.sessionMinutes * 60_000), ...(closing ? { status: "HANDED_OFF", endedAt: now } : {}) },
      });
      return { reply: step.reply, status: step.status, bot, nodeTitle: tree.nodes[step.nodeId]?.title ?? null, replayed: false };
    });
  } catch (err) {
    if (isDuplicate(err)) return null;
    throw err;
  }
}

/** Opens a menu for a message no rule answered. Null when nothing should start. */
async function stepStart(bots: Bot[], where: Where, messageRef: string, text: string, isFirstMessage: boolean, inScope: (bot: Bot) => boolean, now: Date): Promise<StepResult> {
  const bot = bots.find((b) => inScope(b) && (menuTriggerMatches(b.keywords, text) || (b.startOnFirstMessage && isFirstMessage)));
  if (!bot) return null;
  const tree = readMenuTree(bot.tree);
  if (!tree) return null;
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${where.lockKey})::bigint)`;
      const replay = await tx.menuEvent.findFirst({ where: { messageRef }, select: { replyText: true, nodeTitle: true } });
      if (replay) return replay.replyText ? { reply: replay.replyText, status: "ACTIVE" as const, bot, nodeTitle: replay.nodeTitle, replayed: true } : null;
      // After a hand-off the customer is talking to a person: "hi" must not bring the robot back.
      if (bot.quietMinutes > 0) {
        const quiet = await tx.menuSession.findFirst({ where: { ...where.session, status: "HANDED_OFF", endedAt: { gt: new Date(now.getTime() - bot.quietMinutes * 60_000) } }, select: { id: true } });
        if (quiet) return null;
      }
      await tx.menuSession.updateMany({ where: { ...where.session, status: "ACTIVE" }, data: { status: "ENDED", endedAt: now } });
      const step = startMenu(tree, wordingOf(bot));
      if (step.action !== "REPLY") return null;
      const session = await tx.menuSession.create({
        data: { ...(where.create as Prisma.MenuSessionUncheckedCreateInput), botId: bot.id, nodeId: step.state.nodeId, path: [], lastActivityAt: now, startedAt: now, expiresAt: new Date(now.getTime() + bot.sessionMinutes * 60_000) },
      });
      await tx.menuEvent.create({ data: event(bot, session, messageRef, step, tree) });
      return { reply: step.reply, status: step.status, bot, nodeTitle: tree.nodes[step.nodeId]?.title ?? null, replayed: false };
    });
  } catch (err) {
    if (isDuplicate(err)) return null;
    throw err;
  }
}

// ── WhatsApp ────────────────────────────────────────────────────────────────────────────────────

export interface WhatsAppMenuInput {
  messageId: string;
  accountId: string;
  chatId: string;
  senderPhone: string;
  senderJid: string | null;
  senderName: string | null;
  body: string;
  isFirstMessage: boolean;
  group: { id: string; name: string; testModeEnabled: boolean; isMonitored: boolean } | null;
  settings: AutomationSettings;
  traceId: string;
}

const whatsappWhere = (input: WhatsAppMenuInput): Where => {
  const senderKey = input.group ? (input.senderJid ?? input.senderPhone) : input.chatId;
  return { session: { chatId: input.chatId, senderKey }, create: { accountId: input.accountId, chatId: input.chatId, senderKey }, lockKey: `menu:${currentProjectId()}:${input.chatId}:${senderKey}` };
};

const inWhatsAppScope = (input: WhatsAppMenuInput) => (bot: Bot) => (input.group ? bot.onWhatsAppGroups && input.group.isMonitored : bot.onWhatsAppPersonal);

/** A colleague in the chat, or a reply that is not one of this menu's own, since the menu last spoke. */
async function humanInWhatsApp(chatId: string, session: MenuSession): Promise<boolean> {
  const rows = await prisma.message.findMany({
    where: { chatId, timestampWa: { gte: session.startedAt }, OR: [{ direction: "OUTGOING" }, { isFromTeamMember: true }] },
    orderBy: { timestampWa: "desc" },
    take: 30,
    select: { direction: true, isFromTeamMember: true, body: true },
  });
  if (rows.length === 0) return false;
  if (rows.some((r) => r.direction === "INCOMING" && r.isFromTeamMember)) return true;
  const own = new Set((await prisma.menuEvent.findMany({ where: { sessionId: session.id }, select: { replyText: true } })).map((e) => e.replyText));
  return rows.some((r) => !own.has(r.body));
}

async function replyOnWhatsApp(input: WhatsAppMenuInput, result: NonNullable<StepResult>): Promise<void> {
  await enqueueOutboundMessage({
    accountId: input.accountId,
    chatId: input.chatId,
    toPhone: input.senderPhone,
    body: result.reply,
    incomingMessageId: input.messageId,
    ruleId: null,
    actionType: "AUTO_REPLY",
    settings: input.settings,
    testMode: input.group?.testModeEnabled ?? false,
    idempotencyVariant: MENU_BOT_VARIANT,
  });
  if (result.status !== "HANDED_OFF" || result.replayed) return;
  const until = new Date(Date.now() + result.bot.quietMinutes * 60_000);
  if (input.group) await prisma.whatsAppGroup.updateMany({ where: { id: input.group.id }, data: { aiSuppressedUntil: until } });
  await sendHumanFallbackAlert({
    messageId: input.messageId,
    accountId: input.accountId,
    groupName: input.group?.name ?? null,
    senderPhone: input.senderPhone,
    senderName: input.senderName,
    message: input.body,
    confidence: null,
    intent: result.nodeTitle,
    reason: "MENU_HANDOFF",
    automationSettings: input.settings,
    aiSettings: await getAiSettings(),
    correlationId: input.traceId,
  }).catch((err) => console.error("[menu-bot] the hand-off alert failed", err));
}

async function safeOnWhatsApp(input: WhatsAppMenuInput): Promise<boolean> {
  const safety = await checkAutoReplySafety({ accountId: input.accountId, toPhone: input.senderPhone, groupId: input.group?.id ?? null, rule: null, cooldownSeconds: null, settings: input.settings });
  return safety.allowed;
}

/** Before the rules: a customer inside a running menu. True when the menu answered. Never throws. */
export async function continueMenuOnWhatsApp(input: WhatsAppMenuInput): Promise<boolean> {
  try {
    const bots = await activeBots();
    if (bots.length === 0 || !(await safeOnWhatsApp(input))) return false;
    const result = await stepRunning(bots, whatsappWhere(input), input.messageId, input.body, new Date(), (s) => humanInWhatsApp(input.chatId, s));
    if (!result) return false;
    await replyOnWhatsApp(input, result);
    return true;
  } catch (err) {
    console.error("[menu-bot] could not continue a menu", err);
    return false;
  }
}

/** After the rules, on a genuine miss: does this message open a menu? True when it did. Never throws. */
export async function startMenuOnWhatsApp(input: WhatsAppMenuInput): Promise<boolean> {
  try {
    const bots = await activeBots();
    if (bots.length === 0 || !(await safeOnWhatsApp(input))) return false;
    const result = await stepStart(bots, whatsappWhere(input), input.messageId, input.body, input.isFirstMessage, inWhatsAppScope(input), new Date());
    if (!result) return false;
    await replyOnWhatsApp(input, result);
    return true;
  } catch (err) {
    console.error("[menu-bot] could not start a menu", err);
    return false;
  }
}

// ── Messenger, Instagram, Telegram, website chat ────────────────────────────────────────────────

/** Older than this, a message is history and gets no automatic answer, the same line AI replies use. */
const CHANNEL_WINDOW_MS = 15 * 60_000;

/**
 * A customer's message on a channel. True when a menu answered, and then AI does not. Never throws: the message is already
 * stored, and a menu failure must leave it to everything else.
 */
export async function handleChannelMenu(input: { messageId: string; conversationId: string; text: string | null; occurredAt: Date; isFirstMessage: boolean }, now: Date = new Date()): Promise<boolean> {
  try {
    if (!input.text?.trim() || now.getTime() - input.occurredAt.getTime() > CHANNEL_WINDOW_MS) return false;
    const bots = await activeBots();
    if (bots.length === 0) return false;
    const settings = await getAutomationSettings();
    if (!settings.automationEnabled || settings.mode === "MANUAL_ONLY") return false;

    const conversation = await prisma.channelConversation.findUniqueOrThrow({
      where: { id: input.conversationId },
      select: { id: true, type: true, kind: true, aiSuppressedUntil: true, lastInboundAt: true, customerName: true, title: true, connection: { select: { id: true, enabled: true, status: true, humanAgentEnabled: true } } },
    });
    const { connection } = conversation;
    if (conversation.kind === "GROUP" || !connection.enabled || connection.status === "DISCONNECTED" || connection.status === "NEEDS_RECONNECT") return false;
    if (conversation.aiSuppressedUntil && conversation.aiSuppressedUntil > now) return false;
    const window = decideReplyWindow({ type: conversation.type, lastInboundAt: conversation.lastInboundAt, now, humanAgentEnabled: connection.humanAgentEnabled, automated: true });
    if (!window.allowed) return false;

    const where: Where = { session: { channelConversationId: conversation.id }, create: { channelConversationId: conversation.id }, lockKey: `menu:${currentProjectId()}:${conversation.id}` };
    const humanSteppedIn = async (session: MenuSession) =>
      (await prisma.channelMessage.count({ where: { conversationId: conversation.id, direction: "OUTBOUND", senderType: { in: ["AGENT", "BUSINESS"] }, occurredAt: { gte: session.startedAt } } })) > 0;
    const inScope = (bot: Bot) => (bot.channels as MenuBotChannel[]).includes(conversation.type as MenuBotChannel);

    const result = (await stepRunning(bots.filter(inScope), where, input.messageId, input.text, now, humanSteppedIn)) ?? (await stepStart(bots, where, input.messageId, input.text, input.isFirstMessage, inScope, now));
    if (!result) return false;
    if (validateChannelText(conversation.type, result.reply)) return false;

    await prisma.channelMessage.upsert({
      where: { projectId_idempotencyKey: { projectId: currentProjectId(), idempotencyKey: `menu:${input.messageId}` } },
      create: { conversationId: conversation.id, connectionId: connection.id, type: conversation.type, direction: "OUTBOUND", senderType: "AI", text: result.reply, contentType: "TEXT", occurredAt: now, deliveryStatus: "QUEUED", idempotencyKey: `menu:${input.messageId}`, messagingType: "RESPONSE" },
      update: {},
    });
    await prisma.channelConversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now, lastMessagePreview: channelMessagePreview(result.reply, "TEXT"), lastMessageDirection: "OUTBOUND" } });
    await prisma.channelMessage.updateMany({ where: { id: input.messageId, aiClaimedAt: null }, data: { aiClaimedAt: now, aiOutcome: "SKIPPED", aiReason: "Answered by a menu bot." } });

    if (result.status === "HANDED_OFF" && !result.replayed) {
      await prisma.channelConversation.update({ where: { id: conversation.id }, data: { aiSuppressedUntil: new Date(now.getTime() + result.bot.quietMinutes * 60_000) } });
      await sendHumanFallbackAlert({
        messageId: null,
        accountId: null,
        groupName: conversation.title,
        senderPhone: "",
        senderName: conversation.customerName,
        message: input.text,
        confidence: null,
        intent: result.nodeTitle,
        reason: "MENU_HANDOFF",
        automationSettings: settings,
        aiSettings: await getAiSettings(),
      }).catch((err) => console.error("[menu-bot] the hand-off alert failed", err));
    }
    return true;
  } catch (err) {
    console.error("[menu-bot] could not answer on a channel", err);
    return false;
  }
}
