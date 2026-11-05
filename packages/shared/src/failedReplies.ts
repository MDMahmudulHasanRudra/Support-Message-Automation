/**
 * Failed customer replies (FAILED_REPLIES.md): the rules the list, the retry and the close actions
 * share. Pure, so the page, the server actions and the tests read one definition.
 *
 * A "customer reply" is a send that answers a customer: a WhatsApp AUTO_REPLY (a rule or the AI) or
 * MANUAL_REPLY (a person in WhatsApp Chat), or an outbound reply on Messenger / Instagram / Telegram /
 * website chat. Broadcasts and internal alerts have their own failure views and are not here.
 *
 * Delivery uncertainty is the rule everything else respects: a send whose call into the provider began
 * and never answered may have reached the customer. Nothing retries such a row by itself; a person
 * retries it only after confirming they checked, and never when the chat already shows the message.
 */

export type FailedReplySource = "WHATSAPP" | "CHANNEL";
export type FailedReplyState = "FAILED" | "RETRYING" | "RESOLVED" | "CLOSED";
export type FailedReplyResolution = "RESOLVED" | "CLOSED";

export const FAILED_REPLY_STATES: readonly FailedReplyState[] = ["FAILED", "RETRYING", "RESOLVED", "CLOSED"];
export const FAILED_REPLY_STATE_LABELS: Record<FailedReplyState, string> = {
  FAILED: "Failed",
  RETRYING: "Retrying",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/** A person may retry one reply this many times; past it, close it or answer another way. */
export const FAILED_REPLY_MAX_MANUAL_RETRIES = 5;
/** An echo of the message this long before or after the send began counts as evidence it arrived. */
export const FAILED_REPLY_ECHO_WINDOW_MS = 15 * 60_000;

/** WhatsApp statuses that mean "did not go out". CANCELLED is a deliberate stop, listed only after a retry. */
export const WHATSAPP_FAILED_STATUSES = ["FAILED", "RATE_LIMITED", "SKIPPED"] as const;
export const CHANNEL_FAILED_STATUSES = ["FAILED", "UNKNOWN"] as const;

export interface FailedReplyFacts {
  source: FailedReplySource;
  /** OutboundMessage.status or ChannelMessage.deliveryStatus. */
  status: string;
  resolution: FailedReplyResolution | null;
  manualRetryCount: number;
}

/** Where a row stands on Failed Replies; null when it does not belong there at all. */
export function failedReplyState(facts: FailedReplyFacts): FailedReplyState | null {
  // On the list at all: it failed, or a person retried it. Only then does a resolution apply.
  const failedStatuses: readonly string[] = facts.source === "WHATSAPP" ? WHATSAPP_FAILED_STATUSES : CHANNEL_FAILED_STATUSES;
  if (!failedStatuses.includes(facts.status) && facts.manualRetryCount <= 0) return null;
  if (facts.resolution === "CLOSED") return "CLOSED";
  if (facts.resolution === "RESOLVED") return "RESOLVED";
  const retried = facts.manualRetryCount > 0;
  if (facts.source === "WHATSAPP") {
    if ((WHATSAPP_FAILED_STATUSES as readonly string[]).includes(facts.status)) return "FAILED";
    if (!retried) return null;
    if (facts.status === "SENT") return "RESOLVED";
    if (facts.status === "PENDING" || facts.status === "PROCESSING") return "RETRYING";
    if (facts.status === "CANCELLED") return "FAILED";
    return null;
  }
  if ((CHANNEL_FAILED_STATUSES as readonly string[]).includes(facts.status)) return "FAILED";
  if (!retried) return null;
  if (facts.status === "SENT" || facts.status === "DELIVERED" || facts.status === "READ") return "RESOLVED";
  if (facts.status === "QUEUED" || facts.status === "SENDING") return "RETRYING";
  return null;
}

export type FailedReplyCategory =
  | "DELIVERY_UNCERTAIN"
  | "NOT_CONNECTED"
  | "NOT_IN_CHAT"
  | "RATE_LIMITED"
  | "QUOTE_MISSING"
  | "WRONG_ACCOUNT"
  | "CONTENT_REFUSED"
  | "AUTOMATION_PAUSED"
  | "CHANNEL_WINDOW"
  | "CHANNEL_CREDENTIAL"
  | "PROVIDER_REFUSED";

export const FAILED_REPLY_CATEGORY_LABELS: Record<FailedReplyCategory, string> = {
  DELIVERY_UNCERTAIN: "Delivery uncertain",
  NOT_CONNECTED: "Account not connected",
  NOT_IN_CHAT: "Not in the chat",
  RATE_LIMITED: "Sending limit reached",
  QUOTE_MISSING: "Quoted message missing",
  WRONG_ACCOUNT: "Account of another workspace",
  CONTENT_REFUSED: "Content could not be sent",
  AUTOMATION_PAUSED: "Automation paused",
  CHANNEL_WINDOW: "Reply window closed",
  CHANNEL_CREDENTIAL: "Connection needs attention",
  PROVIDER_REFUSED: "Refused by the provider",
};

/** What the failure was, in one category, from the facts the row records. Display and eligibility only. */
export function classifyReplyFailure(input: {
  source: FailedReplySource;
  status: string;
  failureReason: string | null;
  deliveryUncertain: boolean;
}): FailedReplyCategory {
  const reason = (input.failureReason ?? "").toLowerCase();
  if (input.source === "CHANNEL") {
    if (input.status === "UNKNOWN") return "DELIVERY_UNCERTAIN";
    if (/window|24 ?h|outside|human.agent/.test(reason)) return "CHANNEL_WINDOW";
    if (/token|credential|reconnect|unauthori[sz]ed|permission|expired/.test(reason)) return "CHANNEL_CREDENTIAL";
    if (/rate|too many/.test(reason)) return "RATE_LIMITED";
    return "PROVIDER_REFUSED";
  }
  if (input.deliveryUncertain) return "DELIVERY_UNCERTAIN";
  if (input.status === "RATE_LIMITED" || /rate|per-client limit/.test(reason)) return "RATE_LIMITED";
  if (input.status === "CANCELLED" && /automation was paused/.test(reason)) return "AUTOMATION_PAUSED";
  if (/not connected/.test(reason)) return "NOT_CONNECTED";
  if (input.status === "SKIPPED" || /no longer a member|membership|could not be found on this whatsapp account/.test(reason)) return "NOT_IN_CHAT";
  if (/quote|quoted/.test(reason)) return "QUOTE_MISSING";
  if (/different project|another project|another workspace/.test(reason)) return "WRONG_ACCOUNT";
  if (/cannot send|file|sticker|poll|location|forward|refused/.test(reason)) return "CONTENT_REFUSED";
  return "PROVIDER_REFUSED";
}

export interface RetryFacts {
  source: FailedReplySource;
  state: FailedReplyState | null;
  category: FailedReplyCategory;
  manualRetryCount: number;
  /** WhatsApp: the sending account's status; channels: the connection's. Null when it no longer exists. */
  connectionStatus: string | null;
  /** WhatsApp AUTO_REPLY only: the kill switch would cancel it at send time. */
  automationPausedForThis: boolean;
  /** A message with this text from this number was seen in the chat around the send. */
  echoSeen: boolean;
  /** The person ticked "I checked the chat and the customer did not receive it". */
  confirmedUncertain: boolean;
}

export type RetryDecision = { ok: true } | { ok: false; reason: string; needsConfirmation?: boolean };

/** Whether a person may send this reply again now, and if not, exactly why. */
export function decideFailedReplyRetry(f: RetryFacts): RetryDecision {
  if (f.state === "RETRYING") return { ok: false, reason: "It is already queued to be sent again." };
  if (f.state === "RESOLVED" || f.state === "CLOSED") return { ok: false, reason: "It has been resolved or closed. Reopen it first." };
  if (f.state !== "FAILED") return { ok: false, reason: "Only a failed reply can be sent again." };
  if (f.manualRetryCount >= FAILED_REPLY_MAX_MANUAL_RETRIES) {
    return { ok: false, reason: `It has been retried ${FAILED_REPLY_MAX_MANUAL_RETRIES} times. Close it, or answer the customer another way.` };
  }
  if (f.category === "WRONG_ACCOUNT") return { ok: false, reason: "The account it was queued on belongs to another workspace; it would fail again." };
  if (f.connectionStatus === null) return { ok: false, reason: f.source === "WHATSAPP" ? "The WhatsApp account it was queued on no longer exists." : "The channel connection no longer exists." };
  if (f.source === "WHATSAPP" && f.connectionStatus !== "CONNECTED") return { ok: false, reason: "The WhatsApp account is not connected. Reconnect it first, then retry." };
  if (f.source === "CHANNEL" && f.connectionStatus !== "CONNECTED") return { ok: false, reason: "The channel connection is not connected. Reconnect it first, then retry." };
  if (f.automationPausedForThis) return { ok: false, reason: "Automation is paused, so an automatic reply would be cancelled at send time. Resume automation, or reply from the chat yourself." };
  if (f.category === "DELIVERY_UNCERTAIN") {
    if (f.echoSeen) return { ok: false, reason: "A matching message from this number appears in the chat, so the customer most likely received it. Mark it resolved instead." };
    if (!f.confirmedUncertain) return { ok: false, needsConfirmation: true, reason: "It is not known whether the customer received this. Check the chat first, then confirm to send it again." };
  }
  return { ok: true };
}

/** Bulk retry never sends an uncertain reply: each of those needs its own check and confirmation. */
export function allowedInBulkRetry(f: RetryFacts): boolean {
  return f.category !== "DELIVERY_UNCERTAIN" && decideFailedReplyRetry({ ...f, confirmedUncertain: false }).ok;
}

/** Resolve / close / reopen: which transitions a person may make from a state. */
export type FailedReplyActionKind = "RETRY" | "RESOLVE" | "CLOSE" | "REOPEN";
export function canTransition(state: FailedReplyState | null, action: Exclude<FailedReplyActionKind, "RETRY">): boolean {
  if (action === "REOPEN") return state === "RESOLVED" || state === "CLOSED";
  return state === "FAILED";
}

