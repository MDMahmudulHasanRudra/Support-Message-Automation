"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@support-automation/db";
import {
  blankMenuTree,
  DEFAULT_MENU_WORDING,
  MENU_BOT_CHANNELS,
  MENU_BOT_TEMPLATES,
  menuTreeProblems,
  readMenuKeywords,
  readMenuTree,
  RULE_TEMPLATES,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";

/**
 * Menu bots and automation templates (MENU_BOTS.md). They use the Automation Rules keys: a menu bot is automation, and the
 * person who may switch a rule on is the person who may switch a bot on. A new bot is always a DRAFT, and activation is its
 * own key and its own check.
 */

type Fail = { error: string };
const FEATURE = "MENU_BOTS" as const;

async function refresh(id?: string) {
  revalidatePath(await projectPath("/menu-bots"));
  if (id) revalidatePath(await projectPath(`/menu-bots/${id}`));
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export async function createMenuBot(input: { templateId?: unknown; name?: unknown }): Promise<{ id: string } | Fail> {
  const granted = await checkPermission("automation_rules.create", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const template = MENU_BOT_TEMPLATES.find((t) => t.id === input.templateId) ?? null;
  const name = text(input.name, 120) || template?.name || "New menu";
  const wording = template?.wording ?? DEFAULT_MENU_WORDING;
  const bot = await prisma.menuBot.create({
    data: {
      name,
      tree: (template?.tree ?? blankMenuTree()) as unknown as Prisma.InputJsonValue,
      keywords: template?.keywords ?? ["menu", "hi", "hello"],
      invalidText: wording.invalidText,
      handoffText: wording.handoffText,
      backLabel: wording.backLabel,
      homeLabel: wording.homeLabel,
      maxInvalid: wording.maxInvalid,
      createdById: granted.session.userId,
    },
    select: { id: true },
  });
  await refresh();
  return { id: bot.id };
}

export async function saveMenuBot(id: string, input: Record<string, unknown>): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("automation_rules.edit", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const name = text(input.name, 120);
  if (!name) return { error: "Give the bot a name." };
  const tree = readMenuTree(input.tree);
  if (!tree) return { error: "The menu could not be read. Reload the page and try again." };
  const invalidText = text(input.invalidText, 500);
  const handoffText = text(input.handoffText, 1000);
  const backLabel = text(input.backLabel, 30);
  const homeLabel = text(input.homeLabel, 30);
  if (!invalidText || !handoffText || !backLabel || !homeLabel) return { error: "Fill in the wording: the wrong-number line, the hand-over line and both labels." };
  const keywords = readMenuKeywords(input.keywords);
  const channels = Array.isArray(input.channels) ? MENU_BOT_CHANNELS.filter((c) => (input.channels as unknown[]).includes(c)) : [];

  const current = await prisma.menuBot.findFirst({ where: { id }, select: { status: true } });
  if (!current) return { error: "That bot is no longer here." };
  // A running bot is answering customers: it cannot be saved into a state that could not have been switched on.
  if (current.status === "ACTIVE") {
    const problems = menuTreeProblems(tree);
    if (problems.length) return { error: `This bot is live, so fix this first: ${problems[0]}` };
    if (keywords.length === 0 && input.startOnFirstMessage !== true) return { error: "This bot is live and needs a word that starts it, or to start on a first message." };
  }
  await prisma.menuBot.updateMany({
    where: { id },
    data: {
      name,
      tree: tree as unknown as Prisma.InputJsonValue,
      keywords,
      startOnFirstMessage: input.startOnFirstMessage === true,
      onWhatsAppPersonal: input.onWhatsAppPersonal === true,
      onWhatsAppGroups: input.onWhatsAppGroups === true,
      channels,
      invalidText,
      handoffText,
      backLabel,
      homeLabel,
      maxInvalid: clamp(input.maxInvalid, 1, 10, 2),
      sessionMinutes: clamp(input.sessionMinutes, 1, 1440, 30),
      quietMinutes: clamp(input.quietMinutes, 0, 10080, 120),
    },
  });
  await refresh(id);
  return { ok: true };
}

export async function setMenuBotStatus(id: string, status: "ACTIVE" | "PAUSED"): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("automation_rules.activate", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const bot = await prisma.menuBot.findFirst({ where: { id } });
  if (!bot) return { error: "That bot is no longer here." };
  if (status === "ACTIVE") {
    const tree = readMenuTree(bot.tree);
    if (!tree) return { error: "The menu could not be read." };
    const problems = menuTreeProblems(tree);
    if (problems.length) return { error: problems[0]! };
    if (bot.keywords.length === 0 && !bot.startOnFirstMessage) return { error: "Add a word that starts this bot, or let it start on a first message." };
    if (!bot.onWhatsAppPersonal && !bot.onWhatsAppGroups && bot.channels.length === 0) return { error: "Choose where this bot answers." };
  }
  await prisma.menuBot.updateMany({ where: { id }, data: { status } });
  if (status === "PAUSED") await prisma.menuSession.updateMany({ where: { botId: id, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date() } });
  await logSystemEvent("INFO", "menu-bots", status === "ACTIVE" ? `Menu bot switched on: ${bot.name}` : `Menu bot paused: ${bot.name}`, { botId: id, userId: granted.session.userId });
  await refresh(id);
  return { ok: true };
}

export async function deleteMenuBot(id: string): Promise<{ ok: true } | Fail> {
  const granted = await checkPermission("automation_rules.delete", FEATURE);
  if ("denied" in granted) return { error: granted.denied };
  const r = await prisma.menuBot.deleteMany({ where: { id, status: { not: "ACTIVE" } } });
  if (r.count === 0) return { error: "Pause this bot before deleting it." };
  await refresh();
  return { ok: true };
}

/** Adds a ready-made rule as a DRAFT to edit and switch on: a template never answers anyone by itself. */
export async function addRuleTemplate(templateId: string): Promise<{ id: string } | Fail> {
  const granted = await checkPermission("automation_rules.create");
  if ("denied" in granted) return { error: granted.denied };
  const template = RULE_TEMPLATES.find((t) => t.id === templateId);
  if (!template) return { error: "That template is no longer offered." };
  const conditions = { sender: { type: "CLIENT" as const }, ...(template.timeWindow ? { timeWindow: template.timeWindow } : {}) };
  const rule = await prisma.automationRule.create({
    data: {
      name: template.name,
      description: template.description,
      type: "AUTO_REPLY",
      matchType: template.matchType,
      keywords: template.keywords,
      conditions: conditions as unknown as Prisma.InputJsonValue,
      actions: [{ type: "AUTO_REPLY" }] as unknown as Prisma.InputJsonValue,
      priority: template.priority,
      status: "DRAFT",
      cooldownSeconds: template.cooldownSeconds,
      replyMessage: template.replyMessage,
      createdById: granted.session.userId,
    },
    select: { id: true },
  });
  revalidatePath(await projectPath("/rules"));
  return { id: rule.id };
}
