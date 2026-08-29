import {
  prisma,
  createAiFallbackDecision,
  createRuleProposalFromAiReply,
  resolveWhatsAppAccount,
  isResolutionError,
} from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import type { AiSettings, AutomationSettings } from "@prisma/client";
import { checkAiFallbackEligibility } from "./eligibility.js";
import { buildFallbackPrompt, parseFallbackResponse } from "./prompt.js";
import { findRelevantKnowledge } from "./knowledgeContext.js";
import { recordAiSupportActivity } from "../supportActivity/recordAiSupport.js";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { checkAutoReplySafety } from "../pipeline/safety.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";

export interface RunAiFallbackParams {
  message: { id: string; body: string; timestampWa?: Date };
  accountId: string;
  chatId: string;
  toPhone: string;
  senderName?: string | null;
  group: {
    id: string;
    name: string;
    isMonitored: boolean;
    aiAutomationEnabled: boolean;
    aiAutomationExcluded: boolean;
    aiSuppressedUntil: Date | null;
  } | null;
  automationSettings: AutomationSettings;
  /** Test-only seam (mirrors aiAnalysisJob.ts's clientOverride) — production call sites never pass it. */
  clientOverride?: AiClient;
}

/**
 * The Hybrid AI Automation fallback layer's orchestrator. Called from processIncomingMessage.ts
 * only when the deterministic rule engine returned NO_MATCH on a genuine (non-team-member)
 * customer message. Every possible outcome is exactly one of:
 *   - silently returns (ineligible — see eligibility.ts's doc comment: zero side effects)
 *   - AI_REPLIED: enqueues exactly one AUTO_REPLY OutboundMessage through the existing outbound
 *     queue (never sends directly), then records the decision
 *   - HUMAN_FALLBACK: queues exactly one notification through the existing Notification system,
 *     then records the decision with a short diagnostic `reason`
 * Never throws — the caller wraps this in its own try/catch as a defensive backstop, but every
 * failure mode here (AI unavailable, AI error, malformed response, safety-gate rejection) is
 * already handled as a HUMAN_FALLBACK outcome, not an exception.
 */
