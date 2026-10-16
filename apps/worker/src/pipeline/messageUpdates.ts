import type { Prisma } from "@prisma/client";
import { ACK_LEVEL, applyAck, isGroupChatId, isPersonalChatId, recordableAckLevel } from "@support-automation/shared";
import { prisma } from "../db.js";
import { withAccountProject } from "../project/context.js";
import { registerMessageMedia } from "../media/registerMessageMedia.js";
import { recordTeamAttendance } from "../teamManagement/attendance.js";
import { isActiveTeamMember } from "./teamFilter.js";
import { isOwnAccountMessage } from "./ownAccounts.js";
import { resolveGroup } from "./processIncomingMessage.js";
import type { RawIncomingMessage } from "./types.js";

/**
 * Chat v2 rich messaging (CHAT_RICH_MESSAGING.md): what happens to a message AFTER it was first seen
 * — a receipt, a deletion — and the store-only path for history loaded on request.
 *
 * Everything here writes facts WhatsApp reported and nothing else: no rule, AI, reply, wait, case,
 * alert or escalation is ever started from this file.
 */

/**
 * The receipt and rich columns a new message row starts with. A message this account sends usually
 * arrives here already at ack 1 (sent); it is recorded at once so the very first tick is a fact rather
 * than an assumption.
 */
export function initialMessageColumns(raw: RawIncomingMessage, now = new Date()): {
  ackLevel?: number;
  deliveredAt?: Date;
  readAt?: Date;
  playedAt?: Date;
  richContent?: Prisma.InputJsonValue;
} {
  const out: ReturnType<typeof initialMessageColumns> = {};
  const level = raw.direction === "OUTGOING" ? recordableAckLevel(raw.ackLevel) : null;
  if (level !== null) {
    const receipt = applyAck({ ackLevel: null, deliveredAt: null, readAt: null, playedAt: null }, level, now);
    if (receipt) {
      out.ackLevel = receipt.ackLevel!;
      if (receipt.deliveredAt) out.deliveredAt = receipt.deliveredAt;
      if (receipt.readAt) out.readAt = receipt.readAt;
      if (receipt.playedAt) out.playedAt = receipt.playedAt;
    }
  }
  if (raw.richContent) out.richContent = raw.richContent as unknown as Prisma.InputJsonValue;
  return out;
}

/**
 * A delivery / read receipt for a message this account sent. The level only ever rises and each time
 * is written once — `applyAck`'s rule, applied as conditional updates so two acks racing can neither
 * lower the level nor overwrite a time already recorded. A receipt for a message we have not stored
 * (yet, or ever) changes nothing; the stored row starts from the level its echo carried.
 *
 * Returns whether the level rose. Never throws: a receipt is a nicety, and nothing may reach the
 * library's emitter.
 */
export async function recordMessageAck(accountId: string, whatsappMessageId: string, ackLevel: number, now = new Date()): Promise<boolean> {
  const level = recordableAckLevel(ackLevel);
  if (level === null) return false;
  try {
    return await withAccountProject(accountId, async () => {
      // OUTGOING only: a message another of our numbers sent arrives here as INCOMING-turned-OUTGOING
      // with no receipt of its own, and an incoming row's "ack" is this account reading it.
      const base = { accountId, whatsappMessageId, direction: "OUTGOING" as const };
      const raised = await prisma.message.updateMany({
        where: { ...base, OR: [{ ackLevel: null }, { ackLevel: { lt: level } }] },
        data: { ackLevel: level },
      });
      if (raised.count === 0) return false;
      if (level >= ACK_LEVEL.DELIVERED) await prisma.message.updateMany({ where: { ...base, deliveredAt: null }, data: { deliveredAt: now } });
      if (level >= ACK_LEVEL.READ) await prisma.message.updateMany({ where: { ...base, readAt: null }, data: { readAt: now } });
      if (level >= ACK_LEVEL.PLAYED) await prisma.message.updateMany({ where: { ...base, playedAt: null }, data: { playedAt: now } });
      return true;
    });
  } catch (err) {
    console.error(`[receipts] could not record a receipt for ${accountId}:${whatsappMessageId}`, err);
    return false;
  }
}

/**
 * WhatsApp said this message was deleted for everyone. The row and its text are KEPT — what was said
 * stays on record — and only `revokedAt` is set, once. A deletion of a message we never stored has
 * nothing to mark. Never throws.
 */
export async function recordMessageRevoked(accountId: string, whatsappMessageId: string, now = new Date()): Promise<boolean> {
  try {
    return await withAccountProject(accountId, async () => {
      const marked = await prisma.message.updateMany({ where: { accountId, whatsappMessageId, revokedAt: null }, data: { revokedAt: now } });
      return marked.count > 0;
    });
  } catch (err) {
    console.error(`[deleted] could not mark ${accountId}:${whatsappMessageId} as deleted`, err);
    return false;
  }
}

