import { prisma } from "@support-automation/db";
import type { Prisma } from "@prisma/client";
import { evaluate, type EngineRule } from "@support-automation/engine";
import type { RuleAction } from "@support-automation/shared";
import { enqueueOutboundMessage } from "./enqueueOutbound.js";
import { buildExecutionIdempotencyKey } from "./idempotency.js";
import { enqueueNotification } from "../notifications/enqueueNotification.js";
import { checkAutoReplySafety } from "./safety.js";
import { getAutomationSettings } from "./settings.js";
import { isActiveTeamMember } from "./teamFilter.js";
import { toEngineRule } from "./ruleMapping.js";
import type { RawIncomingMessage } from "./types.js";

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

export async function processIncomingMessage(raw: RawIncomingMessage): Promise<void> {
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

  const isFromTeamMember = await isActiveTeamMember(raw.senderPhone);
  traceStage(traceId, "TEAM_MEMBER_CHECK", { isFromTeamMember });

  const group = raw.whatsappGroupId
    ? await prisma.whatsAppGroup.findUnique({
        where: { accountId_whatsappGroupId: { accountId: raw.accountId, whatsappGroupId: raw.whatsappGroupId } },
        select: { id: true },
      })
    : null;
  if (raw.whatsappGroupId) {
    traceStage(traceId, "GROUP_RESOLVED", { whatsappGroupId: raw.whatsappGroupId, resolvedGroupId: group?.id ?? null });
  }

  // Fetch the previous message in this chat BEFORE inserting the current
  // one, so it can never match itself.
  const previous = await prisma.message.findFirst({
    where: { accountId: raw.accountId, chatId: raw.chatId },
    orderBy: { timestampWa: "desc" },
    select: { senderPhone: true, isFromTeamMember: true },
  });

  const normalizedBody = raw.body.trim();

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
        normalizedBody,
        timestampWa: raw.timestampWa,
        processingStatus: "PENDING",
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Duplicate WhatsApp event (retry, redelivery, worker restart) — already processed.
      traceStage(traceId, "DUPLICATE_CHECK", { isDuplicate: true, result: "skipped — already processed" });
      return;
    }
    throw err;
  }
  traceStage(traceId, "MESSAGE_PERSISTED", { messageId: message.id });
  traceStage(traceId, "DUPLICATE_CHECK", { isDuplicate: false, result: "unique — proceeding" });

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
  const executedActions: ActionExecutionRecord[] = [];

  for (const action of result.actions) {
    executedActions.push(
      await executeAction({
        action,
        message,
        raw,
        groupId: group?.id ?? null,
        matchedRule: result.matchedRule,
        matchedRuleRow,
        settings,
      }),
    );
  }

  await prisma.automationExecution.create({
    data: {
      messageId: message.id,
      ruleId: result.matchedRule?.id ?? null,
      actionsExecuted: executedActions as unknown as Prisma.InputJsonValue,
      decision: result.finalDecision,
      reasonTrace: result.trace as unknown as Prisma.InputJsonValue,
      idempotencyKey: buildExecutionIdempotencyKey({
        messageId: message.id,
        ruleId: result.matchedRule?.id ?? null,
      }),
    },
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

async function storeNonAutomatedMessage(raw: RawIncomingMessage): Promise<void> {
  try {
    await prisma.message.create({
      data: {
        accountId: raw.accountId,
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
  matchedRule: EngineRule | null;
  matchedRuleRow: { replyMessage: string | null; cooldownSeconds: number | null; replyDelayMinMs: number | null; replyDelayMaxMs: number | null } | null;
  settings: Awaited<ReturnType<typeof getAutomationSettings>>;
}): Promise<ActionExecutionRecord> {
  const { action, message, raw, groupId, matchedRule, matchedRuleRow, settings } = params;

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
        destination: settings.teamsWebhookUrl,
        relatedMessageId: message.id,
        relatedRuleId: matchedRule?.id ?? null,
        payload: buildNotificationPayload(raw, matchedRule, action),
      });
      return { type: "NOTIFY_TEAMS", executed: true, reason: "Queued for delivery to Microsoft Teams." };
    }

    case "NOTIFY_WHATSAPP": {
      if (!settings.whatsappNotificationGroupId) {
        return { type: "NOTIFY_WHATSAPP", executed: false, reason: "No WhatsApp notification group configured." };
      }
      await enqueueNotification({
        type: "WHATSAPP",
        destination: settings.whatsappNotificationGroupId,
        relatedMessageId: message.id,
        relatedRuleId: matchedRule?.id ?? null,
        payload: buildNotificationPayload(raw, matchedRule, action),
      });
      return { type: "NOTIFY_WHATSAPP", executed: true, reason: "Queued for delivery to the WhatsApp support group." };
    }

    default:
      return { type: action.type, executed: false, reason: "Unknown action type." };
  }
}

function buildNotificationPayload(
  raw: RawIncomingMessage,
  matchedRule: EngineRule | null,
  action: RuleAction,
): Record<string, unknown> {
  return {
    chatId: raw.chatId,
    groupId: raw.whatsappGroupId ?? null,
    clientPhone: raw.senderPhone,
    clientName: raw.senderName ?? null,
    message: raw.body,
    category: action.category ?? null,
    matchedRuleName: matchedRule?.name ?? null,
  };
}
