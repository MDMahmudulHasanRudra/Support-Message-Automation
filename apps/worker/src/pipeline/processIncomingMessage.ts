import { countMetric } from "../health/metrics.js";
import { resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
import { prisma } from "../db.js";
import type { Prisma } from "@prisma/client";
import { evaluate, type EngineRule } from "@support-automation/engine";
import type { RuleAction } from "@support-automation/shared";
import type { AiClient } from "@support-automation/ai-client";
import { enqueueOutboundMessage } from "./enqueueOutbound.js";
import { buildExecutionIdempotencyKey } from "./idempotency.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { getEventDelivery, resolveWhatsAppDestinations } from "../notifications/eventSettings.js";
import { checkAutoReplySafety } from "./safety.js";
import { getAutomationSettings } from "./settings.js";
import { isActiveTeamMember } from "./teamFilter.js";
import { toEngineRule } from "./ruleMapping.js";
import type { RawIncomingMessage } from "./types.js";
import { markHumanReplied, openOrContinueCase } from "../escalation/escalationQueue.js";
import { detectSupportActivity } from "../supportActivity/detector.js";
import { updateSupportSessionForActivity } from "../supportActivity/sessionTracker.js";
import { runAiFallback } from "../aiFallback/runAiFallback.js";
import { recordHumanTakeover } from "../aiFallback/humanTakeover.js";
import { recordTeamAttendance } from "../teamManagement/attendance.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { countDroppedMessage } from "./dropCounter.js";
import { currentProjectId, projectIsOperating, withAccountProject } from "../project/context.js";

interface ActionExecutionRecord {
  type: RuleAction["type"];
  executed: boolean;
  reason: string;
}

/**
 * Processes one message event end-to-end: validation, direction/loop
 * prevention, team-member filtering, duplicate detection, rule evaluation,
 * and action execution (queueing replies/notifications — never sending
 * directly). Mirrors the "FINAL SAFE MESSAGE PROCESSING FLOW" in
 * WHATSAPP ACCOUNT SAFETY AND ANTI-SPAM REQUIREMENTS.md.
 */
/**
 * PHASE 6.1 — observability only, added for the real-message acceptance
 * test (no behavior change): `${accountId}:${whatsappMessageId}` is already
 * a natural, unique correlation ID (it's the same pair the DB's own
 * @@unique constraint uses), so it's reused here rather than minting a new
 * one. Logged to console/docker logs only, not SystemLog — this fires on
 * every single message, and writing that to the DB-backed Logs page would
 * be a lasting volume/behavior change, not a test-only addition.
 */
function traceStage(traceId: string, stage: string, details?: Record<string, unknown>): void {
  console.log(`[pipeline] [${traceId}] ${stage}${details ? " " + JSON.stringify(details) : ""}`);
}

/** `aiClientOverride` is a test-only seam (mirrors processOneAiAnalysisBatch's clientOverride) — production's sole caller never passes it. */
export async function processIncomingMessage(raw: RawIncomingMessage, aiClientOverride?: AiClient): Promise<void> {
  // The project is the receiving account's — the authoritative link (MULTI_PROJECT_PLAN.md §4.2).
  // Nothing in the message itself can choose it, and an unknown account is refused, not defaulted.
  return withAccountProject(raw.accountId, () => processIncomingMessageInProject(raw, aiClientOverride));
}

async function processIncomingMessageInProject(raw: RawIncomingMessage, aiClientOverride?: AiClient): Promise<void> {
  const traceId = `${raw.accountId}:${raw.whatsappMessageId}`;

  if (!raw.body || raw.body.trim().length === 0) {
    // Counted, not merely returned from. This is the one exit where a message the provider handed
    // over leaves no trace of any kind, and "messages are being dropped here" and "no messages are
    // arriving" looked identical from outside during the 18 Sep 2026 outage. A steady low rate is
    // ordinary — stickers, images without captions, system events; a SPIKE is WhatsApp having
    // changed the shape of something this code reads as empty, which is a real and invisible way
    // to lose customer messages. Fire-and-forget: see countDroppedMessage.
    countDroppedMessage(raw.accountId, "EMPTY_BODY");
    return; // unsupported/empty message type — nothing to automate
  }

  if (raw.direction !== "INCOMING") {
    // Outgoing (our own replies) and system messages must never re-enter
    // client automation — this is the primary loop-prevention guard.
    await storeNonAutomatedMessage(raw);
    return;
  }

  traceStage(traceId, "MESSAGE_NORMALIZED", {
    chatId: raw.chatId,
    senderPhone: raw.senderPhone,
    isGroup: Boolean(raw.whatsappGroupId),
    bodyPreview: raw.body.slice(0, 80),
  });

  // A suspended or archived project (§8) still STORES every message — collection is a push, and a
  // message not stored now is gone — but runs no rules and no AI, exactly like a message recovered
  // too late to answer. Nothing is queued to be sent when it is reactivated.
  if (!(await projectIsOperating(currentProjectId()))) {
    traceStage(traceId, "PROJECT_NOT_OPERATING");
    await storeMissedMessageInProject(raw);
    return;
  }

  const stored = await persistIncomingMessage(raw, "PENDING", traceId);
  if (!stored) return; // duplicate WhatsApp event — already processed

  await runAutomationStage(raw, stored, traceId, aiClientOverride);
}

/**
 * Everything that happens to a message AFTER its row exists: escalation, support activity, rule
 * evaluation, the AI fallback, the resulting actions, and the status settle.
 *
 * Split out so it can be run a second time. A message stranded `PENDING` — the row written, the
 * process then killed before this finished — could not previously be retried at all: re-delivering
 * it hits `persistIncomingMessage`'s P2002 and returns "already processed", so the customer was
 * never answered and nothing anywhere said so. `messageRecovery.ts` calls this directly for exactly
 * those rows.
 *
 * Re-running is safe because every write in here is keyed: `OutboundMessage.idempotencyKey` stops a
 * second send, `AutomationExecution.idempotencyKey` is upserted rather than inserted,
 * `createAiFallbackDecision` already answers P2002 with a message instead of a throw, and
 * `SupportActivity.messageId` is insert-and-catch.
 */
export async function runAutomationStage(
  raw: RawIncomingMessage,
  stored: StoredIncomingMessage,
  traceId: string,
  aiClientOverride?: AiClient,
): Promise<void> {
  return withAccountProject(raw.accountId, () => runAutomationStageInProject(raw, stored, traceId, aiClientOverride));
}

async function runAutomationStageInProject(
  raw: RawIncomingMessage,
  stored: StoredIncomingMessage,
  traceId: string,
  aiClientOverride?: AiClient,
): Promise<void> {
  const { message, group, isFromTeamMember, quotedMessage, previous } = stored;

  // The recovery path reaches here directly; the same rule as the live path applies.
  if (!(await projectIsOperating(currentProjectId()))) {
    await prisma.message.update({ where: { id: message.id }, data: { processingStatus: "IGNORED" } });
    return;
  }

  // Everything from here to the processingStatus settle below runs AFTER the Message row exists,
  // because that row is this pipeline's dedupe guard and has to be written before any work that
  // could fire twice. That ordering has a cost: an unexpected throw in between (a rule regex the
  // engine chokes on, a transient failure in the action loop or the AutomationExecution insert)
  // used to leave the row PENDING forever — and WhatsApp's redelivery then hits persistIncomingMessage's
  // P2002 path and returns "already processed", so it was never retried and the customer never answered.
  // Marking it FAILED makes it visibly unprocessed instead of silently stuck.
  try {
    // Priority-Based Support Monitoring & Escalation runs alongside the rule engine, never gated
    // by its decision — a human reply always stops escalation, and a priority group always starts
    // monitoring, regardless of what (if anything) the rule engine matched. Fire-and-forget with
    // its own error boundary: an escalation-tracking failure must never break message processing.
    try {
      if (isFromTeamMember) {
        await markHumanReplied(raw.chatId);
        // Human takeover (Slice 3): a separate, independent concern from escalation's SLA timers —
        // pause the AI fallback layer for this group briefly so it doesn't immediately answer a
        // different customer's next message while a human is actively engaged. Whether this group
        // is AI-eligible now depends on AiSettings.aiAutomationScope, so recordHumanTakeover()
        // makes that call itself and no-ops for a group AI could never answer in.
        if (group) {
          await recordHumanTakeover({
            id: group.id,
            isMonitored: group.isMonitored,
            aiAutomationEnabled: group.aiAutomationEnabled,
            aiAutomationExcluded: group.aiAutomationExcluded,
          });
        }
      } else if (group?.priority && group.escalationMonitoringEnabled) {
        await openOrContinueCase({
          accountId: raw.accountId,
          groupId: group.id,
          chatId: raw.chatId,
          clientPhone: raw.senderPhone,
          priority: group.priority,
          assignedTeamMemberId: group.assignedTeamMemberId,
          triggerMessageId: message.id,
          timestampWa: raw.timestampWa,
        });
      }
    } catch (err) {
      console.error("[escalation] failed to update support escalation state", err);
    }

    // Support Activity Tracking — same fire-and-forget philosophy as the escalation block above: a
    // detection failure must never break message processing, and it is a true no-op end-to-end when
    // SupportActivitySettings.enabled is false (checked first thing inside the detector).
    try {
      const activityResult = await detectSupportActivity({
        accountId: raw.accountId,
        groupId: group?.id ?? null,
        isFromTeamMember,
        senderPhone: raw.senderPhone,
        messageId: message.id,
        body: raw.body,
        timestampWa: raw.timestampWa,
        quotedMessage: quotedMessage
          ? { senderPhone: quotedMessage.senderPhone, isFromTeamMember: quotedMessage.isFromTeamMember }
          : null,
        mentionedPhones: raw.mentionedPhones ?? [],
      });
      // Support session open/close tracking piggybacks on a successfully-recorded activity — never a
      // separate detection pass. Its own nested try/catch so a session-tracking bug can never hide
      // the fact that the SupportActivity row itself was already recorded correctly.
      if (activityResult) {
        try {
          await updateSupportSessionForActivity(activityResult);
        } catch (err) {
          console.error("[support-activity] failed to update support session", err);
        }
      }
    } catch (err) {
      console.error("[support-activity] failed to record support activity", err);
    }

    // Team Management's attendance evidence. Same shape as the two hooks above — awaited, with its
    // own try/catch, and swallowed: a failure to record that somebody worked must never stop a
    // customer's message being processed.
    //
    // Idempotent per member-day rather than per message, which is what lets it sit on all three
    // ingestion paths — the live one, the catch-up sweep, and a stranded-message re-run — without
    // any of them double-counting. It recomputes rather than increments; see attendance.ts.
    //
    // It differs from its neighbours in one way worth knowing: it takes a Postgres advisory lock, so
    // it genuinely serialises. The key is (member, Dhaka day), so only the SAME person's messages on
    // the SAME day ever wait on each other — two people messaging at once never contend.
    try {
      await recordTeamAttendance({
        groupId: group?.id ?? null,
        isFromTeamMember,
        senderPhone: raw.senderPhone,
        timestampWa: raw.timestampWa,
      });
    } catch (err) {
      console.error("[team-attendance] failed to record attendance evidence", err);
    }

    /**
     * Only the Primary account answers customers.
     *
     * Every connected account collects messages, and every one of them could also reply — so
     * connecting a second number silently doubled the voices answering in any group both were in,
     * and a spare number linked just to watch the inbox would start speaking to customers on its
     * own. One number is the support number; the rest are there to read.
     *
     * The gate sits HERE, immediately before the rules are read, because this is the one seam both
     * reply paths cross: the deterministic rule's AUTO_REPLY and, on a rule-miss, the AI fallback.
     * Everything above it — escalation, support activity, attendance — is evidence-gathering that
     * must keep running for every account, or a non-Primary number would stop counting somebody's
     * work simply because it does not reply.
     *
     * Deliberately NOT a re-route to the Primary account. WhatsApp group membership is per number,
     * so an account that is not in that group fails `verifyGroupMembership` at the queue and the
     * customer gets nothing at all — a redirect would turn "the wrong number answered" into
     * "nobody answered", silently. Suppressing is the honest reading of "only Primary replies":
     * the message is still stored, still appears in the inbox, and still counts as waiting for a
     * human.
     *
     * With NO Primary set at all, this gate stands aside and the receiving account answers as it
     * always did. That is the deliberate half, and it is the opposite of what "only Primary
     * replies" first suggests: the rule exists to stop a SECOND number joining in, not to make a
     * missing setting silently switch customer replies off everywhere. A deployment that has never
     * touched the setting — or one where somebody pressed Remove Primary — would otherwise go
     * quiet across every group with nothing on screen explaining it, which is a worse failure than
     * the one being prevented. Exactly one account can be Primary (the database enforces it), so
     * once one is set the rule is unambiguous.
     */
    const primaryAccount = await prisma.whatsAppAccount.findFirst({
      where: { isPrimary: true },
      select: { id: true, label: true },
    });
    if (primaryAccount && primaryAccount.id !== raw.accountId) {
      const why = `it arrived on an account that is not Primary ("${primaryAccount.label}" is).`;
      traceStage(traceId, "AUTOMATION_RULE_CHECK", { matched: false, matchedRuleType: null });
      // Settled exactly as the ordinary no-match path does: PROCESSED, and the checkpoint moved.
      // Leaving it PENDING would make `recoverStrandedMessages` re-run it every few hours, and the
      // checkpoint is what `catchUpMissedMessages` reads to know where a gap begins — a message
      // this worker genuinely saw and decided about must not look like one it missed.
      await prisma.message.update({
        where: { id: message.id },
        data: { processingStatus: "PROCESSED" },
      });
      countMetric("processed");
      await prisma.processingCheckpoint.upsert({
        where: { accountId: raw.accountId },
        update: { lastProcessedMessageId: message.id, lastProcessedTimestampWa: raw.timestampWa },
        create: {
          accountId: raw.accountId,
          lastProcessedMessageId: message.id,
          lastProcessedTimestampWa: raw.timestampWa,
        },
      });
      console.log(`[pipeline] [${traceId}] AUTOMATION_SKIPPED_NOT_PRIMARY ${why}`);
      return;
    }

    const activeRuleRows = await prisma.automationRule.findMany({ where: { status: "ACTIVE" } });
    const rules: EngineRule[] = activeRuleRows.map(toEngineRule);
    const ruleRowById = new Map(activeRuleRows.map((r) => [r.id, r]));

    const result = evaluate({
      message: {
        body: raw.body,
        senderPhone: raw.senderPhone,
        isFromTeamMember,
        groupId: group?.id ?? null,
        chatId: raw.chatId,
        timestamp: raw.timestampWa,
      },
      previousMessage: previous
        ? { senderPhone: previous.senderPhone, isFromTeamMember: previous.isFromTeamMember }
        : null,
      rules,
    });

    const matchedRuleRow = result.matchedRule ? ruleRowById.get(result.matchedRule.id) ?? null : null;

    // The engine (packages/engine/evaluate.ts) evaluates every active rule in a
    // single priority-sorted pass rather than as separate sequential gates —
    // these three lines map that one result onto the conceptual categories
    // requested for tracing (which RuleType, if any, won), they are NOT
    // separate evaluation steps in the actual engine.
    const matchedType = matchedRuleRow?.type ?? null;
    traceStage(traceId, "IGNORE_RULE_CHECK", {
      matched: matchedType === "DEFAULT_IGNORE" || (matchedType === null && result.finalDecision === "IGNORE"),
      matchedRuleType: matchedType,
    });
    traceStage(traceId, "DEFAULT_RULE_CHECK", {
      matched: matchedType === "TEAM_FILTER" || matchedType === "LAST_SENDER" || matchedType === "EXCEPTION",
      matchedRuleType: matchedType,
    });
    traceStage(traceId, "AUTOMATION_RULE_CHECK", {
      matched: matchedType === "AUTO_REPLY" || matchedType === "GENERIC" || matchedType === "SUPPORT_ESCALATION",
      matchedRuleType: matchedType,
    });

    const settings = await getAutomationSettings();

    // Hybrid AI Automation fallback layer — only on a genuine rule-miss (never on the team-member-
    // filter IGNORE, which is a different synthetic decision). Own try/catch, same fire-and-forget-
    // but-logged philosophy as the escalation/support-activity hooks above: a failure here must
    // never break message processing. See apps/worker/src/aiFallback/runAiFallback.ts.
    if (result.finalDecision === "NO_MATCH") {
      try {
        await runAiFallback({
          message: { id: message.id, body: raw.body, timestampWa: raw.timestampWa },
          accountId: raw.accountId,
          chatId: raw.chatId,
          toPhone: raw.senderPhone,
          senderName: raw.senderName,
          group: group
            ? {
                id: group.id,
                name: group.name,
                isMonitored: group.isMonitored,
                aiAutomationEnabled: group.aiAutomationEnabled,
                aiAutomationExcluded: group.aiAutomationExcluded,
                aiSuppressedUntil: group.aiSuppressedUntil,
                // Was omitted, so `params.group?.testModeEnabled ?? false` inside runAiFallback
                // was always false and an approved test group still paid the full randomised
                // 3-15s reply delay on every AI answer and every handover mention. The throttle
                // exemptions were unaffected (safety.ts and the queue both re-read the flag from
                // the database themselves), which is why this stayed invisible.
                testModeEnabled: group.testModeEnabled,
              }
            : null,
          automationSettings: settings,
          // The pipeline's own trace id, which already identifies this message in every log line
          // above. Threaded through so the decision, its evidence snapshot and those log lines all
          // carry the same correlation value rather than three ways of naming one message.
          correlationId: traceId,
          clientOverride: aiClientOverride,
        });
      } catch (err) {
        console.error("[ai-fallback] failed to run AI fallback stage", err);
        // A true unexpected exception here (unlike a graceful HUMAN_FALLBACK, which is already fully
        // captured in its own AiFallbackDecision row) would otherwise leave no structured trace
        // beyond a console line — worth one SystemLog entry, same convention patternDetectionJob.ts/
        // aiAnalysisJob.ts already use for their own failure paths. Deliberately not logging every
        // ordinary outcome here (see this file's own MESSAGE_NORMALIZED trace-volume comment).
        await logSystemEvent("ERROR", "ai-fallback", "AI fallback stage threw an unexpected error", {
          messageId: message.id,
          accountId: raw.accountId,
          error: (err as Error).message,
        });
      }
    }

    const executedActions: ActionExecutionRecord[] = [];

    for (const action of result.actions) {
      executedActions.push(
        await executeAction({
          action,
          message,
          raw,
          groupId: group?.id ?? null,
          groupName: group?.name ?? null,
          testMode: group?.testModeEnabled ?? false,
          matchedRule: result.matchedRule,
          matchedRuleRow,
          settings,
        }),
      );
    }

    const executionIdempotencyKey = buildExecutionIdempotencyKey({
      messageId: message.id,
      ruleId: result.matchedRule?.id ?? null,
    });
    const executionRecord = {
      messageId: message.id,
      ruleId: result.matchedRule?.id ?? null,
      actionsExecuted: executedActions as unknown as Prisma.InputJsonValue,
      decision: result.finalDecision,
      reasonTrace: result.trace as unknown as Prisma.InputJsonValue,
      idempotencyKey: executionIdempotencyKey,
    };
    // Upsert, not create. A retry of a message stranded mid-pipeline reaches this a second time,
    // and a plain create would throw P2002 on the unique key — making every retry fail at the last
    // step, which is worse than not retrying at all. The record describes the decision just taken,
    // so the later one is the accurate one.
    await prisma.automationExecution.upsert({
      where: { idempotencyKey: executionIdempotencyKey },
      create: executionRecord,
      update: executionRecord,
    });

    traceStage(traceId, "ACTION_DECISION", {
      finalDecision: result.finalDecision,
      matchedRuleId: result.matchedRule?.id ?? null,
      matchedRuleName: result.matchedRule?.name ?? null,
      executedActions,
    });

    await prisma.message.update({
      where: { id: message.id },
      data: { processingStatus: result.finalDecision === "IGNORE" ? "IGNORED" : "PROCESSED" },
    });
    countMetric("processed");
  } catch (err) {
    countMetric("failed");
    await prisma.message
      .update({ where: { id: message.id }, data: { processingStatus: "FAILED" } })
      .catch((markErr) => console.error("[pipeline] could not mark message FAILED", markErr));
    // Message has no column for the failure text, so the detail goes where the dashboard can
    // already read it. Never swallowed: rethrown so ProviderRegistry's existing handler still logs.
    await logSystemEvent("ERROR", "pipeline", "Message processing failed after the message was stored", {
      messageId: message.id,
      accountId: raw.accountId,
      error: (err as Error).message,
    }).catch(() => undefined);
    throw err;
  }

  await prisma.processingCheckpoint.upsert({
    where: { accountId: raw.accountId },
    update: { lastProcessedMessageId: message.id, lastProcessedTimestampWa: raw.timestampWa },
    create: {
      accountId: raw.accountId,
      lastProcessedMessageId: message.id,
      lastProcessedTimestampWa: raw.timestampWa,
    },
  });
}

export interface StoredIncomingMessage {
  message: { id: string };
  group: Awaited<ReturnType<typeof resolveGroup>>;
  isFromTeamMember: boolean;
  quotedMessage: { id: string; senderPhone: string; isFromTeamMember: boolean } | null;
  previous: { senderPhone: string; isFromTeamMember: boolean } | null;
}

/**
 * Writes one incoming message and everything that has to be resolved alongside it. Returns null
 * when the row already exists — the P2002 here IS this pipeline's dedup guard, which is what makes
 * replaying a message safe rather than merely tolerable.
 *
 * Shared by the live path and the catch-up sweep on purpose. A message recovered after a gap has to
 * land in the database byte-identically to one seen live, or every reader downstream — the inbox,
 * support activity, escalation, learning — quietly sees two classes of message. That drift is not
 * hypothetical: `storeNonAutomatedMessage` below is a second copy of this write that fell behind,
 * and still stores `isFromTeamMember: false` with no quote and no mentions.
 */
async function persistIncomingMessage(
  raw: RawIncomingMessage,
  processingStatus: "PENDING" | "IGNORED",
  /** Null for a bulk replay: one trace line per message is useful live and is noise a thousand at a time. */
  traceId: string | null,
): Promise<StoredIncomingMessage | null> {
  const isFromTeamMember = await isActiveTeamMember(raw.senderPhone);
  if (traceId) traceStage(traceId, "TEAM_MEMBER_CHECK", { isFromTeamMember });

  const group = await resolveGroup(raw);
  if (traceId && raw.whatsappGroupId) {
    traceStage(traceId, "GROUP_RESOLVED", { whatsappGroupId: raw.whatsappGroupId, resolvedGroupId: group?.id ?? null });
  }

  // Fetch the previous message in this chat BEFORE inserting the current
  // one, so it can never match itself.
  const previous = await prisma.message.findFirst({
    where: { accountId: raw.accountId, chatId: raw.chatId },
    orderBy: { timestampWa: "desc" },
    select: { senderPhone: true, isFromTeamMember: true },
  });

  // Resolve the WhatsApp "quoted reply" reference to our own Message row, if we have it tracked —
  // null if the quoted message predates tracking or this message isn't a reply at all. Feeds
  // Support Activity Tracking's REPLY_TO_CUSTOMER trigger.
  const quotedMessage = raw.quotedWhatsappMessageId
    ? await prisma.message.findUnique({
        where: { accountId_whatsappMessageId: { accountId: raw.accountId, whatsappMessageId: raw.quotedWhatsappMessageId } },
        select: { id: true, senderPhone: true, isFromTeamMember: true },
      })
    : null;

  let message;
  try {
    message = await prisma.message.create({
      data: {
        accountId: raw.accountId,
        groupId: group?.id ?? null,
        whatsappMessageId: raw.whatsappMessageId,
        chatId: raw.chatId,
        senderPhone: raw.senderPhone,
        senderName: raw.senderName,
        isFromTeamMember,
        direction: "INCOMING",
        body: raw.body,
        normalizedBody: raw.body.trim(),
        timestampWa: raw.timestampWa,
        processingStatus,
        quotedMessageId: quotedMessage?.id ?? null,
        mentionedPhones: raw.mentionedPhones ?? [],
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      if (traceId) traceStage(traceId, "DUPLICATE_CHECK", { isDuplicate: true, result: "skipped — already processed" });
      return null;
    }
    throw err;
  }

  if (traceId) {
    traceStage(traceId, "MESSAGE_PERSISTED", { messageId: message.id });
    traceStage(traceId, "DUPLICATE_CHECK", { isDuplicate: false, result: "unique — proceeding" });
  }

  return { message, group, isFromTeamMember, quotedMessage, previous };
}

/**
 * Stores a message recovered from a gap that is too old to answer, and records the support work
 * visible in it — without evaluating a single rule.
 *
 * The distinction this draws is the one a person would: a question from four minutes ago, missed
 * because the worker restarted, still deserves its answer and goes through the ordinary pipeline.
 * A question from this morning does not get an automated reply at lunchtime as though it had just
 * arrived — the customer has moved on, a colleague has very likely already answered in the group,
 * and a burst of them on every restart is exactly the unprompted bulk sending this product refuses
 * to do. Silence there is not data loss: the message is stored, so it appears in the inbox, counts
 * in Team Performance, and shows up under "waiting for a reply" if nobody ever answered it.
 *
 * Support activity IS recorded, because that is a record of work a colleague really did. Escalation
 * is deliberately not opened: a backdated case would immediately be overdue and fire its whole
 * alert ladder for a conversation that has since ended. `markHumanReplied` is the exception — it
 * only ever CLOSES a case, and a reply that really happened should close one whenever we learn of it.
 */
export async function storeMissedMessage(raw: RawIncomingMessage): Promise<boolean> {
  return withAccountProject(raw.accountId, () => storeMissedMessageInProject(raw));
}

async function storeMissedMessageInProject(raw: RawIncomingMessage): Promise<boolean> {
  if (!raw.body || raw.body.trim().length === 0) return false;

  if (raw.direction !== "INCOMING") {
    await storeNonAutomatedMessage(raw);
    return true;
  }

  const stored = await persistIncomingMessage(raw, "IGNORED", null);
  if (!stored) return false;

  const { message, group, isFromTeamMember, quotedMessage } = stored;

  try {
    if (isFromTeamMember) {
      await markHumanReplied(raw.chatId);
    }
  } catch (err) {
    console.error("[catch-up] failed to close escalation state for a recovered message", err);
  }

  try {
    const activityResult = await detectSupportActivity({
      accountId: raw.accountId,
      groupId: group?.id ?? null,
      isFromTeamMember,
      senderPhone: raw.senderPhone,
      messageId: message.id,
      body: raw.body,
      timestampWa: raw.timestampWa,
      quotedMessage: quotedMessage
        ? { senderPhone: quotedMessage.senderPhone, isFromTeamMember: quotedMessage.isFromTeamMember }
        : null,
      mentionedPhones: raw.mentionedPhones ?? [],
    });
    if (activityResult) {
      await updateSupportSessionForActivity(activityResult).catch((err) =>
        console.error("[catch-up] failed to update support session for a recovered message", err),
      );
    }
  } catch (err) {
    console.error("[catch-up] failed to record support activity for a recovered message", err);
  }

  // A message recovered from a gap is still evidence somebody worked that day, even when it is too
  // old to answer. Recording it is how a restart does not quietly cost an executive their
  // attendance for the morning it happened in.
  try {
    await recordTeamAttendance({
      groupId: group?.id ?? null,
      isFromTeamMember,
      senderPhone: raw.senderPhone,
      timestampWa: raw.timestampWa,
    });
  } catch (err) {
    console.error("[team-attendance] failed to record attendance for a recovered message", err);
  }

  return true;
}

/**
 * Rebuilds, from a stored row, exactly what `processIncomingMessage` had in hand when it first saw
 * the message — so `runAutomationStage` can be re-run against it.
 *
 * Reconstructed rather than kept: a message stranded mid-pipeline was stranded because the process
 * that held that context went away, so there is nothing left to keep. Everything needed is on the
 * row or reachable from it, which is why this is possible at all.
 *
 * `previous` deliberately re-reads the chat's newest message OTHER than this one, exactly as the
 * live path does, rather than the newest overall — matching itself is the bug that lookup was
 * written to avoid.
 */
export async function loadStoredMessageContext(
  messageId: string,
): Promise<{ raw: RawIncomingMessage; stored: StoredIncomingMessage } | null> {
  const row = await prisma.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      accountId: true,
      chatId: true,
      senderPhone: true,
      senderName: true,
      isFromTeamMember: true,
      body: true,
      timestampWa: true,
      mentionedPhones: true,
      quotedMessage: { select: { id: true, senderPhone: true, isFromTeamMember: true, whatsappMessageId: true } },
      whatsappMessageId: true,
    },
  });
  if (!row) return null;

  // A group chat id is the group's own JID; that suffix is WhatsApp's own convention and is what
  // the provider used to decide `isGroupMsg` in the first place.
  const whatsappGroupId = row.chatId.endsWith("@g.us") ? row.chatId : null;

  const raw: RawIncomingMessage = {
    accountId: row.accountId,
    whatsappMessageId: row.whatsappMessageId,
    chatId: row.chatId,
    whatsappGroupId,
    senderPhone: row.senderPhone,
    senderName: row.senderName,
    direction: "INCOMING",
    body: row.body,
    timestampWa: row.timestampWa,
    quotedWhatsappMessageId: row.quotedMessage?.whatsappMessageId ?? null,
    mentionedPhones: row.mentionedPhones,
  };

  const [group, previous] = await Promise.all([
    resolveGroup(raw),
    prisma.message.findFirst({
      where: { accountId: row.accountId, chatId: row.chatId, id: { not: row.id } },
      orderBy: { timestampWa: "desc" },
      select: { senderPhone: true, isFromTeamMember: true },
    }),
  ]);

  return {
    raw,
    stored: {
      message: { id: row.id },
      group,
      isFromTeamMember: row.isFromTeamMember,
      quotedMessage: row.quotedMessage
        ? {
            id: row.quotedMessage.id,
            senderPhone: row.quotedMessage.senderPhone,
            isFromTeamMember: row.quotedMessage.isFromTeamMember,
          }
        : null,
      previous,
    },
  };
}

