import { prisma } from "@support-automation/db";
import { resolveAiClient, type AiClient } from "@support-automation/ai-client";
import type { LearningBatchJobTrigger } from "@prisma/client";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { getLearningSettings } from "./sessionSegmentation.js";
import { rescoreCandidate } from "./patternDetectionJob.js";

/**
 * Conversation Learning — Phase 5 (AI-assisted batch analysis, fully optional). The only file in
 * this codebase that calls an AI provider for pattern discovery, and the only caller of
 * @support-automation/ai-client's resolveAiClient() for the "LEARNING" job. Gated hard on BOTH
 * AiSettings.aiEngineEnabled and AiSettings.learningEnabled — checked explicitly here AND inside
 * resolveAiClient() itself (belt-and-suspenders: the explicit check here still applies even when
 * a test injects `clientOverride`, so a MockAiClient-based test still exercises the same real
 * gating rule instead of trivially bypassing it). Never calls AI per-message: one call per
 * PatternCandidate, capped at MAX_CANDIDATES_PER_BATCH per run, and only for candidates that
 * already cleared the deterministic occurrence/diversity floor — a pattern that can never surface
 * regardless of AI's opinion is never sent to it. The AI's response is parsed into a confidence
 * number and a summary string — nothing here ever executes a WhatsApp action, creates a rule, or
 * sends a message.
 */

const MAX_CANDIDATES_PER_BATCH = 20;
const EXAMPLE_EVIDENCE_PER_CANDIDATE = 3;

/** `clientOverride` is a test-only seam (mirrors processOne(provider)'s MockProvider injection elsewhere in this worker) — production call sites never pass it. */
export async function processOneAiAnalysisBatch(
  trigger: LearningBatchJobTrigger = "SCHEDULED",
  clientOverride?: AiClient,
): Promise<boolean> {
  const aiSettings = await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } });
  if (!aiSettings.aiEngineEnabled || !aiSettings.learningEnabled) return false;

  const client = clientOverride ?? (await resolveAiClient("LEARNING"));
  if (!client) return false;

  const settings = await getLearningSettings();
  const modelConfig = await prisma.aiModelConfig.findUnique({ where: { job: "LEARNING" } });
  const humanReviewThreshold = aiSettings.humanReviewThreshold;

  const candidates = await prisma.patternCandidate.findMany({
    where: {
      status: "PENDING_ANALYSIS",
      occurrenceCount: { gte: settings.minOccurrenceForCandidate },
      distinctGroupCount: { gte: settings.minDistinctGroupsForCandidate },
      distinctClientCount: { gte: settings.minDistinctClientsForCandidate },
    },
    orderBy: { occurrenceCount: "desc" },
    take: MAX_CANDIDATES_PER_BATCH,
  });
  if (candidates.length === 0) return false;

  const job = await prisma.learningBatchJob.create({
    data: {
      jobType: "AI_ANALYSIS",
      trigger,
      status: "RUNNING",
      startedAt: new Date(),
      aiProviderId: modelConfig?.providerId ?? null,
    },
  });

  let updated = 0;
  try {
    for (const candidate of candidates) {
      try {
        const evidence = await prisma.patternCandidateEvidence.findMany({
          where: { patternCandidateId: candidate.id },
          take: EXAMPLE_EVIDENCE_PER_CANDIDATE,
          orderBy: { createdAt: "desc" },
          include: { matchedMessage: { select: { body: true } } },
        });

        const result = await client.complete(buildAnalysisRequest(candidate, evidence));
        const parsed = parseAnalysisResponse(result.text);

        await prisma.patternCandidate.update({
          where: { id: candidate.id },
          data: {
            aiConfidenceScore: parsed.confidence,
            aiAnalysisSummary: parsed.summary,
            aiProviderId: modelConfig?.providerId ?? null,
          },
        });

        // Reuse the exact same status-transition rule the deterministic job uses, now that
        // aiConfidenceScore is no longer null — may promote straight to PENDING_REVIEW.
        await rescoreCandidate(candidate.id, settings, humanReviewThreshold);

        // If it didn't clear the review threshold, mark it ANALYZED so it's never re-selected for
        // (and never re-billed for) another AI pass without new evidence arriving first.
        const reloaded = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
        if (reloaded.status === "PENDING_ANALYSIS") {
          await prisma.patternCandidate.update({ where: { id: candidate.id }, data: { status: "ANALYZED" } });
        }

        updated++;
      } catch (err) {
        // One candidate's API failure/malformed response must never abort the whole batch.
        await logSystemEvent("WARN", "conversation-learning", "AI analysis failed for one pattern candidate", {
          candidateId: candidate.id,
          error: (err as Error).message,
        });
      }
    }

    await prisma.learningBatchJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", completedAt: new Date(), candidatesConsidered: candidates.length, candidatesUpdated: updated },
    });
    return updated > 0;
  } catch (err) {
    await prisma.learningBatchJob.update({
      where: { id: job.id },
      data: { status: "FAILED", completedAt: new Date(), errorMessage: (err as Error).message },
    });
    await logSystemEvent("ERROR", "conversation-learning", "AI analysis batch failed", { error: (err as Error).message });
    throw err;
  }
}

function buildAnalysisRequest(
  candidate: { suggestedKeywords: string[]; occurrenceCount: number; distinctGroupCount: number; distinctClientCount: number; suggestedReplyMessage: string | null },
  evidence: Array<{ matchedMessage: { body: string } | null }>,
) {
  const examples = evidence
    .map((e) => e.matchedMessage?.body)
    .filter((body): body is string => Boolean(body))
    .map((body, i) => `${i + 1}. "${body}"`)
    .join("\n");

  const userPrompt = [
    `A support automation system detected a recurring customer message pattern.`,
    `Suggested keywords: ${candidate.suggestedKeywords.join(", ") || "(none)"}`,
    `Seen ${candidate.occurrenceCount} time(s) across ${candidate.distinctGroupCount} distinct group(s) and ${candidate.distinctClientCount} distinct client(s).`,
    candidate.suggestedReplyMessage ? `A support team member has previously replied: "${candidate.suggestedReplyMessage}"` : "No team-member reply has been observed for this pattern yet.",
    examples ? `Example customer messages:\n${examples}` : "",
    ``,
    `Assess whether this looks like a genuine, coherent, reusable support pattern worth turning into an automation rule (as opposed to a coincidental grouping of unrelated messages).`,
    `Respond in EXACTLY this format, two lines, nothing else:`,
    `CONFIDENCE: <a single integer 0-100>`,
    `SUMMARY: <one short paragraph explaining your reasoning>`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    systemPrompt:
      "You are assisting a support-automation system in reviewing candidate conversation patterns. You only ever analyze and report — you cannot and must not attempt to send messages, execute commands, or take any action beyond returning the requested assessment.",
    userPrompt,
    maxTokens: 300,
    temperature: 0,
  };
}

/** Exported for direct unit testing — pure text parsing, no IO. */
export function parseAnalysisResponse(text: string): { confidence: number | null; summary: string } {
  const confidenceMatch = text.match(/CONFIDENCE:\s*(-?\d+)/i);
  const summaryMatch = text.match(/SUMMARY:\s*([\s\S]+)/i);

  const confidence = confidenceMatch ? Math.max(0, Math.min(100, Number(confidenceMatch[1]))) : null;
  const summary = summaryMatch ? summaryMatch[1]!.trim() : text.trim().slice(0, 1000);

  return { confidence, summary };
}
