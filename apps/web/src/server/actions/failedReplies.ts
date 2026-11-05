"use server";

import { revalidatePath } from "next/cache";
import { canTransition, type FailedReplySource } from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { disabledFeaturesFor } from "@/server/projectFeatures";
import { activeProjectId } from "@/server/projectContext";
import { projectPath } from "@/server/projectPaths";
import { logSystemEvent } from "@/server/logSystemEvent";
import { ChannelReplyError, retryChannelReply } from "@/server/channels/replies";
import {
  FAILED_REPLY_MAX_SELECTION,
  getFailedReply,
  listFailedReplyKeys,
  parseFailedReplyFilters,
  retryDecisionFor,
  type FailedReplyRow,
} from "@/server/failedReplies";

/**
 * Messages → Failed Replies actions (FAILED_REPLIES.md). Every action:
 *   - checks its permission itself (`messages.reply` for WhatsApp rows, `conversations.reply` with the
 *     OMNICHANNEL feature for channel rows), since a Server Action is a public endpoint;
 *   - re-reads the row through the project-scoped client, so another project's id is "not found";
 *   - changes the row with a CONDITIONAL update on the state it read, and writes its history row in the
 *     same transaction — a worker settling the row meanwhile wins, and nothing is half-recorded.
 * A retry re-queues the SAME row with the SAME idempotency key; it never creates a second message, and
 * the worker re-checks the kill switch, rate limits and membership at send time exactly as before.
 */

export interface FailedReplyItem {
  source: FailedReplySource;
  id: string;
}

export interface FailedReplyActionResult {
  error?: string;
  /** How many rows the action changed, and how many it left alone (with why, for one row). */
  done?: number;
  skipped?: number;
  /** For a single retry that needs the uncertainty confirmation first. */
  needsConfirmation?: boolean;
}

async function gate(source: FailedReplySource): Promise<{ userId: string; username: string } | { denied: string }> {
  const access = source === "WHATSAPP" ? await checkPermission("messages.reply") : await checkPermission("conversations.reply", "OMNICHANNEL");
  if ("denied" in access) return access;
  return { userId: access.session.userId, username: access.session.username };
}

async function channelsOn(): Promise<boolean> {
  return !(await disabledFeaturesFor(await activeProjectId())).has("OMNICHANNEL");
}

async function load(item: FailedReplyItem): Promise<FailedReplyRow | null> {
  if (item.source !== "WHATSAPP" && item.source !== "CHANNEL") return null;
  if (typeof item.id !== "string" || item.id.length > 64) return null;
  return getFailedReply(item.source, item.id, await channelsOn());
}

const cleanNote = (note: string | undefined | null) => note?.trim().slice(0, 300) || null;

async function refresh(): Promise<void> {
  revalidatePath(await projectPath("/messages/failed-replies"), "layout");
}

/** Re-queues one WhatsApp reply. False when the row changed under us. */
async function retryWhatsApp(row: FailedReplyRow, actor: { userId: string; username: string }, confirmedUncertain: boolean, note: string | null): Promise<boolean> {
  const projectId = await activeProjectId();
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.outboundMessage.updateMany({
      where: { id: row.id, status: row.status as never, replyResolution: null, manualRetryCount: row.manualRetryCount },
      data: {
        status: "PENDING",
        attemptCount: 0,
        scheduledAt: now,
        sendStartedAt: null,
        deliveryUncertain: false,
        failureReason: null,
        manualRetryCount: { increment: 1 },
        lastManualRetryAt: now,
      },
    });
    if (updated.count === 0) return false;
    await tx.failedReplyAction.create({
      data: {
        projectId,
        outboundMessageId: row.id,
        action: "RETRY",
        fromStatus: row.status,
        failureReason: row.failureReason,
        confirmedUncertain: row.deliveryUncertain && confirmedUncertain,
        note,
        actorUserId: actor.userId,
        actorUsername: actor.username,
      },
    });
    return true;
  });
}

async function retryOne(item: FailedReplyItem, confirmedUncertain: boolean, note: string | null, bulk: boolean): Promise<{ ok: boolean; reason?: string; needsConfirmation?: boolean; denied?: string }> {
  const actor = await gate(item.source);
  if ("denied" in actor) return { ok: false, denied: actor.denied };
  const row = await load(item);
  if (!row) return { ok: false, reason: "That reply was not found in this workspace." };
  const { decision, bulk: bulkAllowed } = await retryDecisionFor(row, confirmedUncertain);
  if (bulk && !bulkAllowed) return { ok: false, reason: decision.ok ? "Delivery uncertain: retry it on its own after checking the chat." : decision.reason };
  if (!decision.ok) return { ok: false, reason: decision.reason, needsConfirmation: decision.needsConfirmation };

  if (row.source === "CHANNEL") {
    try {
      await retryChannelReply({ messageId: row.id, confirmedUnknown: confirmedUncertain, actor, note });
    } catch (err) {
      if (err instanceof ChannelReplyError) return { ok: false, reason: err.message };
      throw err;
    }
  } else if (!(await retryWhatsApp(row, actor, confirmedUncertain, note))) {
    return { ok: false, reason: "That reply changed meanwhile. Reload to see where it is." };
  }
  await logSystemEvent(
    "INFO",
    "failed-replies",
    "A failed customer reply was queued again",
    { source: row.source, fromStatus: row.status, uncertain: row.deliveryUncertain, confirmedUncertain, manualRetry: row.manualRetryCount + 1 },
    { actorUserId: actor.userId, targetType: row.source === "WHATSAPP" ? "OutboundMessage" : "ChannelMessage", targetId: row.id },
  );
  return { ok: true };
}