/**
 * Resolves the raw event's WhatsApp group id to our own WhatsAppGroup row — null when the message
 * isn't from a group, or from one this account hasn't synced yet. Shared by both storage paths so
 * there is exactly one lookup, not a second one that could drift.
 */
const RESOLVED_GROUP_SELECT = {
  id: true,
  name: true,
  isActive: true,
  priority: true,
  assignedTeamMemberId: true,
  escalationMonitoringEnabled: true,
  isMonitored: true,
  aiAutomationEnabled: true,
  aiAutomationExcluded: true,
  aiSuppressedUntil: true,
  testModeEnabled: true,
} as const;

/**
 * A message from a group is proof this account is in that group — and that proof now counts.
 *
 * The group list used to come ONLY from the group sync, which reads WhatsApp Web's chat list. That
 * read can be partial: straight after a number is linked the phone is still pushing its chats
 * across, and on 24 Sep 2026 a sync two minutes after linking saw 498 of 1,952 groups. Every group
 * outside that read stayed inactive, so the inbox (which lists active groups) hid their
 * conversations while their messages kept arriving, and a group that appeared after the last
 * sync had no row at all — its messages were stored against no group and shown nowhere.
 *
 * So the pipeline closes both gaps from evidence it already has:
 *   - an INACTIVE group that sends a message is marked active again;
 *   - an UNKNOWN group is registered, with every automation flag at its default (off) — a group
 *     nobody has looked at must never start receiving automated replies because it spoke.
 * Neither ever deactivates anything or touches monitoring, AI or priority settings.
 *
 * Create-and-catch rather than upsert, so the common case (a known, active group) stays one read.
 */
