/**
 * Group versus personal (1:1) conversations in the WhatsApp Chat inbox. Shared by the server reader
 * (server/chatInbox.ts) and the client list, so both agree on what a key and a type mean.
 *
 * The type is DERIVED, never stored. A group conversation is a `WhatsAppGroup` row. A personal chat
 * is an account's `Message` rows with no group and a chat id in WhatsApp's own individual domains:
 * `@c.us` (a phone number) or `@lid` (WhatsApp's linked-device id for a person whose number is
 * hidden). That suffix is WhatsApp's convention and the one the provider decided `isGroupMsg` from
 * (groups are `@g.us`); the display name is never used. Anything else with no group — the status
 * broadcast (`status@broadcast`), channels (`@newsletter`), broadcast lists — is neither, and is not
 * listed. `PERSONAL_CHAT_SQL` in server/chatInbox.ts is the SQL form of `isPersonalChatId`, and a
 * test pins the two together.
 */

export type ConversationKind = "GROUP" | "PERSONAL";

/** The inbox's type filter. `all` is groups and personal chats together. */
export type ConversationType = "all" | "groups" | "personal";

export const CONVERSATION_TYPES: readonly ConversationType[] = ["all", "groups", "personal"];

/** The URL search parameter carrying the type filter (`?type=groups`). Absent means `all`. */
export const CONVERSATION_TYPE_PARAM = "type";

/** Anything unrecognised is `all`: a pasted or stale link must still open the inbox. */
export function parseConversationType(raw: string | null | undefined): ConversationType {
  return raw === "groups" || raw === "personal" ? raw : "all";
}

export function kindMatchesType(kind: ConversationKind, type: ConversationType): boolean {
  return type === "all" || (type === "groups" ? kind === "GROUP" : kind === "PERSONAL");
}

const PERSONAL_SUFFIXES = ["@c.us", "@lid"] as const;

/** A 1:1 chat id: WhatsApp's individual domains only. */
export function isPersonalChatId(chatId: string): boolean {
  return PERSONAL_SUFFIXES.some((suffix) => chatId.endsWith(suffix) && chatId.length > suffix.length);
}

/**
 * A personal chat's key in the list. A group's key is its `WhatsAppGroup.id` (a cuid); a personal
 * chat has no row, so its key is its chat id behind a prefix no cuid can carry.
 */
const PERSONAL_KEY_PREFIX = "personal:";

export function personalConversationKey(chatId: string): string {
  return `${PERSONAL_KEY_PREFIX}${chatId}`;
}

/** The chat id behind a personal key, or null for a group key (or anything malformed). */
export function personalChatIdFromKey(key: string): string | null {
  if (!key.startsWith(PERSONAL_KEY_PREFIX)) return null;
  const chatId = key.slice(PERSONAL_KEY_PREFIX.length);
  return isPersonalChatId(chatId) ? chatId : null;
}

/** Path of one conversation inside an account's workspace, without the type query. */
export function conversationPath(accountId: string, conversation: { id: string; kind: ConversationKind; chatId: string }): string {
  const base = `/chat/account/${accountId}`;
  return conversation.kind === "PERSONAL" ? `${base}/personal/${encodeURIComponent(conversation.chatId)}` : `${base}/${conversation.id}`;
}

/** `?type=…` for a non-default type, so a refresh or a link keeps the filter; nothing for `all`. */
export function conversationTypeQuery(type: ConversationType): string {
  return type === "all" ? "" : `?${CONVERSATION_TYPE_PARAM}=${type}`;
}

/**
 * What to call a personal chat with no name on record: the number for `@c.us`, and for a `@lid`
 * only the fact that WhatsApp hides the number (its digits are not a phone number, so printing them
 * as one would invite somebody to dial it).
 */
export function personalChatFallbackName(chatId: string): string {
  const [digits] = chatId.split("@");
  if (chatId.endsWith("@c.us")) return `+${digits}`;
  return `Hidden number ···${(digits ?? "").slice(-4)}`;
}
