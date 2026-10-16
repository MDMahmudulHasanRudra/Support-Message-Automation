"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import {
  forwardRefusal,
  isSendableSticker,
  outboundSummary,
  validateLocation,
  validatePoll,
  type LocationContent,
  type PollContent,
} from "@support-automation/shared";
import { prisma } from "@/server/db";
import { checkPermission } from "@/server/authorize";
import { logSystemEvent } from "@/server/logSystemEvent";
import { projectPath } from "@/server/projectPaths";
import { isChatUiV2Enabled, resolveConversation, type ConversationRef, type ResolvedConversation } from "@/server/chatThreadV2";

/**
 * Chat v2 rich messaging (CHAT_RICH_MESSAGING.md) — the dashboard side of polls, locations, stickers,
 * forwards, stars, pin / archive on the phone, and loading earlier messages from WhatsApp.
 *
 * Every function is a public endpoint and checks for itself: the permission, the CHAT_UI_V2 feature
 * (nothing here works with it off), and a conversation the server re-derives from what the request
 * names (`resolveConversation`) — never an account, chat or project taken on trust.
 *
 * Sends go where every send goes: ONE `OutboundMessage` row (MANUAL_REPLY), which the worker sends
 * through the one outbound queue under the same rate limits, kill-switch rule and live membership
 * check as a typed reply. Stars, pins, archives and history loads are live browser actions, so they
 * are `WorkerCommand`s like a reaction.
 */

export interface RichActionResult {
  error?: string;
  /** Set when the action queued a worker command whose result the browser may poll for. */
  commandId?: string;
  sentAt?: number;
}

const OFF = "The new conversation view is not switched on for this project, so nothing was done.";
const NOT_FOUND = "This conversation could not be found on the selected account. Nothing was sent.";
const IDEMPOTENCY_WINDOW_MS = 10_000;

async function gate(key: "messages.view" | "messages.reply"): Promise<{ userId: string } | { error: string }> {
  const granted = await checkPermission(key);
  if ("denied" in granted) return { error: granted.denied };
  if (!(await isChatUiV2Enabled())) return { error: OFF };
  return { userId: granted.session.userId };
}

/**
 * Everything a send into this conversation needs, checked: the account connected, a group still
 * joined, a personal chat one the account already has (a reply, never a first message).
 */
async function sendTarget(
  conversation: ResolvedConversation,
): Promise<{ ok: true; accountLabel: string; name: string; groupRowId: string | null } | { ok: false; error: string }> {
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: conversation.accountId }, select: { label: true, status: true } });
  if (!account) return { ok: false, error: NOT_FOUND };
  if (account.status !== "CONNECTED") {
    return { ok: false, error: `${account.label} is ${account.status.toLowerCase()}, so nothing was sent. Reconnect it on WhatsApp Accounts.` };
  }
  if (conversation.kind === "GROUP") {
    const group = await prisma.whatsAppGroup.findUnique({ where: { id: conversation.groupRowId }, select: { name: true, isActive: true } });
    if (!group) return { ok: false, error: NOT_FOUND };
    if (!group.isActive) return { ok: false, error: `This account is no longer a member of ${group.name}, so nothing was sent.` };
    return { ok: true, accountLabel: account.label, name: group.name, groupRowId: conversation.groupRowId };
  }
  const existing = await prisma.message.findFirst({
    where: { accountId: conversation.accountId, chatId: conversation.chatId, groupId: null },
    orderBy: { timestampWa: "desc" },
    select: { senderName: true },
  });
  if (!existing) return { ok: false, error: `${account.label} has no conversation with this number, so nothing was sent. Replies continue an existing chat; they never start one.` };
  return { ok: true, accountLabel: account.label, name: existing.senderName || conversation.chatId.split("@")[0]!, groupRowId: null };
}

type RichSend =
  | { kind: "POLL"; poll: PollContent }
  | { kind: "LOCATION"; location: LocationContent }
  | { kind: "STICKER"; mediaId: string }
  | { kind: "FORWARD"; sourceMessageId: string; sourceBody: string };