export async function resolveGroup(raw: RawIncomingMessage) {
  return withAccountProject(raw.accountId, () => resolveGroupInProject(raw));
}

async function resolveGroupInProject(raw: RawIncomingMessage) {
  if (!raw.whatsappGroupId) return null;
  const where = {
    accountId_whatsappGroupId: { accountId: raw.accountId, whatsappGroupId: raw.whatsappGroupId },
  };
  const existing = await prisma.whatsAppGroup.findUnique({ where, select: RESOLVED_GROUP_SELECT });
  if (existing) {
    if (existing.isActive) return existing;
    return prisma.whatsAppGroup.update({ where, data: { isActive: true }, select: RESOLVED_GROUP_SELECT });
  }
  try {
    return await prisma.whatsAppGroup.create({
      data: {
        accountId: raw.accountId,
        whatsappGroupId: raw.whatsappGroupId,
        name: raw.groupName?.trim() || raw.whatsappGroupId,
      },
      select: RESOLVED_GROUP_SELECT,
    });
  } catch (err) {
    // Two messages from a brand-new group raced to register it; the other one won.
    if ((err as { code?: string }).code === "P2002") {
      return prisma.whatsAppGroup.findUnique({ where, select: RESOLVED_GROUP_SELECT });
    }
    throw err;
  }
}

