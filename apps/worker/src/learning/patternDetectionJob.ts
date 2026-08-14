import {
  approveRuleProposalById,
  createRuleProposalFromCandidate,
  isResolutionError,
  prisma,
  resolveWhatsAppAccount,
} from "@support-automation/db";
import type { LearningSettings, PatternCandidateStatus } from "@prisma/client";
import { derivePatternSignature, meetsCandidateFloor, scorePatternCandidate } from "@support-automation/engine";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { getLearningSettings } from "./sessionSegmentation.js";

/** A candidate in any of these states has already been resolved one way or another (a real rule
 * exists, or a human dismissed it) — further Unknown Pattern alerts about it would be noise. */
const UNKNOWN_PATTERN_TERMINAL_STATUSES = new Set<PatternCandidateStatus>(["APPROVED", "REJECTED", "MERGED", "EXPIRED"]);

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
 *
 * Phase 6 additions: rescoreCandidate() also auto-approves a candidate into a real (still DRAFT)
 * AutomationRule when LearningSettings.autoApprovalEnabled is explicitly on AND the confidence
 * score clears autoApprovalMinConfidence — default is OFF, and even auto-approved rules still
 * require a separate human "activate" click on the Rules page (see approveRuleProposalById()'s
 * own doc comment in packages/db). This batch also sweeps candidates that have sat idle past
 * LearningSettings.candidateExpiryDays into EXPIRED, so PENDING_REVIEW never grows unbounded.
 *
 * Unknown Pattern Detection (later addition): rescoreCandidate() also tracks unhandledCount — of
 * a candidate's evidence, how many rows have no respondingRuleId (no existing AutomationRule fired
 * for that historical message). Once unhandledCount alone clears the same deterministic floor used
 * for candidate surfacing (meetsCandidateFloor), and LearningSettings.unknownPatternNotificationsEnabled
 * is explicitly on (default OFF), a support-group WhatsApp alert is queued via the existing
 * Notification/enqueueNotification mechanism — never a new send path, never bypassing the outbound
 * queue's cooldown/rate-limit layer that real AUTO_REPLY actions go through (a Notification is a
 * distinct, pre-existing delivery lane the app already uses for support alerts). A per-candidate
 * cooldown (unknownPatternCooldownMinutes) stops one recurring unhandled question from re-alerting
 * every 15-minute tick, and a candidate already APPROVED/REJECTED/MERGED/EXPIRED never re-alerts —
 * it's already been resolved one way or another.
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

    const expiredCount = await sweepExpiredCandidates(settings.candidateExpiryDays);

    await prisma.learningBatchJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        candidatesConsidered: sessionsLinked,
        // Generic counter shared across jobType meanings (see LearningBatchJob's schema comment) —
        // here it's rescored candidates plus any newly expired this tick.
        candidatesUpdated: dirtyCandidateIds.size + expiredCount,
      },
    });
    return sessionsLinked > 0 || dirtyCandidateIds.size > 0 || expiredCount > 0;
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
 * Moves any candidate still waiting on something (not yet reviewed one way or another) into
 * EXPIRED once it's gone `candidateExpiryDays` without an update — prevents PENDING_REVIEW (and
 * the PENDING_ANALYSIS/ANALYZED accumulator states) from growing forever if nobody ever looks at
 * them. Terminal states (APPROVED/REJECTED/WITHDRAWN/MERGED/EXPIRED itself) are untouched.
 */