async function queueRichSend(ref: ConversationRef, send: RichSend): Promise<RichActionResult> {
  const allowed = await gate("messages.reply");
  if ("error" in allowed) return { error: allowed.error };
  const conversation = await resolveConversation(ref);
  if (!conversation) return { error: NOT_FOUND };
  const target = await sendTarget(conversation);
  if (!target.ok) return { error: target.error };
  if (send.kind === "POLL" && conversation.kind !== "GROUP") return { error: "WhatsApp allows polls in groups only. Nothing was sent." };

  const content: Prisma.InputJsonValue =
    send.kind === "POLL"
      ? { ...send.poll }
      : send.kind === "LOCATION"
        ? { ...send.location }
        : send.kind === "STICKER"
          ? { mediaId: send.mediaId }
          : { sourceMessageId: send.sourceMessageId };
  const body = outboundSummary(send.kind, {
    poll: send.kind === "POLL" ? send.poll : undefined,
    location: send.kind === "LOCATION" ? send.location : undefined,
    forwardedBody: send.kind === "FORWARD" ? send.sourceBody : undefined,
  });
  // A double-press within ten seconds is one send; the same poll a minute later is a new one.
  const bucket = Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS);
  const digest = createHash("sha256").update(JSON.stringify([send.kind, content])).digest("hex").slice(0, 32);
  const where = conversation.kind === "GROUP" ? conversation.groupRowId : `personal:${conversation.accountId}:${conversation.chatId}`;

  try {
    await prisma.outboundMessage.create({
      data: {
        accountId: conversation.accountId,
        chatId: conversation.chatId,
        // The per-client rate limit keys off this, exactly as for a typed reply.
        toPhone: conversation.chatId,
        body,
        contentType: send.kind,
        content,
        actionType: "MANUAL_REPLY",
        idempotencyKey: `manual-rich:${where}:${bucket}:${digest}`,
        groupId: target.groupRowId,
        groupNameSnapshot: target.name,
        createdById: allowed.userId,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") {
      await logSystemEvent("ERROR", "chat-inbox", "Failed to queue a poll, location, sticker or forward", {
        error: (err as Error).message,
        kind: send.kind,
        accountId: conversation.accountId,
        userId: allowed.userId,
      });
      return { error: `That could not be queued because of a server error, and nothing was sent. Try again — if it keeps failing, check System Logs.` };
    }
  }
  await logSystemEvent("INFO", "chat-inbox", `Queued a ${send.kind.toLowerCase()} to ${target.name}`, {
    kind: send.kind,
    accountId: conversation.accountId,
    userId: allowed.userId,
  });
  revalidatePath(await projectPath("/chat"), "layout");
  return { sentAt: Date.now() };
}

/** A poll, to a group. Validated here and again by the worker before it is sent. */
export async function sendChatPoll(ref: ConversationRef, input: { name: unknown; options: unknown; allowMultiple: unknown }): Promise<RichActionResult> {
  const poll = validatePoll(input);
  if (!poll.ok) return { error: poll.error };
  return queueRichSend(ref, { kind: "POLL", poll: poll.value });
}

export async function sendChatLocation(ref: ConversationRef, input: { latitude: unknown; longitude: unknown; name: unknown }): Promise<RichActionResult> {
  const location = validateLocation(input);
  if (!location.ok) return { error: location.error };
  return queueRichSend(ref, { kind: "LOCATION", location: location.value });
}

/** A sticker already stored in this project's media storage, sent as it is. */
export async function sendChatSticker(ref: ConversationRef, mediaId: unknown): Promise<RichActionResult> {
  if (typeof mediaId !== "string" || mediaId.length > 64) return { error: "Choose a sticker." };
  // The scoped client: another project's file is "not found".
  const media = await prisma.messageMedia.findUnique({ where: { id: mediaId }, select: { mediaType: true, mimeType: true, status: true, sizeBytes: true } });
  if (!media || !isSendableSticker(media)) return { error: "That sticker is no longer stored, so it cannot be sent." };
  return queueRichSend(ref, { kind: "STICKER", mediaId });
}

/**
 * Forwards one stored message to another conversation of the SAME account. The source must be a
 * message of that account (WhatsApp forwards from the session that holds it), not deleted for
 * everyone; the target is checked like any send — one target per press, never a broadcast.
 */
export async function forwardChatMessage(messageId: unknown, target: ConversationRef): Promise<RichActionResult> {
  const allowed = await gate("messages.reply");
  if ("error" in allowed) return { error: allowed.error };
  if (typeof messageId !== "string" || messageId.length > 64) return { error: "That message could not be found." };
  const source = await prisma.message.findUnique({ where: { id: messageId }, select: { accountId: true, revokedAt: true, body: true, chatId: true } });
  const refusal = forwardRefusal(source, target?.accountId);
  if (refusal) return { error: refusal };
  const conversation = await resolveConversation(target);
  if (conversation && conversation.chatId === source!.chatId) return { error: "That message is already in this conversation." };
  return queueRichSend(target, { kind: "FORWARD", sourceMessageId: messageId, sourceBody: source!.body });
}

/** Stars or unstars a stored message on WhatsApp. The thread shows the star once the worker confirmed it. */
export async function starChatMessage(messageId: unknown, star: unknown): Promise<RichActionResult> {
  const allowed = await gate("messages.reply");
  if ("error" in allowed) return { error: allowed.error };
  if (typeof messageId !== "string" || messageId.length > 64 || typeof star !== "boolean") return { error: "That message could not be found." };
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, accountId: true, whatsappMessageId: true, account: { select: { label: true, status: true } } },
  });
  if (!message) return { error: "That message could not be found." };
  if (message.account.status !== "CONNECTED") return { error: `${message.account.label} is ${message.account.status.toLowerCase()}, so nothing was changed.` };
  const inFlight = await prisma.workerCommand.findFirst({
    where: { type: "STAR_MESSAGE", accountId: message.accountId, status: { in: ["PENDING", "PROCESSING"] }, payload: { path: ["messageId"], equals: message.id } },
    select: { id: true, payload: true },
  });
  if (inFlight && (inFlight.payload as { star?: unknown } | null)?.star === star) return { commandId: inFlight.id };
  const command = await prisma.workerCommand.create({
    data: { type: "STAR_MESSAGE", accountId: message.accountId, payload: { messageId: message.id, whatsappMessageId: message.whatsappMessageId, star } },
    select: { id: true },
  });
  return { commandId: command.id };
}

