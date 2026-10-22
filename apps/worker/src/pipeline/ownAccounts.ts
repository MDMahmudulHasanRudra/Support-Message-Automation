import { parseMessageKey, parseWhatsAppId, isPersonKind } from "@support-automation/shared";
import { prisma } from "../db.js";
import { currentProjectId } from "../project/context.js";
import type { RawIncomingMessage } from "./types.js";

/**
 * Whether an INCOMING message was in fact sent by another of OUR WhatsApp numbers
 * (WHATSAPP_IDENTITY.md §3).
 *
 * When account A posts in a group account B is also in — an AI reply, a reply typed in WhatsApp
 * Chat, an executive on A's handset — B receives it like anybody else's message. Processed as one,
 * it was a customer's: rules and the AI could answer our own reply (a loop between our numbers,
 * bounded only by cooldowns), an escalation case could open against it, and the inbox showed the
 * group as waiting on itself. The pipeline stores it as the business's own message instead.
 *
 * Three pieces of evidence, each proof on its own:
 *  1. the sender is one of the project's accounts' phone numbers;
 *  2. the sender id is one our accounts have SENT from IN A GROUP — there the sender of an outgoing
 *     row is its author, the id WhatsApp shows for our number (usually its LID, which no other
 *     field records). Group rows only, on purpose: a one-to-one row's sender comes from `from`,
 *     and learning "ours" from anything less than certain would turn a customer into us, and
 *     every message they sent into one nobody answers. A group's own id is never learned;
 *  3. one of our outbound rows in this chat carries the same WhatsApp key — covers the very first
 *     message from a number whose own echo has not been stored yet.
 *
 * (1) and (2) are cached per project for five minutes, and (2) also learns from every outgoing
 * message the moment it is stored (`rememberOwnSender`), so a fresh id is known without waiting.
 */

const CACHE_MS = 5 * 60_000;
/** A send's outbound row is matched only if it was created this recently (bounds the lookup). */
const RECENT_SEND_MS = 15 * 60_000;

interface OwnIds {
  ids: Set<string>;
  loadedAt: number;
}
const cache = new Map<string, OwnIds>();

async function ownIds(projectId: string): Promise<Set<string>> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.loadedAt < CACHE_MS) return hit.ids;
  const [accounts, sent] = await Promise.all([
    prisma.whatsAppAccount.findMany({ select: { phoneNumber: true } }),
    prisma.$queryRaw<Array<{ sender: string }>>`
      SELECT DISTINCT m."senderPhone" AS sender FROM "Message" m
      WHERE m."projectId" = ${projectId} AND m."direction" = 'OUTGOING'
        AND m."chatId" LIKE '%@g.us' AND m."senderPhone" <> split_part(m."chatId", '@', 1)`,
  ]);
  const ids = new Set(sent.map((row) => row.sender).filter(Boolean));
  for (const account of accounts) {
    const digits = account.phoneNumber?.replace(/\D/g, "");
    if (digits) ids.add(digits);
  }
  // Ids learned since the last load are kept: they are proven, and a reload must not forget them.
  for (const id of hit?.ids ?? []) ids.add(id);
  cache.set(projectId, { ids, loadedAt: Date.now() });
  return ids;
}

/** Records the id one of our accounts just sent from in a group (see evidence 2 above). */
export function rememberOwnSender(projectId: string, raw: Pick<RawIncomingMessage, "chatId" | "senderPhone">): void {
  const chat = parseWhatsAppId(raw.chatId);
  if (!raw.senderPhone || chat?.kind !== "GROUP" || raw.senderPhone === chat.user) return;
  const hit = cache.get(projectId);
  if (hit) hit.ids.add(raw.senderPhone);
}

export async function isOwnAccountMessage(raw: RawIncomingMessage): Promise<boolean> {
  const sender = parseWhatsAppId(raw.senderJid) ?? parseWhatsAppId(raw.senderPhone);
  if (!sender || !isPersonKind(sender.kind)) return false;
  const projectId = currentProjectId();

  if ((await ownIds(projectId)).has(sender.user)) return true;

  const key = parseMessageKey(raw.whatsappMessageId);
  if (!key) return false;
  const sent = await prisma.outboundMessage.findFirst({
    where: {
      chatId: raw.chatId,
      accountId: { not: raw.accountId },
      // From the message's own time: a message recovered after a restart is older than the window
      // measured from now, and the send it echoes was made around when it was written.
      createdAt: { gte: new Date(Math.min(Date.now(), raw.timestampWa.getTime()) - RECENT_SEND_MS) },
      providerMessageId: { startsWith: `true_${raw.chatId}_${key.keyId}` },
    },
    select: { id: true },
  });
  return Boolean(sent);
}

/** Test-only: forget every cached id. */
export function resetOwnAccountCacheForTests(): void {
  cache.clear();
}
