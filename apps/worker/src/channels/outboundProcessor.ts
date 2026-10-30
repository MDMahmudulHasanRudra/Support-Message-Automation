import { decryptSecret } from "@support-automation/db";
import { channelRetryDelayMs, decideReplyWindow, type ChannelType } from "@support-automation/shared";
import { prisma } from "../db.js";
import { recordLoopTick, registerLoop } from "../health/loopLiveness.js";
import { logSystemEvent } from "../logging/logSystemEvent.js";
import { forEachProject } from "../project/context.js";
import { projectHasFeature } from "../project/features.js";
import { getAutomationSettings } from "../pipeline/settings.js";
import { metaAppSecretFor, sendMetaText, sendTelegramText, type FetchImpl, type SendOutcome } from "./providerApi.js";

/**
 * The send queue for Messenger, Instagram and Telegram (OMNICHANNEL.md §8) — the channels' one
 * outbound mechanism, as `OutboundMessage` is WhatsApp's. A reply is a `ChannelMessage` written
 * QUEUED by the dashboard (a person) or by `aiReply.ts` (AI); this loop is the only thing that sends.
 *
 * Per row: claim it (QUEUED → SENDING, a conditional update, so it is sent by one tick only), check
 * everything again at send time — the connection still on and connected, the reply window still
 * open, and for AI the kill switch still off — then send, and record exactly what happened:
 *   - SENT with the provider's id (receipts later move it to DELIVERED / READ);
 *   - a refusal the provider says is temporary → back to QUEUED with a backoff, up to 5 attempts;
 *   - a dead credential → FAILED, and the connection marked NEEDS_RECONNECT;
 *   - any other refusal → FAILED with the reason in plain words;
 *   - an outcome nobody can know (a timeout after the request left) → UNKNOWN, never retried by
 *     itself: retrying could message the customer twice. A person decides.
 * A row stuck in SENDING (the worker died mid-send) becomes UNKNOWN for the same reason.
 */

const LOOP_NAME = "channel-outbound";
const SENDS_PER_PROJECT_PER_TICK = 5;
/** Longer than any send's own timeout (20 s) by a wide margin. */
export const STUCK_SENDING_MS = 5 * 60_000;

export function startChannelOutboundProcessor(intervalMs = 2_000): NodeJS.Timeout {
  registerLoop(LOOP_NAME, intervalMs);
  let processing = false;
  return setInterval(() => {
    if (processing) return;
    processing = true;
    void runChannelOutboundTick()
      .catch((err) => console.error("[channels] unexpected error in the send queue", err))
      .finally(() => {
        processing = false;
        recordLoopTick(LOOP_NAME, intervalMs);
      });
  }, intervalMs);
}

export async function runChannelOutboundTick(now: Date = new Date(), fetchImpl: FetchImpl = fetch): Promise<void> {
  await forEachProject(LOOP_NAME, async () => {
    if (!(await projectHasFeature("OMNICHANNEL"))) return;
    await recoverStuckSends(now);
    for (let i = 0; i < SENDS_PER_PROJECT_PER_TICK; i++) {
      const sent = await sendNextQueued(now, fetchImpl);
      if (!sent) break;
    }
  });
}