export interface HistoryStoreResult {
  /** Messages the session held for the chat. */
  seen: number;
  /** New rows written. */
  stored: number;
  /** Stored rows newly marked deleted because the session now shows them revoked. */
  markedDeleted: number;
  /** The oldest timestamp the session held, if any. */
  oldestAt: Date | null;
}

/**
 * Stores the messages one "Load earlier from WhatsApp" press brought in (CHAT_RICH_MESSAGING.md §4).
 *
 * STORE-ONLY, deliberately narrower than every other write path. A message loaded on request can be
 * months old; running it through the pipeline would answer it, open a wait or a Support Assignment
 * case that is instantly overdue, fire escalation and mood alerts, and record support activity for a
 * day long gone. So this writes the `Message` row (deduplicated by the same unique key as every path),
 * registers its attachment, and recomputes the sender's attendance for that day (a recompute, so it
 * converges) — and nothing else. `ProcessingCheckpoint` is not touched: it marks live progress, and an
 * old timestamp would move it backwards.
 *
 * Only messages of `chatId` are stored, whatever the session returns, and only for a group or a
 * personal chat.
 */
export async function storeHistoryMessages(accountId: string, chatId: string, messages: RawIncomingMessage[], now = new Date()): Promise<HistoryStoreResult> {
  return withAccountProject(accountId, async () => {
    const result: HistoryStoreResult = { seen: 0, stored: 0, markedDeleted: 0, oldestAt: null };
    if (!isGroupChatId(chatId) && !isPersonalChatId(chatId)) return result;
    const mine = messages.filter((m) => m.accountId === accountId && m.chatId === chatId);
    result.seen = mine.length;
    for (const m of mine) if (!result.oldestAt || m.timestampWa < result.oldestAt) result.oldestAt = m.timestampWa;

    // One query for what is already stored, so a page of fifty mostly-known messages costs no inserts.
    const ids = mine.map((m) => m.whatsappMessageId);
    const known = new Set(
      ids.length
        ? (await prisma.message.findMany({ where: { accountId, whatsappMessageId: { in: ids } }, select: { whatsappMessageId: true } })).map((r) => r.whatsappMessageId)
        : [],
    );

    for (const raw of mine) {
      if (raw.revoked) {
        if (known.has(raw.whatsappMessageId) && (await recordMessageRevoked(accountId, raw.whatsappMessageId, now))) result.markedDeleted++;
        continue;
      }
      if (known.has(raw.whatsappMessageId) || !raw.body?.trim()) continue;
      if (await storeOneHistoryMessage(raw, now)) result.stored++;
    }
    return result;
  });
}

async function storeOneHistoryMessage(raw: RawIncomingMessage, now: Date): Promise<boolean> {
  // The same classification the live path makes, without its side effects: our other number's
  // message is the business's, and a roster member is staff.
  const direction = raw.direction === "INCOMING" && (await isOwnAccountMessage(raw)) ? "OUTGOING" : raw.direction;
  const isFromTeamMember = direction === "INCOMING" ? await isActiveTeamMember(raw.senderPhone, raw.senderJid) : false;
  const group = await resolveGroup(raw);
  const quoted = raw.quotedWhatsappMessageId
    ? await prisma.message.findUnique({
        where: { accountId_whatsappMessageId: { accountId: raw.accountId, whatsappMessageId: raw.quotedWhatsappMessageId } },
        select: { id: true },
      })
    : null;
  let messageId: string;
  try {
    const row = await prisma.message.create({
      data: {
        accountId: raw.accountId,
        groupId: group?.id ?? null,
        whatsappMessageId: raw.whatsappMessageId,
        chatId: raw.chatId,
        senderPhone: raw.senderPhone,
        senderJid: raw.senderJid ?? null,
        senderName: raw.senderName,
        isFromTeamMember,
        direction,
        body: raw.body,
        normalizedBody: raw.body.trim(),
        timestampWa: raw.timestampWa,
        // Never automated, so never PENDING: IGNORED for a customer's, PROCESSED for ours — the same
        // statuses the catch-up path gives a message too old to answer.
        processingStatus: direction === "INCOMING" ? "IGNORED" : "PROCESSED",
        quotedMessageId: quoted?.id ?? null,
        mentionedPhones: raw.mentionedPhones ?? [],
        loadedFromHistoryAt: now,
        ...initialMessageColumns({ ...raw, direction }, now),
      },
      select: { id: true },
    });
    messageId = row.id;
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return false; // stored meanwhile by the live path
    throw err;
  }
  if (raw.media) await registerMessageMedia({ messageId, accountId: raw.accountId, groupId: group?.id ?? null, media: raw.media });
  if (isFromTeamMember) {
    try {
      await recordTeamAttendance({ groupId: group?.id ?? null, isFromTeamMember, senderPhone: raw.senderPhone, senderJid: raw.senderJid ?? null, timestampWa: raw.timestampWa });
    } catch (err) {
      console.error("[history] could not recompute attendance for a loaded message", err);
    }
  }
  return true;
}
