import { prisma } from "@support-automation/db";
import type { LearningSettings } from "@prisma/client";
import { derivePatternSignature, meetsCandidateFloor, scorePatternCandidate } from "@support-automation/engine";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { getLearningSettings } from "./sessionSegmentation.js";

/**
 * Conversation Learning — Phase 2 (deterministic pattern detection). Entirely AI-free: every score
 * comes from packages/engine/src/patternDetection.ts's pure functions, never from an AI provider.
 * Reads ConversationSession/Message rows the segmentation job already produced; never writes to
 * Message, AutomationRule, or anything the real pipeline/rule engine reads.
 *
 * A PatternCandidate row is created as soon as a pattern's first occurrence is seen — the hard
 * floor (LearningSettings.minOccurrenceForCandidate/minDistinctGroupsForCandidate/
 * minDistinctClientsForCandidate) is enforced by rescoreCandidate() refusing to advance `status`
 * past PENDING_ANALYSIS until it's met, and by the dashboard only listing rows currently past it —
 * so a single isolated conversation can never become visible or actionable, even though its row
 * technically exists as an accumulator.
 */

const SESSION_BATCH_SIZE = 200;

export async function processOnePatternDetectionBatch(): Promise<boolean> {
  const settings = await getLearningSettings();
  if (!settings.conversationLearningEnabled) return false;

  const job = await prisma.learningBatchJob.create({
    data: { jobType: "PATTERN_DETECTION", trigger: "SCHEDULED", status: "RUNNING", startedAt: new Date() },
  });

  try {
    const { sessionsLinked, dirtyCandidateIds } = await linkClosedSessionsToCandidates();
    const humanReviewThreshold = (
      await prisma.aiSettings.upsert({ where: { id: "global" }, update: {}, create: { id: "global" } })
    ).humanReviewThreshold;

    for (const candidateId of dirtyCandidateIds) {
      await rescoreCandidate(candidateId, settings, humanReviewThreshold);
    }

    await prisma.learningBatchJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        candidatesConsidered: sessionsLinked,
        candidatesUpdated: dirtyCandidateIds.size,
      },
    });
    return sessionsLinked > 0 || dirtyCandidateIds.size > 0;
  } catch (err) {
    await prisma.learningBatchJob.update({
      where: { id: job.id },
      data: { status: "FAILED", completedAt: new Date(), errorMessage: (err as Error).message },
    });
    await logSystemEvent("ERROR", "conversation-learning", "Pattern detection batch failed", {
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Reads a bounded slice of CLOSED sessions with no evidence row yet. Each session's first
 * customer (non-team-member, incoming) message derives the pattern signature; a session whose
 * only messages are from team members (e.g. staff coordinating in a group with no customer
 * message at all) has nothing to derive a signature from and is deliberately left without an
 * evidence row — a known, accepted limitation: such a session is simply re-checked on every
 * future tick rather than needing separate "processed, but no pattern" tracking, and the bounded
 * batch size caps the wasted work.
 */
async function linkClosedSessionsToCandidates(): Promise<{ sessionsLinked: number; dirtyCandidateIds: Set<string> }> {
  const sessions = await prisma.conversationSession.findMany({
    where: { status: "CLOSED", evidence: { none: {} } },
    take: SESSION_BATCH_SIZE,
  });

  const dirtyCandidateIds = new Set<string>();
  if (sessions.length === 0) return { sessionsLinked: 0, dirtyCandidateIds };

  for (const session of sessions) {
    const firstCustomerMessage = await prisma.message.findFirst({
      where: { conversationSessionId: session.id, isFromTeamMember: false, direction: "INCOMING" },
      orderBy: { timestampWa: "asc" },
    });
    if (!firstCustomerMessage) continue;

    const { patternKey, keywords } = derivePatternSignature(firstCustomerMessage.body);
    if (!patternKey) continue; // no distinctive tokens at all (e.g. a bare emoji/sticker placeholder body)

    const teamReply = await prisma.message.findFirst({
      where: {
        conversationSessionId: session.id,
        isFromTeamMember: true,
        timestampWa: { gt: firstCustomerMessage.timestampWa },
      },
      orderBy: { timestampWa: "asc" },
    });

    const respondingExecution = await prisma.automationExecution.findFirst({
      where: { message: { conversationSessionId: session.id }, ruleId: { not: null } },
      orderBy: { matchedAt: "asc" },
    });

    const candidate = await prisma.patternCandidate.upsert({
      where: { patternKey },
      update: {},
      create: {
        patternKey,
        suggestedMatchType: "KEYWORDS",
        suggestedKeywords: keywords,
        firstSeenAt: firstCustomerMessage.timestampWa,
        lastSeenAt: firstCustomerMessage.timestampWa,
      },
    });

    await prisma.patternCandidateEvidence.create({
      data: {
        patternCandidateId: candidate.id,
        conversationSessionId: session.id,
        matchedMessageId: firstCustomerMessage.id,
        wasResolved: Boolean(teamReply),
        respondingRuleId: respondingExecution?.ruleId ?? null,
      },
    });

    // Capture the first-ever observed resolution as the suggested reply template — evidence, not
    // binding, and never overwritten once set (a human reviewer can always edit it later).
    if (teamReply && !candidate.suggestedReplyMessage) {
      await prisma.patternCandidate.update({
        where: { id: candidate.id },
        data: { suggestedReplyMessage: teamReply.body },
      });
    }

    dirtyCandidateIds.add(candidate.id);
  }

  return { sessionsLinked: sessions.length, dirtyCandidateIds };
}

/**
 * Recomputes one candidate's aggregate evidence stats and scores from scratch off its linked
 * PatternCandidateEvidence rows — cheap enough per-candidate given the bounded batch size, and
 * avoids any risk of incremental counters drifting from the actual evidence over time. Exported:
 * aiAnalysisJob.ts calls this too, right after writing a fresh aiConfidenceScore, so both jobs
 * share one status-transition rule instead of two copies drifting apart.
 */
export async function rescoreCandidate(
  candidateId: string,
  settings: LearningSettings,
  humanReviewThreshold: number,
): Promise<void> {
  const evidenceRows = await prisma.patternCandidateEvidence.findMany({
    where: { patternCandidateId: candidateId },
    include: { conversationSession: true, matchedMessage: true },
  });
  if (evidenceRows.length === 0) return;

  const occurrenceCount = evidenceRows.length;
  const distinctGroupCount = new Set(
    evidenceRows.map((e) => e.conversationSession.groupId).filter((v): v is string => Boolean(v)),
  ).size;
  const distinctClientCount = new Set(
    evidenceRows.map((e) => e.matchedMessage?.senderPhone).filter((v): v is string => Boolean(v)),
  ).size;
  const resolvedCount = evidenceRows.filter((e) => e.wasResolved).length;
  const keywordSets = evidenceRows
    .map((e) => (e.matchedMessage ? derivePatternSignature(e.matchedMessage.body).keywords : null))
    .filter((v): v is string[] => v !== null);
  // Prefer the matched message's own timestamp; fall back to the session's lastMessageAt only if
  // the message was since deleted out from under this evidence row (matchedMessageId is SetNull).
  const timestamps = evidenceRows.map((e) => e.matchedMessage?.timestampWa ?? e.conversationSession.lastMessageAt);
  const firstSeenAt = new Date(Math.min(...timestamps.map((d) => d.getTime())));
  const lastSeenAt = new Date(Math.max(...timestamps.map((d) => d.getTime())));

  const candidate = await prisma.patternCandidate.findUniqueOrThrow({ where: { id: candidateId } });

  const scores = scorePatternCandidate(
    {
      occurrenceCount,
      distinctGroupCount,
      distinctClientCount,
      resolvedCount,
      keywordSets,
      lastSeenAt,
      aiConfidenceScore: candidate.aiConfidenceScore,
      humanVerifiedBoost: candidate.humanVerifiedBoost,
    },
    {
      minOccurrenceForCandidate: settings.minOccurrenceForCandidate,
      minDistinctGroupsForCandidate: settings.minDistinctGroupsForCandidate,
      minDistinctClientsForCandidate: settings.minDistinctClientsForCandidate,
      weightFrequency: settings.weightFrequency,
      weightDiversity: settings.weightDiversity,
      weightConsistency: settings.weightConsistency,
      weightResolution: settings.weightResolution,
      weightRecency: settings.weightRecency,
      weightAiConfidence: settings.weightAiConfidence,
    },
    new Date(),
  );

  const floorMet = meetsCandidateFloor({ occurrenceCount, distinctGroupCount, distinctClientCount }, settings);

  // The floor gates status advancement, not just visibility — a candidate never reaches
  // PENDING_REVIEW purely because the confidence formula produced a high number on thin evidence.
  // PENDING_ANALYSIS and ANALYZED (the latter only reachable once aiAnalysisJob.ts has scored a
  // candidate) are both valid pre-review states this job can promote from — occurrence/diversity
  // counts only grow over time, so a real backslide out of PENDING_REVIEW/APPROVED/etc. can't
  // happen; this guard is about the first transition into PENDING_REVIEW only.
  let status = candidate.status;
  if (!floorMet) {
    status = "PENDING_ANALYSIS";
  } else if (
    (candidate.status === "PENDING_ANALYSIS" || candidate.status === "ANALYZED") &&
    scores.confidenceScore >= humanReviewThreshold
  ) {
    status = "PENDING_REVIEW";
  }

  await prisma.patternCandidate.update({
    where: { id: candidateId },
    data: {
      occurrenceCount,
      distinctGroupCount,
      distinctClientCount,
      firstSeenAt,
      lastSeenAt,
      frequencyScore: scores.frequencyScore,
      diversityScore: scores.diversityScore,
      consistencyScore: scores.consistencyScore,
      resolutionScore: scores.resolutionScore,
      recencyScore: scores.recencyScore,
      confidenceScore: scores.confidenceScore,
      status,
    },
  });
}