async function recoverStuckSends(now: Date): Promise<void> {
  await prisma.channelMessage.updateMany({
    where: { deliveryStatus: "SENDING", sendingStartedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
    data: {
      deliveryStatus: "UNKNOWN",
      lastError: "The send did not finish (the worker stopped while sending), so it is not known whether the customer received it. Check the conversation in the provider's app before sending again.",
    },
  });
}

/** Claim and send the oldest due reply in the current project. False when there was nothing to send. */
export async function sendNextQueued(now: Date = new Date(), fetchImpl: FetchImpl = fetch): Promise<boolean> {
  const candidate = await prisma.channelMessage.findFirst({
    where: { deliveryStatus: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!candidate) return false;
  const claim = await prisma.channelMessage.updateMany({
    where: { id: candidate.id, deliveryStatus: "QUEUED" },
    data: { deliveryStatus: "SENDING", sendingStartedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count === 0) return true;

  const message = await prisma.channelMessage.findUniqueOrThrow({
    where: { id: candidate.id },
    select: {
      id: true,
      type: true,
      text: true,
      attachments: true,
      attempts: true,
      senderType: true,
      messagingType: true,
      messagingTag: true,
      conversation: { select: { id: true, externalThreadId: true, lastInboundAt: true, kind: true } },
      connection: {
        select: { id: true, name: true, enabled: true, status: true, authMode: true, pageId: true, humanAgentEnabled: true, accessTokenCiphertext: true, appSecretCiphertext: true },
      },
    },
  });
  const fail = (reason: string) => finish(message.id, { deliveryStatus: "FAILED", failedAt: now, lastError: reason, nextAttemptAt: null });
  const { connection, conversation } = message;

  if (!connection.enabled || connection.status === "DISCONNECTED") {
    await fail(`Not sent: ${connection.name} is switched off or disconnected.`);
    return true;
  }
  // Website chat has no provider: a stored reply IS delivered — the visitor's widget reads it from
  // here. The same empty-text and kill-switch rules apply as for every other channel.
  if (message.type === "WEBCHAT") {
    // A photo the team sent (Website Chat V3) is already stored; the visitor reads it with their own token.
    const hasPhoto = Array.isArray(message.attachments) && message.attachments.length > 0;
    if (!message.text?.trim() && !hasPhoto) {
      await fail("Not sent: the message is empty.");
      return true;
    }
    if (message.senderType === "AI") {
      const settings = await getAutomationSettings();
      if (!settings.automationEnabled || settings.mode === "MANUAL_ONLY") {
        await fail("Not sent: automation was switched off before this AI reply went out.");
        return true;
      }
    }
    await markSent(message.id, `webchat-${message.id}`, now, null, null);
    return true;
  }
  if (connection.status === "NEEDS_RECONNECT" || !connection.accessTokenCiphertext) {
    await fail(
      connection.authMode === "PLATFORM"
        ? `Not sent: ${connection.name} needs reconnecting (Settings → Messaging Channels → Reconnect with Facebook).`
        : `Not sent: ${connection.name} needs new credentials (Settings → Messaging Channels).`,
    );
    return true;
  }
  if (!message.text?.trim()) {
    await fail("Not sent: the message is empty.");
    return true;
  }
  const automated = message.senderType === "AI";
  if (automated) {
    const settings = await getAutomationSettings();
    if (!settings.automationEnabled || settings.mode === "MANUAL_ONLY") {
      await fail("Not sent: automation was switched off before this AI reply went out.");
      return true;
    }
  }
  // The window is checked again now, not only when the reply was written: a reply queued at 23h59
  // and retried after a provider outage may no longer be allowed.
  const window = decideReplyWindow({ type: message.type as ChannelType, lastInboundAt: conversation.lastInboundAt, now, humanAgentEnabled: connection.humanAgentEnabled, automated });
  if (!window.allowed) {
    await fail(`Not sent: ${window.reason}`);
    return true;
  }

  let outcome: SendOutcome;
  try {
    const token = decryptSecret(connection.accessTokenCiphertext);
    if (message.type === "TELEGRAM") {
      outcome = await sendTelegramText({ token, chatId: conversation.externalThreadId, text: message.text, replyToMessageId: null, fetchImpl });
    } else {
      const appSecret = metaAppSecretFor(connection);
      if (!connection.pageId || !appSecret) {
        await fail(
          connection.authMode === "PLATFORM"
            ? `Not sent: Connect with Facebook is not configured on this server any more (no platform app secret). Ask the platform administrator.`
            : `Not sent: ${connection.name}'s credentials are incomplete. Enter them again.`,
        );
        return true;
      }
      outcome = await sendMetaText({
        pageId: connection.pageId,
        token,
        appSecret,
        recipientId: conversation.externalThreadId,
        text: message.text,
        messagingType: window.messagingType === "MESSAGE_TAG" ? "MESSAGE_TAG" : "RESPONSE",
        tag: window.tag,
        // Messenger echoes it back, which is how the echo of this send is recognised. Instagram's send
        // API has no such field; its echo is matched by the id returned below instead.
        metadata: message.type === "MESSENGER" ? message.id : null,
        fetchImpl,
      });
    }
  } catch (err) {
    // A credential that cannot be decrypted: nothing was sent.
    await fail(`Not sent: ${connection.name}'s saved credentials could not be read. Enter them again.`);
    console.error("[channels] could not read a connection's credentials", err);
    return true;
  }

  switch (outcome.kind) {
    case "SENT":
      await markSent(message.id, outcome.externalMessageId, now, window.messagingType, window.tag);
      return true;
    case "UNKNOWN":
      await finish(message.id, { deliveryStatus: "UNKNOWN", lastError: outcome.message, nextAttemptAt: null });
      return true;
    case "NOT_SENT":
    case "REFUSED": {
      const error = outcome.kind === "NOT_SENT" ? { retryable: true, needsReauth: false, message: outcome.message } : outcome.error;
      if (error.needsReauth) {
        await prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_RECONNECT", lastError: error.message, lastErrorAt: now } });
        await logSystemEvent("ERROR", "channels", "CHANNEL_CREDENTIAL_REFUSED", { connectionId: connection.id, type: message.type }, { targetType: "ChannelConnection", targetId: connection.id });
        await fail(`Not sent: ${error.message}`);
        return true;
      }
      const delay = error.retryable ? channelRetryDelayMs(message.attempts, outcome.kind === "REFUSED" ? outcome.error.retryAfterSeconds : undefined) : null;
      if (delay !== null) {
        await finish(message.id, { deliveryStatus: "QUEUED", nextAttemptAt: new Date(now.getTime() + delay), lastError: error.message, sendingStartedAt: null });
      } else {
        await fail(error.retryable ? `Not sent after ${message.attempts} attempts: ${error.message}` : error.message);
      }
      return true;
    }
  }
}

async function finish(id: string, data: Parameters<typeof prisma.channelMessage.update>[0]["data"]): Promise<void> {
  await prisma.channelMessage.updateMany({ where: { id, deliveryStatus: "SENDING" }, data: data as never });
}

/**
 * SENT, with the provider's id. If the echo of this very send was processed first and stored as a
 * separate row (its text did not match ours exactly), that row IS this message: it is removed and
 * this one takes the id, so the thread shows it once.
 */
async function markSent(id: string, externalMessageId: string, now: Date, messagingType: string | null, tag: string | null): Promise<void> {
  const data = { deliveryStatus: "SENT" as const, externalMessageId, sentAt: now, lastError: null, nextAttemptAt: null, messagingType, messagingTag: tag };
  const current = await prisma.channelMessage.findUniqueOrThrow({ where: { id }, select: { connectionId: true, externalMessageId: true } });
  const duplicate = await prisma.channelMessage.findFirst({
    where: { connectionId: current.connectionId, externalMessageId, id: { not: id } },
    select: { id: true, senderType: true },
  });
  if (duplicate?.senderType === "BUSINESS") {
    await prisma.$transaction([prisma.channelMessage.delete({ where: { id: duplicate.id } }), prisma.channelMessage.updateMany({ where: { id, deliveryStatus: "SENDING" }, data })]);
    return;
  }
  // The echo may already have set the id on this row (inboundProcessor's in-flight match).
  await prisma.channelMessage.updateMany({ where: { id, deliveryStatus: "SENDING" }, data: current.externalMessageId === externalMessageId || !duplicate ? data : { ...data, externalMessageId: current.externalMessageId } });
}
