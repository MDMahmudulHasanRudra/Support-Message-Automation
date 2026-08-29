"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { requireSession } from "@/server/auth";
import { logSystemEvent } from "@/server/logSystemEvent";

export interface ChatSendState {
  error?: string;
  sentAt?: number;
}

/** WhatsApp's own single-message ceiling; refuse past it rather than let the provider truncate. */
const MAX_BODY_LENGTH = 4096;

/**
 * Collapses an accidental double-submit of identical text into one send, while still
 * allowing a genuine repeat ("ok", "thanks") a few seconds later. Ten seconds is long
 * enough to cover a double-click or a resubmitted form, short enough that no one notices
 * the limit exists.
 */
const IDEMPOTENCY_WINDOW_MS = 10_000;

function buildManualReplyIdempotencyKey(groupId: string, body: string): string {
  const bucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return `manual-reply:${groupId}:${bucket}:${digest}`;
}

/**
 * Queues one operator-typed reply to a WhatsApp group.
 *
 * Writes a single `OutboundMessage` row and stops there — it never talks to the worker
 * and never sends anything itself. That is the same DB-mediated hand-off the Teams
 * resolution notifier uses, and it keeps the promise that all outbound WhatsApp traffic
 * leaves through exactly one queue. Deliberately not `enqueueOutboundMessage()`, which is
 * shaped for the incoming-message pipeline's non-null `incomingMessageId` and rule-cooldown
 * contract; neither applies to a human replying in a group.
 */
export async function sendChatMessage(
  groupId: string,
  _prevState: ChatSendState,
  formData: FormData,
): Promise<ChatSendState> {
  const session = await requireSession();

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Type a message before sending." };
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `That message is ${body.length} characters. WhatsApp accepts at most ${MAX_BODY_LENGTH}.` };
  }

  const group = await prisma.whatsAppGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      whatsappGroupId: true,
      accountId: true,
      isActive: true,
      account: { select: { label: true, status: true } },
    },
  });
  if (!group) return { error: "That conversation no longer exists." };

  // Checked here so the operator is told immediately, in the composer, instead of watching
  // the message sit queued until the worker discovers the same thing and marks it SKIPPED.
  if (!group.isActive) {
    return {
      error: `This account is no longer a member of ${group.name}, so messages cannot be sent to it. Resync groups if you have since been re-added.`,
    };
  }
  if (group.account.status !== "CONNECTED") {
    return {
      error: `${group.account.label} is ${group.account.status.toLowerCase()}. Reconnect it on WhatsApp Accounts before sending.`,
    };
  }

  try {
    await prisma.outboundMessage.create({
      data: {
        accountId: group.accountId,
        chatId: group.whatsappGroupId,
        // A group has no single recipient number; the broadcast path sets the chat id here
        // for the same reason, and the queue's per-client rate limiter keys off this value.
        toPhone: group.whatsappGroupId,
        body,
        actionType: "MANUAL_REPLY",
        idempotencyKey: buildManualReplyIdempotencyKey(groupId, body),
        groupId: group.id,
        groupNameSnapshot: group.name,
        createdById: session.userId,
      },
    });
  } catch (err) {
    // A P2002 here is the idempotency window doing its job on a double-submit: the first
    // write already queued this exact text, so report success rather than a scary error.
    if ((err as { code?: string }).code === "P2002") {
      revalidatePath(`/chat/${groupId}`);
      return { sentAt: Date.now() };
    }
    throw err;
  }

  await logSystemEvent("INFO", "chat-inbox", `Queued a manual reply to ${group.name}`, {
    groupId: group.id,
    accountId: group.accountId,
    userId: session.userId,
    length: body.length,
  });

  revalidatePath(`/chat/${groupId}`);
  revalidatePath("/chat");
  return { sentAt: Date.now() };
}

/**
 * Cancels a queued reply that has not left yet. Only ever touches a MANUAL_REPLY row that is
 * still PENDING — an automation-generated send or one already in flight is never cancellable
 * from here.
 */
export async function cancelQueuedChatMessage(outboundId: string, groupId: string): Promise<void> {
  await requireSession();
  await prisma.outboundMessage.updateMany({
    where: { id: outboundId, actionType: "MANUAL_REPLY", status: "PENDING" },
    data: { status: "CANCELLED", failureReason: "Cancelled from the chat inbox before sending." },
  });
  revalidatePath(`/chat/${groupId}`);
}
