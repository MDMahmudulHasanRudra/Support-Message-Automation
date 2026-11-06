import type { Prisma } from "@prisma/client";
import {
  channelStatusOf,
  channelStorageOf,
  DEFAULT_LIFECYCLE_POLICY,
  statusAfterCustomerMessage,
  type ConversationStatus,
  type LifecyclePolicy,
  type LifecycleSystemReason,
} from "@support-automation/shared";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { currentProjectId, forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";

/**
 * Unified Inbox V3 — the worker's half of the conversation lifecycle (packages/shared conversationLifecycle.ts,
 * feature UNIFIED_INBOX_V3, off by default). Three things, all in the current project, all no-ops while the
 * feature is off:
 *   - a customer's WhatsApp message moves a recorded WhatsApp conversation by the project's policy;
 *   - a customer's channel message does the same for a channel conversation (feature off: the old rule —
 *     any inbound message reopens a closed conversation — applies unchanged, in inboundProcessor.ts);
 *   - a snooze whose time has come reopens, once.
 * Every change is a conditional update on the status it read, with its ConversationEvent in the same
 * transaction, so a replay, a retry or two workers converge on one change and one event. Nothing here
 * creates a WhatsApp state row: no row means OPEN and unassigned, so an untouched chat costs no write.
 * Events carry statuses, times and a reason — never message text.
 */

const LOOP_NAME = "inbox-lifecycle";
const SNOOZE_BATCH = 200;

export async function lifecyclePolicy(): Promise<LifecyclePolicy> {
  const row = await prisma.inboxLifecycleSettings.findFirst({ select: { reopenResolvedOnCustomerMessage: true, reopenSnoozedOnCustomerMessage: true } });
  return row ?? DEFAULT_LIFECYCLE_POLICY;
}

const eventKindFor = (from: ConversationStatus): "UNSNOOZE" | "REOPEN" => (from === "SNOOZED" ? "UNSNOOZE" : "REOPEN");
const context = (reason: LifecycleSystemReason, extra: Record<string, string> = {}): Prisma.InputJsonValue => ({ reason, ...extra });

/**
 * The WhatsApp message hook (persistIncomingMessage, after the Message insert, once per new message).
 * Never throws: a lifecycle problem must not cost a message its processing.
 */
export async function recordWhatsAppConversationActivity(input: { accountId: string; chatId: string; at: Date; fromCustomer: boolean }): Promise<void> {
  try {
    if (!(await projectHasFeature("UNIFIED_INBOX_V3"))) return;
    const state = await prisma.whatsAppConversationState.findFirst({
      where: { accountId: input.accountId, chatId: input.chatId },
      select: { id: true, status: true },
    });
    if (!state) return;
    // Times only ever move forward (a late, recovered message must not move them back).
    await prisma.whatsAppConversationState.updateMany({
      where: { id: state.id, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: input.at } }] },
      data: { lastActivityAt: input.at },
    });
    if (!input.fromCustomer) return;
    await prisma.whatsAppConversationState.updateMany({
      where: { id: state.id, OR: [{ lastCustomerMessageAt: null }, { lastCustomerMessageAt: { lt: input.at } }] },
      data: { lastCustomerMessageAt: input.at },
    });
    const next = statusAfterCustomerMessage(state.status, await lifecyclePolicy());
    if (!next) return;
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const moved = await tx.whatsAppConversationState.updateMany({
        where: { id: state.id, status: state.status },
        data: { status: next, snoozedUntil: null, statusChangedAt: now, resolvedAt: null, resolvedById: null },
      });
      if (moved.count === 0) return;
      await tx.conversationEvent.create({
        data: {
          projectId: currentProjectId(),
          accountId: input.accountId,
          chatId: input.chatId,
          kind: eventKindFor(state.status),
          fromValue: state.status,
          toValue: next,
          context: context("CUSTOMER_MESSAGE"),
        },
      });
    });
  } catch (err) {
    console.error("[inbox-lifecycle] could not apply a WhatsApp message to its conversation state", err);
  }
}

/**
 * A customer's channel message, with the feature on: the policy decides. Returns true when it handled the
 * status (feature on), false when the caller should apply the old rule. Throws only on a database error,
 * which the inbound processor already handles per event.
 */
export async function applyChannelCustomerMessage(conversationId: string): Promise<boolean> {
  if (!(await projectHasFeature("UNIFIED_INBOX_V3"))) return false;
  const conversation = await prisma.channelConversation.findFirst({ where: { id: conversationId }, select: { status: true } });
  if (!conversation) return true;
  const from = channelStatusOf(conversation.status);
  const next = statusAfterCustomerMessage(from, await lifecyclePolicy());
  if (!next) return true;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const moved = await tx.channelConversation.updateMany({
      where: { id: conversationId, status: conversation.status },
      data: { status: channelStorageOf(next), snoozedUntil: null, closedAt: null, resolvedById: null, statusChangedAt: now },
    });
    if (moved.count === 0) return;
    await tx.conversationEvent.create({
      data: { projectId: currentProjectId(), channelConversationId: conversationId, kind: eventKindFor(from), fromValue: from, toValue: next, context: context("CUSTOMER_MESSAGE") },
    });
  });
  return true;
}

/** Reopens every snooze in the current project whose time has come. Returns how many reopened. */
export async function reopenEndedSnoozes(now: Date = new Date()): Promise<number> {
  if (!(await projectHasFeature("UNIFIED_INBOX_V3"))) return 0;
  const projectId = currentProjectId();
  let reopened = 0;

  const states = await prisma.whatsAppConversationState.findMany({
    where: { status: "SNOOZED", snoozedUntil: { lte: now } },
    select: { id: true, accountId: true, chatId: true, snoozedUntil: true },
    orderBy: { snoozedUntil: "asc" },
    take: SNOOZE_BATCH,
  });
  for (const s of states) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.whatsAppConversationState.updateMany({
        where: { id: s.id, status: "SNOOZED", snoozedUntil: s.snoozedUntil },
        data: { status: "OPEN", snoozedUntil: null, statusChangedAt: now },
      });
      if (moved.count === 0) return;
      reopened++;
      await tx.conversationEvent.create({
        data: { projectId, accountId: s.accountId, chatId: s.chatId, kind: "UNSNOOZE", fromValue: "SNOOZED", toValue: "OPEN", context: context("SNOOZE_ENDED", { snoozedUntil: s.snoozedUntil!.toISOString() }) },
      });
    });
  }

  const conversations = await prisma.channelConversation.findMany({
    where: { status: "SNOOZED", snoozedUntil: { lte: now } },
    select: { id: true, snoozedUntil: true },
    orderBy: { snoozedUntil: "asc" },
    take: SNOOZE_BATCH,
  });
  for (const c of conversations) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.channelConversation.updateMany({
        where: { id: c.id, status: "SNOOZED", snoozedUntil: c.snoozedUntil },
        data: { status: "OPEN", snoozedUntil: null, statusChangedAt: now },
      });
      if (moved.count === 0) return;
      reopened++;
      await tx.conversationEvent.create({
        data: { projectId, channelConversationId: c.id, kind: "UNSNOOZE", fromValue: "SNOOZED", toValue: "OPEN", context: context("SNOOZE_ENDED", { snoozedUntil: c.snoozedUntil!.toISOString() }) },
      });
    });
  }
  return reopened;
}

export function startInboxLifecycleProcessor(intervalMs = 60_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void forEachProject(LOOP_NAME, () => reopenEndedSnoozes(new Date()))
      .catch((err) => console.error("[inbox-lifecycle] snooze pass failed", err))
      .finally(() => {
        running = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}
