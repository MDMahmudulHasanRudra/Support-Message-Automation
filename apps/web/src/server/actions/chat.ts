"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@support-automation/db";
import { checkPermission, requireAccess } from "@/server/authorize";
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
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };
  const session = granted.session;

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

    // Anything else — the group deleted between the lookup above and this insert, a dropped
    // connection — has to come back through the same error channel every other failure here uses.
    // Rethrowing replaced the composer with a generic error boundary, so the operator's typed
    // message vanished with nothing said about it.
    await logSystemEvent("ERROR", "chat-inbox", "Failed to queue a manual reply", {
      error: (err as Error).message,
      groupId: group.id,
      accountId: group.accountId,
      userId: session.userId,
    });
    return {
      error: `Your message to ${group.name} could not be queued because of a server error, and was not sent. Try again — if it keeps failing, check System Logs.`,
    };
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
  await requireAccess("messages.reply");
  await prisma.outboundMessage.updateMany({
    where: { id: outboundId, actionType: "MANUAL_REPLY", status: "PENDING" },
    data: { status: "CANCELLED", failureReason: "Cancelled from the chat inbox before sending." },
  });
  revalidatePath(`/chat/${groupId}`);
}

export interface MessageActionResult {
  error?: string;
}

/**
 * Reacts to a stored message with one emoji -- ours or a customer's, since WhatsApp allows
 * reacting to either. `messageId` is our own row's id rather than the WhatsApp message id, so the
 * account it belongs to can be resolved server-side instead of trusted from the client.
 *
 * This is a live browser action -- a WorkerCommand, not an OutboundMessage -- because a reaction
 * has nothing to retry, rate-limit or queue: it either lands on the next tick or it does not.
 */
export async function reactToChatMessage(messageId: string, emoji: string): Promise<MessageActionResult> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { accountId: true, whatsappMessageId: true, groupId: true },
  });
  if (!message) return { error: "That message could not be found." };

  await prisma.workerCommand.create({
    data: {
      type: "REACT_TO_MESSAGE",
      accountId: message.accountId,
      payload: { whatsappMessageId: message.whatsappMessageId, emoji },
    },
  });
  if (message.groupId) revalidatePath(`/chat/${message.groupId}`);
  return {};
}

/**
 * Edits the text of a message this account sent. WhatsApp's own edit feature is marked
 * experimental by the underlying library and most accounts do not have it -- a reported failure
 * here is the ordinary outcome on many accounts, not evidence of a defect, and is surfaced as
 * plainly as any other "could not send" error.
 *
 * Deliberately does NOT rewrite `Message.body`: that column is the record of what was actually
 * sent, and WhatsApp's own edit indicator on the customer's device is the real record that a
 * message changed. Silently rewriting history here would make our own record disagree with what a
 * customer scrolling back actually sees.
 */
export async function editChatMessage(messageId: string, newBody: string): Promise<MessageActionResult> {
  const granted = await checkPermission("messages.reply");
  if ("denied" in granted) return { error: granted.denied };

  const trimmed = newBody.trim();
  if (!trimmed) return { error: "The edited message cannot be empty." };
  if (trimmed.length > MAX_BODY_LENGTH) return { error: `Keep it under ${MAX_BODY_LENGTH} characters.` };

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { accountId: true, whatsappMessageId: true, groupId: true, direction: true },
  });
  if (!message) return { error: "That message could not be found." };
  if (message.direction !== "OUTGOING") return { error: "Only a message this account sent can be edited." };

  await prisma.workerCommand.create({
    data: {
      type: "EDIT_MESSAGE",
      accountId: message.accountId,
      payload: { whatsappMessageId: message.whatsappMessageId, newBody: trimmed },
    },
  });
  if (message.groupId) revalidatePath(`/chat/${message.groupId}`);
  return {};
}
