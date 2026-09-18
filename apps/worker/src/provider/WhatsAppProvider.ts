import type { RawIncomingMessage } from "../pipeline/types.js";

export type ConnectionStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "RECONNECTING"
  | "AUTHENTICATION_REQUIRED"
  | "SESSION_ERROR"
  | "ERROR";

export interface GroupParticipant {
  /** Digits only, already stripped of the WhatsApp JID domain. */
  phoneNumber: string;
  /** WhatsApp display name, when the contact exposes one. */
  name: string | null;
  /** True for the account this worker is signed in as — never a colleague to add to a roster. */
  isSelf: boolean;
}

export interface GroupInfo {
  whatsappGroupId: string;
  name: string;
}

export interface AccountInfo {
  phoneNumber: string | null;
  pushName: string | null;
}

export interface SendResult {
  success: boolean;
  providerMessageId?: string;
  error?: string;
}

/**
 * What the browser can say about what it has seen — including that it cannot say anything.
 *
 * `fetchMessagesSince` deliberately swallows its own failures and returns an empty array, which is
 * right for catch-up: a sweep that cannot read history has simply recovered nothing, and throwing
 * would take down the connection it just finished establishing.
 *
 * It is exactly wrong for a watchdog. "WhatsApp holds nothing newer" and "WhatsApp could not be
 * asked" are opposite findings — the first is a quiet afternoon, the second is very likely the
 * failure being hunted — and collapsing them is what let a broken browser log "quiet for 195m and
 * WhatsApp agrees". A probe that can return `ok: false` is what makes the distinction expressible
 * at all; everything the watchdog does with it depends on this type.
 */
export type CollectionProbe =
  | { ok: true; messages: RawIncomingMessage[] }
  | { ok: false; reason: string };

/**
 * The core rule engine, pipeline, and queue processor depend only on this
 * interface — never on OpenWA directly (see ARCHITECTURE.md). A future
 * official WhatsApp Business Platform provider is a drop-in implementation.
 */
export interface WhatsAppProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): ConnectionStatus;
  getGroups(): Promise<GroupInfo[]>;
  /**
   * Registers the one handler every incoming message is delivered to.
   *
   * The implementation must keep the handler wired across its own reconnects — a provider that
   * attaches it once, to whatever session happened to be live at registration, goes quiet forever
   * the first time that session is rebuilt, and reports itself perfectly healthy while doing so.
   * Safe to call before connect().
   */
  subscribeToMessages(handler: (message: RawIncomingMessage) => void): void;
  /**
   * Messages the provider can still see for chats touched since `since`, oldest first, capped at
   * `limit`.
   *
   * This is how a gap in collection gets closed. Live delivery is a push: anything that arrives
   * while the process is down, restarting, or between sessions is simply never delivered, and no
   * amount of reconnect logic recovers it — the event has already been and gone. Implementations
   * return an empty array rather than throwing; a provider with no history to offer is a weaker
   * guarantee, not a broken one.
   */
  fetchMessagesSince(since: Date, limit: number): Promise<RawIncomingMessage[]>;
  /**
   * The same read as `fetchMessagesSince`, but able to report that it failed.
   *
   * Used only by the collection watchdog, which is asking a different question: not "what can I
   * recover" but "can this session still see anything at all". An implementation must return
   * `ok: false` whenever the answer is genuinely unknown rather than empty — a dead browser, a
   * chat enumeration that threw, or a roster that came back with zero chats, which for an account
   * known to be in monitored groups is not a fact about WhatsApp but a fact about the session.
   */
  probeCollection(since: Date, limit: number): Promise<CollectionProbe>;
  /**
   * `mentions` are contact ids ("<digits>@c.us") to tag. WhatsApp only notifies a mentioned person
   * if they are a participant of that chat; tagging someone who is not simply renders as text.
   */
  sendMessage(chatId: string, body: string, mentions?: string[]): Promise<SendResult>;
  getAccountInfo(): Promise<AccountInfo>;
  /**
   * Lightweight, single-chat membership check used by the Group Message
   * Sender immediately before sending (see safety requirement: never send
   * blindly). Deliberately NOT a full `getGroups()` rescan — that call is
   * expensive enough on large accounts to need its own timeout/retry
   * wrapper (see commandProcessor.ts) and is unsuitable to run per-message.
   * Returns false (never throws) if membership can't be confirmed.
   */
  verifyGroupMembership(chatId: string): Promise<boolean>;
  /**
   * On-demand, single-group participant count. Deliberately NOT part of
   * getGroups()/the bulk sync path — fetching full participant metadata for
   * every group in one call is far more expensive than fetching names alone
   * (see Group Management audit). Returns null (never throws) if the count
   * can't be determined.
   */
  getGroupParticipantCount(chatId: string): Promise<number | null>;
  /**
   * On-demand roster for a single group: who is actually in it, according to WhatsApp.
   *
   * Distinct from reading `Message.senderPhone` history, which only ever knows the people who
   * have spoken since this app started watching — no use at all for a group that is quiet, or
   * one being set up before any traffic exists. Same on-demand, never-in-bulk-sync reasoning as
   * getGroupParticipantCount above: full participant metadata for every group at once is far
   * more expensive than fetching names alone. Returns an empty array (never throws) if the
   * roster cannot be read.
   */
  getGroupParticipants(chatId: string): Promise<GroupParticipant[]>;
  /**
   * Adds a phone number as a participant of the given group (used by the
   * "Add to Groups" module). The digits-only `phoneNumber` is the caller's
   * responsibility to validate/normalize before this is called — this
   * method only turns it into the provider's own contact id format.
   * Never throws: provider-level failures (not an admin, contact doesn't
   * exist, group doesn't exist, etc.) come back as `{ success: false, error }`.
   */
  addGroupParticipant(chatId: string, phoneNumber: string): Promise<SendResult>;
  /**
   * Ends the current session and invalidates its persisted session data, so the NEXT connect()
   * requires a fresh QR scan — distinct from disconnect(), which is a transient step inside
   * RECONNECT that expects the same session to be reusable afterward. Never throws; failures are
   * logged and swallowed since the caller (the LOGOUT command) must still report a clean local
   * DISCONNECTED state either way (see OpenWAProvider's doc comment on why this call is risky).
   */
  logout(): Promise<void>;
}
