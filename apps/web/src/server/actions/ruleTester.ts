"use server";

import { prisma } from "@support-automation/db";
import { evaluate, type EngineRule } from "@support-automation/engine";
import { isRuleActionArray, isRuleConditions } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import type { EvaluationResult } from "@support-automation/engine";

export interface RuleTesterState {
  error?: string;
  result?: EvaluationResult;
}

/**
 * Dry test only: evaluates the message against the current rule set
 * in-process, in the web server. It never calls the worker, the outbound
 * queue, or a WhatsApp provider, so nothing can be sent — per the spec's
 * "must NOT send a real WhatsApp message... unless explicitly configured
 * for a live test" requirement. A "live test" (Phase 5's SEND_LIVE_TEST
 * WorkerCommand) is a deliberately separate, explicit action.
 */
export async function testRule(_prevState: RuleTesterState, formData: FormData): Promise<RuleTesterState> {
  await requireSession();

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Message body is required." };

  const senderPhone = String(formData.get("senderPhone") ?? "+8801000000000").trim();
  const isFromTeamMember = formData.get("isFromTeamMember") === "on";
  const groupId = String(formData.get("groupId") ?? "").trim() || null;
  const previousSenderPhone = String(formData.get("previousSenderPhone") ?? "").trim();
  const previousSenderIsTeamMember = formData.get("previousSenderIsTeamMember") === "on";

  const simulateAtRaw = String(formData.get("simulateAt") ?? "").trim();
  const timestamp = simulateAtRaw ? new Date(simulateAtRaw) : new Date();
  if (Number.isNaN(timestamp.getTime())) return { error: "Invalid simulated time." };

  const activeRuleRows = await prisma.automationRule.findMany({ where: { status: "ACTIVE" } });
  const rules: EngineRule[] = activeRuleRows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    matchType: row.matchType,
    matchValue: row.matchValue,
    keywords: row.keywords,
    conditions: isRuleConditions(row.conditions) ? row.conditions : {},
    actions: isRuleActionArray(row.actions) ? row.actions : [],
    priority: row.priority,
  }));

  const result = evaluate({
    message: {
      body,
      senderPhone,
      isFromTeamMember,
      groupId,
      chatId: groupId ?? senderPhone,
      timestamp,
    },
    previousMessage: previousSenderPhone
      ? { senderPhone: previousSenderPhone, isFromTeamMember: previousSenderIsTeamMember }
      : null,
    rules,
  });

  return { result };
}