async function storeNonAutomatedMessage(raw: RawIncomingMessage): Promise<void> {
  // These messages are never automated, but they are still the other half of every conversation —
  // our own replies come back through this path on WhatsApp's echo. Without groupId the chat
  // inbox's thread query (which filters on it) could not see them at all, so a thread showed only
  // the customer's side and its awaiting-reply signal could never clear. An unknown group still
  // stores the message, with groupId null, exactly as the incoming path does.
  const group = await resolveGroup(raw);
  let stored = true;
  try {
    await prisma.message.create({
      data: {
        accountId: raw.accountId,
        groupId: group?.id ?? null,
        whatsappMessageId: raw.whatsappMessageId,
        chatId: raw.chatId,
        senderPhone: raw.senderPhone,
        senderName: raw.senderName,
        isFromTeamMember: false,
        direction: raw.direction,
        body: raw.body,
        normalizedBody: raw.body.trim(),
        timestampWa: raw.timestampWa,
        processingStatus: "PROCESSED",
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    // Already stored — this is a replayed echo, so the side effect below has already run.
    stored = false;
  }

  if (!stored || raw.direction !== "OUTGOING") return;

  /**
   * An outgoing message means this customer HAS been answered, so any open escalation case for
   * the chat is closed here.
   *
   * This path used to do nothing but store the row, and that left the escalation ladder blind to
   * the single most common way a customer actually gets answered: an executive typing in WhatsApp
   * on the business handset. Those messages arrive `fromMe: true` → OUTGOING → here, never
   * touching the `isFromTeamMember` branch that `markHumanReplied` lived in. So a question
   * answered by a colleague in thirty seconds kept escalating on schedule — second alert, member
   * DM, admin DM — about a conversation that was already handled.
   *
   * "OUTGOING counts as a reply" is not a new definition invented here: it is the one the chat
   * inbox already uses to decide whether a conversation is still waiting ("a reply is
   * `direction = OUTGOING` (ours, including AI) **or** `isFromTeamMember`"). Escalation honoured
   * only the second half. Counting our own automated replies too is deliberate and correct for
   * *this* signal — the case exists to detect an unanswered customer, and an answer is an answer
   * whoever sent it.
   *
   * Deliberately NOT paired with `recordHumanTakeover` here. That one means "a person is handling
   * this, so the AI must stay quiet", and the AI's own replies come back through this exact path
   * — suppressing AI on its own echo would silence it for the rest of every conversation it took
   * part in. Telling a human reply apart from our own needs a lookup this path cannot afford
   * today; it is tracked separately.
   */
  try {
    await markHumanReplied(raw.chatId);
  } catch (err) {
    console.error("[escalation] failed to close a case on an outgoing reply", err);
  }
}

async function executeAction(params: {
  action: RuleAction;
  message: { id: string };
  raw: RawIncomingMessage;
  groupId: string | null;
  groupName: string | null;
  /** True for a group an admin marked as a test group — see WhatsAppGroup.testModeEnabled. */
  testMode: boolean;
  matchedRule: EngineRule | null;
  matchedRuleRow: { replyMessage: string | null; cooldownSeconds: number | null; replyDelayMinMs: number | null; replyDelayMaxMs: number | null } | null;
  settings: Awaited<ReturnType<typeof getAutomationSettings>>;
}): Promise<ActionExecutionRecord> {
  const { action, message, raw, groupId, groupName, testMode, matchedRule, matchedRuleRow, settings } = params;

  switch (action.type) {
    case "IGNORE":
      return { type: "IGNORE", executed: true, reason: "Message ignored; no reply or notification sent." };

    case "STOP_PROCESSING":
      return { type: "STOP_PROCESSING", executed: true, reason: "Marker only; evaluation already stopped at the matched rule." };

    case "TAG":
      return { type: "TAG", executed: true, reason: `Tagged: ${action.tag ?? "(unnamed tag)"}` };

    case "SUPPORT_REQUIRED":
      return {
        type: "SUPPORT_REQUIRED",
        executed: true,
        reason: `Marked as requiring support attention${action.category ? ` (category: ${action.category})` : ""}.`,
      };

    case "AUTO_REPLY": {
      if (!matchedRule || !matchedRuleRow?.replyMessage) {
        return { type: "AUTO_REPLY", executed: false, reason: "Matched rule has no replyMessage configured." };
      }
      const safety = await checkAutoReplySafety({
        accountId: raw.accountId,
        toPhone: raw.senderPhone,
        groupId,
        rule: matchedRule,
        cooldownSeconds: matchedRuleRow.cooldownSeconds,
        settings,
      });
      if (!safety.allowed) {
        return { type: "AUTO_REPLY", executed: false, reason: `Blocked by safety layer: ${safety.reason}` };
      }
      const { queued } = await enqueueOutboundMessage({
        accountId: raw.accountId,
        chatId: raw.chatId,
        toPhone: raw.senderPhone,
        body: matchedRuleRow.replyMessage,
        incomingMessageId: message.id,
        ruleId: matchedRule.id,
        actionType: "AUTO_REPLY",
        settings,
        ruleDelayMinMs: matchedRuleRow.replyDelayMinMs,
        ruleDelayMaxMs: matchedRuleRow.replyDelayMaxMs,
        testMode,
      });
      return {
        type: "AUTO_REPLY",
        executed: queued,
        reason: queued ? "Queued for delivery." : "Already queued for this message (idempotent no-op).",
      };
    }

    case "FORWARD": {
      if (!action.forwardToChatId) {
        return { type: "FORWARD", executed: false, reason: "No forwardToChatId configured." };
      }
      const { queued } = await enqueueOutboundMessage({
        accountId: raw.accountId,
        chatId: action.forwardToChatId,
        toPhone: action.forwardToChatId,
        body: `Forwarded message from ${raw.senderName ?? raw.senderPhone}:\n${raw.body}`,
        incomingMessageId: message.id,
        ruleId: matchedRule?.id ?? null,
        actionType: "FORWARD",
        settings,
        testMode,
      });
      return {
        type: "FORWARD",
        executed: queued,
        reason: queued ? `Forwarded to ${action.forwardToChatId}.` : "Already forwarded (idempotent no-op).",
      };
    }

    case "NOTIFY_TEAMS": {
      if (!settings.teamsWebhookUrl) {
        return { type: "NOTIFY_TEAMS", executed: false, reason: "No Teams webhook URL configured." };
      }
      await enqueueNotification({
        type: "TEAMS",
        event: "RULE_NOTIFY_TEAMS",
        destination: settings.teamsWebhookUrl,
        relatedMessageId: message.id,
        relatedRuleId: matchedRule?.id ?? null,
        payload: buildNotificationPayload(raw, groupName, matchedRule, action),
      });
      return { type: "NOTIFY_TEAMS", executed: true, reason: "Queued for delivery to Microsoft Teams." };
    }

    case "NOTIFY_WHATSAPP": {
      if (settings.whatsappNotificationGroupIds.length === 0) {
        return { type: "NOTIFY_WHATSAPP", executed: false, reason: "No WhatsApp notification group configured." };
      }
      // Centralized account resolution — never scattered. See resolveWhatsAppAccount()'s own doc
      // comment for the decision tree; a resolution failure means a clear error, never a silent
      // send through some other connected account.
      const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP", prisma);
      if (isResolutionError(resolution)) {
        return { type: "NOTIFY_WHATSAPP", executed: false, reason: resolution.error };
      }
      console.log(
        `[whatsapp-routing] service=NOTIFY_WHATSAPP account=${resolution.accountLabel} accountId=${resolution.accountId} source=${resolution.source} action=ENQUEUE`,
      );
      const payload = buildNotificationPayload(raw, groupName, matchedRule, action);
      // Per-event routing: this event's own groups if the Notification Center has any, otherwise
      // the global list this deployment always used.
      const delivery = await getEventDelivery("RULE_NOTIFY_WHATSAPP");
      const destinations = resolveWhatsAppDestinations(delivery, settings.whatsappNotificationGroupIds);
      for (const destination of destinations) {
        await enqueueNotification({
          type: "WHATSAPP",
          event: "RULE_NOTIFY_WHATSAPP",
          destination,
          accountId: resolution.accountId,
          relatedMessageId: message.id,
          relatedRuleId: matchedRule?.id ?? null,
          payload,
        });
      }
      return {
        type: "NOTIFY_WHATSAPP",
        executed: true,
        reason: `Queued for delivery to ${settings.whatsappNotificationGroupIds.length} WhatsApp support group(s) via "${resolution.accountLabel}".`,
      };
    }

    default:
      return { type: action.type, executed: false, reason: "Unknown action type." };
  }
}

function buildNotificationPayload(
  raw: RawIncomingMessage,
  groupName: string | null,
  matchedRule: EngineRule | null,
  action: RuleAction,
): Record<string, unknown> {
  return {
    chatId: raw.chatId,
    groupId: raw.whatsappGroupId ?? null,
    groupName,
    clientPhone: raw.senderPhone,
    clientName: raw.senderName ?? null,
    message: raw.body,
    category: action.category ?? null,
    matchedRuleName: matchedRule?.name ?? null,
  };
}