/**
 * Pins / archives this conversation ON THE WHATSAPP PHONE. Separate from the inbox's own pin and
 * archive, which only arrange this shared inbox; neither ever changes monitoring or AI.
 */
export async function setWhatsAppChatState(ref: ConversationRef, change: { pin?: unknown; archive?: unknown }): Promise<RichActionResult> {
  const allowed = await gate("messages.reply");
  if ("error" in allowed) return { error: allowed.error };
  const conversation = await resolveConversation(ref);
  if (!conversation) return { error: NOT_FOUND };
  const pin = typeof change?.pin === "boolean" ? change.pin : null;
  const archive = typeof change?.archive === "boolean" ? change.archive : null;
  if ((pin === null) === (archive === null)) return { error: "Choose pin or archive." };
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: conversation.accountId }, select: { label: true, status: true } });
  if (!account || account.status !== "CONNECTED") return { error: `${account?.label ?? "This account"} is not connected, so nothing was changed.` };
  const type = pin !== null ? "PIN_CHAT" : "ARCHIVE_CHAT";
  const payload = pin !== null ? { chatId: conversation.chatId, pin } : { chatId: conversation.chatId, archive: archive! };
  const command = await prisma.workerCommand.create({ data: { type, accountId: conversation.accountId, payload }, select: { id: true } });
  await logSystemEvent("INFO", "chat-inbox", `Asked WhatsApp to ${pin !== null ? (pin ? "pin" : "unpin") : archive ? "archive" : "unarchive"} a chat on the phone`, {
    accountId: conversation.accountId,
    userId: allowed.userId,
  });
  return { commandId: command.id };
}

