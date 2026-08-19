import { prisma, createAiFallbackDecision, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import type { AutomationSettings } from "@prisma/client";
import { checkAiFallbackEligibility } from "./eligibility.js";
import { buildFallbackPrompt, parseFallbackResponse } from "./prompt.js";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { checkAutoReplySafety } from "../pipeline/safety.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";

export interface RunAiFallbackParams {
  message: { id: string; body: string };
  accountId: string;
  chatId: string;
  toPhone: string;
  senderName?: string | null;
  group: { id: string; name: string; isMonitored: boolean; aiAutomationEnabled: boolean } | null;
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
    group: params.group ? { isMonitored: params.group.isMonitored, aiAutomationEnabled: params.group.aiAutomationEnabled } : null,
    aiEngineEnabled: aiSettings.aiEngineEnabled,
    autoResponseEnabled: aiSettings.autoResponseEnabled,
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

  if (!client) {
    await recordHumanFallback("AI_UNAVAILABLE");
    return;
  }

  let completion;
  try {
    completion = await client.complete(
      buildFallbackPrompt({ customerMessage: params.message.body, groupName: params.group?.name ?? null }),
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
  const safety = await checkAutoReplySafety({
    accountId: params.accountId,
    toPhone: params.toPhone,
    groupId: params.group?.id ?? null,
    rule: null,
    cooldownSeconds: null,
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

  if (params.automationSettings.whatsappNotificationGroupIds.length > 0) {
    const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP");
    if (!isResolutionError(resolution)) {
      const { id } = await enqueueNotification({
        type: "WHATSAPP",
        destination: params.automationSettings.whatsappNotificationGroupIds[0]!,
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