export async function runAiFallback(params: RunAiFallbackParams): Promise<void> {
  const aiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });

  const eligibility = checkAiFallbackEligibility({
    automationEnabled: params.automationSettings.automationEnabled,
    mode: params.automationSettings.mode,
    group: params.group
      ? {
          isMonitored: params.group.isMonitored,
          aiAutomationEnabled: params.group.aiAutomationEnabled,
          aiAutomationExcluded: params.group.aiAutomationExcluded,
          aiSuppressedUntil: params.group.aiSuppressedUntil,
        }
      : null,
    aiEngineEnabled: aiSettings.aiEngineEnabled,
    autoResponseEnabled: aiSettings.autoResponseEnabled,
    scope: aiSettings.aiAutomationScope,
    now: new Date(),
  });
  if (!eligibility.eligible) return;

  const client = params.clientOverride ?? (await resolveAiClient("RESPONSE"));

  // Resolved independently of the (possibly mocked, in tests) completion result — mirrors
  // aiAnalysisJob.ts's own pattern, and matters for correctness: AiFallbackDecision.aiProviderId
  // is a real foreign key, so it must come from a genuine AiModelConfig row, never from whatever
  // string a test double's providerId happens to be.
  const modelConfig = await prisma.aiModelConfig.findUnique({ where: { job: "RESPONSE" } });
  const aiProviderId = modelConfig?.providerId ?? null;

  const recordHumanFallback = async (
    reason: string,
    fields: { intent?: string | null; confidenceScore?: number | null; responseText?: string | null; modelId?: string | null; tokensUsed?: number | null } = {},
  ): Promise<void> => {
    const notificationId = await sendHumanFallbackAlert({
      messageId: params.message.id,
      accountId: params.accountId,
      groupName: params.group?.name ?? null,
      senderPhone: params.toPhone,
      senderName: params.senderName ?? null,
      message: params.message.body,
      confidence: fields.confidenceScore ?? null,
      intent: fields.intent ?? null,
      reason,
      automationSettings: params.automationSettings,
      aiSettings,
    });
    await createAiFallbackDecision({
      messageId: params.message.id,
      accountId: params.accountId,
      groupId: params.group?.id ?? null,
      aiProviderId,
      modelId: fields.modelId ?? null,
      intent: fields.intent ?? null,
      confidenceScore: fields.confidenceScore ?? null,
      responseText: fields.responseText ?? null,
      outcome: "HUMAN_FALLBACK",
      reason,
      notificationId,
      tokensUsed: fields.tokensUsed ?? null,
    });
  };

  // A cheap pre-check, before spending a real AI API call: if this exact (account, client) pair is
  // already cooling down from a recent AI reply, there's no point asking AI again — it would just
  // get blocked at send time anyway. The full re-check below still runs right before enqueueing,
  // as defense-in-depth against rate limits shifting during the AI call's own latency (mirrors the
  // outbound queue processor's own send-time re-check of the same conditions).
  const preCheck = await checkAutoReplySafety({
    accountId: params.accountId,
    toPhone: params.toPhone,
    groupId: params.group?.id ?? null,
    rule: null,
    cooldownSeconds: aiSettings.aiReplyCooldownSeconds,
    settings: params.automationSettings,
  });
  if (!preCheck.allowed) {
    await recordHumanFallback(`SAFETY_BLOCKED: ${preCheck.reason}`);
    return;
  }

  if (!client) {
    await recordHumanFallback("AI_UNAVAILABLE");
    return;
  }

  // Ground the answer in what this team has actually verified, so the AI describes how their
  // product behaves rather than how a similar one generally does. Returns an empty list when
  // there is nothing relevant or the lookup fails — answering ungrounded is strictly better
  // than not answering.
  const knowledge = await findRelevantKnowledge(params.message.body, params.group?.id ?? null);

  // "Never guess about our product." With this on, an unanswerable question reaches a person
  // instead of the model's general knowledge — which is the right default for a product whose
  // behaviour nothing outside this company could know. Checked before the API call, so an
  // ungroundable question costs nothing.
  if (aiSettings.requireKnowledgeForAiReply && knowledge.length === 0) {
    await recordHumanFallback("NO_KNOWLEDGE");
    return;
  }

  let completion;
  try {
    completion = await client.complete(
      buildFallbackPrompt({
        customerMessage: params.message.body,
        groupName: params.group?.name ?? null,
        knowledge,
      }),
    );
  } catch (err) {
    await recordHumanFallback(`AI_ERROR: ${(err as Error).message}`);
    return;
  }

  const parsed = parseFallbackResponse(completion.text);
  const commonFields = {
    intent: parsed.intent,
    confidenceScore: parsed.confidence,
    responseText: parsed.responseText,
    modelId: completion.modelId,
    tokensUsed: completion.tokensUsed,
  };

  if (parsed.confidence === null) {
    await recordHumanFallback("MALFORMED_RESPONSE", commonFields);
    return;
  }
  if (!parsed.shouldReply) {
    await recordHumanFallback("AI_DECLINED", commonFields);
    return;
  }
  if (!parsed.responseText) {
    await recordHumanFallback("EMPTY_RESPONSE", commonFields);
    return;
  }
  if (parsed.confidence < aiSettings.autoResponseConfidenceThreshold) {
    await recordHumanFallback("LOW_CONFIDENCE", commonFields);
    return;
  }

  // Re-run every existing safety gate (kill switch, mode, monitored-group check, cooldown, rate
  // limits) with a null rule — see safety.ts's doc comment for why null is AUTO_REPLY-equivalent.
  // Defense-in-depth against the preCheck above going stale during the AI call's own latency.
  const safety = await checkAutoReplySafety({
    accountId: params.accountId,
    toPhone: params.toPhone,
    groupId: params.group?.id ?? null,
    rule: null,
    cooldownSeconds: aiSettings.aiReplyCooldownSeconds,
    settings: params.automationSettings,
  });
  if (!safety.allowed) {
    await recordHumanFallback(`SAFETY_BLOCKED: ${safety.reason}`, commonFields);
    return;
  }

  const { outboundMessageId } = await enqueueOutboundMessage({
    accountId: params.accountId,
    chatId: params.chatId,
    toPhone: params.toPhone,
    body: parsed.responseText,
    incomingMessageId: params.message.id,
    ruleId: null,
    actionType: "AUTO_REPLY",
    settings: params.automationSettings,
  });

  await createAiFallbackDecision({
    messageId: params.message.id,
    accountId: params.accountId,
    groupId: params.group?.id ?? null,
    aiProviderId,
    modelId: completion.modelId,
    intent: parsed.intent,
    confidenceScore: parsed.confidence,
    responseText: parsed.responseText,
    outcome: "AI_REPLIED",
    outboundMessageId: outboundMessageId ?? null,
    tokensUsed: completion.tokensUsed,
  });

  // The AI resolved this one without a person, and that is still support delivered to the
  // group — counted as an AI actor so it never inflates anyone's personal numbers. Its own
  // try/catch: a tracking write must never turn a successfully-answered customer into an error.
  try {
    await recordAiSupportActivity({
      accountId: params.accountId,
      groupId: params.group?.id ?? null,
      messageId: params.message.id,
      occurredAt: params.message.timestampWa ?? new Date(),
    });
  } catch (err) {
    console.error("[aiFallback] failed to record AI support activity", err);
  }

  await maybeDraftRuleFromReply({
    aiSettings,
    customerMessage: params.message.body,
    replyText: parsed.responseText,
    confidence: parsed.confidence,
    intent: parsed.intent,
    sourceMessageId: params.message.id,
    groupName: params.group?.name ?? null,
  });
}