async function sweepExpiredCandidates(candidateExpiryDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - candidateExpiryDays * 24 * 60 * 60_000);
  const result = await prisma.patternCandidate.updateMany({
    where: {
      status: { in: ["PENDING_ANALYSIS", "ANALYZED", "PENDING_REVIEW"] },
      updatedAt: { lt: cutoff },
    },
    data: { status: "EXPIRED" },
  });
  return result.count;
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

  // Auto-approval: explicit opt-in only (default OFF), and only from the transition just computed
  // above — never overrides a status a human (or a prior auto-approval) already set. Creating the
  // real AutomationRule still goes through the exact same validated path a human's Approve click
  // uses (packages/db's approveRuleProposalById), including the "always DRAFT, never ACTIVE"
  // safety gate — auto-approval only ever skips the human's click, never the validation, and never
  // the separate manual activation step on the Rules page.
  if (status === "PENDING_REVIEW" && settings.autoApprovalEnabled && scores.confidenceScore >= settings.autoApprovalMinConfidence) {
    const proposalResult = await createRuleProposalFromCandidate(candidateId);
    if ("id" in proposalResult) {
      const approveResult = await approveRuleProposalById({
        proposalId: proposalResult.id,
        reviewedById: null,
        autoApproved: true,
      });
      if (!("error" in approveResult)) {
        status = "APPROVED";
      }
    }
    // If either step returned an error (e.g. a human already created a proposal for this
    // candidate first), fall through with status left at PENDING_REVIEW — never treated as a
    // failure, never retried more than the normal rescore cadence already would.
  }

  // Unknown Pattern Detection: same deterministic floor (meetsCandidateFloor), applied to
  // UNHANDLED evidence specifically rather than total occurrenceCount — a pattern an existing
  // rule already handles well never counts as "unknown" here, no matter how often it recurs.
  // Independent of the confidence-weighted PENDING_REVIEW transition above (this floor check
  // doesn't consult scores.confidenceScore at all): it's meant as an earlier, lighter-weight
  // signal that something is going unanswered, not a restatement of the review gate.
  const unhandledCount = evidenceRows.filter((e) => e.respondingRuleId === null).length;
  let unknownPatternNotifiedAt = candidate.unknownPatternNotifiedAt;

  const alreadyResolved = UNKNOWN_PATTERN_TERMINAL_STATUSES.has(status as PatternCandidateStatus);
  const unknownPatternFloorMet = meetsCandidateFloor(
    { occurrenceCount: unhandledCount, distinctGroupCount, distinctClientCount },
    settings,
  );
  const cooldownElapsed =
    !unknownPatternNotifiedAt ||
    Date.now() - unknownPatternNotifiedAt.getTime() >= settings.unknownPatternCooldownMinutes * 60_000;

  if (settings.unknownPatternNotificationsEnabled && !alreadyResolved && unknownPatternFloorMet && cooldownElapsed) {
    const sent = await sendUnknownPatternAlert(candidate, evidenceRows, {
      unhandledCount,
      distinctGroupCount,
      distinctClientCount,
      confidenceScore: scores.confidenceScore,
    });
    if (sent) unknownPatternNotifiedAt = new Date();
  }

  await prisma.patternCandidate.update({
    where: { id: candidateId },
    data: {
      occurrenceCount,
      distinctGroupCount,
      distinctClientCount,
      unhandledCount,
      unknownPatternNotifiedAt,
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

interface UnknownPatternEvidenceRow {
  conversationSession: { groupId: string | null };
  matchedMessage: { id: string; body: string; timestampWa: Date } | null;
}

/**
 * Queues one Unknown Pattern WhatsApp alert via the existing Notification mechanism — the same
 * enqueueNotification()/dispatcher.ts delivery lane the rule engine's NOTIFY_WHATSAPP action and
 * Priority Support Escalation already use, never a new send path. Returns false (never persists
 * unknownPatternNotifiedAt) when nothing was actually queued, so an unresolvable account or an
 * unconfigured destination list doesn't burn the cooldown — the next tick will simply try again.
 */
async function sendUnknownPatternAlert(
  candidate: { id: string; suggestedKeywords: string[] },
  evidenceRows: UnknownPatternEvidenceRow[],
  evidence: { unhandledCount: number; distinctGroupCount: number; distinctClientCount: number; confidenceScore: number },
): Promise<boolean> {
  const automationSettings = await getAutomationSettings();
  if (automationSettings.whatsappNotificationGroupIds.length === 0) return false;

  const resolution = await resolveWhatsAppAccount("CONVERSATION_LEARNING");
  if (isResolutionError(resolution)) {
    await logSystemEvent("WARN", "conversation-learning", "Unknown Pattern alert skipped — no WhatsApp account available", {
      patternCandidateId: candidate.id,
      error: resolution.error,
    });
    return false;
  }

  const latestEvidence = evidenceRows
    .filter((e): e is UnknownPatternEvidenceRow & { matchedMessage: NonNullable<UnknownPatternEvidenceRow["matchedMessage"]> } =>
      Boolean(e.matchedMessage),
    )
    .sort((a, b) => b.matchedMessage.timestampWa.getTime() - a.matchedMessage.timestampWa.getTime())[0];

  const latestGroupId = latestEvidence?.conversationSession.groupId ?? null;
  const group = latestGroupId ? await prisma.whatsAppGroup.findUnique({ where: { id: latestGroupId } }) : null;

  const payload = {
    alertKind: "UNKNOWN_PATTERN",
    patternCandidateId: candidate.id,
    patternKeywords: candidate.suggestedKeywords,
    occurrences: evidence.unhandledCount,
    groups: evidence.distinctGroupCount,
    clients: evidence.distinctClientCount,
    confidence: evidence.confidenceScore,
    latestMessage: latestEvidence?.matchedMessage.body ?? null,
    groupName: group?.name ?? null,
    groupId: latestGroupId,
  };

  for (const destination of automationSettings.whatsappNotificationGroupIds) {
    await enqueueNotification({
      type: "WHATSAPP",
      destination,
      accountId: resolution.accountId,
      relatedMessageId: latestEvidence?.matchedMessage.id ?? null,
      relatedPatternCandidateId: candidate.id,
      payload,
    });
  }
  return true;
}
