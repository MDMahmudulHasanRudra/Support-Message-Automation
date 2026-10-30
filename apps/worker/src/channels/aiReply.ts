import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { aiDisclosureText, CHANNELS, decideAiDisclosure, decideReplyWindow, channelMessagePreview, isAiDisclosureChannel, validateChannelText, withAiDisclosure, type AiDisclosureReason, type ChannelType, validateCommerceFigures } from "@support-automation/shared";
import type { AiSettings, AutomationSettings } from "@prisma/client";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { currentProjectId, forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { getAiSettings } from "../ai/settings.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { buildAnswerPlan, renderAnswerPlan, validateGrounding } from "../aiFallback/answerPlan.js";
import { findRelevantKnowledge } from "../aiFallback/knowledgeContext.js";
import { findCommerceGrounding } from "../aiFallback/commerceContext.js";
import { expandQueryTerms } from "../aiFallback/queryExpansion.js";
import { researchForCustomerQuestion } from "../aiFallback/deepAnswer.js";
import { buildFallbackPrompt, parseFallbackResponse } from "../aiFallback/prompt.js";
import type { ConversationTurn } from "../aiFallback/conversationContext.js";
import { sendHumanFallbackAlert } from "../aiFallback/runAiFallback.js";
import { getApprovedStyleGuidance } from "../knowledge/communicationStyleJob.js";

/**
 * AI replies on Messenger, Instagram and Telegram (OMNICHANNEL.md §9).
 *
 * The SAME answering logic as WhatsApp's AI fallback, not a second one: the knowledge search,
 * query expansion, live Forge research, the answer plan, the prompt, the response parser and the
 * grounding check are the functions `runAiFallback` calls, and every gate is applied in the same
 * order with the same thresholds — response mode, the business-question guard that no setting
 * relaxes, the confidence floor, the general-answer floor, the invented-procedure check. What
 * differs is only what a channel needs: the conversation comes from `ChannelMessage`, the reply is
 * queued as a `ChannelMessage` (the channels' one send queue), and the decision is recorded on the
 * customer's message rather than in `AiFallbackDecision` (whose rows point at WhatsApp messages).
 * `runAiFallback` itself is untouched.
 *
 * When AI may run at all — every one of these must hold, or the message is recorded SKIPPED with why:
 *   the Omnichannel and AI-reply features; the kill switch off and the mode not MANUAL_ONLY; the AI
 *   engine and auto-responses on; the connection switched on and its own AI switch on; a 1:1
 *   conversation (never a Telegram group — the WhatsApp equivalent is an opted-in monitored group,
 *   and a bot answering every line of a group chat is the spam this product refuses to send); no
 *   person handling it (`aiSuppressedUntil`); the provider's reply window open for an AUTOMATED
 *   reply; the message at most AI_WINDOW old; and no newer customer message waiting — a customer
 *   who sends three lines gets one answer, to the last of them, with the first two as context.
 *
 * Claimed exactly once: `aiClaimedAt` is set by a conditional update before anything else, so a
 * restart, a second worker or a replayed webhook can never produce a second reply or a second alert.
 * The reply itself also carries an idempotency key derived from the customer's message.
 */

const LOOP_NAME = "channel-ai";
/** Older than this, a message is history — answering it now would be the burst a backlog causes. */
export const AI_WINDOW_MS = 15 * 60_000;
/** Give the customer a moment to finish typing before answering. */
export const AI_SETTLE_MS = 3_000;
const TRANSCRIPT_TURNS = 10;
const PER_PROJECT_PER_TICK = 3;

export function startChannelAiProcessor(intervalMs = 3_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void runChannelAiTick()
      .catch((err) => console.error("[channels] unexpected error in channel AI replies", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export async function runChannelAiTick(now: Date = new Date(), clientOverride?: AiClient): Promise<void> {
  await forEachProject(LOOP_NAME, async () => {
    if (!(await projectHasFeature("OMNICHANNEL"))) return;
    const due = await prisma.channelMessage.findMany({
      where: {
        direction: "INBOUND",
        senderType: "CUSTOMER",
        aiClaimedAt: null,
        createdAt: { gte: new Date(now.getTime() - AI_WINDOW_MS), lte: new Date(now.getTime() - AI_SETTLE_MS) },
        connection: { aiAutomationEnabled: true },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PER_PROJECT_PER_TICK,
      select: { id: true },
    });
    for (const row of due) await answerChannelMessage(row.id, now, clientOverride);
  });
}

type Outcome = { outcome: "SKIPPED" | "HANDED_OVER" | "REPLIED"; reason: string | null; confidence?: number | null; modelId?: string | null; replyId?: string | null };

async function record(messageId: string, o: Outcome): Promise<void> {
  await prisma.channelMessage.update({
    where: { id: messageId },
    data: { aiOutcome: o.outcome, aiReason: o.reason, aiConfidence: o.confidence ?? null, aiModelId: o.modelId ?? null, aiReplyMessageId: o.replyId ?? null },
  });
}

/** Decide, and act on, one customer message. Exported for tests. Never throws. */
export async function answerChannelMessage(messageId: string, now: Date = new Date(), clientOverride?: AiClient): Promise<Outcome | null> {
  const claim = await prisma.channelMessage.updateMany({ where: { id: messageId, aiClaimedAt: null }, data: { aiClaimedAt: now } });
  if (claim.count === 0) return null;
  try {
    const outcome = await decide(messageId, now, clientOverride);
    await record(messageId, outcome);
    return outcome;
  } catch (err) {
    console.error(`[channels] AI reply for message ${messageId} failed`, err);
    const outcome: Outcome = { outcome: "HANDED_OVER", reason: `AI_ERROR: ${(err as Error)?.message?.slice(0, 200) ?? "unknown"}` };
    await record(messageId, outcome).catch(() => undefined);
    return outcome;
  }
}

/** Why AI may not answer in this conversation right now, or null when it may. Re-run just before queueing. */
async function ineligibility(
  conversationId: string,
  connection: { enabled: boolean; status: string; aiAutomationEnabled: boolean; humanAgentEnabled: boolean },
  type: ChannelType,
  settings: { automation: AutomationSettings; ai: AiSettings },
  now: Date,
): Promise<string | null> {
  if (!settings.automation.automationEnabled) return "Automation is switched off (kill switch).";
  if (settings.automation.mode === "MANUAL_ONLY") return "Automation is in manual-only mode.";
  if (!settings.ai.aiEngineEnabled || !settings.ai.autoResponseEnabled) return "AI replies are switched off in AI Settings.";
  if (!(await projectHasFeature("AI_REPLY"))) return "AI replies are not enabled for this project.";
  if (!connection.enabled || connection.status === "DISCONNECTED" || connection.status === "NEEDS_RECONNECT") return "The connection is off or needs new credentials.";
  if (!connection.aiAutomationEnabled) return "AI is switched off for this connection.";
  const conversation = await prisma.channelConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { kind: true, aiSuppressedUntil: true, lastInboundAt: true } });
  if (conversation.kind === "GROUP") return "AI does not answer in group chats.";
  if (conversation.aiSuppressedUntil && conversation.aiSuppressedUntil > now) return "A person is handling this conversation.";
  const window = decideReplyWindow({ type, lastInboundAt: conversation.lastInboundAt, now, humanAgentEnabled: connection.humanAgentEnabled, automated: true });
  if (!window.allowed) return window.reason;
  return null;
}

async function decide(messageId: string, now: Date, clientOverride?: AiClient): Promise<Outcome> {
  const message = await prisma.channelMessage.findUniqueOrThrow({
    where: { id: messageId },
    select: {
      id: true,
      type: true,
      text: true,
      createdAt: true,
      occurredAt: true,
      conversationId: true,
      conversation: { select: { customerName: true, customerUsername: true, title: true, externalThreadId: true } },
      connection: { select: { id: true, name: true, enabled: true, status: true, aiAutomationEnabled: true, humanAgentEnabled: true, aiDisclosureEnabled: true, aiDisclosureText: true, aiDisclosureIdleHours: true } },
    },
  });
  const type = message.type as ChannelType;
  if (now.getTime() - message.createdAt.getTime() > AI_WINDOW_MS) return { outcome: "SKIPPED", reason: "Too old to answer automatically." };

  const newer = await prisma.channelMessage.count({
    where: { conversationId: message.conversationId, direction: "INBOUND", senderType: "CUSTOMER", createdAt: { gt: message.createdAt }, id: { not: message.id } },
  });
  if (newer > 0) return { outcome: "SKIPPED", reason: "The customer sent another message; that one is answered instead." };

  const settings = { automation: await getAutomationSettings(), ai: await getAiSettings() };
  const blocked = await ineligibility(message.conversationId, message.connection, type, settings, now);
  if (blocked) return { outcome: "SKIPPED", reason: blocked };

  const customer = message.conversation.customerName ?? (message.conversation.customerUsername ? `@${message.conversation.customerUsername}` : message.conversation.externalThreadId);
  const handOver = async (reason: string, extra: Partial<Outcome> = {}): Promise<Outcome> => {
    await sendHumanFallbackAlert({
      messageId: null,
      accountId: null,
      groupName: `${CHANNELS[type].label} · ${message.connection.name}`,
      senderPhone: customer,
      senderName: message.conversation.customerName,
      message: message.text ?? channelMessagePreview(null, "UNSUPPORTED"),
      confidence: extra.confidence ?? null,
      intent: null,
      reason,
      automationSettings: settings.automation,
      aiSettings: settings.ai,
      correlationId: message.id,
    }).catch((err) => console.error("[channels] could not raise the AI handover alert", err));
    return { outcome: "HANDED_OVER", reason, ...extra };
  };

  const text = message.text?.trim();
  if (!text) return handOver("MEDIA_ONLY_MESSAGE");

  // The same per-customer cooldown as WhatsApp's AI replies (AiSettings.aiReplyCooldownSeconds).
  if (settings.ai.aiReplyCooldownSeconds > 0) {
    const recent = await prisma.channelMessage.count({
      where: { conversationId: message.conversationId, senderType: "AI", createdAt: { gte: new Date(now.getTime() - settings.ai.aiReplyCooldownSeconds * 1000) } },
    });
    if (recent > 0) return handOver("SAFETY_BLOCKED: AI reply cooldown");
  }
  // The automation's per-customer hourly ceiling, applied per conversation.
  const lastHour = await prisma.channelMessage.count({ where: { conversationId: message.conversationId, senderType: "AI", createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
  if (lastHour >= settings.automation.maxRepliesPerClientPerHour) return handOver("SAFETY_BLOCKED: per-customer hourly limit");

  const client = clientOverride ?? (await resolveAiClient("RESPONSE", prisma));
  if (!client) return handOver("AI_UNAVAILABLE");

  const earlier = await prisma.channelMessage.findMany({
    where: { conversationId: message.conversationId, occurredAt: { lt: message.occurredAt }, text: { not: null }, NOT: { deliveryStatus: { in: ["FAILED", "QUEUED"] } } },
    orderBy: { occurredAt: "desc" },
    take: TRANSCRIPT_TURNS,
    select: { direction: true, text: true },
  });
  const conversation: ConversationTurn[] = earlier.reverse().map((m) => ({ role: m.direction === "INBOUND" ? "CUSTOMER" : "SUPPORT", body: m.text ?? "" }));

  // Catalogue answers when commerce answers are on (AI_COMMERCE.md). No order details here: these
  // channels carry no phone number that proves who the customer is.
  const commerce = await findCommerceGrounding({ text, switches: settings.ai, customerPhone: null });
  if (commerce.handoverRequest) return handOver("COMMERCE_REQUEST");
  let knowledge = await findRelevantKnowledge(text, { groupId: null, accountId: null }, undefined, () => expandQueryTerms(client, text, conversation));
  if (commerce.snippets.length) knowledge = [...commerce.snippets, ...knowledge];
  const mayResearch = settings.ai.aiResponseMode === "KNOWLEDGE_PLUS_FORGE" || settings.ai.aiResponseMode === "KNOWLEDGE_FORGE_GENERAL";
  let researchReason: string | undefined;
  if (knowledge.length === 0 && mayResearch) {
    const researched = await researchForCustomerQuestion({ question: text, groupId: null, client });
    knowledge = researched.snippets;
    researchReason = researched.reason;
  }
  const mayAnswerGenerally = settings.ai.aiResponseMode === "KNOWLEDGE_PLUS_GENERAL" || settings.ai.aiResponseMode === "KNOWLEDGE_FORGE_GENERAL";
  if (!mayAnswerGenerally && knowledge.length === 0) return handOver(researchReason ? `NO_KNOWLEDGE: ${researchReason}` : "NO_KNOWLEDGE");

  const plan = buildAnswerPlan(text, knowledge);
  let completion;
  try {
    completion = await client.complete(
      buildFallbackPrompt({
        customerMessage: text,
        groupName: null,
        defaultReplyLanguage: settings.ai.defaultReplyLanguage,
        styleGuidance: await getApprovedStyleGuidance(),
        knowledge,
        conversation,
        planGuidance: renderAnswerPlan(plan),
        commerceRules: commerce.rules,
      }),
    );
  } catch (err) {
    return handOver(`AI_ERROR: ${(err as Error).message}`);
  }
  const parsed = parseFallbackResponse(completion.text);
  const extra = { confidence: parsed.confidence, modelId: completion.modelId };
  if (completion.truncated) return handOver("TRUNCATED_RESPONSE", extra);
  if (parsed.confidence === null) return handOver("MALFORMED_RESPONSE", extra);
  if (!parsed.shouldReply) return handOver("AI_DECLINED", extra);
  if (!parsed.responseText) return handOver("EMPTY_RESPONSE", extra);
  const grounded = knowledge.length > 0;
  // Not configurable, as on WhatsApp: nothing verified behind a business-specific answer means no answer.
  if (parsed.scope === "BUSINESS_SPECIFIC" && !grounded) return handOver("NO_BUSINESS_KNOWLEDGE", extra);
  const required = grounded ? settings.ai.autoResponseConfidenceThreshold : Math.max(settings.ai.autoResponseConfidenceThreshold, settings.ai.generalAnswerMinConfidence);
  if (parsed.confidence < required) return handOver(grounded ? "LOW_CONFIDENCE" : "LOW_CONFIDENCE_GENERAL", extra);
  const grounding = validateGrounding(parsed.responseText, plan);
  if (!grounding.ok) return handOver(grounding.reason ?? "UNGROUNDED_RESPONSE", extra);
  if (commerce.policy?.active && !validateCommerceFigures(parsed.responseText, commerce.groundingText).ok) return handOver("UNGROUNDED_PRICE", extra);
  const tooLong = validateChannelText(type, parsed.responseText);
  if (tooLong) return handOver("REPLY_TOO_LONG_FOR_CHANNEL", extra);

  // Facebook Messenger and Instagram DM only (Meta's Messenger Platform policy, docs/meta-integration/08):
  // saying the reply is automated, when the connection asks for it. Telegram never gets here — the
  // provider check is explicit. The answer itself is untouched: the line goes above it, in the same
  // message, after every gate above has passed. If the two together no longer fit the channel, a
  // person answers instead: an automated reply missing its disclosure is never sent.
  const disclosure = isAiDisclosureChannel(type) ? await disclosureFor(message) : null;
  const replyText = disclosure ? withAiDisclosure(aiDisclosureText(message.connection.aiDisclosureText), parsed.responseText) : parsed.responseText;
  if (disclosure && validateChannelText(type, replyText)) return handOver("REPLY_TOO_LONG_WITH_DISCLOSURE", extra);

  // Everything is re-checked after the model's latency: a person may have replied, or the kill switch
  // been pressed, while it was thinking.
  const fresh = { automation: await getAutomationSettings(), ai: await getAiSettings() };
  const stillBlocked = await ineligibility(message.conversationId, message.connection, type, fresh, new Date());
  if (stillBlocked) return { outcome: "SKIPPED", reason: `Not sent: ${stillBlocked}`, ...extra };

  const queuedAt = new Date();
  const reply = await prisma.channelMessage.upsert({
    where: { projectId_idempotencyKey: { projectId: currentProjectId(), idempotencyKey: `ai:${message.id}` } },
    create: {
      conversationId: message.conversationId,
      connectionId: message.connection.id,
      type,
      direction: "OUTBOUND",
      senderType: "AI",
      text: replyText,
      aiDisclosed: disclosure !== null,
      contentType: "TEXT",
      occurredAt: queuedAt,
      deliveryStatus: "QUEUED",
      idempotencyKey: `ai:${message.id}`,
      messagingType: "RESPONSE",
    },
    update: {},
    select: { id: true },
  });
  await prisma.channelConversation.update({
    where: { id: message.conversationId },
    data: { lastMessageAt: queuedAt, lastMessagePreview: channelMessagePreview(replyText, "TEXT"), lastMessageDirection: "OUTBOUND" },
  });
  return { outcome: "REPLIED", reason: null, ...extra, replyId: reply.id };
}

/**
 * Whether this AI reply must say it is automated (packages/shared `decideAiDisclosure`): read from the
 * conversation's own history, so a restart or a second worker reaches the same answer. A disclosing
 * reply that FAILED was never seen by the customer and does not count.
 */
async function disclosureFor(
  message: { id: string; conversationId: string; occurredAt: Date; connection: { aiDisclosureEnabled: boolean; aiDisclosureIdleHours: number } },
): Promise<AiDisclosureReason | null> {
  if (!message.connection.aiDisclosureEnabled) return null;
  const last = await prisma.channelMessage.findFirst({
    where: { conversationId: message.conversationId, senderType: "AI", aiDisclosed: true, deliveryStatus: { not: "FAILED" } },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  const humanSince = last
    ? await prisma.channelMessage.count({
        where: { conversationId: message.conversationId, direction: "OUTBOUND", senderType: { in: ["AGENT", "BUSINESS"] }, occurredAt: { gt: last.occurredAt }, deliveryStatus: { not: "FAILED" } },
      })
    : 0;
  const previous = await prisma.channelMessage.findFirst({
    where: { conversationId: message.conversationId, id: { not: message.id }, occurredAt: { lt: message.occurredAt } },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  return decideAiDisclosure({
    enabled: true,
    lastDisclosedAt: last?.occurredAt ?? null,
    humanRepliedSince: humanSince > 0,
    previousMessageAt: previous?.occurredAt ?? null,
    answeringAt: message.occurredAt,
    idleHours: message.connection.aiDisclosureIdleHours,
  });
}
