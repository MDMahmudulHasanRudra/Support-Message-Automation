import { prisma } from "@/server/db";
import { activeDisabledFeatures } from "@/server/projectFeatures";
import {
  createSenderResolver,
  decodeThreadCursor,
  describeSenderId,
  encodeThreadCursor,
  hasReachablePhoneNumber,
  mentionJidForDigits,
  normalizePhoneNumber,
  phoneJidDigits,
  summariseOwnReactions,
  type MentionCandidate,
  type ThreadPosition,
} from "@support-automation/shared";
import { isPersonalChatId } from "@/lib/chatConversationType";
import { buildThreadEntries, THREAD_MESSAGE_SELECT, type ThreadEntry } from "@/server/chatInbox";

/**
 * WhatsApp Chat v2 reads (CHAT_UI_V2.md). Plain async helpers, called from Server Components and from
 * the actions in server/actions/chatThread.ts — never trusted with a scope from the browser.
 *
 * A conversation is always re-derived here from what the request names: an account of THIS project
 * (the scoped client) and either that account's own copy of a group or one of its personal chats. A
 * cursor, a message id or a search term only ever narrows WITHIN that conversation, so an id from
 * another project, account or chat reaches nothing.
 */

export async function isChatUiV2Enabled(): Promise<boolean> {
  return !(await activeDisabledFeatures()).has("CHAT_UI_V2");
}

/** What the browser names. Nothing in it is trusted until `resolveConversation` has re-derived it. */
export interface ConversationRef {
  accountId: string;
  /** A group conversation: that account's `WhatsAppGroup.id`. */
  groupId?: string | null;
  /** A personal conversation: the chat id (`…@c.us` / `…@lid`). */
  personalChatId?: string | null;
}

export type ResolvedConversation =
  | { kind: "GROUP"; accountId: string; groupRowId: string; chatId: string }
  | { kind: "PERSONAL"; accountId: string; chatId: string };

export async function resolveConversation(ref: ConversationRef): Promise<ResolvedConversation | null> {
  if (!ref || typeof ref.accountId !== "string" || ref.accountId.length > 64) return null;
  if (ref.groupId) {
    if (typeof ref.groupId !== "string" || ref.groupId.length > 64) return null;
    const group = await prisma.whatsAppGroup.findUnique({ where: { id: ref.groupId }, select: { id: true, accountId: true, whatsappGroupId: true } });
    if (!group || group.accountId !== ref.accountId) return null;
    return { kind: "GROUP", accountId: group.accountId, groupRowId: group.id, chatId: group.whatsappGroupId };
  }
  if (ref.personalChatId) {
    if (typeof ref.personalChatId !== "string" || !isPersonalChatId(ref.personalChatId)) return null;
    const account = await prisma.whatsAppAccount.findUnique({ where: { id: ref.accountId }, select: { id: true } });
    if (!account) return null;
    return { kind: "PERSONAL", accountId: account.id, chatId: ref.personalChatId };
  }
  return null;
}

/** The stored messages of exactly this conversation. */
function messageWhere(conversation: ResolvedConversation) {
  return conversation.kind === "GROUP"
    ? { groupId: conversation.groupRowId }
    : { accountId: conversation.accountId, chatId: conversation.chatId, groupId: null };
}

/** Strictly older than a position in `(timestampWa, id)` order. */
function olderThan(position: ThreadPosition) {
  const at = new Date(position.at);
  return { OR: [{ timestampWa: { lt: at } }, { timestampWa: at, id: { lt: position.id } }] };
}

export const OLDER_PAGE_SIZE = 60;
/** How far a jump (to a quote or a search hit) may page back in one go. Further than this is refused. */
export const MAX_JUMP_MESSAGES = 600;

export interface OlderPage {
  entries: ThreadEntry[];
  /** Roster names for the `@digits` already in these entries' text (`mentionNamesFor`). */
  mentionNames: Record<string, string>;
  hasMore: boolean;
  /** The cursor for the page before this one, or null when nothing older exists. */
  cursor: string | null;
}

export type OlderPageResult = OlderPage | { error: string };

/**
 * One page of stored messages older than `cursor`, oldest first. With `untilMessageId`, every message
 * from that one up to the cursor (plus a few older for context) — what jumping to a quote or a search
 * hit needs — bounded by MAX_JUMP_MESSAGES.
 */
