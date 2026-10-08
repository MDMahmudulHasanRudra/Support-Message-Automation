import { projectHasFeature } from "../project/features.js";
import { createAiFallbackDecision, createRuleProposalFromAiReply, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import { prisma } from "../db.js";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { isMediaOnlyBody } from "@support-automation/shared";
import type { AiSettings, AutomationSettings } from "@prisma/client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { checkAiFallbackEligibility } from "./eligibility.js";
import { buildFallbackPrompt, parseFallbackResponse } from "./prompt.js";
import { buildAnswerPlan, renderAnswerPlan, validateGrounding } from "./answerPlan.js";
import { findRelevantKnowledge } from "./knowledgeContext.js";
import { buildEvidenceBundle, fingerprintOf, recordEvidenceSnapshot } from "./evidenceSnapshot.js";
import { expandQueryTerms } from "./queryExpansion.js";
import { loadConversationContext } from "./conversationContext.js";
import { recordUnansweredQuestion } from "../forge/forgeResearchJob.js";
import { mentionTeamForHandover } from "./mentionTeam.js";
import { sendUnableToUnderstandReply } from "./unableToUnderstandReply.js";
import { researchForCustomerQuestion } from "./deepAnswer.js";
import { getApprovedStyleGuidance } from "../knowledge/communicationStyleJob.js";
import { recordAiSupportActivity } from "../supportActivity/recordAiSupport.js";
import { enqueueOutboundMessage } from "../pipeline/enqueueOutbound.js";
import { checkAutoReplySafety } from "../pipeline/safety.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getAiSettings } from "../ai/settings.js";

/**
 * Which version of THIS SYSTEM produced an answer.
 *
 * Recorded on every interaction so that comparing two models over the same question means
 * something. Without it a difference in output could be the model, or a prompt edit, or a change
 * to retrieval shipped in between — and there would be no way to tell which. Bumped by hand when
 * the prompt or the retrieval contract changes in a way that could move an answer.
 */
const PROMPT_VERSION = "2026-09-18.1";
const RETRIEVAL_VERSION = "bm25f.2026-09-18.1";

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
    /** See WhatsAppGroup.testModeEnabled — lifts the anti-spam throttles for an approved test group. */
    testModeEnabled?: boolean;
  } | null;
  automationSettings: AutomationSettings;
  /**
   * Ties every record for one incoming message together — logs, the decision, the snapshot.
   *
   * The pipeline's own trace id (`<accountId>:<whatsappMessageId>`), passed in rather than minted
   * here: it already identifies this message everywhere else, and a second identifier for the same
   * thing would mean joining two correlation schemes to follow one reply.
   */
  correlationId?: string;
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
  const aiSettings = await getAiSettings();

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
    aiReplyEntitled: await projectHasFeature("AI_REPLY"),
  });
  if (!eligibility.eligible) return;

  // Resolved independently of the (possibly mocked, in tests) completion result — mirrors
  // aiAnalysisJob.ts's own pattern, and matters for correctness: AiFallbackDecision.aiProviderId
  // is a real foreign key, so it must come from a genuine AiModelConfig row, never from whatever
  // string a test double's providerId happens to be.
  const modelConfig = await prisma.aiModelConfig.findFirst({ where: { job: "RESPONSE" } });
  const aiProviderId = modelConfig?.providerId ?? null;

  const recordHumanFallback = async (
    reason: string,
    fields: {
      intent?: string | null;
      confidenceScore?: number | null;
      responseText?: string | null;
      modelId?: string | null;
      tokensUsed?: number | null;
      /** Timing, finish reason and evidence fingerprint, once a model has actually been called. */
      interaction?: { latencyMs?: number | null; finishReason?: string | null; evidenceFingerprint?: string | null };
    } = {},
  ): Promise<void> => {
    // The decision row is claimed BEFORE anything is sent, and that ordering is the idempotency
    // guard for the entire handover.
    //
    // It used to be the other way round: the alert went out, then the decision was written, and
    // `createAiFallbackDecision` answers a duplicate with a returned error rather than a throw. So
    // a re-run of this message — `recoverStrandedMessages` re-runs `runAutomationStage` wholesale
    // for a row stranded between 5 minutes and 6 hours — sent a SECOND "AI Assistance Required"
    // alert, posted a second mention, and queued the question for research again, while the
    // duplicate decision was quietly discarded. `Notification` has no idempotency key of its own
    // to catch it, so nothing else could.
    //
    // `AiFallbackDecision.messageId` is @unique, so claiming first makes exactly one pass per
    // message perform the side effects, however many times this runs.
    const decision = await createAiFallbackDecision({
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
      tokensUsed: fields.tokensUsed ?? null,
      correlationId: params.correlationId ?? null,
      promptVersion: PROMPT_VERSION,
      retrievalVersion: RETRIEVAL_VERSION,
      ...fields.interaction,
    }, prisma);
    if (!("id" in decision)) return;

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
      correlationId: params.correlationId ?? null,
    });
    // Linked after the fact rather than at creation, since the row now exists first. Its own
    // try/catch: the team has already been told, and failing to record WHICH alert told them must
    // not turn a completed handover into an error.
    if (notificationId) {
      try {
        await prisma.aiFallbackDecision.update({
          where: { id: decision.id },
          data: { notificationId },
        });
      } catch (err) {
        console.error("[aiFallback] could not link the handover alert to its decision", err);
      }
    }

    // Tell the CUSTOMER too, when that is switched on and the AI genuinely had nothing reliable to
    // say — "we could not understand this, the support team will follow up". Runs only on the pass
    // that claimed the decision above, so a re-run can never send it twice; the throttle-caused
    // handovers never qualify (see packages/shared/src/unableToUnderstand.ts).
    const holdingReplyId = await sendUnableToUnderstandReply({
      reason,
      aiSettings,
      automationSettings: params.automationSettings,
      accountId: params.accountId,
      groupId: params.group?.id ?? null,
      chatId: params.chatId,
      toPhone: params.toPhone,
      incomingMessageId: params.message.id,
      messageBody: params.message.body,
      testMode: params.group?.testModeEnabled ?? false,
      correlationId: params.correlationId ?? null,
    });
    if (holdingReplyId) {
      try {
        await prisma.aiFallbackDecision.update({
          where: { id: decision.id },
          data: { holdingReplyOutboundMessageId: holdingReplyId },
        });
      } catch (err) {
        console.error("[aiFallback] could not link the holding reply to its decision", err);
      }
    }

    // The customer has already been handed to a human above; this only queues the question to be
    // researched against the product's own source later, so the NEXT person to ask gets an
    // answer. Restricted to the two reasons that actually mean "nobody has written this down" —
    // a low-confidence or safety-blocked answer is a different problem, and researching it would
    // fill the queue with questions that already have answers.
    //
    // Fire-and-forget with its own error boundary, exactly like the escalation and
    // support-activity hooks in processIncomingMessage.ts: a research-queue failure must never
    // change what the customer experienced.
    // Ask for help inside the customer's own group, by name, when that is switched on. Additive:
    // the alert above has already gone to the notifications group, and this is about the request
    // landing where the conversation is rather than replacing it.
    if (aiSettings.mentionTeamOnHandover && params.group?.id) {
      await mentionTeamForHandover({
        accountId: params.accountId,
        groupId: params.group.id,
        chatId: params.chatId,
        toPhone: params.toPhone,
        incomingMessageId: params.message.id,
        settings: params.automationSettings,
        testMode: params.group.testModeEnabled ?? false,
      });
    }

    // `startsWith`, not `===`: under the two Forge response modes a failed live research attempt
    // makes the recorded reason the composite "NO_KNOWLEDGE: <why>" (see the deepAnswerReason
    // path above), which never equals the bare string. So on exactly the two configurations where
    // the offline research queue is useful, nothing was ever queued into it — the 2-minute
    // processor had nothing to do precisely when it mattered.
    if (reason.startsWith("NO_BUSINESS_KNOWLEDGE") || reason.startsWith("NO_KNOWLEDGE")) {
      try {
        await recordUnansweredQuestion({
          question: params.message.body,
          fallbackDecisionId: decision.id,
        });
      } catch (err) {
        console.error("[forge] failed to queue an unanswered question for research", err);
      }
    }
  };

  // The customer sent media and nothing else — a screenshot, a voice note, a sticker. The body is
  // a placeholder the provider substituted so the message exists in the inbox; it is a record that
  // something arrived, not a description of it, and nothing in this pipeline can see inside the
  // media. Answering "[Image]" produces a confident generic reply to a screenshot nobody looked
  // at, which is worse than silence because it looks like help.
  //
  // Checked before the safety pre-check and before any API call: there is nothing here to spend a
  // completion on. A CAPTIONED image is not caught by this — the caption is the customer's own
  // question and is answered on its own terms.
  if (isMediaOnlyBody(params.message.body)) {
    await recordHumanFallback("MEDIA_ONLY_MESSAGE");
    return;
  }

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

  // Resolved HERE, not at the top of the function: it reads the provider row and decrypts a
  // stored credential, and the two gates above — a media-only message, an active cooldown or an
  // exhausted rate limit — end the turn without ever reaching a model. Doing that work first meant
  // paying for it on every sticker and every throttled message.
  const client = params.clientOverride ?? (await resolveAiClient("RESPONSE", prisma));
  if (!client) {
    await recordHumanFallback("AI_UNAVAILABLE");
    return;
  }

  // Ground the answer in what this team has actually verified, so the AI describes how their
  // product behaves rather than how a similar one generally does. Returns an empty list when
  // there is nothing relevant or the lookup fails — answering ungrounded is strictly better
  // than not answering.
  //
  // When the customer's own words find nothing, the search is retried in English rather than
  // giving up on the knowledge base — most of these entries are English and most of these
  // customers are not writing in it (see queryExpansion.ts). This runs before the deep-answer
  // research below on purpose: researching the product's source to answer a question four
  // verified entries already cover is the expensive way to arrive somewhere we could have
  // reached with one small call.
  // The turns before this one, so a follow-up is understood as a follow-up rather than as the
  // first thing anyone ever said. Empty for the first message of a conversation, and empty if the
  // read fails — both leave exactly the behaviour that existed before this.
  const conversation = await loadConversationContext({
    accountId: params.accountId,
    chatId: params.chatId,
    currentMessageId: params.message.id,
    currentMessageAt: params.message.timestampWa ?? new Date(),
  });

  let knowledge = await findRelevantKnowledge(
    params.message.body,
    { groupId: params.group?.id ?? null, accountId: params.accountId },
    undefined,
    () => expandQueryTerms(client, params.message.body, conversation),
  );

  // Nothing written down covers this. With deep answers on, go and find out now rather than
  // handing over and researching it for the next person.
  //
  // This produces GROUNDING, not a reply — sanitised knowledge entries that the normal prompt
  // below then answers from, exactly as if someone had written them months ago. So raw source
  // never reaches the prompt that drafts a customer reply, and every gate after this point still
  // applies unchanged. It is slower, which is the trade: a harder question takes longer.
  const mayResearch =
    aiSettings.aiResponseMode === "KNOWLEDGE_PLUS_FORGE" ||
    aiSettings.aiResponseMode === "KNOWLEDGE_FORGE_GENERAL";

  let deepAnswerReason: string | undefined;
  if (knowledge.length === 0 && mayResearch) {
    const researched = await researchForCustomerQuestion({
      question: params.message.body,
      groupId: params.group?.id ?? null,
      client,
    });
    knowledge = researched.snippets;
    deepAnswerReason = researched.reason;
  }

  // Under STRICT_KNOWLEDGE_ONLY, nothing verified means nothing answered — whatever the
  // question turns out to be about. Since the outcome does not depend on the classification,
  // this is decided before the API call, so an ungroundable question costs nothing at all.
  // Every mode except the two that allow general knowledge needs something verified behind the
  // answer. Written as "may not answer generally" rather than a list of modes, so adding another
  // source later cannot silently start letting ungrounded answers through.
  const mayAnswerGenerally =
    aiSettings.aiResponseMode === "KNOWLEDGE_PLUS_GENERAL" ||
    aiSettings.aiResponseMode === "KNOWLEDGE_FORGE_GENERAL";

  if (!mayAnswerGenerally && knowledge.length === 0) {
    // Naming why the research came back empty, so a handover after a deep-answer attempt is
    // distinguishable from one where nothing was tried — "NO_KNOWLEDGE" alone would hide that.
    await recordHumanFallback(deepAnswerReason ? `NO_KNOWLEDGE: ${deepAnswerReason}` : "NO_KNOWLEDGE");
    return;
  }

  // What the evidence actually supports, worked out from the retrieved rows themselves rather
  // than asked of a model: how many documented procedures there are, and whether a how-to
  // question has none. Built AFTER any deep-answer research, so it plans over the final evidence
  // set. See answerPlan.ts for why this is deterministic and why there is no second AI call.
  const plan = buildAnswerPlan(params.message.body, knowledge);

  // The evidence, as one object, fingerprinted before the model sees it. Assembling it here rather
  // than reconstructing it afterwards is what makes the fingerprint describe what was actually
  // sent: anything derived after the call could differ from what the prompt was built from.
  const bundle = buildEvidenceBundle({
    question: params.message.body,
    intent: null,
    knowledge,
    plan,
  });
  const evidenceFingerprint = fingerprintOf(bundle);

  const startedAt = Date.now();
  let completion;
  try {
    completion = await client.complete(
      buildFallbackPrompt({
        customerMessage: params.message.body,
        groupName: params.group?.name ?? null,
        defaultReplyLanguage: aiSettings.defaultReplyLanguage,
        styleGuidance: await getApprovedStyleGuidance(),
        knowledge,
        conversation,
        planGuidance: renderAnswerPlan(plan),
      }),
    );
  } catch (err) {
    await recordHumanFallback(`AI_ERROR: ${(err as Error).message}`, {
      interaction: { latencyMs: Date.now() - startedAt, evidenceFingerprint },
    });
    return;
  }
  const latencyMs = Date.now() - startedAt;

  const parsed = parseFallbackResponse(completion.text);
  // NOTE ON `tokensUsed`: this is the REPLY completion only. A message can also pay for a query
  // expansion (queryExpansion.ts) and, under the Forge modes, a live research call
  // (deepAnswer.ts), and neither is counted here — those functions return terms and grounding
  // rather than a completion result, so the figure is not available at this point without
  // threading it back through both. Read this column as "what the answer cost", not "what the
  // message cost"; the provider's own dashboard is the authority on total spend.
  const commonFields = {
    intent: parsed.intent,
    confidenceScore: parsed.confidence,
    responseText: parsed.responseText,
    modelId: completion.modelId,
    tokensUsed: completion.tokensUsed,
    interaction: {
      latencyMs,
      // The provider's own word for how the generation ended. `truncated` is this system's reading
      // of it; keeping the raw form means a future provider's vocabulary is recorded rather than
      // flattened into a boolean this code happened to define first.
      finishReason: completion.truncated ? "length" : "stop",
      evidenceFingerprint,
    },
  };

  // The token ceiling cut the answer off. Because RESPONSE is the last line of the required
  // format, truncation always lands in the reply text and never in the metadata above it — so
  // every gate below would pass on a confident, well-formed, half-finished answer, and the
  // customer would receive a procedure that stops mid-step. That is the exact outcome the
  // prompt's own NEVER INVENT A STEP rule exists to prevent, arriving by a different route.
  // `truncated` has been on the completion result since it was written, for this, and nothing
  // read it.
  if (completion.truncated) {
    await recordHumanFallback("TRUNCATED_RESPONSE", commonFields);
    return;
  }

  if (parsed.confidence === null) {
    await recordHumanFallback("MALFORMED_RESPONSE", commonFields);
    return;
  }

  // What the AI itself concluded is checked before whether we would have permitted it. Both
  // end in a handoff, but "the AI judged this needs a person" is a more useful thing to read in
  // the activity log than "we would not have let it answer anyway" — the first tells an
  // operator something about the question, the second only about configuration.
  if (!parsed.shouldReply) {
    await recordHumanFallback("AI_DECLINED", commonFields);
    return;
  }
  if (!parsed.responseText) {
    await recordHumanFallback("EMPTY_RESPONSE", commonFields);
    return;
  }

  // The rule that is deliberately not configurable. A model knowing how billing software
  // generally works is not the same as this software having the authority to state how THIS
  // company's billing works — and a fluent guess about a refund window or support hours is
  // worse than no answer, because it sounds official. Relaxing the response mode widens what
  // counts as answerable general conversation; it never licenses inventing this business.
  const groundedInVerifiedKnowledge = knowledge.length > 0;
  if (parsed.scope === "BUSINESS_SPECIFIC" && !groundedInVerifiedKnowledge) {
    await recordHumanFallback("NO_BUSINESS_KNOWLEDGE", commonFields);
    return;
  }
  // An ungrounded general answer is held to its own, normally higher bar: there is no team
  // material behind it, only the model's own confidence in itself.
  const requiredConfidence = groundedInVerifiedKnowledge
    ? aiSettings.autoResponseConfidenceThreshold
    : Math.max(aiSettings.autoResponseConfidenceThreshold, aiSettings.generalAnswerMinConfidence);
  if (parsed.confidence < requiredConfidence) {
    await recordHumanFallback(
      groundedInVerifiedKnowledge ? "LOW_CONFIDENCE" : "LOW_CONFIDENCE_GENERAL",
      commonFields,
    );
    return;
  }

  // The draft is confident, in scope and above threshold — and may still have invented the one
  // thing the prompt most forbids. `NEVER INVENT A STEP` is a request, and a request is not a
  // guarantee, so this checks mechanically: a how-to question, no documented steps anywhere in
  // the evidence, and a numbered list in the reply anyway. Deliberately narrow — see
  // validateGrounding for why a broad hallucination test would block good answers and get ignored.
  const grounding = validateGrounding(parsed.responseText, plan);
  if (!grounding.ok) {
    await recordHumanFallback(grounding.reason ?? "UNGROUNDED_RESPONSE", commonFields);
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
      testMode: params.group?.testModeEnabled ?? false,
  });

  const replied = await createAiFallbackDecision({
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
    latencyMs,
    finishReason: completion.truncated ? "length" : "stop",
    promptVersion: PROMPT_VERSION,
    retrievalVersion: RETRIEVAL_VERSION,
    evidenceFingerprint,
    correlationId: params.correlationId ?? null,
  }, prisma);

  // What the answer was built on, recorded against the decision that produced it. Written after the
  // decision because it hangs off it, and never allowed to fail the interaction: the customer has
  // already been answered by this point, and losing a reply because its audit record could not be
  // filed would trade the outcome for the paperwork.
  if ("id" in replied) {
    await recordEvidenceSnapshot({ decisionId: replied.id, bundle, fingerprint: evidenceFingerprint });
  }

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
    // A rule is a standing answer this company gives. An ungrounded general answer is the
    // model talking about the world, not this business stating its position, so it must never
    // harden into one — even when the model was confident.
    groundedInVerifiedKnowledge,
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
  groundedInVerifiedKnowledge: boolean;
  customerMessage: string;
  replyText: string;
  confidence: number;
  intent: string | null;
  sourceMessageId: string;
  groupName: string | null;
}): Promise<void> {
  if (!params.aiSettings.aiRuleGenerationEnabled) return;
  if (!params.groundedInVerifiedKnowledge) return;
  if (params.confidence < params.aiSettings.aiRuleGenerationMinConfidence) return;

  try {
    await createRuleProposalFromAiReply({
      customerMessage: params.customerMessage,
      replyText: params.replyText,
      confidence: params.confidence,
      intent: params.intent,
      sourceMessageId: params.sourceMessageId,
      groupName: params.groupName,
    }, prisma);
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
  /** The pipeline trace id, so a failure here groups with everything else for this message. */
  correlationId?: string | null;
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

  // Why each channel did not deliver, so the terminal case below can say which door was shut
  // rather than only that nobody answered. Routing policy is untouched: WhatsApp is still
  // preferred, Teams is still the fallback, and a muted channel still falls through.
  let whatsappOutcome = "NO_DESTINATIONS_CONFIGURED";
  let teamsOutcome = "NO_WEBHOOK_CONFIGURED";

  if (takeoverDestinations.length > 0) {
    const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP", prisma);
    if (isResolutionError(resolution)) {
      whatsappOutcome = `ROUTING_FAILED: ${resolution.error}`;
    }
    if (!isResolutionError(resolution)) {
      // EVERY configured destination, not just the first.
      //
      // This read `takeoverDestinations[0]` and nothing else, so an admin who listed three groups
      // had two of them silently never told about a handover — the setting accepted the list, the
      // page showed the list, and one group heard about it. Same loop the unknown-pattern alert
      // in patternDetectionJob.ts already uses.
      //
      // The FIRST id that is actually written is what the decision links to: the handover is one
      // event however many places it was announced in, and `AiFallbackDecision.notificationId` is
      // a single foreign key. A muted channel writes nothing at all (`suppressed`), which is why
      // that is tested per destination rather than assumed from the first.
      let firstNotificationId: string | null = null;
      for (const destination of takeoverDestinations) {
        const queued = await enqueueNotification({
          type: "WHATSAPP",
          event: "AI_HUMAN_FALLBACK",
          destination,
          accountId: resolution.accountId,
          relatedMessageId: params.messageId,
          payload,
        });
        // `suppressed` means the admin muted this event's WhatsApp channel, so NOTHING was written
        // and `id` is the empty string rather than a real Notification id. Recording it would write
        // "" into AiFallbackDecision.notificationId — a foreign key — which fails with P2003, and
        // createAiFallbackDecision only swallows P2002. That rethrow used to destroy the decision
        // row, the in-group mention and the Forge research task together, so muting one alert
        // channel silently blinded the entire handover path.
        if (!queued.suppressed && !firstNotificationId) firstNotificationId = queued.id;
      }
      // Something was genuinely written, so this is where the handover was announced. A muted
      // channel falls through to Teams instead: that is a statement about WhatsApp, not about
      // whether the team is told at all.
      if (firstNotificationId) return firstNotificationId;
      whatsappOutcome = "MUTED";
    }
  }

  if (params.automationSettings.teamsWebhookUrl) {
    const sent = await enqueueNotification({
      type: "TEAMS",
      event: "AI_HUMAN_FALLBACK",
      destination: params.automationSettings.teamsWebhookUrl,
      relatedMessageId: params.messageId,
      payload,
    });
    if (!sent.suppressed) return sent.id;
    teamsOutcome = "MUTED";
  }

  // Every channel is shut, so nobody has been told a customer is waiting for a person.
  //
  // This used to be a bare `return null`. The AiFallbackDecision row was still written, so the
  // handover appeared in the AI Activity log with a null notificationId — and a null there reads
  // identically whether the alert was muted on purpose, could not be routed, or was never
  // configured at all. Every sibling raise-point already records this: the escalation queue defers
  // with a WARN, the watchdog states outright that nobody could be told, pattern detection and the
  // Teams resolver both log a skip. This one said nothing, which is the shape the watchdog names —
  // the absence of an alert reads as the absence of a problem.
  //
  // Reported, never retried: the routing policy above is unchanged, and the customer-facing side
  // of the handover has already happened. This makes the terminal state observable, nothing more.
  await logSystemEvent(
    "ERROR",
    "ai-fallback",
    "AI_HUMAN_FALLBACK_NOTIFICATION_FAILED",
    {
      reason: "NO_AVAILABLE_NOTIFICATION_CHANNEL",
      whatsapp: whatsappOutcome,
      teams: teamsOutcome,
      accountId: params.accountId,
      handoverReason: params.reason,
    },
    {
      targetType: "Message",
      targetId: params.messageId,
      correlationId: params.correlationId ?? null,
    },
  );

  return null;
}
