"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import { validateRegexSafety } from "@support-automation/engine";
import type { RuleAction, RuleConditions } from "@support-automation/shared";
import { requireSession } from "@/server/auth";

const ACTION_TYPES = [
  "IGNORE",
  "TAG",
  "AUTO_REPLY",
  "SUPPORT_REQUIRED",
  "NOTIFY_TEAMS",
  "NOTIFY_WHATSAPP",
  "FORWARD",
  "STOP_PROCESSING",
] as const;

export interface RuleFormState {
  error?: string;
}

function parseConditions(formData: FormData): RuleConditions {
  const conditions: RuleConditions = {};

  const senderType = String(formData.get("senderType") ?? "ANY");
  if (senderType !== "ANY") {
    conditions.sender = { type: senderType as NonNullable<RuleConditions["sender"]>["type"] };
  }

  const previousSenderType = String(formData.get("previousSenderType") ?? "");
  if (previousSenderType && previousSenderType !== "NONE") {
    conditions.previousSender = { type: previousSenderType as NonNullable<RuleConditions["previousSender"]>["type"] };
  }

  const groupIds = String(formData.get("groupIds") ?? "").trim();
  if (groupIds) {
    conditions.groupScope = { type: "SPECIFIC", groupIds: groupIds.split(",").map((g) => g.trim()).filter(Boolean) };
  }

  return conditions;
}

function parseActions(formData: FormData): RuleAction[] {
  const actions: RuleAction[] = [];
  for (const type of ACTION_TYPES) {
    if (formData.get(`action_${type}`) === "on") {
      const action: RuleAction = { type };
      if (type === "TAG") action.tag = String(formData.get("actionTag") ?? "").trim() || undefined;
      if (type === "SUPPORT_REQUIRED") action.category = String(formData.get("actionCategory") ?? "").trim() || undefined;
      if (type === "FORWARD") action.forwardToChatId = String(formData.get("actionForwardChatId") ?? "").trim() || undefined;
      actions.push(action);
    }
  }
  return actions;
}

function parseRuleFields(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const type = String(formData.get("type") ?? "GENERIC") as any;
  const matchType = String(formData.get("matchType") ?? "ALWAYS") as any;
  const matchValue = String(formData.get("matchValue") ?? "").trim() || null;
  const keywordsRaw = String(formData.get("keywords") ?? "").trim();
  const keywords = keywordsRaw ? keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean) : [];
  const priority = Number(formData.get("priority") ?? 0);
  const status = String(formData.get("status") ?? "DRAFT") as any;
  const cooldownSecondsRaw = String(formData.get("cooldownSeconds") ?? "").trim();
  const cooldownSeconds = cooldownSecondsRaw ? Number(cooldownSecondsRaw) : null;
  const replyMessage = String(formData.get("replyMessage") ?? "").trim() || null;
  const replyDelayMinMsRaw = String(formData.get("replyDelayMinMs") ?? "").trim();
  const replyDelayMaxMsRaw = String(formData.get("replyDelayMaxMs") ?? "").trim();
  const replyDelayMinMs = replyDelayMinMsRaw ? Number(replyDelayMinMsRaw) : null;
  const replyDelayMaxMs = replyDelayMaxMsRaw ? Number(replyDelayMaxMsRaw) : null;

  return {
    name,
    description,
    type,
    matchType,
    matchValue,
    keywords,
    priority,
    status,
    cooldownSeconds,
    replyMessage,
    replyDelayMinMs,
    replyDelayMaxMs,
  };
}

/** Mandatory regex-safety gate: a REGEX rule cannot be saved unless its pattern passes packages/engine's validator. */
function validateIfRegex(matchType: string, matchValue: string | null): string | null {
  if (matchType !== "REGEX") return null;
  if (!matchValue) return "A REGEX rule requires a pattern.";
  const result = validateRegexSafety(matchValue);
  return result.safe ? null : `Regex rejected: ${result.reason}`;
}

export async function createRule(_prevState: RuleFormState, formData: FormData): Promise<RuleFormState> {
  await requireSession();
  const fields = parseRuleFields(formData);

  if (!fields.name) return { error: "Rule name is required." };
  const regexError = validateIfRegex(fields.matchType, fields.matchValue);
  if (regexError) return { error: regexError };

  const conditions = parseConditions(formData);
  const actions = parseActions(formData);
  if (actions.length === 0) return { error: "At least one action is required." };

  await prisma.automationRule.create({
    data: { ...fields, conditions: conditions as any, actions: actions as any },
  });

  revalidatePath("/rules");
  redirect("/rules");
}

export async function updateRule(id: string, _prevState: RuleFormState, formData: FormData): Promise<RuleFormState> {
  await requireSession();
  const fields = parseRuleFields(formData);

  if (!fields.name) return { error: "Rule name is required." };
  const regexError = validateIfRegex(fields.matchType, fields.matchValue);
  if (regexError) return { error: regexError };

  const conditions = parseConditions(formData);
  const actions = parseActions(formData);
  if (actions.length === 0) return { error: "At least one action is required." };

  await prisma.automationRule.update({
    where: { id },
    data: { ...fields, conditions: conditions as any, actions: actions as any },
  });

  revalidatePath("/rules");
  redirect("/rules");
}

export async function setRuleStatus(id: string, status: "ACTIVE" | "DISABLED" | "ARCHIVED"): Promise<void> {
  await requireSession();
  await prisma.automationRule.update({ where: { id }, data: { status } });
  revalidatePath("/rules");
}

export async function deleteRule(id: string): Promise<void> {
  await requireSession();
  await prisma.automationRule.delete({ where: { id } });
  revalidatePath("/rules");
}

export async function duplicateRule(id: string): Promise<void> {
  await requireSession();
  const original = await prisma.automationRule.findUniqueOrThrow({ where: { id } });
  await prisma.automationRule.create({
    data: {
      name: `${original.name} (copy)`,
      description: original.description,
      type: original.type,
      matchType: original.matchType,
      matchValue: original.matchValue,
      keywords: original.keywords,
      conditions: original.conditions as any,
      actions: original.actions as any,
      priority: original.priority,
      status: "DRAFT",
      cooldownSeconds: original.cooldownSeconds,
      replyMessage: original.replyMessage,
      replyDelayMinMs: original.replyDelayMinMs,
      replyDelayMaxMs: original.replyDelayMaxMs,
    },
  });
  revalidatePath("/rules");
}

export async function updatePriority(id: string, priority: number): Promise<void> {
  await requireSession();
  await prisma.automationRule.update({ where: { id }, data: { priority } });
  revalidatePath("/rules");
}