export async function loadOlderEntries(conversation: ResolvedConversation, rawCursor: unknown, untilMessageId?: string | null): Promise<OlderPageResult> {
  const cursor = decodeThreadCursor(rawCursor);
  if (!cursor) return { error: "That position in the conversation is not valid. Reload the conversation." };
  const base = messageWhere(conversation);

  let take = OLDER_PAGE_SIZE;
  if (untilMessageId) {
    if (typeof untilMessageId !== "string" || untilMessageId.length > 64) return { error: "That message could not be found in this conversation." };
    const target = await prisma.message.findFirst({ where: { ...base, id: untilMessageId }, select: { id: true, timestampWa: true } });
    if (!target) return { error: "That message is not in this conversation." };
    const between = await prisma.message.count({
      where: { AND: [base, olderThan(cursor), { OR: [{ timestampWa: { gt: target.timestampWa } }, { timestampWa: target.timestampWa, id: { gte: target.id } }] }] },
    });
    if (between > MAX_JUMP_MESSAGES) {
      return { error: `That message is more than ${MAX_JUMP_MESSAGES} messages back. Scroll up to load it a page at a time, or find it under All Messages.` };
    }
    take = Math.max(between + 10, OLDER_PAGE_SIZE);
  }

  const rows = await prisma.message.findMany({
    where: { AND: [base, olderThan(cursor)] },
    orderBy: [{ timestampWa: "desc" }, { id: "desc" }],
    take: take + 1,
    select: THREAD_MESSAGE_SELECT,
  });
  const hasMore = rows.length > take;
  const page = (hasMore ? rows.slice(0, take) : rows).reverse();
  const entries = await buildThreadEntries(conversation.accountId, page, [], conversation.kind === "GROUP" ? conversation.chatId : null);
  const oldest = page[0];
  return {
    entries: await attachOwnReactions(conversation.accountId, entries),
    mentionNames: await mentionNamesFor(entries),
    hasMore,
    cursor: hasMore && oldest ? encodeThreadCursor({ at: oldest.timestampWa.getTime(), id: oldest.id }) : null,
  };
}

/** The cursor that pages back from a window of entries (its oldest STORED message). */
export function cursorBefore(entries: readonly ThreadEntry[]): string | null {
  const stored = entries.filter((e) => e.kind !== "QUEUED");
  let oldest: ThreadEntry | undefined;
  for (const e of stored) {
    if (!oldest || e.at.getTime() < oldest.at.getTime() || (e.at.getTime() === oldest.at.getTime() && e.id < oldest.id)) oldest = e;
  }
  return oldest ? encodeThreadCursor({ at: oldest.at.getTime(), id: oldest.id }) : null;
}

/**
 * This account's own reactions on the given stored messages, as the worker settled them. Bounded by
 * the ids asked about (a thread window or a page) and by this account.
 */
export async function attachOwnReactions(accountId: string, entries: ThreadEntry[]): Promise<ThreadEntry[]> {
  const ids = entries.filter((e) => e.kind === "INCOMING" || e.kind === "OUTGOING").map((e) => e.id);
  if (ids.length === 0) return entries;
  const commands = await prisma.workerCommand.findMany({
    where: { type: "REACT_TO_MESSAGE", accountId, OR: ids.map((id) => ({ payload: { path: ["messageId"], equals: id } })) },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { status: true, payload: true, result: true, createdAt: true },
  });
  if (commands.length === 0) return entries;
  const states = summariseOwnReactions(
    commands.flatMap((c) => {
      const payload = c.payload as { messageId?: unknown; emoji?: unknown; requestedById?: unknown } | null;
      if (typeof payload?.messageId !== "string" || typeof payload.emoji !== "string") return [];
      const result = c.result as { error?: unknown } | null;
      return [
        {
          messageId: payload.messageId,
          emoji: payload.emoji,
          status: c.status,
          createdAt: c.createdAt,
          error: typeof result?.error === "string" ? result.error : null,
          requestedById: typeof payload.requestedById === "string" ? payload.requestedById : null,
        },
      ];
    }),
  );
  return entries.map((e) => (states.has(e.id) ? { ...e, ownReaction: states.get(e.id)! } : e));
}

export interface ThreadSearchHit {
  id: string;
  at: Date;
  outgoing: boolean;
  /** The text around the match, at most ~160 characters. */
  snippet: string;
}

