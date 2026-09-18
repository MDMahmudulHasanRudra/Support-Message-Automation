import { prisma } from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import { buildFallbackPrompt, parseFallbackResponse } from "../aiFallback/prompt.js";
import { findRelevantKnowledge } from "../aiFallback/knowledgeContext.js";
import { expandQueryTerms } from "../aiFallback/queryExpansion.js";
import type { ConversationTurn } from "../aiFallback/conversationContext.js";
import { getApprovedStyleGuidance } from "../knowledge/communicationStyleJob.js";
import { getAiSettings } from "../ai/settings.js";

/**
 * The AI Sandbox's worker side: answers one queued sandbox turn.
 *
 * WHAT THIS IS. A faithful dry run of the AI fallback layer's DECISION path —
 * knowledge retrieval, the response-mode gate, the real prompt, the real parse, the
 * business-question guard and the confidence threshold — so an admin can see not only
 * what the AI would say, but which gate would have stopped it saying it.
 *
 * WHAT THIS IS NOT, and must never become. It performs none of runAiFallback's side
 * effects, and the list is exhaustive on purpose:
 *   - no `checkAiFallbackEligibility` (that gate asks whether a REAL group has opted in,
 *     is monitored, and is not in a human-takeover cooldown — none of which is a question
 *     about a test message, and all of which would make the sandbox unusable)
 *   - no `checkAutoReplySafety` (rate limits and cooldowns protect a WhatsApp number this
 *     path never touches; letting a test consume that budget would be the tail wagging the dog)
 *   - no `enqueueOutboundMessage` — nothing is ever sent
 *   - no `createAiFallbackDecision` — the AI Activity log stays a record of real customers
 *   - no `enqueueNotification`, no `mentionTeamForHandover` — nobody is paged for a test
 *   - no `recordAiSupportActivity` — no one's performance figures move
 *   - no `createRuleProposalFromAiReply` — a test cannot draft a standing rule
 *
 * Because it shares `buildFallbackPrompt`/`parseFallbackResponse`/`findRelevantKnowledge`
 * by importing them rather than copying them, a change to the production prompt shows up
 * here automatically. That is the whole reason this lives in the worker instead of in the
 * web app: the sandbox tests what production actually does, not a second implementation
 * of it that drifts.
 *
 * Never throws. A failed turn is recorded as FAILED with its error text, which is a result
 * the admin can read, not an exception that kills a background loop.
 */
export async function processOneSandboxTurn(): Promise<void> {
  // Claim-style: exactly one worker tick can move a turn out of PENDING, the same guard
  // the outbound queue and the knowledge importer use.
  const pending = await prisma.sandboxTurn.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!pending) return;

  const claimed = await prisma.sandboxTurn.updateMany({
    where: { id: pending.id, status: "PENDING" },
    data: { status: "PROCESSING" },
  });
  if (claimed.count === 0) return; // another tick got it first

  try {
    await answerTurn(pending.id);
  } catch (err) {
    console.error("[sandbox] turn failed", err);
    await prisma.sandboxTurn
      .update({
        where: { id: pending.id },
        data: {
          status: "FAILED",
          error: (err as Error).message.slice(0, 500),
          completedAt: new Date(),
        },
      })
      .catch(() => {
        /* the row is gone (session deleted mid-run) — nothing left to record against */
      });
  }
}

