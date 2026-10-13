/**
 * Client ⇄ WhatsApp chat links (CLIENT_CENTER_PLAN.md §3.4): the pure rules. Nothing here touches a
 * database or sends anything.
 *
 * A link is a person's statement that a one-to-one chat on an account IS a client. It is never made
 * automatically, never from a number match and never in bulk: a number that equals a client's
 * WhatsApp number is only ever a SUGGESTION the admin may confirm.
 */

const PERSONAL_SUFFIXES = ["@c.us", "@lid"] as const;

/** A one-to-one chat id in WhatsApp's own individual domains. Never a group (`@g.us`) or a broadcast. */
export function isLinkableChatId(chatId: string): boolean {
  return PERSONAL_SUFFIXES.some((suffix) => chatId.endsWith(suffix) && chatId.length > suffix.length);
}

/**
 * The phone digits a chat id carries: only `@c.us` carries a number. `@lid` is WhatsApp's opaque id
 * for a person whose number is hidden — its digits are NOT a phone number, so it yields null and is
 * never suggested (an admin can still link one deliberately).
 */
export function chatNumberDigits(chatId: string): string | null {
  if (!chatId.endsWith("@c.us")) return null;
  const digits = chatId.slice(0, -"@c.us".length);
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

export interface LinkableChat {
  chatId: string;
}

/**
 * The chats whose number equals one of the client's WhatsApp numbers (already normalised to digits),
 * returned as a Set of chat ids. A suggestion only: showing one links nothing.
 */
export function suggestedChatIds(clientWhatsAppNumbers: readonly string[], chats: readonly LinkableChat[]): Set<string> {
  const wanted = new Set(clientWhatsAppNumbers.filter((n) => n.length > 0));
  const out = new Set<string>();
  for (const chat of chats) {
    const digits = chatNumberDigits(chat.chatId);
    if (digits && wanted.has(digits)) out.add(chat.chatId);
  }
  return out;
}

/** Why a link request was refused, in a sentence for the person who pressed the button. */
export const CHAT_LINK_REFUSALS = {
  notPersonal: "Only an individual WhatsApp chat can be linked, not a group.",
  noChat: "That account has no stored conversation with this chat. Link a chat the account already has.",
  alreadyLinked: "That chat is already linked to another client. Remove that link first.",
  alreadyLinkedHere: "That chat is already linked to this client.",
  noAccount: "That WhatsApp account is not one of this project's accounts.",
} as const;
