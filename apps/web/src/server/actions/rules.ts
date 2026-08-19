"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@support-automation/db";
import type { RuleAction, RuleConditions } from "@support-automation/shared";
import { requireSession } from "@/server/auth";
import { validateRuleBusinessRules } from "@/server/ruleValidation";

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

/** `<input type="time">` submits "HH:MM" — only the hour is used (see RuleForm.tsx's "Active from/until" hint). */
function parseHour(value: FormDataEntryValue | null): number {
  const hour = Number(String(value ?? "0:00").split(":")[0]);
  return Math.min(23, Math.max(0, Number.isFinite(hour) ? Math.trunc(hour) : 0));
}

/** Only reads the form's schedule fields when the toggle is on — undefined when off, never a default window. */
function parseTimeWindow(formData: FormData): RuleConditions["timeWindow"] {
  if (formData.get("timeWindowEnabled") !== "on") return undefined;
  const startHour = parseHour(formData.get("timeWindowStartHour"));
  const endHour = parseHour(formData.get("timeWindowEndHour"));
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => formData.get(`timeWindowDay_${d}`) === "on");
  return { startHour, endHour, ...(days.length > 0 ? { days } : {}) };
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

  const timeWindow = parseTimeWindow(formData);
  if (timeWindow) conditions.timeWindow = timeWindow;

  return conditions;
}

/** A zero-width window (e.g. 22:00 to 22:00) would never match anything — use Disable for "intentionally inactive" instead. */
function validateTimeWindow(formData: FormData): string | null {
  if (formData.get("timeWindowEnabled") !== "on") return null;
  const startHour = parseHour(formData.get("timeWindowStartHour"));
  const endHour = parseHour(formData.get("timeWindowEndHour"));
  if (startHour === endHour) {
    return "Active-from and active-until cannot be the same hour — this would never match. Use Disable instead if you want the rule inactive.";
  }
  return null;
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

export async function createRule(_prevState: RuleFormState, formData: FormData): Promise<RuleFormState> {
  await requireSession();
  const fields = parseRuleFields(formData);
  const conditions = parseConditions(formData);
  const actions = parseActions(formData);

  const businessError = validateRuleBusinessRules({
    name: fields.name,
    matchType: fields.matchType,
    matchValue: fields.matchValue,
    actions,
    timeWindowEnabled: formData.get("timeWindowEnabled") === "on",
    timeWindowStartHour: conditions.timeWindow?.startHour,
    timeWindowEndHour: conditions.timeWindow?.endHour,
  });
  if (businessError) return { error: businessError };

  await prisma.automationRule.create({
    data: { ...fields, conditions: conditions as any, actions: actions as any },
  });

  revalidatePath("/rules");
  redirect("/rules");
}

export async function updateRule(id: string, _prevState: RuleFormState, formData: FormData): Promise<RuleFormState> {
  await requireSession();
  const fields = parseRuleFields(formData);
  const conditions = parseConditions(formData);
  const actions = parseActions(formData);

  const businessError = validateRuleBusinessRules({
    name: fields.name,
    matchType: fields.matchType,
    matchValue: fields.matchValue,
    actions,
    timeWindowEnabled: formData.get("timeWindowEnabled") === "on",
    timeWindowStartHour: conditions.timeWindow?.startHour,
    timeWindowEndHour: conditions.timeWindow?.endHour,
  });
  if (businessError) return { error: businessError };

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