async function answerTurn(turnId: string): Promise<void> {
  const turn = await prisma.sandboxTurn.findUnique({
    where: { id: turnId },
    include: { session: { include: { group: { select: { id: true, name: true } } } } },
  });
  if (!turn) return;

  const aiSettings = await getAiSettings();

  /** Records the outcome and ends the turn. Mirrors runAiFallback's own `reason` vocabulary. */
  const finish = async (fields: {
    outcome: "AI_REPLIED" | "HUMAN_FALLBACK";
    reason?: string | null;
    responseText?: string | null;
    intent?: string | null;
    scope?: string | null;
    confidenceScore?: number | null;
    modelId?: string | null;
    tokensUsed?: number | null;
    knowledgeTitles?: string[];
  }): Promise<void> => {
    await prisma.sandboxTurn.update({
      where: { id: turnId },
      data: {
        status: "COMPLETE",
        outcome: fields.outcome,
        reason: fields.reason ?? null,
        responseText: fields.responseText ?? null,
        intent: fields.intent ?? null,
        scope: fields.scope ?? null,
        confidenceScore: fields.confidenceScore ?? null,
        modelId: fields.modelId ?? null,
        tokensUsed: fields.tokensUsed ?? null,
        knowledgeTitles: fields.knowledgeTitles ?? [],
        completedAt: new Date(),
      },
    });
  };

  // The engine master switch is the one production gate that genuinely applies here: with it
  // off there is no model to ask. Every OTHER gate in checkAiFallbackEligibility is about a
  // real group and a real customer, and is deliberately not consulted — see the header.
  if (!aiSettings.aiEngineEnabled) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: "AI_UNAVAILABLE: the AI Engine master switch is off." });
    return;
  }

  let client: AiClient | null;
  try {
    client = await resolveAiClient("RESPONSE");
  } catch (err) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: `AI_UNAVAILABLE: ${(err as Error).message}` });
    return;
  }
  if (!client) {
    await finish({
      outcome: "HUMAN_FALLBACK",
      reason: "AI_UNAVAILABLE: no provider is assigned to the Response job, or it is disabled.",
    });
    return;
  }

  // The earlier turns of THIS sandbox conversation, so a follow-up reads as a follow-up —
  // the same role-reduced shape production builds from real messages, assembled here from
  // sandbox rows instead. It never reads the Message table.
  const conversation = await loadSandboxConversation(turn.sessionId, turn.createdAt);

  const groupId = turn.session.group?.id ?? null;
  const knowledge = await findRelevantKnowledge(turn.userMessage, groupId, undefined, () =>
    expandQueryTerms(client!, turn.userMessage, conversation),
  );
  const knowledgeTitles = knowledge.map((entry) => entry.title);

  // Deep-answer research is deliberately NOT run here. It writes verified AiKnowledgeItem
  // rows as a side effect (see deepAnswer.ts), and a testing surface must not be able to
  // add verified knowledge by being used.
  const mayAnswerGenerally =
    aiSettings.aiResponseMode === "KNOWLEDGE_PLUS_GENERAL" ||
    aiSettings.aiResponseMode === "KNOWLEDGE_FORGE_GENERAL";

  if (!mayAnswerGenerally && knowledge.length === 0) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: "NO_KNOWLEDGE", knowledgeTitles });
    return;
  }

  let completion;
  try {
    completion = await client.complete(
      buildFallbackPrompt({
        customerMessage: turn.userMessage,
        groupName: turn.session.group?.name ?? null,
        defaultReplyLanguage: aiSettings.defaultReplyLanguage,
        styleGuidance: await getApprovedStyleGuidance(),
        knowledge,
        conversation,
      }),
    );
  } catch (err) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: `AI_ERROR: ${(err as Error).message}`, knowledgeTitles });
    return;
  }

  const parsed = parseFallbackResponse(completion.text);
  const common = {
    intent: parsed.intent,
    scope: parsed.scope,
    confidenceScore: parsed.confidence,
    responseText: parsed.responseText,
    modelId: completion.modelId,
    tokensUsed: completion.tokensUsed,
    knowledgeTitles,
  };

  if (parsed.confidence === null) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: "MALFORMED_RESPONSE", ...common });
    return;
  }
  if (!parsed.shouldReply) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: "AI_DECLINED", ...common });
    return;
  }
  if (!parsed.responseText) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: "EMPTY_RESPONSE", ...common });
    return;
  }

  // The business-question guard, reproduced exactly — it is the rule production does not let
  // anyone configure away, so a sandbox that skipped it would be reassuring about the wrong
  // thing.
  const grounded = knowledge.length > 0;
  if (parsed.scope === "BUSINESS_SPECIFIC" && !grounded) {
    await finish({ outcome: "HUMAN_FALLBACK", reason: "NO_BUSINESS_KNOWLEDGE", ...common });
    return;
  }

  const requiredConfidence = grounded
    ? aiSettings.autoResponseConfidenceThreshold
    : Math.max(aiSettings.autoResponseConfidenceThreshold, aiSettings.generalAnswerMinConfidence);
  if (parsed.confidence < requiredConfidence) {
    await finish({
      outcome: "HUMAN_FALLBACK",
      reason: grounded ? "LOW_CONFIDENCE" : "LOW_CONFIDENCE_GENERAL",
      ...common,
    });
    return;
  }

  await finish({ outcome: "AI_REPLIED", ...common });
}

/** Enough turns to resolve a reference, matching conversationContext.ts's own MAX_TURNS. */
const MAX_SANDBOX_TURNS = 10;

/**
 * The completed turns before this one, oldest first, reduced to the same CUSTOMER/SUPPORT
 * roles production uses. A turn that ended in a handover contributes only the customer's
 * side — there was no reply, and inventing one would teach the model that the conversation
 * went somewhere it did not.
 */
async function loadSandboxConversation(sessionId: string, before: Date): Promise<ConversationTurn[]> {
  const rows = await prisma.sandboxTurn.findMany({
    where: { sessionId, createdAt: { lt: before }, status: "COMPLETE" },
    orderBy: { createdAt: "desc" },
    take: MAX_SANDBOX_TURNS,
    select: { userMessage: true, responseText: true, outcome: true },
  });

  const turns: ConversationTurn[] = [];
  for (const row of [...rows].reverse()) {
    turns.push({ role: "CUSTOMER", body: row.userMessage });
    if (row.outcome === "AI_REPLIED" && row.responseText) {
      turns.push({ role: "SUPPORT", body: row.responseText });
    }
  }
  return turns;
}