/**
 * Asks WhatsApp for one more page of this conversation's earlier messages. What arrives is stored for
 * reading only (§4). A second press while one is running joins it.
 */
export async function loadEarlierFromWhatsApp(ref: ConversationRef): Promise<RichActionResult> {
  const allowed = await gate("messages.view");
  if ("error" in allowed) return { error: allowed.error };
  const conversation = await resolveConversation(ref);
  if (!conversation) return { error: NOT_FOUND };
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: conversation.accountId }, select: { label: true, status: true } });
  if (!account || account.status !== "CONNECTED") {
    return { error: `${account?.label ?? "This account"} is not connected, so WhatsApp cannot be asked for earlier messages.` };
  }
  const inFlight = await prisma.workerCommand.findFirst({
    where: { type: "LOAD_EARLIER_MESSAGES", accountId: conversation.accountId, status: { in: ["PENDING", "PROCESSING"] }, payload: { path: ["chatId"], equals: conversation.chatId } },
    select: { id: true },
  });
  if (inFlight) return { commandId: inFlight.id };
  const command = await prisma.workerCommand.create({
    data: { type: "LOAD_EARLIER_MESSAGES", accountId: conversation.accountId, payload: { chatId: conversation.chatId } },
    select: { id: true },
  });
  return { commandId: command.id };
}

const READABLE_COMMANDS = ["LOAD_EARLIER_MESSAGES", "STAR_MESSAGE", "PIN_CHAT", "ARCHIVE_CHAT"] as const;

export interface RichCommandState {
  status: "PENDING" | "PROCESSING" | "DONE" | "FAILED" | "UNKNOWN";
  error?: string;
  /** LOAD_EARLIER_MESSAGES: how many new messages were stored, and whether WhatsApp had no more. */
  stored?: number;
  reachedStart?: boolean;
  /** PIN_CHAT / ARCHIVE_CHAT: false = it already was in that state. */
  changed?: boolean | null;
}

/** The state of one of the commands above. Polled; refuses as "unknown", never a redirect. */
export async function readRichCommand(commandId: unknown): Promise<RichCommandState> {
  const allowed = await gate("messages.view");
  if ("error" in allowed || typeof commandId !== "string" || commandId.length > 64) return { status: "UNKNOWN" };
  const command = await prisma.workerCommand.findUnique({ where: { id: commandId }, select: { type: true, status: true, result: true } });
  if (!command || !(READABLE_COMMANDS as readonly string[]).includes(command.type)) return { status: "UNKNOWN" };
  const result = (command.result ?? {}) as { error?: unknown; stored?: unknown; reachedStart?: unknown; changed?: unknown };
  return {
    status: command.status as RichCommandState["status"],
    error: typeof result.error === "string" ? result.error : undefined,
    stored: typeof result.stored === "number" ? result.stored : undefined,
    reachedStart: typeof result.reachedStart === "boolean" ? result.reachedStart : undefined,
    changed: typeof result.changed === "boolean" ? result.changed : null,
  };
}

export interface StickerChoice {
  mediaId: string;
  animated: boolean;
}

/**
 * Stickers this project already holds — the ones customers and the team have exchanged — newest
 * first, one per distinct file. Only stored WebPs WhatsApp will accept as stickers are offered.
 */
export async function listStickerChoices(): Promise<StickerChoice[]> {
  const allowed = await gate("messages.reply");
  if ("error" in allowed) return [];
  const rows = await prisma.messageMedia.findMany({
    where: { mediaType: "STICKER", status: "STORED", mimeType: "image/webp" },
    orderBy: { createdAt: "desc" },
    take: 400,
    select: { id: true, sha256: true, sizeBytes: true, isAnimated: true, mediaType: true, mimeType: true, status: true },
  });
  const seen = new Set<string>();
  const out: StickerChoice[] = [];
  for (const row of rows) {
    if (!isSendableSticker(row)) continue;
    const key = row.sha256 ?? row.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mediaId: row.id, animated: row.isAnimated });
    if (out.length >= 48) break;
  }
  return out;
}
