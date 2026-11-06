/**
 * Unified Inbox V3 — conversation lifecycle (feature UNIFIED_INBOX_V3, off by default). One set of rules
 * for WhatsApp conversations (`WhatsAppConversationState`) and channel conversations
 * (`ChannelConversation.status`), used by the dashboard's actions, the worker's inbound hook and its snooze
 * loop, so the three can never disagree. Pure.
 *
 *   OPEN      the team owes the customer something. Where every conversation starts, and where it returns.
 *   PENDING   the team has done its part and waits on the customer. Their next message makes it OPEN, always.
 *   SNOOZED   put aside until `snoozedUntil`; it becomes OPEN then, or earlier on a customer message when
 *             the project's policy says so (default yes).
 *   RESOLVED  done. A customer message reopens it when the policy says so (default yes); otherwise it stays
 *             resolved and the message is still stored and shown as usual.
 *
 * Channel conversations store RESOLVED as their existing CLOSED value, so every existing close / reopen path
 * keeps working unchanged (`channelStatusOf` / `channelStorageOf`).
 */

export const CONVERSATION_STATUSES = ["OPEN", "PENDING", "SNOOZED", "RESOLVED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  OPEN: "Open",
  PENDING: "Pending",
  SNOOZED: "Snoozed",
  RESOLVED: "Resolved",
};

export function isConversationStatus(value: unknown): value is ConversationStatus {
  return typeof value === "string" && (CONVERSATION_STATUSES as readonly string[]).includes(value);
}

/** A snooze is at least a minute and at most this many days ahead. */
export const SNOOZE_MAX_DAYS = 90;
const SNOOZE_MIN_MS = 60_000;

/** How the worker and the dashboard map a channel conversation's stored status (CLOSED = RESOLVED). */
export type ChannelStoredStatus = "OPEN" | "CLOSED" | "PENDING" | "SNOOZED";
export function channelStatusOf(stored: ChannelStoredStatus): ConversationStatus {
  return stored === "CLOSED" ? "RESOLVED" : stored;
}
export function channelStorageOf(status: ConversationStatus): ChannelStoredStatus {
  return status === "RESOLVED" ? "CLOSED" : status;
}

export interface LifecyclePolicy {
  reopenResolvedOnCustomerMessage: boolean;
  reopenSnoozedOnCustomerMessage: boolean;
}
export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = { reopenResolvedOnCustomerMessage: true, reopenSnoozedOnCustomerMessage: true };

/** What a person asked for. */
export type LifecycleRequest = { to: "OPEN" } | { to: "PENDING" } | { to: "RESOLVED" } | { to: "SNOOZED"; until: Date };

export type TransitionDecision =
  | { ok: true; to: ConversationStatus; snoozedUntil: Date | null; event: "REOPEN" | "PENDING" | "RESOLVE" | "SNOOZE" | "UNSNOOZE" }
  | { ok: false; reason: string };

/**
 * Whether a person may move a conversation from `from` as requested, and to what. Re-snoozing a snoozed
 * conversation to a new time is allowed; asking for the state it is already in is refused (nothing changes).
 */
export function decideTransition(from: ConversationStatus, request: LifecycleRequest, now: Date): TransitionDecision {
  if (request.to === "SNOOZED") {
    const until = request.until;
    if (!(until instanceof Date) || Number.isNaN(until.getTime())) return { ok: false, reason: "Choose when the snooze should end." };
    if (until.getTime() - now.getTime() < SNOOZE_MIN_MS) return { ok: false, reason: "A snooze must end at least a minute from now." };
    if (until.getTime() - now.getTime() > SNOOZE_MAX_DAYS * 86_400_000) return { ok: false, reason: `A snooze can last at most ${SNOOZE_MAX_DAYS} days.` };
    if (from === "RESOLVED") return { ok: false, reason: "A resolved conversation cannot be snoozed. Reopen it first." };
    return { ok: true, to: "SNOOZED", snoozedUntil: until, event: "SNOOZE" };
  }
  if (request.to === from) return { ok: false, reason: `It is already ${CONVERSATION_STATUS_LABELS[from].toLowerCase()}.` };
  if (request.to === "OPEN") return { ok: true, to: "OPEN", snoozedUntil: null, event: from === "SNOOZED" ? "UNSNOOZE" : "REOPEN" };
  if (request.to === "PENDING") {
    if (from === "RESOLVED") return { ok: false, reason: "A resolved conversation cannot be marked pending. Reopen it first." };
    return { ok: true, to: "PENDING", snoozedUntil: null, event: "PENDING" };
  }
  return { ok: true, to: "RESOLVED", snoozedUntil: null, event: "RESOLVE" };
}

/**
 * A customer's new message: the status it moves the conversation to, or null to leave it. A message from the
 * team (or from our own number) never changes the lifecycle — the team marks pending or resolved itself.
 */
export function statusAfterCustomerMessage(from: ConversationStatus, policy: LifecyclePolicy): ConversationStatus | null {
  if (from === "PENDING") return "OPEN";
  if (from === "SNOOZED") return policy.reopenSnoozedOnCustomerMessage ? "OPEN" : null;
  if (from === "RESOLVED") return policy.reopenResolvedOnCustomerMessage ? "OPEN" : null;
  return null;
}

/** A snooze whose time has come. */
export function snoozeHasEnded(status: ConversationStatus, snoozedUntil: Date | null, now: Date): boolean {
  return status === "SNOOZED" && snoozedUntil !== null && snoozedUntil.getTime() <= now.getTime();
}

/** The kinds of `ConversationEvent` the lifecycle writes (the older STATUS / ASSIGNEE / TEAM kinds stay). */
export const LIFECYCLE_EVENT_KINDS = ["REOPEN", "PENDING", "RESOLVE", "SNOOZE", "UNSNOOZE", "ASSIGNEE", "TEAM", "PRIORITY", "TAGS"] as const;
export type LifecycleEventKind = (typeof LIFECYCLE_EVENT_KINDS)[number];

/** Why the system (not a person) changed a status — kept in the event's context, never message text. */
export type LifecycleSystemReason = "CUSTOMER_MESSAGE" | "SNOOZE_ENDED";

/** WhatsApp conversation type, derived from the chat id (WhatsApp's own domains), never from a name. */
export function whatsAppConversationType(chatId: string): "GROUP" | "PERSONAL" | null {
  if (chatId.endsWith("@g.us")) return "GROUP";
  if (chatId.endsWith("@c.us") || chatId.endsWith("@lid")) return "PERSONAL";
  return null;
}

/** Inbox V3 agent presence (V3-05): one key per conversation, the same in every reader and writer. */
export function presenceKey(ref: { kind: "whatsapp"; accountId: string; chatId: string } | { kind: "channel"; conversationId: string }): string {
  return ref.kind === "whatsapp" ? `wa:${ref.accountId}:${ref.chatId}` : `ch:${ref.conversationId}`;
}
/** Someone counts as viewing for this long after their last heartbeat, and as typing for this long after a keystroke. */
export const PRESENCE_VIEWING_MS = 30_000;
export const PRESENCE_TYPING_MS = 8_000;
/** How often an open conversation sends its heartbeat. Well inside the viewing window, so a live viewer never flickers. */
export const PRESENCE_HEARTBEAT_MS = 10_000;