/** Stored messages of this conversation containing `term`, newest first, at most 30. */
export async function searchConversationMessages(conversation: ResolvedConversation, term: string): Promise<ThreadSearchHit[]> {
  const q = term.trim();
  if (q.length < 2 || q.length > 100) return [];
  const rows = await prisma.message.findMany({
    where: { ...messageWhere(conversation), body: { contains: q, mode: "insensitive" } },
    orderBy: [{ timestampWa: "desc" }, { id: "desc" }],
    take: 30,
    select: { id: true, timestampWa: true, direction: true, body: true },
  });
  return rows.map((row) => {
    const index = row.body.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, index - 60);
    const snippet = `${start > 0 ? "…" : ""}${row.body.slice(start, start + 160)}${start + 160 < row.body.length ? "…" : ""}`;
    return { id: row.id, at: row.timestampWa, outgoing: row.direction === "OUTGOING", snippet };
  });
}

/**
 * Who may be tagged in this group (chatMentions.ts): phone-number ids that wrote in THIS account's
 * copy of the group, and roster members who wrote here and have a number a person typed. Bounded:
 * the most recent 300 distinct senders. A LID is counted, never offered.
 */
export async function mentionCandidatesFor(conversation: ResolvedConversation): Promise<{ candidates: MentionCandidate[]; unmentionable: number }> {
  if (conversation.kind !== "GROUP") return { candidates: [], unmentionable: 0 };
  const [grouped, roster] = await Promise.all([
    // One row per (sender, name they used), newest first; reduced below to the newest name per sender.
    prisma.message.groupBy({
      by: ["senderPhone", "senderJid", "senderName"],
      where: { groupId: conversation.groupRowId, direction: "INCOMING" },
      _max: { timestampWa: true },
      orderBy: { _max: { timestampWa: "desc" } },
      take: 600,
    }),
    prisma.internalTeamMember.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true, phoneNumber: true, whatsappId: true } }),
  ]);
  const senders: Array<{ senderPhone: string; senderJid: string | null; senderName: string | null }> = [];
  const seen = new Set<string>();
  for (const row of grouped) {
    const key = `${row.senderPhone}\u0000${row.senderJid ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    senders.push(row);
    if (senders.length >= 300) break;
  }
  const resolver = createSenderResolver(roster);
  const memberById = new Map(roster.map((m) => [m.id, m]));

  const byJid = new Map<string, MentionCandidate>();
  let unmentionable = 0;
  for (const sender of senders) {
    const resolution = resolver.resolve(sender.senderPhone, sender.senderJid);
    const member = resolution.memberId ? memberById.get(resolution.memberId) : undefined;
    // A roster member: their typed number, when it is a real one.
    if (member && hasReachablePhoneNumber(member)) {
      const digits = normalizePhoneNumber(member.phoneNumber);
      if (digits) {
        const jid = mentionJidForDigits(digits);
        if (!byJid.has(jid)) byJid.set(jid, { jid, label: member.name, source: "TEAM_MEMBER" });
        continue;
      }
    }
    // Anyone else: only when WhatsApp itself delivered a phone-number id.
    const digits = phoneJidDigits(sender.senderJid);
    if (!digits) {
      unmentionable += 1;
      continue;
    }
    const jid = mentionJidForDigits(digits);
    if (byJid.has(jid)) continue;
    const name = sender.senderName?.trim();
    byJid.set(jid, { jid, label: name || describeSenderId(sender.senderPhone, sender.senderJid).phone || `+${digits}`, source: "SENDER" });
  }
  return { candidates: [...byJid.values()], unmentionable };
}

/**
 * Roster names for the `@digits` mentions that already appear in these entries' text — what the v2
 * view shows as "@Name". Only digits present in a message the viewer can already read are looked up,
 * so this never hands the browser a list of staff numbers. The digits resolve through the one identity
 * rule (WHATSAPP_IDENTITY.md); an unresolved, conflicting or ambiguous one gets no name and the text
 * stays exactly as WhatsApp delivered it.
 */
export async function mentionNamesFor(entries: readonly ThreadEntry[]): Promise<Record<string, string>> {
  const digits = new Set<string>();
  for (const entry of entries) for (const match of entry.body.matchAll(/@(\d{5,20})(?!\d)/g)) digits.add(match[1]!);
  if (digits.size === 0) return {};
  const roster = await prisma.internalTeamMember.findMany({ select: { id: true, name: true, phoneNumber: true, whatsappId: true } });
  const resolver = createSenderResolver(roster);
  const names = new Map(roster.map((m) => [m.id, m.name]));
  const out: Record<string, string> = {};
  for (const d of [...digits].slice(0, 200)) {
    const memberId = resolver.resolve(d, null).memberId;
    if (memberId && names.has(memberId)) out[d] = names.get(memberId)!;
  }
  return out;
}
