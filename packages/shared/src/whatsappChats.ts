/**
 * Which WhatsApp chats are conversations this product collects, and which of them a gap sweep reads.
 *
 * The kind comes from WhatsApp's own addressing, never from a flag or a display name: `@g.us` is a
 * group, `@c.us` (a phone number) or `@lid` (a person whose number WhatsApp hides) is one person.
 * Anything else — the status broadcast (`status@broadcast`), channels (`@newsletter`), broadcast
 * lists — is neither, and is never read back. The WhatsApp Chat inbox lists personal chats by the same
 * rule (`apps/web/src/lib/chatConversationType.ts` re-exports `isPersonalChatId` from here, and its
 * SQL twin is pinned to it by a test).
 *
 * Gap recovery (Phase 2, PHASE2.md Stage 4) used to read groups only, so a personal message that
 * arrived while the worker was down was lost for good even though the live path stores personal
 * messages. `selectCatchUpChats` is the one decision about which chats a sweep reads.
 */

export type CollectedChatKind = "GROUP" | "PERSONAL";

const PERSONAL_SUFFIXES = ["@c.us", "@lid"] as const;

/** A group chat id: WhatsApp's group domain. */
export function isGroupChatId(chatId: string): boolean {
  return chatId.endsWith("@g.us") && chatId.length > "@g.us".length;
}

/** A 1:1 chat id: WhatsApp's individual domains only. */
export function isPersonalChatId(chatId: string): boolean {
  return PERSONAL_SUFFIXES.some((suffix) => chatId.endsWith(suffix) && chatId.length > suffix.length);
}

/** GROUP, PERSONAL, or null for anything this product does not collect as a conversation. */
export function collectedChatKind(chatId: string): CollectedChatKind | null {
  if (isGroupChatId(chatId)) return "GROUP";
  if (isPersonalChatId(chatId)) return "PERSONAL";
  return null;
}

/** A chat as the browser lists it: its id and its last interaction, in seconds since the epoch. */
export interface ChatActivity {
  id: string;
  t: number | null;
}

export interface CatchUpChat {
  id: string;
  kind: CollectedChatKind;
  t: number;
}

/**
 * The chats a sweep reads for messages newer than `sinceMs`: groups and personal chats touched after
 * it, each once, most recently active first.
 *
 * - A chat with no recorded interaction time cannot be shown to be inside the gap and is not read —
 *   the same rule the group sweep always had.
 * - Status, channels and broadcast lists are never read, whatever their activity.
 * - Most recent first, so when a sweep reaches its message cap the chats it leaves unread are the
 *   ones quiet for longest; the gap is then recorded PARTIAL, never RECOVERED.
 */
export function selectCatchUpChats(chats: readonly ChatActivity[], sinceMs: number): CatchUpChat[] {
  const seen = new Set<string>();
  const selected: CatchUpChat[] = [];
  for (const chat of chats) {
    if (typeof chat.id !== "string" || seen.has(chat.id)) continue;
    const kind = collectedChatKind(chat.id);
    if (!kind) continue;
    if (typeof chat.t !== "number" || !Number.isFinite(chat.t) || chat.t * 1000 <= sinceMs) continue;
    seen.add(chat.id);
    selected.push({ id: chat.id, kind, t: chat.t });
  }
  return selected.sort((a, b) => b.t - a.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
