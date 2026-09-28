/**
 * How many conversations the inbox list renders — see the long note on `getChatConversations` in
 * server/chatInbox.ts. Lives here, not there, because the (client) conversation list needs the
 * number, and server/chatInbox.ts is server-only: it reads the request's project.
 */
export const CONVERSATION_LIST_LIMIT = 300;