/** One reply, from its detail page or its row. An uncertain one needs `confirmedUncertain`. */
export async function retryFailedReply(input: FailedReplyItem & { confirmedUncertain?: boolean; note?: string }): Promise<FailedReplyActionResult> {
  const result = await retryOne({ source: input.source, id: input.id }, input.confirmedUncertain === true, cleanNote(input.note), false);
  if (result.denied) return { error: result.denied };
  if (!result.ok) return { error: result.reason, needsConfirmation: result.needsConfirmation };
  await refresh();
  return { done: 1, skipped: 0 };
}

/** Several replies. Never sends an uncertain one: those need a person's check, one at a time. */
export async function retryFailedReplies(input: { items: FailedReplyItem[]; note?: string }): Promise<FailedReplyActionResult> {
  const items = dedupe(input.items).slice(0, FAILED_REPLY_MAX_SELECTION);
  if (items.length === 0) return { error: "Choose at least one reply." };
  let done = 0;
  let skipped = 0;
  for (const item of items) {
    const result = await retryOne(item, false, cleanNote(input.note), true);
    if (result.denied && items.length === 1) return { error: result.denied };
    if (result.ok) done++;
    else skipped++;
  }
  await refresh();
  return { done, skipped };
}

type Settle = "RESOLVE" | "CLOSE" | "REOPEN";

async function settleOne(item: FailedReplyItem, action: Settle, note: string | null): Promise<"done" | "skipped" | { denied: string }> {
  const actor = await gate(item.source);
  if ("denied" in actor) return actor;
  const row = await load(item);
  if (!row || !canTransition(row.state, action)) return "skipped";
  // Reopen undoes a person's resolve or close; a reply that was retried and SENT has nothing to undo.
  if (action === "REOPEN" && row.resolution === null) return "skipped";
  const projectId = await activeProjectId();
  const now = new Date();
  const data =
    action === "REOPEN"
      ? { replyResolution: null, replyResolvedAt: null, replyResolvedById: null, replyResolutionNote: null }
      : { replyResolution: action === "RESOLVE" ? ("RESOLVED" as const) : ("CLOSED" as const), replyResolvedAt: now, replyResolvedById: actor.userId, replyResolutionNote: note };
  const expect = row.resolution;
  const changed = await prisma.$transaction(async (tx) => {
    const updated =
      row.source === "WHATSAPP"
        ? await tx.outboundMessage.updateMany({ where: { id: row.id, status: row.status as never, replyResolution: expect }, data })
        : await tx.channelMessage.updateMany({ where: { id: row.id, deliveryStatus: row.status as never, replyResolution: expect }, data });
    if (updated.count === 0) return false;
    await tx.failedReplyAction.create({
      data: {
        projectId,
        ...(row.source === "WHATSAPP" ? { outboundMessageId: row.id } : { channelMessageId: row.id }),
        action,
        fromStatus: row.status,
        failureReason: row.failureReason,
        note,
        actorUserId: actor.userId,
        actorUsername: actor.username,
      },
    });
    return true;
  });
  return changed ? "done" : "skipped";
}

async function settleMany(items: FailedReplyItem[], action: Settle, note: string | undefined): Promise<FailedReplyActionResult> {
  const list = dedupe(items).slice(0, FAILED_REPLY_MAX_SELECTION);
  if (list.length === 0) return { error: "Choose at least one reply." };
  if (action === "CLOSE" && !cleanNote(note)) return { error: "Say why it is being closed — it is kept with the record." };
  let done = 0;
  let skipped = 0;
  for (const item of list) {
    const result = await settleOne(item, action, cleanNote(note));
    if (typeof result === "object") {
      if (list.length === 1) return { error: result.denied };
      skipped++;
    } else if (result === "done") done++;
    else skipped++;
  }
  if (done > 0) {
    await logSystemEvent("INFO", "failed-replies", `Failed customer replies ${action === "RESOLVE" ? "resolved" : action === "CLOSE" ? "closed" : "reopened"}`, { done, skipped });
  }
  await refresh();
  return { done, skipped };
}

/** The customer was answered some other way, or the message turned out to have arrived. */
export async function resolveFailedReplies(input: { items: FailedReplyItem[]; note?: string }): Promise<FailedReplyActionResult> {
  return settleMany(input.items, "RESOLVE", input.note);
}

/** Permanently closed: it will not be sent. A reason is required. */
export async function closeFailedReplies(input: { items: FailedReplyItem[]; note?: string }): Promise<FailedReplyActionResult> {
  return settleMany(input.items, "CLOSE", input.note);
}

export async function reopenFailedReply(input: FailedReplyItem & { note?: string }): Promise<FailedReplyActionResult> {
  return settleMany([{ source: input.source, id: input.id }], "REOPEN", input.note);
}

/** "Select all matching": the keys behind the current filters, capped. Polled by nothing; refuses as empty. */
export async function selectAllFailedReplies(query: Record<string, string>): Promise<{ items: FailedReplyItem[]; truncated: boolean }> {
  const access = await checkPermission("messages.view");
  if ("denied" in access) return { items: [], truncated: false };
  const items = await listFailedReplyKeys(parseFailedReplyFilters(query), await channelsOn());
  return { items, truncated: items.length >= FAILED_REPLY_MAX_SELECTION };
}

function dedupe(items: FailedReplyItem[]): FailedReplyItem[] {
  const seen = new Set<string>();
  const out: FailedReplyItem[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || (item.source !== "WHATSAPP" && item.source !== "CHANNEL") || typeof item.id !== "string") continue;
    const key = `${item.source}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: item.source, id: item.id });
  }
  return out;
}

