/**
 * How many conversations the inbox list renders — see the long note on `getChatConversations` in
 * server/chatInbox.ts. Lives here, not there, because the (client) conversation list needs the
 * number, and server/chatInbox.ts is server-only: it reads the request's project.
 */
export const CONVERSATION_LIST_LIMIT = 300;

/**
 * How many of an account's most recent PERSONAL chats are always in the "All" list, on top of the
 * ranked 300. On a number in hundreds of busy groups the 300th most recent group can be minutes old,
 * so without this a customer's personal message from half an hour ago was not in the list at all —
 * stored, counted on the Personal chip, and invisible where the operator was looking (18 Oct 2026).
 * They take their place by recency, so the list stays one ordering; this only stops the cap from
 * cutting them off.
 */
export const PERSONAL_CHATS_ALWAYS_LISTED = 100;