/**
 * Teaches the deterministic engine what the AI just worked out: the answer becomes a rule
 * draft, so the next customer asking the same question is served by a rule — instantly, at no
 * API cost, and identically every time — instead of another AI call.
 *
 * A side effect of an already-completed reply, so it gets its own try/catch: a failure to draft
 * a rule must never turn a message the customer was successfully answered into an error. The
 * threshold sits above the reply threshold on purpose — answering once at 90% is fine, but
 * codifying that answer into a standing rule deserves a higher bar.
 */
async function maybeDraftRuleFromReply(params: {
  aiSettings: AiSettings;
  customerMessage: string;
  replyText: string;
  confidence: number;
  intent: string | null;
  sourceMessageId: string;
  groupName: string | null;
}): Promise<void> {
  if (!params.aiSettings.aiRuleGenerationEnabled) return;
  if (params.confidence < params.aiSettings.aiRuleGenerationMinConfidence) return;

  try {
    await createRuleProposalFromAiReply({
      customerMessage: params.customerMessage,
      replyText: params.replyText,
      confidence: params.confidence,
      intent: params.intent,
      sourceMessageId: params.sourceMessageId,
      groupName: params.groupName,
    });
  } catch (err) {
    console.error("[aiFallback] failed to draft a rule from an AI reply", err);
  }
}

/**
 * Sends exactly one human-fallback alert (preferring WhatsApp, since that's more likely to reach
 * a human already watching the support group, falling back to Teams) through the existing
 * Notification system — never a new send path. Returns the created Notification's id, or null if
 * neither channel is configured (the AiFallbackDecision is still recorded either way, matching how
 * the rule engine's own NOTIFY_TEAMS/NOTIFY_WHATSAPP actions report "not configured" rather than
 * silently failing).
 */
async function sendHumanFallbackAlert(params: {
  messageId: string;
  accountId: string;
  groupName: string | null;
  senderPhone: string;
  senderName: string | null;
  message: string;
  confidence: number | null;
  intent: string | null;
  reason: string;
  automationSettings: AutomationSettings;
  aiSettings: AiSettings;
}): Promise<string | null> {
  const payload: Record<string, unknown> = {
    alertKind: "AI_ASSISTANCE_REQUIRED",
    groupName: params.groupName,
    clientPhone: params.senderPhone,
    clientName: params.senderName,
    message: params.message,
    confidence: params.confidence,
    intent: params.intent,
    reason: params.reason,
  };

  // A dedicated AI-takeover destination if one is configured, otherwise the general
  // notification group — so an existing deployment keeps alerting exactly where it already
  // did, and a team that wants AI hand-offs in their own channel can have that instead.
  const takeoverDestinations =
    params.aiSettings.takeoverNotifyGroupIds.length > 0
      ? params.aiSettings.takeoverNotifyGroupIds
      : params.automationSettings.whatsappNotificationGroupIds;

  if (takeoverDestinations.length > 0) {
    const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP");
    if (!isResolutionError(resolution)) {
      const { id } = await enqueueNotification({
        type: "WHATSAPP",
        destination: takeoverDestinations[0]!,
        accountId: resolution.accountId,
        relatedMessageId: params.messageId,
        payload,
      });
      return id;
    }
  }

  if (params.automationSettings.teamsWebhookUrl) {
    const { id } = await enqueueNotification({
      type: "TEAMS",
      destination: params.automationSettings.teamsWebhookUrl,
      relatedMessageId: params.messageId,
      payload,
    });
    return id;
  }

  return null;
}
