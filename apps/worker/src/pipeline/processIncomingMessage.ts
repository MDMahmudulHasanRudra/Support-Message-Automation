import { countMetric } from "../health/metrics.js";
import { prisma, resolveWhatsAppAccount, isResolutionError } from "@support-automation/db";
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
import { logSystemEvent } from "../logging/logSystemEvent.js";

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
  const traceId = `${raw.accountId}:${raw.whatsappMessageId}`;

  if (!raw.body || raw.body.trim().length === 0) {
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
  const { message, group, isFromTeamMember, quotedMessage, previous } = stored;

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
              }
            : null,
          automationSettings: settings,
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
async function resolveGroup(raw: RawIncomingMessage) {
  if (!raw.whatsappGroupId) return null;
  return prisma.whatsAppGroup.findUnique({
    where: { accountId_whatsappGroupId: { accountId: raw.accountId, whatsappGroupId: raw.whatsappGroupId } },
    select: {
      id: true,
      name: true,
      priority: true,
      assignedTeamMemberId: true,
      escalationMonitoringEnabled: true,
      isMonitored: true,
      aiAutomationEnabled: true,
      aiAutomationExcluded: true,
      aiSuppressedUntil: true,
      testModeEnabled: true,
    },
  });
}

async function storeNonAutomatedMessage(raw: RawIncomingMessage): Promise<void> {
  // These messages are never automated, but they are still the other half of every conversation —
  // our own replies come back through this path on WhatsApp's echo. Without groupId the chat
  // inbox's thread query (which filters on it) could not see them at all, so a thread showed only
  // the customer's side and its awaiting-reply signal could never clear. An unknown group still
  // stores the message, with groupId null, exactly as the incoming path does.
  const group = await resolveGroup(raw);
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
      const resolution = await resolveWhatsAppAccount("NOTIFY_WHATSAPP");
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
